// Channels - Twilio's inbound WhatsApp webhook. Same Twilio Messages
// platform as SMS (see twilio-sms-webhook's own comment on the request
// shape/signature verification, unchanged here), except WhatsApp numbers
// arrive prefixed "whatsapp:+61..." - stripped before storing/matching so
// channel_conversations.external_contact stays a plain E.164 number, same
// format SMS already uses (keeps the auto-client-match-by-phone logic
// identical either way).
//
// A tenant's WhatsApp sender is a Twilio Sandbox number for early testing
// (no Meta Business verification needed to try this end to end) or a
// permanent Business-verified sender once approved - either way, pasted
// into Company Settings as tenants.whatsapp_phone_number and configured in
// the Twilio console as this number's "WHEN A MESSAGE COMES IN" webhook.
// See docs/SETUP.md's Channels section for the full setup.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";

const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/twilio-whatsapp-webhook`;
const MEDIA_BUCKET = "channel-media";
const WHATSAPP_PREFIX = "whatsapp:";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stripWhatsappPrefix(value: string): string {
  return value.startsWith(WHATSAPP_PREFIX) ? value.slice(WHATSAPP_PREFIX.length) : value;
}

// Deliberate duplicate of packages/shared/src/channels.ts's toE164 - see
// twilio-sms-webhook's own comment on why (Edge Functions are self-
// contained, can't import another function's code).
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

// Same algorithm as twilio-sms-webhook's own verifyTwilioSignature -
// Twilio signs the raw POST params (including the "whatsapp:" prefix
// exactly as sent) against this function's own URL, so this is unchanged
// from the SMS version other than FUNCTION_URL.
async function verifyTwilioSignature(params: URLSearchParams, signature: string | null): Promise<boolean> {
  if (!signature || !TWILIO_AUTH_TOKEN) return false;
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
  console.log("[twilio-whatsapp-webhook] received request", { functionUrl: FUNCTION_URL, hasSignatureHeader: !!signatureHeader, rawBody });

  const valid = await verifyTwilioSignature(params, signatureHeader);
  console.log("[twilio-whatsapp-webhook] signature check", { valid });
  if (!valid) return json({ error: "invalid_signature" }, 401);

  const fromRaw = params.get("From");
  const toRaw = params.get("To");
  const body = params.get("Body");
  const messageSid = params.get("MessageSid");
  // The WhatsApp account's own display name, when set - not present on
  // plain SMS, worth capturing as a nicer default than a bare number.
  const profileName = params.get("ProfileName");
  if (!fromRaw || !toRaw) return json({ ok: true, skipped: "missing_from_or_to" });

  const from = stripWhatsappPrefix(fromRaw);
  const to = stripWhatsappPrefix(toRaw);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: tenant, error: tenantError } = await admin.from("tenants").select("id").eq("whatsapp_phone_number", to).maybeSingle();
  if (tenantError) {
    console.error("[twilio-whatsapp-webhook] Failed to look up tenant", tenantError);
    return json({ error: "server_error" }, 500);
  }
  if (!tenant) {
    return json({ ok: true, skipped: "unknown_recipient" });
  }

  const { data: existingConversation, error: fetchConvoError } = await admin
    .from("channel_conversations")
    .select("id, unread_count")
    .eq("tenant_id", tenant.id)
    .eq("channel_type", "whatsapp")
    .eq("external_contact", from)
    .maybeSingle();
  if (fetchConvoError) {
    console.error("[twilio-whatsapp-webhook] Failed to look up conversation", fetchConvoError);
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
    if (updateError) console.error("[twilio-whatsapp-webhook] Failed to update conversation", updateError);
  } else {
    const { data: clients } = await admin.from("clients").select("id, phone").eq("tenant_id", tenant.id).not("phone", "is", null);
    const matches = (clients ?? []).filter((c) => c.phone && toE164(c.phone) === from);
    const clientId = matches.length === 1 ? matches[0]!.id : null;

    const { data: newConversation, error: insertConvoError } = await admin
      .from("channel_conversations")
      .insert({
        tenant_id: tenant.id,
        channel_type: "whatsapp",
        external_contact: from,
        contact_name: profileName,
        client_id: clientId,
        last_message_at: new Date().toISOString(),
        last_message_preview: preview,
        unread_count: 1,
      })
      .select("id")
      .single();
    if (insertConvoError || !newConversation) {
      console.error("[twilio-whatsapp-webhook] Failed to create conversation", insertConvoError);
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
      console.error("[twilio-whatsapp-webhook] Failed to store media", mediaUrl, e);
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
    console.error("[twilio-whatsapp-webhook] Failed to insert message", messageError);
    return json({ error: "server_error" }, 500);
  }

  return json({ ok: true, conversation_id: conversationId });
});
