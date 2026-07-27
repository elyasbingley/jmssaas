// Cron-driven dispatcher for the communication engine (see
// supabase/migrations/20260804000100_communication_engine.sql). Deployed as
// a Supabase Edge Function (Deno runtime, npm: specifiers supported),
// invoked periodically by pg_cron -> net.http_post - there's no PowerSync/
// Supabase instance provisioned in this environment to actually schedule
// that call, so the one-time `select cron.schedule(...)` SQL is documented
// by hand in docs/SETUP.md rather than shipped as a migration (it needs the
// project's own deployed URL + a service-role bearer token, neither of
// which exists at migration-authoring time). Not triggered by the mobile
// app directly - the whole point of a queue table is that scheduling
// (Postgres trigger, or a mobile "On The Way" tap) and sending are
// decoupled, since the phone that scheduled a message may be offline by
// the time it's actually due.
//
// GET or POST both trigger a sweep (pg_cron's net.http_post always POSTs;
// GET is only for convenience when testing by hand from a browser/curl).
// Always requires the service-role bearer token in Authorization - this
// function reads/writes across every tenant's scheduled_communications, so
// it must never be reachable with just the anon key.
//
// Rendering: rendered_subject/rendered_body on a scheduled_communications
// row hold whatever the inserter (a Postgres trigger, or the mobile app)
// couldn't fully resolve on the spot - this function does the rest at send
// time, for every entity_type except 'calendar_event' (nothing in this
// migration or the mobile app ever creates one of those, so it's sent
// verbatim if it ever shows up). Two cases:
//
//   'quote'/'invoice' rows (from the auto-scheduling triggers on
//   quotes/invoices) start as a straight copy of the template, {token}s
//   fully intact - this function rebuilds {quote_*}/{invoice_*}/
//   {client_*}/{company_*} context from the database and renders the whole
//   thing.
//
//   'job' rows (from the mobile app's manual "On The Way"/review-request
//   triggers - see apps/mobile/app/(tabs)/sales/jobs/[id].tsx) arrive with
//   {tech_first_name}/{eta_minutes} ALREADY substituted client-side, since
//   those come from ephemeral input (who tapped the button, what ETA they
//   typed) with nowhere to persist it for later reconstruction - the
//   mobile app has to render those two before the row is even inserted, so
//   the "On The Way" flow still works with no reception. Every other token
//   ({client_*}/{job_*}/{site_address}/{company_*}) is left raw for this
//   function to resolve the same way it does for quote/invoice rows,
//   rebuilding job/client/company context from the database - this is what
//   lets the mobile app queue the row entirely offline without needing
//   company details (bank info, review link, ...) that aren't PowerSync-
//   synced to the device at all.
//
// This is a near-identical Deno-native port of
// packages/shared/src/placeholders.ts - Edge Functions can't import code
// from outside their own function directory, so the two
// copies have to be kept in sync by hand if the token set ever changes.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APPROVAL_PAGE_URL = Deno.env.get("APPROVAL_PAGE_URL") ?? "";

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const TWILIO_FROM_NUMBER = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") ?? "";

// No tenants.timezone column exists (see the migration's own comment) -
// this app is AU-only in every other place that cares about locale (GST
// math, en-AU date formatting, the roof measurement screen's Sydney
// fallback region), so quiet-hours comparison hardcodes Australia/Sydney
// rather than adding a column for a problem this product doesn't have yet.
const QUIET_HOURS_TZ = "Australia/Sydney";

// How many due rows to process per sweep - keeps a single invocation fast
// and bounded; a backlog beyond this just gets picked up on the next sweep.
const BATCH_LIMIT = 50;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" }),
  });
}

// ---------------------------------------------------------------------------
// Placeholder rendering (Deno-native port of packages/shared/src/placeholders.ts)
// ---------------------------------------------------------------------------

interface PlaceholderContext {
  company?: {
    name: string;
    phone: string | null;
    email: string | null;
    bank_account_name: string | null;
    bank_bsb: string | null;
    bank_account_number: string | null;
    google_review_link: string | null;
  };
  client?: { name: string; phone: string | null; email: string | null };
  quote?: {
    quote_number: string;
    total_cents: number;
    issue_date: string;
    expiry_date: string | null;
    approval_link: string | null;
  };
  invoice?: {
    invoice_number: string;
    total_cents: number;
    due_date: string | null;
    payment_link: string | null;
  };
  job?: { number: string | null; title: string; site_address: string | null };
}

function formatCentsAsAud(cents: number): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
}

function formatDateAu(dateString: string | null | undefined): string {
  if (!dateString) return "";
  const d = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateString;
  return d.toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

function buildPlaceholderTokens(context: PlaceholderContext): Record<string, string> {
  const tokens: Record<string, string> = {};
  if (context.client) {
    tokens.client_full_name = context.client.name;
    tokens.client_first_name = firstName(context.client.name);
    tokens.client_phone = context.client.phone ?? "";
    tokens.client_email = context.client.email ?? "";
  }
  if (context.job) {
    tokens.job_number = context.job.number ?? "";
    tokens.job_title = context.job.title;
    tokens.site_address = context.job.site_address ?? "";
  }
  if (context.quote) {
    tokens.quote_number = context.quote.quote_number;
    tokens.quote_total = formatCentsAsAud(context.quote.total_cents);
    tokens.quote_issue_date = formatDateAu(context.quote.issue_date);
    tokens.quote_expiry_date = formatDateAu(context.quote.expiry_date);
    tokens.quote_approval_link = context.quote.approval_link ?? "";
  }
  if (context.invoice) {
    tokens.invoice_number = context.invoice.invoice_number;
    tokens.invoice_total = formatCentsAsAud(context.invoice.total_cents);
    tokens.invoice_due_date = formatDateAu(context.invoice.due_date);
    tokens.invoice_payment_link = context.invoice.payment_link ?? "";
  }
  if (context.company) {
    tokens.company_name = context.company.name;
    tokens.company_phone = context.company.phone ?? "";
    tokens.company_email = context.company.email ?? "";
    tokens.bank_account_name = context.company.bank_account_name ?? "";
    tokens.bank_bsb = context.company.bank_bsb ?? "";
    tokens.bank_account_number = context.company.bank_account_number ?? "";
    tokens.google_review_link = context.company.google_review_link ?? "";
  }
  return tokens;
}

function renderTemplate(body: string, context: PlaceholderContext): string {
  const tokens = buildPlaceholderTokens(context);
  return body.replace(/\{(\w+)\}/g, (match, key: string) => (key in tokens ? tokens[key]! : match));
}

// ---------------------------------------------------------------------------
// Quiet hours (Australia/Sydney) - quiet_hours_start/end on communication_
// rules is the ALLOWED sending window (default 08:00-18:00), not a
// do-not-disturb window despite the name - matches the column defaults in
// the migration. A row due outside that window is deferred by pushing
// scheduled_for to the next occurrence of quiet_hours_start, rather than
// sent late or dropped.
// ---------------------------------------------------------------------------

function sydneyPartsAndOffset(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: QUIET_HOURS_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // e.g. "GMT+10" or "GMT+11" depending on daylight saving.
  const offsetMatch = get("timeZoneName").match(/GMT([+-]\d+)(?::?(\d+))?/);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") === "24" ? "00" : get("hour"),
    minute: get("minute"),
    second: get("second"),
    offsetHours: offsetMatch ? Number(offsetMatch[1]) : 10,
    offsetMinutes: offsetMatch?.[2] ? Number(offsetMatch[2]) : 0,
  };
}

function currentSydneyTimeOfDay(date: Date): string {
  const p = sydneyPartsAndOffset(date);
  return `${p.hour}:${p.minute}:${p.second}`;
}

function isWithinWindow(current: string, start: string, end: string): boolean {
  // start <= end is the normal case (e.g. 08:00-18:00); handle a window
  // that spans midnight too, in case a tenant ever sets one up that way.
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

// Next Sydney-local occurrence of `timeOfDay` (HH:MM or HH:MM:SS) at or
// after `date`. DST transitions mid-window aren't specially handled - an
// acceptable simplification for a "defer by roughly a day" retry, not a
// precision scheduling guarantee.
function nextSydneyOccurrence(date: Date, timeOfDay: string): Date {
  const [h, m, s] = timeOfDay.split(":").map((n) => Number(n) || 0);
  const p = sydneyPartsAndOffset(date);
  const offsetSign = p.offsetHours < 0 ? "-" : "+";
  const offsetStr = `${offsetSign}${String(Math.abs(p.offsetHours)).padStart(2, "0")}:${String(p.offsetMinutes).padStart(2, "0")}`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const todayIso = `${p.year}-${p.month}-${p.day}T${pad(h)}:${pad(m)}:${pad(s)}${offsetStr}`;
  let candidate = new Date(todayIso);
  if (candidate.getTime() <= date.getTime()) {
    candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Context building + dispatch
// ---------------------------------------------------------------------------

interface ScheduledCommunicationRow {
  id: string;
  tenant_id: string;
  entity_type: "quote" | "invoice" | "job" | "calendar_event";
  entity_id: string;
  trigger_key: string;
  channel: "sms" | "email";
  recipient_phone_or_email: string;
  rendered_subject: string | null;
  rendered_body: string;
  scheduled_for: string;
}

// Mirrors apps/mobile/lib/format.ts's formatClientAddress - same fields,
// same join logic, just duplicated here for the same reason as the rest of
// this file's placeholder logic (no cross-directory imports in an Edge
// Function).
function formatAddress(row: {
  address_line1: string | null;
  address_line2: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
}): string | null {
  const parts = [row.address_line1, row.address_line2, [row.suburb, row.state, row.postcode].filter(Boolean).join(" ")].filter(
    Boolean
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

async function buildEntityContext(
  admin: SupabaseClient,
  row: ScheduledCommunicationRow,
  tenant: Record<string, unknown>
): Promise<PlaceholderContext> {
  const context: PlaceholderContext = {
    company: {
      name: String(tenant.name ?? ""),
      phone: (tenant.phone as string) ?? null,
      email: (tenant.email as string) ?? null,
      bank_account_name: (tenant.bank_account_name as string) ?? null,
      bank_bsb: (tenant.bank_bsb as string) ?? null,
      bank_account_number: (tenant.bank_account_number as string) ?? null,
      google_review_link: (tenant.google_review_link as string) ?? null,
    },
  };

  if (row.entity_type === "quote") {
    const { data: quote } = await admin.from("quotes").select("*").eq("id", row.entity_id).single();
    if (!quote) return context;
    const { data: client } = await admin.from("clients").select("*").eq("id", quote.client_id).single();
    if (client) context.client = { name: client.name, phone: client.phone, email: client.email };
    let approvalLink: string | null = null;
    if (APPROVAL_PAGE_URL) {
      const { data: token } = await admin.rpc("generate_quote_approval_link", { p_quote_id: quote.id });
      if (token) approvalLink = `${APPROVAL_PAGE_URL}?type=quote&token=${token}`;
    }
    context.quote = {
      quote_number: quote.quote_number,
      total_cents: quote.total_cents,
      issue_date: quote.issue_date,
      expiry_date: quote.expiry_date,
      approval_link: approvalLink,
    };
  } else if (row.entity_type === "invoice") {
    const { data: invoice } = await admin.from("invoices").select("*").eq("id", row.entity_id).single();
    if (!invoice) return context;
    const { data: client } = await admin.from("clients").select("*").eq("id", invoice.client_id).single();
    if (client) context.client = { name: client.name, phone: client.phone, email: client.email };
    let paymentLink: string | null = null;
    if (APPROVAL_PAGE_URL) {
      const { data: token } = await admin.rpc("generate_invoice_approval_link", { p_invoice_id: invoice.id });
      if (token) paymentLink = `${APPROVAL_PAGE_URL}?type=invoice&token=${token}`;
    }
    context.invoice = {
      invoice_number: invoice.invoice_number,
      total_cents: invoice.total_cents,
      due_date: invoice.due_date,
      payment_link: paymentLink,
    };
  } else if (row.entity_type === "job") {
    const { data: job } = await admin.from("job_cards").select("*").eq("id", row.entity_id).single();
    if (!job) return context;
    const { data: client } = await admin.from("clients").select("*").eq("id", job.client_id).single();
    if (client) context.client = { name: client.name, phone: client.phone, email: client.email };
    let siteAddress: string | null = null;
    if (job.site_id) {
      const { data: site } = await admin.from("client_sites").select("*").eq("id", job.site_id).single();
      if (site) siteAddress = formatAddress(site);
    }
    if (!siteAddress && client) siteAddress = formatAddress(client);
    context.job = { number: job.number, title: job.title, site_address: siteAddress };
  }

  return context;
}

async function sendSms(to: string, body: string): Promise<void> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    throw new Error("SMS provider not configured (TWILIO_* env vars missing)");
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Twilio ${res.status}: ${detail.slice(0, 300)}`);
  }
}

async function sendEmail(to: string, subject: string | null, body: string): Promise<void> {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    throw new Error("Email provider not configured (RESEND_* env vars missing)");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: [to],
      subject: subject || "(no subject)",
      text: body,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) return json({ error: "unauthorized" }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const now = new Date();

  const { data: due, error: fetchError } = await admin
    .from("scheduled_communications")
    .select("id, tenant_id, entity_type, entity_id, trigger_key, channel, recipient_phone_or_email, rendered_subject, rendered_body, scheduled_for")
    .eq("status", "pending")
    .lte("scheduled_for", now.toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(BATCH_LIMIT);

  if (fetchError) {
    console.error("[process-scheduled-comms] Failed to fetch due rows", fetchError.message);
    return json({ error: "server_error" }, 500);
  }

  const rows = (due ?? []) as ScheduledCommunicationRow[];
  let sent = 0;
  let deferred = 0;
  let failed = 0;

  // Cache tenant + rule lookups within this sweep - many due rows typically
  // belong to the same handful of tenants/trigger_keys.
  const tenantCache = new Map<string, Record<string, unknown>>();
  const ruleCache = new Map<string, { quiet_hours_start: string; quiet_hours_end: string } | null>();

  for (const row of rows) {
    try {
      let tenant = tenantCache.get(row.tenant_id);
      if (!tenant) {
        const { data } = await admin.from("tenants").select("*").eq("id", row.tenant_id).single();
        tenant = data ?? {};
        tenantCache.set(row.tenant_id, tenant);
      }

      const ruleKey = `${row.tenant_id}:${row.trigger_key}`;
      let rule = ruleCache.get(ruleKey);
      if (rule === undefined) {
        const { data } = await admin
          .from("communication_rules")
          .select("quiet_hours_start, quiet_hours_end")
          .eq("tenant_id", row.tenant_id)
          .eq("trigger_key", row.trigger_key)
          .maybeSingle();
        rule = data ?? null;
        ruleCache.set(ruleKey, rule);
      }

      if (rule) {
        const currentTime = currentSydneyTimeOfDay(now);
        if (!isWithinWindow(currentTime, rule.quiet_hours_start, rule.quiet_hours_end)) {
          const nextSend = nextSydneyOccurrence(now, rule.quiet_hours_start);
          await admin.from("scheduled_communications").update({ scheduled_for: nextSend.toISOString() }).eq("id", row.id);
          deferred++;
          continue;
        }
      }

      const recipient = row.recipient_phone_or_email.trim();
      if (!recipient) {
        await admin
          .from("scheduled_communications")
          .update({ status: "failed", failure_reason: "No recipient phone/email on file" })
          .eq("id", row.id);
        failed++;
        continue;
      }

      let finalSubject = row.rendered_subject;
      let finalBody = row.rendered_body;
      if (row.entity_type !== "calendar_event") {
        const context = await buildEntityContext(admin, row, tenant);
        finalSubject = finalSubject ? renderTemplate(finalSubject, context) : finalSubject;
        finalBody = renderTemplate(finalBody, context);
      }

      if (row.channel === "sms") {
        await sendSms(recipient, finalBody);
      } else {
        await sendEmail(recipient, finalSubject, finalBody);
      }

      await admin
        .from("scheduled_communications")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          rendered_subject: finalSubject,
          rendered_body: finalBody,
        })
        .eq("id", row.id);
      sent++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[process-scheduled-comms] Failed to dispatch ${row.id}`, message);
      await admin
        .from("scheduled_communications")
        .update({ status: "failed", failure_reason: message.slice(0, 500) })
        .eq("id", row.id);
      failed++;
    }
  }

  return json({ ok: true, processed: rows.length, sent, deferred, failed });
});
