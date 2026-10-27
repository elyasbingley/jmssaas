// Channels - Twilio's delivery/read-receipt webhook for outbound SMS/
// WhatsApp messages. Twilio calls this itself as each message progresses
// through queued -> sending -> sent -> delivered -> read (WhatsApp only,
// and only if the recipient's WhatsApp client reports it) or diverts to
// undelivered/failed at any point - channel-send-message and process-
// whatsapp-broadcast both set this function's own URL as `StatusCallback`
// on every Twilio send, so every outbound message's channel_messages row
// gets its status updated here as Twilio reports it, independent of
// whatever status was written at send time.
//
// Same request shape/signature verification as twilio-sms-webhook/twilio-
// whatsapp-webhook (Twilio POSTs application/x-www-form-urlencoded,
// HMAC-SHA1-signed over this exact URL + sorted params) - duplicated
// rather than imported for the same reason those two already document
// (Edge Functions are self-contained, can't import another function's
// code).

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";

const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/twilio-status-callback`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

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

// Twilio's own MessageStatus values, lowercased as Twilio sends them -
// channel_messages.status's check constraint (see the channel_message_
// delivery_status migration) accepts exactly this set plus 'received'
// (inbound-only, never reported here).
const KNOWN_STATUSES = new Set(["queued", "sending", "sent", "delivered", "read", "undelivered", "failed"]);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: "server_error" }, 500);

  const rawBody = await req.text();
  const params = new URLSearchParams(rawBody);
  const signatureHeader = req.headers.get("x-twilio-signature");

  const valid = await verifyTwilioSignature(params, signatureHeader);
  if (!valid) return json({ error: "invalid_signature" }, 401);

  const messageSid = params.get("MessageSid") ?? params.get("SmsSid");
  const messageStatus = (params.get("MessageStatus") ?? "").toLowerCase();
  if (!messageSid || !KNOWN_STATUSES.has(messageStatus)) {
    return json({ ok: true, skipped: "missing_or_unknown_status" });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // A status callback can arrive out of order (e.g. 'sent' after
  // 'delivered' already landed, on a retry) - only move forward through
  // the natural progression, never backward, so a late/duplicate 'sent'
  // can't clobber an already-recorded 'delivered'/'read'.
  const STATUS_RANK: Record<string, number> = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4, undelivered: 4, failed: 4 };
  const { data: existing } = await admin.from("channel_messages").select("id, status").eq("external_message_id", messageSid).maybeSingle();
  if (!existing) return json({ ok: true, skipped: "unknown_message" });
  if ((STATUS_RANK[existing.status] ?? 0) > (STATUS_RANK[messageStatus] ?? 0)) {
    return json({ ok: true, skipped: "stale_status" });
  }

  const { error: updateError } = await admin.from("channel_messages").update({ status: messageStatus }).eq("id", existing.id);
  if (updateError) {
    console.error("[twilio-status-callback] Failed to update message status", updateError);
    return json({ error: "server_error" }, 500);
  }

  return json({ ok: true });
});
