// Channels - Twilio's inbound SMS webhook. A tenant buys/ports a phone
// number in the platform's Twilio account and pastes it (E.164) into
// Company Settings as tenants.sms_phone_number; Twilio POSTs every SMS
// sent to that number here.
//
// Request shape is Twilio's stable, long-documented inbound-message
// webhook: application/x-www-form-urlencoded body (From/To/Body/
// MessageSid/NumMedia/MediaUrl{n}/MediaContentType{n}), signed via the
// X-Twilio-Signature header - HMAC-SHA1 of the exact webhook URL with
// every POST param's key+value appended directly (keys sorted
// alphabetically, no separator), keyed with the Auth Token, base64-
// encoded. This is a stable, unchanged-for-years part of Twilio's API
// (unlike Resend's inbound shape, this didn't need a live round-trip to
// confirm), but FUNCTION_URL below MUST exactly match what's configured
// as this number's webhook URL in the Twilio console - see docs/SETUP.md.
//
// Edge Functions are self-contained (can't import another function's
// code), so the E.164 normaliser here is a deliberate duplicate of
// packages/shared/src/channels.ts's toE164 - same logic, kept in sync by
// hand if it ever changes, same tradeoff every other function in this
// repo already makes.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";

const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/twilio-sms-webhook`;
const MEDIA_BUCKET = "channel-media";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Twilio always sends SMS From/To already in E.164 - this only exists for
// normalising a tenant's clients.phone column (free text, not validated
// anywhere today) well enough to auto-match an inbound sender to an
// existing client. Keep in sync with packages/shared/src/channels.ts's
// toE164 - see this file's own top comment on why it's duplicated here.
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

async function verifyTwilioSignature(params: URLSearchParams, signature: string | null): Promise<boolean> {
  if (!signature || !TWILIO_AUTH_TOKEN) return false;
  // Not handling repeated param keys per Twilio's edge-case spec - no
  // standard inbound SMS field is ever sent more than once.
  const sortedKeys = [...params.keys()].sort();
  let data = FUNCTION_URL;
  for (const key of sortedKeys) data += key + (params.get(key) ?? "");

  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(TWILIO_AUTH_TOKEN), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sigBytes = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));
  return expected === signature;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "application/pdf": "pdf",
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: "server_error" }, 500);

  const rawBody = await req.text();
  const params = new URLSearchParams(rawBody);
  const signatureHeader = req.headers.get("x-twilio-signature");

  // Logged unconditionally while signature verification is still being
  // confirmed against a live Twilio request - a failure here previously
  // returned 401 with nothing logged, making it indistinguishable from
  // "never called" in Supabase's own logs. See docs/SETUP.md's Channels
  // section for what to check if `valid` comes back false.
  console.log("[twilio-sms-webhook] received request", { functionUrl: FUNCTION_URL, hasSignatureHeader: !!signatureHeader, rawBody });

  const valid = await verifyTwilioSignature(params, signatureHeader);
  console.log("[twilio-sms-webhook] signature check", { valid });
  if (!valid) return json({ error: "invalid_signature" }, 401);

  const from = params.get("From");
  const to = params.get("To");
  const body = params.get("Body");
  const messageSid = params.get("MessageSid");
  if (!from || !to) return json({ ok: true, skipped: "missing_from_or_to" });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: tenant, error: tenantError } = await admin.from("tenants").select("id").eq("sms_phone_number", to).maybeSingle();
  if (tenantError) {
    console.error("[twilio-sms-webhook] Failed to look up tenant", tenantError);
    return json({ error: "server_error" }, 500);
  }
  if (!tenant) {
    // No matching tenant - still 200 (Twilio's own reasonable-response
    // contract) so it doesn't retry-storm a number that will never match.
    return json({ ok: true, skipped: "unknown_recipient" });
  }

  const { data: existingConversation, error: fetchConvoError } = await admin
    .from("channel_conversations")
    .select("id, unread_count")
    .eq("tenant_id", tenant.id)
    .eq("channel_type", "sms")
    .eq("external_contact", from)
    .maybeSingle();
  if (fetchConvoError) {
    console.error("[twilio-sms-webhook] Failed to look up conversation", fetchConvoError);
    return json({ error: "server_error" }, 500);
  }

  const preview = (body ?? "").slice(0, 200) || (params.get("NumMedia") !== "0" ? "(attachment)" : null);
  let conversationId: string;

  if (existingConversation) {
    conversationId = existingConversation.id;
    const { error: updateError } = await admin
      .from("channel_conversations")
      .update({ last_message_at: new Date().toISOString(), last_message_preview: preview, unread_count: existingConversation.unread_count + 1 })
      .eq("id", conversationId);
    if (updateError) console.error("[twilio-sms-webhook] Failed to update conversation", updateError);
  } else {
    // First message from this number - try to auto-link an existing
    // client by phone, normalising both sides (clients.phone is free text,
    // never validated as E.164 anywhere in the app today).
    const { data: clients } = await admin.from("clients").select("id, phone").eq("tenant_id", tenant.id).not("phone", "is", null);
    const matches = (clients ?? []).filter((c) => c.phone && toE164(c.phone) === from);
    const clientId = matches.length === 1 ? matches[0]!.id : null;

    const { data: newConversation, error: insertConvoError } = await admin
      .from("channel_conversations")
      .insert({
        tenant_id: tenant.id,
        channel_type: "sms",
        external_contact: from,
        client_id: clientId,
        last_message_at: new Date().toISOString(),
        last_message_preview: preview,
        unread_count: 1,
      })
      .select("id")
      .single();
    if (insertConvoError || !newConversation) {
      console.error("[twilio-sms-webhook] Failed to create conversation", insertConvoError);
      return json({ error: "server_error" }, 500);
    }
    conversationId = newConversation.id;
  }

  const numMedia = parseInt(params.get("NumMedia") ?? "0", 10) || 0;
  const media: { storage_path: string; file_name: string; mime_type: string | null }[] = [];
  for (let i = 0; i < numMedia; i++) {
    const mediaUrl = params.get(`MediaUrl${i}`);
    const contentType = params.get(`MediaContentType${i}`);
    if (!mediaUrl) continue;
    try {
      const basicAuth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
      const mediaRes = await fetch(mediaUrl, { headers: { Authorization: `Basic ${basicAuth}` } });
      if (!mediaRes.ok) throw new Error(`Twilio media fetch failed: ${mediaRes.status}`);
      const bytes = new Uint8Array(await mediaRes.arrayBuffer());
      const extension = (contentType && EXTENSION_BY_MIME[contentType]) || "bin";
      const fileName = `media-${i}.${extension}`;
      const storagePath = `${tenant.id}/${conversationId}/${crypto.randomUUID()}-${fileName}`;
      const { error: uploadError } = await admin.storage.from(MEDIA_BUCKET).upload(storagePath, bytes, { contentType: contentType ?? undefined });
      if (uploadError) throw uploadError;
      media.push({ storage_path: storagePath, file_name: fileName, mime_type: contentType });
    } catch (e) {
      console.error("[twilio-sms-webhook] Failed to store media", mediaUrl, e);
    }
  }

  const { error: messageError } = await admin.from("channel_messages").insert({
    conversation_id: conversationId,
    tenant_id: tenant.id,
    direction: "inbound",
    body,
    media,
    external_message_id: messageSid,
    status: "received",
  });
  if (messageError) {
    console.error("[twilio-sms-webhook] Failed to insert message", messageError);
    return json({ error: "server_error" }, 500);
  }

  return json({ ok: true, conversation_id: conversationId });
});
