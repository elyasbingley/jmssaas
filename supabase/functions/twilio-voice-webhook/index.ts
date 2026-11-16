// Missed-call text-back - Twilio's inbound Voice webhook. A tenant sets
// their mobile's carrier-side "no answer" call forwarding (not something
// this function or Twilio config can do - see docs/SETUP.md) to their
// existing Twilio number; this function is that number's Voice webhook,
// answering every call that reaches it (which, with forwarding set up
// correctly, only ever happens when the mobile didn't pick up).
//
// Two different requests hit this same URL, told apart by whether
// RecordingUrl is present:
// 1. The initial call (no RecordingUrl yet) - logs the missed call as a
//    lead (find-or-create client + a new job_cards row), texts the
//    caller back immediately, records it all as a channel_messages
//    thread (channel_type 'missed_call', same per-phone-number
//    conversation model Channels already uses for SMS/WhatsApp), then
//    responds with TwiML: play the tenant's own greeting (or a
//    text-to-speech fallback), then record a message.
// 2. Twilio's own recording-complete callback (has RecordingUrl) -
//    downloads the recording, stores it, and attaches it to the same
//    channel_messages row the initial hit already created (matched by
//    external_message_id = CallSid, not a fresh insert - one call, one
//    thread entry, whether or not a message was actually left).
//
// Same signature-verification/E.164 patterns as twilio-sms-webhook -
// duplicated rather than shared, same reason that file's own comment
// gives (Edge Functions can't import another function's code).

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";

const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/twilio-voice-webhook`;
const SEND_NOTIFICATION_URL = `${SUPABASE_URL}/functions/v1/send-notification`;
const STATUS_CALLBACK_URL = `${SUPABASE_URL}/functions/v1/twilio-status-callback`;
const MEDIA_BUCKET = "channel-media";

function xml(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/xml" } });
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Same E.164 normaliser as twilio-sms-webhook/channel-send-message's own
// toE164 - kept in sync by hand if it ever changes, same as those.
function toE164(rawPhone: string): string | null {
  const trimmed = rawPhone.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) return null;
    return `+${digits}`;
  }
  const digitsOnly = trimmed.replace(/\D/g, "");
  if (!digitsOnly) return null;
  if (digitsOnly.startsWith("0") && digitsOnly.length === 10) return `+61${digitsOnly.slice(1)}`;
  if (digitsOnly.startsWith("61") && digitsOnly.length === 11) return `+${digitsOnly}`;
  return null;
}

async function verifyTwilioSignature(url: string, params: URLSearchParams, signature: string | null): Promise<boolean> {
  if (!signature || !TWILIO_AUTH_TOKEN) return false;
  const sortedKeys = [...params.keys()].sort();
  let data = url;
  for (const key of sortedKeys) data += key + (params.get(key) ?? "");
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(TWILIO_AUTH_TOKEN), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sigBytes = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));
  return expected === signature;
}

async function sendSms(from: string, to: string, body: string): Promise<string | null> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  const basicAuth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const form = new URLSearchParams({ To: to, From: from, Body: body, StatusCallback: STATUS_CALLBACK_URL });
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const responseBody = await res.json();
    if (!res.ok) {
      console.error("[twilio-voice-webhook] SMS auto-reply failed", res.status, responseBody);
      return null;
    }
    return responseBody.sid;
  } catch (e) {
    console.error("[twilio-voice-webhook] SMS auto-reply threw", e);
    return null;
  }
}

async function notifyMissedCall(tenantId: string, conversationId: string, fromDisplay: string): Promise<void> {
  try {
    const res = await fetch(SEND_NOTIFICATION_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
      // type: "channel_message" (not a new type) - a missed-call thread
      // IS a channel_message conversation, so this already routes a tap
      // straight to it, same as any other new-message notification.
      body: JSON.stringify({
        tenant_id: tenantId,
        type: "channel_message",
        title: "Missed call",
        body: `Missed call from ${fromDisplay} - auto-reply sent`,
        data: { conversation_id: conversationId },
      }),
    });
    if (!res.ok) console.error("[twilio-voice-webhook] send-notification call failed", res.status, await res.text());
  } catch (e) {
    console.error("[twilio-voice-webhook] send-notification call threw", e);
  }
}

// A caller is never already a "client" from a phone call alone - creates
// one, named after their own number, the moment nothing matches. Same
// placeholder-name convention as a quick-add contact anywhere else in
// this app: visible at a glance as a placeholder, renamed by the admin
// once they know who it actually was.
async function findOrCreateClient(admin: ReturnType<typeof createClient>, tenantId: string, phone: string): Promise<string> {
  const { data: clients } = await admin.from("clients").select("id, phone").eq("tenant_id", tenantId).not("phone", "is", null);
  const match = (clients ?? []).find((c: { phone: string | null }) => c.phone && toE164(c.phone) === phone);
  if (match) return match.id;
  const { data: created, error } = await admin
    .from("clients")
    .insert({ tenant_id: tenantId, name: phone, client_type: "individual", phone })
    .select("id")
    .single();
  if (error || !created) throw new Error(`Failed to create client: ${error?.message}`);
  return created.id;
}

async function findOrCreateMissedCallLeadSource(admin: ReturnType<typeof createClient>, tenantId: string): Promise<string> {
  const { data: existing } = await admin.from("lead_sources").select("id").eq("tenant_id", tenantId).eq("name", "Missed call").maybeSingle();
  if (existing) return existing.id;
  const { data: created, error } = await admin
    .from("lead_sources")
    .insert({ tenant_id: tenantId, name: "Missed call", sort_order: 98 })
    .select("id")
    .single();
  if (error || !created) throw new Error(`Failed to create lead source: ${error?.message}`);
  return created.id;
}

// Repeat missed calls from the same number (common - a client calling back
// 2-3 times in a row) used to each insert their own job_cards row, spamming
// the Jobs list with duplicate "Missed call" leads for one real enquiry.
// Now: only create a new lead if this client doesn't already have one
// still sitting untouched - "untouched" meaning still at the tenant's
// first-position lifecycle stage, the one default_job_lifecycle_stage
// puts every new job in (job_cards.status no longer exists - see the
// job_status_lifecycle_consolidation migration). Once staff moves it to
// any later stage, the next missed call starts a fresh lead again. A
// repeat call while one's still open just appends a note to the existing
// job instead of creating a sibling.
async function findOpenMissedCallJob(
  admin: ReturnType<typeof createClient>,
  tenantId: string,
  clientId: string,
  leadSourceId: string
): Promise<{ id: string; description: string | null } | null> {
  const { data: firstStage, error: stageError } = await admin
    .from("job_lifecycle_stages")
    .select("id")
    .eq("tenant_id", tenantId)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (stageError) console.error("[twilio-voice-webhook] Failed to look up first lifecycle stage", stageError);
  if (!firstStage) return null;

  const { data, error } = await admin
    .from("job_cards")
    .select("id, description")
    .eq("tenant_id", tenantId)
    .eq("client_id", clientId)
    .eq("lead_source_id", leadSourceId)
    .eq("lifecycle_stage_id", firstStage.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) console.error("[twilio-voice-webhook] Failed to look up open missed-call lead", error);
  return data ?? null;
}

async function findOrCreateConversation(
  admin: ReturnType<typeof createClient>,
  tenantId: string,
  from: string,
  clientId: string
): Promise<{ id: string }> {
  const { data: existing } = await admin
    .from("channel_conversations")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("channel_type", "missed_call")
    .eq("external_contact", from)
    .maybeSingle();
  if (existing) return existing;
  const { data: created, error } = await admin
    .from("channel_conversations")
    .insert({ tenant_id: tenantId, channel_type: "missed_call", external_contact: from, client_id: clientId, last_message_at: new Date().toISOString() })
    .select("id")
    .single();
  if (error || !created) throw new Error(`Failed to create conversation: ${error?.message}`);
  return created;
}

async function handleIncomingCall(admin: ReturnType<typeof createClient>, params: URLSearchParams): Promise<Response> {
  const fromRaw = params.get("From");
  const to = params.get("To");
  const callSid = params.get("CallSid");
  if (!fromRaw || !to || !callSid) return xml("<Response><Reject/></Response>");
  const from = toE164(fromRaw) ?? fromRaw;

  const { data: tenant, error: tenantError } = await admin
    .from("tenants")
    .select("id, name, sms_phone_number, voicemail_greeting_url, missed_call_reply_template, missed_call_excluded_numbers")
    .eq("sms_phone_number", to)
    .maybeSingle();
  if (tenantError) {
    console.error("[twilio-voice-webhook] Failed to look up tenant", tenantError);
    return xml("<Response><Say>Sorry, something went wrong.</Say><Hangup/></Response>", 500);
  }
  if (!tenant) return xml("<Response><Reject/></Response>");

  const isExcluded = (tenant.missed_call_excluded_numbers ?? []).includes(from);

  try {
    const clientId = await findOrCreateClient(admin, tenant.id, from);

    // Friends/family on the exclude list still get the voicemail saved
    // and the auto-text sent below, same as anyone else - just no
    // client+job_cards lead created for them.
    if (!isExcluded) {
      const leadSourceId = await findOrCreateMissedCallLeadSource(admin, tenant.id);
      const nowDisplay = new Date().toLocaleString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

      const openJob = await findOpenMissedCallJob(admin, tenant.id, clientId, leadSourceId);
      if (openJob) {
        const { error: touchError } = await admin
          .from("job_cards")
          .update({ description: `${(openJob.description ?? "").trim()}\nCalled again at ${nowDisplay}.`.trim() })
          .eq("id", openJob.id);
        if (touchError) console.error("[twilio-voice-webhook] Failed to update existing missed-call lead", touchError);
      } else {
        const { error: jobError } = await admin.from("job_cards").insert({
          tenant_id: tenant.id,
          client_id: clientId,
          title: `Missed call - ${new Date().toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" })}`,
          description: `Missed call from ${from}. Auto text-back sent; check Channels for any voicemail left.`,
          lead_source_id: leadSourceId,
        });
        if (jobError) console.error("[twilio-voice-webhook] Failed to log missed-call lead", jobError);
      }
    }

    const conversation = await findOrCreateConversation(admin, tenant.id, from, clientId);

    const { data: inboundMessage, error: inboundError } = await admin
      .from("channel_messages")
      .insert({
        conversation_id: conversation.id,
        tenant_id: tenant.id,
        direction: "inbound",
        body: "📞 Missed call",
        external_message_id: callSid,
        status: "received",
      })
      .select("id")
      .single();
    if (inboundError) console.error("[twilio-voice-webhook] Failed to record missed-call message", inboundError);

    const replyText = tenant.missed_call_reply_template;
    const smsSid = await sendSms(tenant.sms_phone_number, from, replyText);
    if (smsSid) {
      await admin.from("channel_messages").insert({
        conversation_id: conversation.id,
        tenant_id: tenant.id,
        direction: "outbound",
        body: replyText,
        external_message_id: smsSid,
        status: "sent",
      });
    }

    await admin
      .from("channel_conversations")
      .update({ last_message_at: new Date().toISOString(), last_message_preview: smsSid ? replyText.slice(0, 200) : "📞 Missed call" })
      .eq("id", conversation.id);

    await notifyMissedCall(tenant.id, conversation.id, from);

    console.log("[twilio-voice-webhook] Logged missed call", { tenantId: tenant.id, from, callSid, inboundMessageId: inboundMessage?.id, smsSent: !!smsSid });
  } catch (e) {
    // Never let a logging/SMS failure stop the caller from at least
    // hearing the greeting and being able to leave a message - the call
    // itself is the thing that must not just hang up silently.
    console.error("[twilio-voice-webhook] Failed to log missed call", e);
  }

  const greeting = tenant.voicemail_greeting_url
    ? `<Play>${escapeXml(tenant.voicemail_greeting_url)}</Play>`
    : `<Say>Hi, you've reached ${escapeXml(tenant.name)}. We can't take your call right now. Please leave a message after the tone.</Say>`;

  return xml(
    `<Response>${greeting}<Record action="${escapeXml(FUNCTION_URL)}" method="POST" maxLength="120" timeout="5" playBeep="true" trim="trim-silence"/><Say>We didn't receive a message. Goodbye.</Say></Response>`
  );
}

async function handleRecordingComplete(admin: ReturnType<typeof createClient>, params: URLSearchParams): Promise<Response> {
  const to = params.get("To");
  const callSid = params.get("CallSid");
  const recordingUrl = params.get("RecordingUrl");
  if (!to || !callSid || !recordingUrl) return xml("<Response><Hangup/></Response>");

  const { data: tenant } = await admin.from("tenants").select("id").eq("sms_phone_number", to).maybeSingle();
  if (!tenant) return xml("<Response><Hangup/></Response>");

  try {
    const basicAuth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
    const recordingRes = await fetch(`${recordingUrl}.mp3`, { headers: { Authorization: `Basic ${basicAuth}` } });
    if (!recordingRes.ok) throw new Error(`Recording fetch failed: ${recordingRes.status}`);
    const bytes = new Uint8Array(await recordingRes.arrayBuffer());

    const { data: message } = await admin
      .from("channel_messages")
      .select("id, conversation_id")
      .eq("tenant_id", tenant.id)
      .eq("external_message_id", callSid)
      .maybeSingle();
    if (!message) {
      console.error("[twilio-voice-webhook] No matching message for recording callback", callSid);
      return xml("<Response><Hangup/></Response>");
    }

    const storagePath = `${tenant.id}/${message.conversation_id}/${crypto.randomUUID()}-voicemail.mp3`;
    const { error: uploadError } = await admin.storage.from(MEDIA_BUCKET).upload(storagePath, bytes, { contentType: "audio/mpeg" });
    if (uploadError) throw uploadError;

    await admin
      .from("channel_messages")
      .update({ body: "🎙️ Voicemail message", media: [{ storage_path: storagePath, file_name: "voicemail.mp3", mime_type: "audio/mpeg" }] })
      .eq("id", message.id);
    await admin
      .from("channel_conversations")
      .update({ last_message_at: new Date().toISOString(), last_message_preview: "🎙️ Voicemail message" })
      .eq("id", message.conversation_id);
  } catch (e) {
    console.error("[twilio-voice-webhook] Failed to store voicemail recording", e);
  }

  return xml("<Response><Hangup/></Response>");
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return xml("<Response/>", 405);
  if (!SUPABASE_SERVICE_ROLE_KEY) return xml("<Response><Say>Server not configured.</Say><Hangup/></Response>", 500);

  const rawBody = await req.text();
  const params = new URLSearchParams(rawBody);
  const signatureHeader = req.headers.get("x-twilio-signature");

  // Logged unconditionally while first confirmed live against a real
  // Twilio call, same reasoning as resend-inbound-webhook's own identical
  // comment - a signature failure otherwise looks indistinguishable from
  // "never called" in Supabase's own logs.
  console.log("[twilio-voice-webhook] received request", { hasSignatureHeader: !!signatureHeader, hasRecordingUrl: !!params.get("RecordingUrl"), rawBody });

  const valid = await verifyTwilioSignature(FUNCTION_URL, params, signatureHeader);
  if (!valid) return xml("<Response><Reject/></Response>", 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  if (params.get("RecordingUrl")) return handleRecordingComplete(admin, params);
  return handleIncomingCall(admin, params);
});
