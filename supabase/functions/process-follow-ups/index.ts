// Sends the follow-up sequences' texts (see the follow_up_sequences
// migration). Each run claims the steps that are due with follow_up_claim -
// which has already applied the stop rules (reply, booked, STOP), the
// 8:30am-6pm window and lateness - sends them through Twilio from the
// company's SMS number, logs each text in Channels so replies thread with
// it, and reports back with follow_up_record.
//
// Called by:
//   * the schedule, every 5 minutes (service role key, {} or {"action":"sweep"}),
//     which first queues any asset service / replacement reminders now due;
//   * checklist-signup, to send a sign-up's first text straight away
//     (service role key, {"enrolment_id"});
//   * the desktop Follow-ups page (signed-in admin):
//       {"enrolment_id", "force": true}  "Send next now" on a test run
//       {"action": "sweep"}              after pressing the storm button
//
// Deployed with --no-verify-jwt: the schedule calls it with the service role
// key, and admin calls are checked here.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const TWILIO_API_BASE = Deno.env.get("TWILIO_API_BASE") ?? "https://api.twilio.com";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") ?? "";
const RESEND_API_BASE = Deno.env.get("RESEND_API_BASE") ?? "https://api.resend.com";
const STATUS_CALLBACK_URL = `${SUPABASE_URL}/functions/v1/twilio-status-callback`;
const UNSUBSCRIBE_URL = `${SUPABASE_URL}/functions/v1/checklist-signup`;

const BATCH = 50;
// Stop starting new batches after this long, so a big storm send finishes
// over a few runs instead of timing out half way.
const TIME_BUDGET_MS = 45_000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS } });
}

interface Claimed {
  enrolment_id: string;
  tenant_id: string;
  client_id: string | null;
  position: number;
  phone: string;
  from: string | null;
  body: string;
  email: string | null;
  email_subject: string | null;
  email_from_name: string | null;
  is_test: boolean;
  sequence: string;
}

interface Result {
  channel: "sms" | "email";
  recipient: string;
  body: string;
  status: "sent" | "failed";
  detail?: string;
  external_id?: string;
  opted_out?: boolean;
}

async function sendSms(from: string, to: string, body: string): Promise<{ sid: string } | { error: string; optedOut: boolean }> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return { error: "Twilio isn't set up (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)", optedOut: false };
  const res = await fetch(`${TWILIO_API_BASE}/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: from, Body: body, StatusCallback: STATUS_CALLBACK_URL }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 21610: the number has texted STOP to this sender.
    return { error: `Twilio ${data?.code ?? res.status}: ${data?.message ?? "send failed"}`, optedOut: data?.code === 21610 };
  }
  return { sid: data.sid };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// "Elyas <hello@example.com>" from the configured sender address.
function fromWithName(name: string | null): string {
  const address = RESEND_FROM_EMAIL.match(/<([^>]+)>/)?.[1] ?? RESEND_FROM_EMAIL.trim();
  const display = (name ?? "").replace(/[<>"]/g, "").trim();
  return display ? `${display} <${address}>` : RESEND_FROM_EMAIL;
}

async function sendEmail(item: Claimed): Promise<Result> {
  const to = item.email!;
  // The text's own opt-out line is for texts; an email gets a link.
  const text = item.body.replace(/\s*Reply STOP to opt out\.?\s*$/i, "").trim();
  const unsubscribe = `${UNSUBSCRIBE_URL}?unsubscribe=${item.enrolment_id}`;
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) return { channel: "email", recipient: to, body: text, status: "failed", detail: "Email isn't set up (RESEND_API_KEY / RESEND_FROM_EMAIL)" };
  const linked = escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  const res = await fetch(`${RESEND_API_BASE}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: fromWithName(item.email_from_name),
      to: [to],
      subject: item.email_subject || "Your checklist",
      text: `${text}\n\nDon't want these emails? Unsubscribe: ${unsubscribe}`,
      html: `<p>${linked}</p><p style="color:#6b7280;font-size:12px">Don't want these emails? <a href="${unsubscribe}">Unsubscribe</a>.</p>`,
      headers: { "List-Unsubscribe": `<${unsubscribe}>` },
    }),
  });
  if (!res.ok) return { channel: "email", recipient: to, body: text, status: "failed", detail: `Resend ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const data = await res.json().catch(() => ({}));
  return { channel: "email", recipient: to, body: text, status: "sent", external_id: data?.id };
}

// Puts the text in the Channels thread for that number, so their reply
// lands under it.
async function logInChannels(admin: SupabaseClient, item: Claimed, sid: string) {
  const at = new Date().toISOString();
  const preview = item.body.slice(0, 200);
  const { data: existing } = await admin
    .from("channel_conversations")
    .select("id")
    .eq("tenant_id", item.tenant_id)
    .eq("channel_type", "sms")
    .eq("external_contact", item.phone)
    .maybeSingle();
  let conversationId = existing?.id as string | undefined;
  if (conversationId) {
    await admin.from("channel_conversations").update({ last_message_at: at, last_message_preview: preview }).eq("id", conversationId);
  } else {
    const { data: created } = await admin
      .from("channel_conversations")
      .insert({ tenant_id: item.tenant_id, channel_type: "sms", external_contact: item.phone, client_id: item.client_id, last_message_at: at, last_message_preview: preview })
      .select("id")
      .single();
    conversationId = created?.id;
  }
  if (conversationId) {
    await admin.from("channel_messages").insert({
      conversation_id: conversationId,
      tenant_id: item.tenant_id,
      direction: "outbound",
      body: item.body,
      external_message_id: sid,
      status: "sent",
      created_at: at,
    });
  }
}

async function sendOne(admin: SupabaseClient, item: Claimed): Promise<Result[]> {
  const results: Result[] = [];
  if (!item.from) {
    results.push({ channel: "sms", recipient: item.phone, body: item.body, status: "failed", detail: "No SMS number set in Company Settings" });
  } else {
    const sms = await sendSms(item.from, item.phone, item.body);
    if ("sid" in sms) {
      results.push({ channel: "sms", recipient: item.phone, body: item.body, status: "sent", external_id: sms.sid });
      try {
        await logInChannels(admin, item, sms.sid);
      } catch (e) {
        console.error("[process-follow-ups] couldn't log the text in Channels", e);
      }
    } else {
      results.push({ channel: "sms", recipient: item.phone, body: item.body, status: "failed", detail: sms.error, opted_out: sms.optedOut });
    }
  }
  if (item.email) {
    try {
      results.push(await sendEmail(item));
    } catch (e) {
      results.push({ channel: "email", recipient: item.email, body: item.body, status: "failed", detail: String(e).slice(0, 200) });
    }
  }
  return results;
}

async function run(admin: SupabaseClient, opts: { enrolmentId?: string; force?: boolean }) {
  const started = Date.now();
  let sent = 0;
  let failed = 0;
  let claimed = 0;
  do {
    const { data, error } = await admin.rpc("follow_up_claim", {
      p_limit: opts.enrolmentId ? 1 : BATCH,
      p_enrolment_id: opts.enrolmentId ?? null,
      p_force: !!opts.force,
    });
    if (error) throw error;
    const items = (data ?? []) as Claimed[];
    if (items.length === 0) break;
    claimed += items.length;
    for (const item of items) {
      const results = await sendOne(admin, item);
      if (results.some((r) => r.channel === "sms" && r.status === "sent")) sent++;
      else failed++;
      const { error: recordError } = await admin.rpc("follow_up_record", { p_enrolment_id: item.enrolment_id, p_position: item.position, p_results: results });
      if (recordError) console.error("[process-follow-ups] couldn't record the result", item.enrolment_id, recordError);
    }
    if (opts.enrolmentId || items.length < BATCH) break;
  } while (Date.now() - started < TIME_BUDGET_MS);
  return { claimed, sent, failed };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: "server_error" }, 500);

  const body = (await req.json().catch(() => ({}))) as { enrolment_id?: string; force?: boolean; action?: string };
  const authHeader = req.headers.get("Authorization") ?? "";
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (authHeader === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) {
      // The scheduled run also queues asset service / replacement reminders
      // that have come due (asset_register migration). Only on the
      // schedule's sweep, not a single sign-up's first text.
      let reminders: unknown = null;
      if (!body.enrolment_id) {
        const { data, error } = await admin.rpc("asset_reminders_enrol");
        if (error) console.error("[process-follow-ups] asset reminders failed", error);
        reminders = data;
      }
      return json({ ok: true, reminders, ...(await run(admin, { enrolmentId: body.enrolment_id })) });
    }

    // A signed-in admin.
    if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: auth } = await caller.auth.getUser();
    if (!auth?.user) return json({ error: "unauthorized" }, 401);
    const { data: profile } = await admin.from("profiles").select("tenant_id, role").eq("id", auth.user.id).single();
    if (!profile || profile.role !== "admin") return json({ error: "forbidden" }, 403);

    if (body.enrolment_id) {
      const { data: enrolment } = await admin.from("follow_up_enrolments").select("tenant_id, is_test").eq("id", body.enrolment_id).maybeSingle();
      if (!enrolment || enrolment.tenant_id !== profile.tenant_id) return json({ error: "not_found" }, 404);
      // Only a test run can skip the wait and the send window.
      return json({ ok: true, ...(await run(admin, { enrolmentId: body.enrolment_id, force: !!body.force && enrolment.is_test })) });
    }
    return json({ ok: true, ...(await run(admin, {})) });
  } catch (e) {
    console.error("[process-follow-ups] run failed", e);
    return json({ error: "server_error", detail: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  }
});
