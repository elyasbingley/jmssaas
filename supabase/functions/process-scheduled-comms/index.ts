// Dispatcher for the communication engine (see
// supabase/migrations/20260804000100_communication_engine.sql). Deployed as
// a Supabase Edge Function (Deno runtime, npm: specifiers supported). Two
// ways in:
//
//   1. The cron sweep - pg_cron -> net.http_post, invoked periodically
//      (there's no PowerSync/Supabase instance provisioned in this
//      environment to actually schedule that call, so the one-time `select
//      cron.schedule(...)` SQL is documented by hand in docs/SETUP.md
//      rather than shipped as a migration - it needs the project's own
//      deployed URL + a service-role bearer token, neither of which exists
//      at migration-authoring time). GET or POST both trigger a sweep
//      (net.http_post always POSTs; GET is only for convenience when
//      testing by hand). Requires the service-role bearer token - this
//      path reads/writes across every tenant's scheduled_communications,
//      so it must never be reachable with just the anon key.
//
//   2. Immediate single-row dispatch - POST { id } with a normal signed-in
//      user's bearer token (any role, not just admin), scoped to that
//      row's own tenant. This is what apps/mobile/app/(tabs)/sales/jobs/
//      [id].tsx calls right after inserting an "On The Way"/review-request
//      row, so a technician's ETA email goes out immediately instead of
//      waiting for the next cron tick - the whole point of "on the way, 15
//      minutes" is that it's time-sensitive. The queue table still does
//      its job if this call fails for any reason (no signal, cold start,
//      function down): the row is already safely `pending` and the next
//      cron sweep picks it up regardless, so this is purely a latency
//      optimisation, never a requirement for correctness.
//
// Neither path is required for quote/invoice follow-ups, which only ever
// get scheduled by the Postgres triggers on the server side and have no
// "I want this to go out right now" moment to optimise for - the cron
// sweep alone is what sends those.
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
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APPROVAL_PAGE_URL = Deno.env.get("APPROVAL_PAGE_URL") ?? "";

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

// dispatchNow (unlike runSweep, which is only ever called server-side with
// the service role key) is called directly from a browser - the desktop
// app's own quote/invoice "Send via Email" buttons hit this function with
// fetch() and the caller's session token. A browser fetch to a
// cross-origin URL (any *.supabase.co function, from either
// http://localhost:5173 or the deployed desktop domain) sends a CORS
// preflight OPTIONS request first; with no CORS headers at all (as this
// function had until now), the browser blocks the response before the
// caller's own code ever sees it - triggerImmediateDispatch's try/catch
// then swallows what looks like a generic network failure, silently
// falling back to "queued, the cron sweep will get it". Mobile's
// React Native fetch never hit this since RN has no same-origin policy to
// enforce - this was invisible until the desktop app started calling the
// same function from a real browser.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS }),
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
    accept_link: string | null;
    decline_link: string | null;
  };
  invoice?: {
    invoice_number: string;
    total_cents: number;
    due_date: string | null;
    payment_link: string | null;
  };
  job?: { number: string | null; title: string; site_address: string | null };
  schedule?: {
    tech_first_name: string | null;
    booking_date: string | null;
    booking_start_time: string | null;
    eta_minutes: number | null;
  };
  // property_maintenance_due only (see the real_estate_maintenance_engine
  // migration) - the recipient there is the property manager, not a
  // client, hence pm_first_name rather than reusing `client`.
  property?: { address: string; pm_first_name: string | null; maintenance_due_date: string | null };
  // referral_lead_received/referral_job_completed only (see the
  // b2b_referral_automation migration) - the recipient is the referral
  // partner, not a client.
  referralPartner?: { partner_first_name: string; referred_client_name: string | null; job_title: string | null; job_value_cents: number | null };
  // report_sent only (see the reports_safety_engine migration).
  report?: { title: string; pdf_link: string | null };
  // subcontractor_quote_request/subcontractor_work_order only (see the
  // subcontractor_management migration).
  purchaseOrder?: { contact_first_name: string; po_number: string | null; po_total_cents: number; quote_link: string | null; pdf_link: string | null };
  // subcontractor_compliance_expired only.
  subcontractor?: { contact_first_name: string; company_name: string; expired_doc_type_label: string; expired_doc_expiry_date: string | null };
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
  if (context.schedule) {
    tokens.tech_first_name = context.schedule.tech_first_name ?? "";
    tokens.booking_date = formatDateAu(context.schedule.booking_date);
    tokens.booking_start_time = context.schedule.booking_start_time ?? "";
    tokens.eta_minutes = context.schedule.eta_minutes != null ? String(context.schedule.eta_minutes) : "";
  }
  if (context.quote) {
    tokens.quote_number = context.quote.quote_number;
    tokens.quote_total = formatCentsAsAud(context.quote.total_cents);
    tokens.quote_issue_date = formatDateAu(context.quote.issue_date);
    tokens.quote_expiry_date = formatDateAu(context.quote.expiry_date);
    tokens.quote_approval_link = context.quote.approval_link ?? "";
    tokens.quote_accept_link = context.quote.accept_link ?? "";
    tokens.quote_decline_link = context.quote.decline_link ?? "";
  }
  if (context.invoice) {
    tokens.invoice_number = context.invoice.invoice_number;
    tokens.invoice_total = formatCentsAsAud(context.invoice.total_cents);
    tokens.invoice_due_date = formatDateAu(context.invoice.due_date);
    tokens.invoice_payment_link = context.invoice.payment_link ?? "";
  }
  if (context.property) {
    tokens.property_address = context.property.address;
    tokens.pm_first_name = context.property.pm_first_name ?? "";
    tokens.property_maintenance_due_date = formatDateAu(context.property.maintenance_due_date);
  }
  if (context.referralPartner) {
    tokens.partner_first_name = context.referralPartner.partner_first_name;
    tokens.referred_client_name = context.referralPartner.referred_client_name ?? "";
    tokens.job_title = context.referralPartner.job_title ?? "";
    tokens.job_value = context.referralPartner.job_value_cents != null ? formatCentsAsAud(context.referralPartner.job_value_cents) : "";
  }
  if (context.report) {
    tokens.report_title = context.report.title;
    tokens.report_pdf_link = context.report.pdf_link ?? "";
  }
  if (context.purchaseOrder) {
    tokens.subcontractor_contact_first_name = context.purchaseOrder.contact_first_name;
    tokens.po_number = context.purchaseOrder.po_number ?? "";
    tokens.po_total = formatCentsAsAud(context.purchaseOrder.po_total_cents);
    tokens.po_quote_link = context.purchaseOrder.quote_link ?? "";
    tokens.po_pdf_link = context.purchaseOrder.pdf_link ?? "";
  }
  if (context.subcontractor) {
    tokens.subcontractor_contact_first_name = context.subcontractor.contact_first_name;
    tokens.subcontractor_company_name = context.subcontractor.company_name;
    tokens.expired_doc_type = context.subcontractor.expired_doc_type_label;
    tokens.expired_doc_expiry_date = formatDateAu(context.subcontractor.expired_doc_expiry_date);
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
  entity_type: "quote" | "invoice" | "job" | "calendar_event" | "client" | "property_asset" | "referral_partner" | "report" | "purchase_order" | "subcontractor";
  entity_id: string;
  trigger_key: string;
  channel: "sms" | "email";
  recipient_phone_or_email: string;
  cc_emails: string[] | null;
  bcc_emails: string[] | null;
  rendered_subject: string | null;
  rendered_body: string;
  scheduled_for: string;
}

// Mirrors apps/mobile/lib/format.ts's formatClientAddress - same fields,
// same join logic, just duplicated here for the same reason as the rest of
// this file's placeholder logic (no cross-directory imports in an Edge
// Function).
const DOC_TYPE_LABELS: Record<string, string> = {
  public_liability: "Public Liability Insurance",
  workers_comp: "Workers Compensation policy",
  trade_license: "Trade License",
  white_card: "White Card",
  safety_induction: "Safety Induction certificate",
  other: "compliance document",
};

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
      accept_link: approvalLink ? `${approvalLink}&action=accept` : null,
      decline_link: approvalLink ? `${approvalLink}&action=decline` : null,
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

    // {tech_first_name}/{booking_date}/{booking_start_time} for the auto-
    // scheduled job_prep_checklist/job_completion_summary templates - the
    // manual triggers (job_on_the_way/job_review_request) already have
    // their own schedule tokens substituted client-side before the row is
    // even inserted (see the mobile app's queueScheduledCommunication), so
    // this is a harmless no-op for those rows, nothing left to replace.
    let techFirstName: string | null = null;
    if (job.assigned_technician_id) {
      const { data: tech } = await admin.from("profiles").select("full_name").eq("id", job.assigned_technician_id).single();
      if (tech?.full_name) techFirstName = firstName(tech.full_name);
    }
    if (job.scheduled_at) {
      const p = sydneyPartsAndOffset(new Date(job.scheduled_at));
      context.schedule = {
        tech_first_name: techFirstName,
        booking_date: `${p.year}-${p.month}-${p.day}`,
        booking_start_time: `${p.hour}:${p.minute}`,
        eta_minutes: null,
      };
    } else if (techFirstName) {
      context.schedule = { tech_first_name: techFirstName, booking_date: null, booking_start_time: null, eta_minutes: null };
    }
  } else if (row.entity_type === "client") {
    // dormant_client_reengagement rows (see process-retention-campaigns) -
    // there's no quote/invoice/job to hang context off, just the client
    // themselves.
    const { data: client } = await admin.from("clients").select("*").eq("id", row.entity_id).single();
    if (client) context.client = { name: client.name, phone: client.phone, email: client.email };
  } else if (row.entity_type === "property_asset") {
    // property_maintenance_due rows (see process-real-estate-maintenance)
    // - entity_id is the property_assets row itself, not the property,
    // since a property can have multiple assets each on their own
    // schedule. Recipient is the property's assigned property manager.
    const { data: asset } = await admin.from("property_assets").select("*").eq("id", row.entity_id).single();
    if (!asset) return context;
    const { data: property } = await admin.from("properties").select("*").eq("id", asset.property_id).single();
    if (!property) return context;
    let pmFirstName: string | null = null;
    if (property.property_manager_id) {
      const { data: pm } = await admin.from("property_managers").select("first_name").eq("id", property.property_manager_id).single();
      if (pm?.first_name) pmFirstName = pm.first_name;
    }
    const attrs = (asset.attributes ?? {}) as { last_gutter_clean_date?: string; gutter_clean_interval_months?: number };
    let dueDate: string | null = null;
    if (attrs.last_gutter_clean_date && attrs.gutter_clean_interval_months) {
      const d = new Date(`${attrs.last_gutter_clean_date}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + attrs.gutter_clean_interval_months);
      dueDate = d.toISOString().slice(0, 10);
    }
    context.property = {
      address: formatAddress(property) ?? property.address_line1,
      pm_first_name: pmFirstName,
      maintenance_due_date: dueDate,
    };
  } else if (row.entity_type === "referral_partner") {
    // referral_lead_received/referral_job_completed rows (see the
    // b2b_referral_automation migration) - entity_id is a job_cards.id
    // (mirrors entity_type='job'), so the partner is resolved via
    // job.referral_partner_id rather than being the entity itself. The
    // monthly digest (process-referral-digest) is the one exception: it
    // has no single job to point at, so its rows use a referral_partners.id
    // as entity_id instead - tried as a fallback below. That's safe
    // because job_cards and referral_partners ids are drawn from separate
    // UUID spaces, never colliding, and the digest email arrives fully
    // pre-rendered anyway (see that function's own comment), so this
    // fallback context is never actually substituted into anything.
    const { data: job } = await admin.from("job_cards").select("*").eq("id", row.entity_id).maybeSingle();
    if (job?.referral_partner_id) {
      const { data: partner } = await admin.from("referral_partners").select("*").eq("id", job.referral_partner_id).single();
      const { data: client } = await admin.from("clients").select("name").eq("id", job.client_id).maybeSingle();
      const { data: paidInvoices } = await admin
        .from("invoices")
        .select("total_cents")
        .eq("job_card_id", job.id)
        .eq("status", "paid");
      const jobValueCents = paidInvoices && paidInvoices.length > 0 ? paidInvoices.reduce((sum: number, inv: { total_cents: number }) => sum + inv.total_cents, 0) : null;
      if (partner) {
        context.referralPartner = {
          partner_first_name: firstName(partner.contact_first_name),
          referred_client_name: client?.name ?? null,
          job_title: job.title,
          job_value_cents: jobValueCents,
        };
      }
    } else {
      const { data: partner } = await admin.from("referral_partners").select("contact_first_name").eq("id", row.entity_id).maybeSingle();
      if (partner) {
        context.referralPartner = { partner_first_name: firstName(partner.contact_first_name), referred_client_name: null, job_title: null, job_value_cents: null };
      }
    }
  } else if (row.entity_type === "report") {
    // report_sent rows (see the reports_safety_engine migration) -
    // entity_id is the report_instances row itself. Client is resolved via
    // report.client_id first, falling back to the linked job's client_id
    // (a report can be linked to a job without its own client_id ever
    // having been set explicitly - see ReportInstance.tsx's link flow).
    const { data: report } = await admin.from("report_instances").select("*").eq("id", row.entity_id).single();
    if (!report) return context;
    const { data: template } = await admin.from("report_templates").select("title").eq("id", report.template_id).single();

    let clientId: string | null = report.client_id;
    if (!clientId && report.job_card_id) {
      const { data: job } = await admin.from("job_cards").select("client_id").eq("id", report.job_card_id).maybeSingle();
      clientId = job?.client_id ?? null;
    }
    if (clientId) {
      const { data: client } = await admin.from("clients").select("*").eq("id", clientId).maybeSingle();
      if (client) context.client = { name: client.name, phone: client.phone, email: client.email };
    }

    let pdfLink: string | null = null;
    if (report.pdf_storage_path) {
      const { data: signed } = await admin.storage.from("report-files").createSignedUrl(report.pdf_storage_path, 60 * 60 * 24 * 7);
      pdfLink = signed?.signedUrl ?? null;
    }
    context.report = { title: template?.title ?? "Report", pdf_link: pdfLink };
  } else if (row.entity_type === "purchase_order") {
    // subcontractor_quote_request/subcontractor_work_order rows (see the
    // subcontractor_management migration) - entity_id is the
    // purchase_orders row. job/site_address use the same PlaceholderJobContext
    // shape entity_type='job' already builds, so {job_title}/{site_address}
    // work in these templates too without a separate token.
    const { data: po } = await admin.from("purchase_orders").select("*").eq("id", row.entity_id).single();
    if (!po) return context;

    const { data: job } = await admin.from("job_cards").select("*").eq("id", po.job_card_id).maybeSingle();
    if (job) {
      const { data: client } = await admin.from("clients").select("*").eq("id", job.client_id).maybeSingle();
      const siteAddress = client ? formatAddress(client) : null;
      context.job = { number: job.number, title: job.title, site_address: siteAddress };
    }

    let contactFirstName = "";
    let contactId = po.contact_id;
    if (!contactId) {
      const { data: primary } = await admin
        .from("subcontractor_contacts")
        .select("id, first_name")
        .eq("subcontractor_id", po.subcontractor_id)
        .eq("is_primary_contact", true)
        .maybeSingle();
      if (primary) {
        contactId = primary.id;
        contactFirstName = firstName(primary.first_name);
      }
    } else {
      const { data: contact } = await admin.from("subcontractor_contacts").select("first_name").eq("id", contactId).maybeSingle();
      if (contact) contactFirstName = firstName(contact.first_name);
    }

    let quoteLink: string | null = null;
    if (po.access_token && APPROVAL_PAGE_URL) {
      quoteLink = `${APPROVAL_PAGE_URL}?type=po_quote&token=${po.access_token}`;
    }
    let pdfLink: string | null = null;
    if (po.pdf_storage_path) {
      const { data: signed } = await admin.storage.from("subcontractor-files").createSignedUrl(po.pdf_storage_path, 60 * 60 * 24 * 7);
      pdfLink = signed?.signedUrl ?? null;
    }

    context.purchaseOrder = {
      contact_first_name: contactFirstName,
      po_number: po.po_number,
      po_total_cents: po.total_cost_cents,
      quote_link: quoteLink,
      pdf_link: pdfLink,
    };
  } else if (row.entity_type === "subcontractor") {
    // subcontractor_compliance_expired rows (see process-subcontractor-
    // compliance) - entity_id is the subcontractor_companies row, one row
    // per contact (recipient_phone_or_email already identifies which
    // contact). Multiple docs can be expired at once; this references
    // whichever is most overdue (earliest expiry_date), a reasonable
    // single example for a message that's fundamentally "please send us
    // updated paperwork", not an exhaustive list.
    const { data: subcontractor } = await admin.from("subcontractor_companies").select("company_name").eq("id", row.entity_id).maybeSingle();
    if (!subcontractor) return context;

    const { data: contact } = await admin
      .from("subcontractor_contacts")
      .select("first_name")
      .eq("subcontractor_id", row.entity_id)
      .eq("email", row.recipient_phone_or_email)
      .maybeSingle();

    const { data: expiredDoc } = await admin
      .from("subcontractor_compliance_docs")
      .select("doc_type, expiry_date")
      .eq("subcontractor_id", row.entity_id)
      .not("expiry_date", "is", null)
      .lt("expiry_date", new Date().toISOString().slice(0, 10))
      .order("expiry_date", { ascending: true })
      .limit(1)
      .maybeSingle();

    context.subcontractor = {
      contact_first_name: contact ? firstName(contact.first_name) : "",
      company_name: subcontractor.company_name,
      expired_doc_type_label: DOC_TYPE_LABELS[expiredDoc?.doc_type as string] ?? "compliance document",
      expired_doc_expiry_date: expiredDoc?.expiry_date ?? null,
    };
  }

  return context;
}

// Template bodies are allowed to contain raw HTML now (the quote reminder
// templates embed styled <a> button links for one-click accept/decline -
// see the reminder_ladder migration) - there's no WYSIWYG/dual-engine
// template builder, an admin just types markup straight into the same
// plain multiline body field the Automation & Messaging Settings screen
// already has, same as any other template edit. sendEmail always sends
// both parts: `html` renders the buttons/markup properly in HTML-capable
// clients, `text` is a stripped-tags fallback for plain-text clients and
// spam filters that weight multipart emails favourably. A body with no
// HTML in it (every non-quote template, still) round-trips through both
// unchanged except for \n -> <br> in the html part.
function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

async function sendEmail(to: string, cc: string[], bcc: string[], subject: string | null, body: string): Promise<void> {
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
      ...(cc.length > 0 ? { cc } : {}),
      ...(bcc.length > 0 ? { bcc } : {}),
      subject: subject || "(no subject)",
      html: body.replace(/\n/g, "<br>"),
      text: stripHtmlTags(body),
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
  }
}

type DispatchOutcome = { outcome: "sent" | "deferred" | "failed" };

// Sends (or defers, or fails) exactly one row and writes the result back to
// scheduled_communications. Shared by the cron sweep and the immediate
// single-row path - `skipQuietHours` is true only for the latter, since a
// human deliberately tapping "On The Way" right now is a real-time action,
// not a background nudge that should wait for business hours the way an
// automated quote follow-up should.
async function dispatchOne(
  admin: SupabaseClient,
  row: ScheduledCommunicationRow,
  tenant: Record<string, unknown>,
  now: Date,
  skipQuietHours: boolean
): Promise<DispatchOutcome> {
  if (!skipQuietHours) {
    const { data: rule } = await admin
      .from("communication_rules")
      .select("quiet_hours_start, quiet_hours_end")
      .eq("tenant_id", row.tenant_id)
      .eq("trigger_key", row.trigger_key)
      .maybeSingle();

    if (rule) {
      const currentTime = currentSydneyTimeOfDay(now);
      if (!isWithinWindow(currentTime, rule.quiet_hours_start, rule.quiet_hours_end)) {
        const nextSend = nextSydneyOccurrence(now, rule.quiet_hours_start);
        await admin.from("scheduled_communications").update({ scheduled_for: nextSend.toISOString() }).eq("id", row.id);
        return { outcome: "deferred" };
      }
    }
  }

  const recipient = row.recipient_phone_or_email.trim();
  if (!recipient) {
    await admin
      .from("scheduled_communications")
      .update({ status: "failed", failure_reason: "No recipient phone/email on file" })
      .eq("id", row.id);
    return { outcome: "failed" };
  }

  let finalSubject = row.rendered_subject;
  let finalBody = row.rendered_body;
  if (row.entity_type !== "calendar_event") {
    const context = await buildEntityContext(admin, row, tenant);
    finalSubject = finalSubject ? renderTemplate(finalSubject, context) : finalSubject;
    finalBody = renderTemplate(finalBody, context);
  }

  // SMS sending was removed after the Twilio integration proved unreliable
  // in practice (auth/number-format issues never fully ironed out) - see
  // git history for the old sendSms/normalizeAuMobileNumber code if SMS is
  // revisited later with a different provider. The `channel` column and
  // `communication_rules.channel`'s 'sms'/'both' options are left in the
  // schema rather than migrated away, since a future SMS provider would
  // slot back into the exact same shape - but nothing currently sends
  // through this branch, so a stray 'sms' row (e.g. a rule an admin
  // manually set back to 'sms') fails clearly instead of silently no-oping.
  if (row.channel !== "email") {
    await admin
      .from("scheduled_communications")
      .update({ status: "failed", failure_reason: "SMS sending is not currently supported - switch this rule to email" })
      .eq("id", row.id);
    return { outcome: "failed" };
  }

  try {
    await sendEmail(recipient, row.cc_emails ?? [], row.bcc_emails ?? [], finalSubject, finalBody);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[process-scheduled-comms] Failed to dispatch ${row.id}`, message);
    await admin
      .from("scheduled_communications")
      .update({ status: "failed", failure_reason: message.slice(0, 500) })
      .eq("id", row.id);
    return { outcome: "failed" };
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
  return { outcome: "sent" };
}

async function runSweep(): Promise<Response> {
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const now = new Date();

  const { data: due, error: fetchError } = await admin
    .from("scheduled_communications")
    .select("id, tenant_id, entity_type, entity_id, trigger_key, channel, recipient_phone_or_email, cc_emails, bcc_emails, rendered_subject, rendered_body, scheduled_for")
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

  // Cache tenant lookups within this sweep - many due rows typically belong
  // to the same handful of tenants.
  const tenantCache = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    let tenant = tenantCache.get(row.tenant_id);
    if (!tenant) {
      const { data } = await admin.from("tenants").select("*").eq("id", row.tenant_id).single();
      tenant = data ?? {};
      tenantCache.set(row.tenant_id, tenant);
    }

    const { outcome } = await dispatchOne(admin, row, tenant, now, false);
    if (outcome === "sent") sent++;
    else if (outcome === "deferred") deferred++;
    else failed++;
  }

  return json({ ok: true, processed: rows.length, sent, deferred, failed });
}

// Immediate single-row dispatch - see the file header comment. Any
// signed-in user can call this (not just admins), since a technician is
// exactly who taps "On The Way" - the row is scoped to their own
// tenant_id, looked up from their own profile, so there's no way to
// dispatch another tenant's queued message this way.
async function dispatchNow(req: Request, authHeader: string): Promise<Response> {
  let body: { id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (!body.id) return json({ error: "bad_request" }, 400);

  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: authData, error: authError } = await callerClient.auth.getUser();
  if (authError || !authData.user) return json({ error: "unauthorized" }, 401);

  const { data: callerProfile } = await callerClient
    .from("profiles")
    .select("tenant_id")
    .eq("id", authData.user.id)
    .single();
  if (!callerProfile) return json({ error: "unauthorized" }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: row } = await admin
    .from("scheduled_communications")
    .select("id, tenant_id, entity_type, entity_id, trigger_key, channel, recipient_phone_or_email, cc_emails, bcc_emails, rendered_subject, rendered_body, scheduled_for")
    .eq("id", body.id)
    .eq("tenant_id", callerProfile.tenant_id)
    .eq("status", "pending")
    .maybeSingle();
  if (!row) return json({ error: "not_found" }, 404);

  const { data: tenant } = await admin.from("tenants").select("*").eq("id", row.tenant_id).single();
  const { outcome } = await dispatchOne(admin, row as ScheduledCommunicationRow, tenant ?? {}, new Date(), true);
  return json({ ok: true, outcome });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: new Headers(CORS_HEADERS) });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) return runSweep();
  if (authHeader.startsWith("Bearer ") && req.method === "POST") return dispatchNow(req, authHeader);
  return json({ error: "unauthorized" }, 401);
});
