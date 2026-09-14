// Channels - sends an admin's reply out through the conversation's own
// channel and records it. Called from the app with the signed-in admin's
// own bearer token (same auth pattern as xero-oauth-start) rather than
// --no-verify-jwt, since - unlike the inbound webhooks - this is only ever
// invoked by a real app user, never by an external provider.
//
// SMS and WhatsApp both via Twilio's Messages API (WhatsApp is the same
// endpoint with a "whatsapp:" prefix on From/To). Messenger via Meta's
// Graph API Send API, using the tenant's own connected Page's access
// token (facebook_connections, set up via facebook-oauth-start/callback).
// Instagram still needs Meta App Review finished first before there's
// anywhere to actually send to; see docs/SETUP.md.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const GRAPH_API_VERSION = "v21.0";
const MEDIA_BUCKET = "channel-media";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: new Headers({ "Content-Type": "application/json", ...CORS_HEADERS }) });
}

// `viaWhatsapp` prefixes both numbers "whatsapp:" - the only difference
// between an SMS/MMS and a WhatsApp send through Twilio's Messages API.
// `mediaUrl`, when given, is the one attachment on this message - Twilio
// fetches it itself (same MediaUrl param name/behavior for MMS and
// WhatsApp), so it has to be a URL Twilio can reach with no auth of its
// own, hence the caller signs it first (see the handler below).
async function sendViaTwilio(params: { from: string; to: string; body?: string; mediaUrl?: string; viaWhatsapp: boolean }): Promise<{ sid: string } | { error: string }> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return { error: "twilio_not_configured" };
  const prefix = params.viaWhatsapp ? "whatsapp:" : "";
  const basicAuth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const form = new URLSearchParams({ To: `${prefix}${params.to}`, From: `${prefix}${params.from}` });
  if (params.body) form.set("Body", params.body);
  if (params.mediaUrl) form.set("MediaUrl", params.mediaUrl);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const responseBody = await res.json();
  if (!res.ok) {
    console.error("[channel-send-message] Twilio send failed", res.status, responseBody);
    return { error: responseBody?.message ?? "twilio_send_failed" };
  }
  return { sid: responseBody.sid };
}

// Meta's Send API takes one message content per call (text OR an
// attachment, never both) - unlike Twilio's single request with an
// optional MediaUrl. When a reply has both body and media, the caller
// below sends two requests and records both under the one channel_messages
// row it inserts; a failure on the second leaves the first already
// delivered (there is no atomic "send both" to fall back to here).
// `messaging_type: "RESPONSE"` is Meta's own required send-context tag -
// only valid within its own 24-hour window since the contact's last
// message (or with template approval most SaaS apps won't have set up),
// same real-world limitation WhatsApp's own session window already has.
async function sendViaMessenger(params: { pageAccessToken: string; recipientId: string; text?: string; media?: { url: string; mimeType: string | null } }): Promise<{ mid: string } | { error: string }> {
  let lastMid: string | undefined;
  if (params.text) {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(params.pageAccessToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: params.recipientId }, messaging_type: "RESPONSE", message: { text: params.text } }),
    });
    const body = await res.json();
    if (!res.ok) {
      console.error("[channel-send-message] Messenger text send failed", res.status, body);
      return { error: body?.error?.message ?? "messenger_send_failed" };
    }
    lastMid = body.message_id;
  }
  if (params.media) {
    const mimeType = params.media.mimeType ?? "";
    const attachmentType = mimeType.startsWith("image") ? "image" : mimeType.startsWith("video") ? "video" : mimeType.startsWith("audio") ? "audio" : "file";
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(params.pageAccessToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: params.recipientId },
        messaging_type: "RESPONSE",
        message: { attachment: { type: attachmentType, payload: { url: params.media.url, is_reusable: false } } },
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      console.error("[channel-send-message] Messenger attachment send failed", res.status, body);
      return { error: body?.error?.message ?? "messenger_send_failed" };
    }
    lastMid = body.message_id;
  }
  if (!lastMid) return { error: "messenger_send_failed" };
  return { mid: lastMid };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: new Headers(CORS_HEADERS) });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: "server_error" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: authData, error: authError } = await callerClient.auth.getUser();
  if (authError || !authData.user) return json({ error: "unauthorized" }, 401);

  const { data: callerProfile } = await callerClient.from("profiles").select("tenant_id, role").eq("id", authData.user.id).single();
  if (!callerProfile) return json({ error: "unauthorized" }, 401);
  if (callerProfile.role !== "admin") return json({ error: "forbidden" }, 403);

  let payload: { conversation_id?: string; body?: string; media?: { storage_path: string; file_name: string; mime_type: string | null } };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const bodyText = payload.body?.trim() || undefined;
  if (!payload.conversation_id || (!bodyText && !payload.media)) {
    return json({ error: "conversation_id_and_body_or_media_required" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: conversation, error: conversationError } = await admin
    .from("channel_conversations")
    .select("id, tenant_id, channel_type, external_contact")
    .eq("id", payload.conversation_id)
    .single();
  if (conversationError || !conversation) return json({ error: "not_found" }, 404);
  // Service-role queries bypass RLS entirely, so tenant isolation has to
  // be checked by hand here - the caller's own tenant_id (from their JWT-
  // verified profile row above), never anything the request body claims.
  if (conversation.tenant_id !== callerProfile.tenant_id) return json({ error: "not_found" }, 404);

  if (conversation.channel_type !== "sms" && conversation.channel_type !== "whatsapp" && conversation.channel_type !== "messenger") {
    return json({ error: "channel_not_connected", message: "Sending isn't available on this channel yet." }, 400);
  }

  // Twilio and Messenger both fetch media themselves rather than accepting
  // raw bytes, so a private-bucket path has to become a URL either can
  // reach with no auth of its own - a signed URL, generous enough (1 hour)
  // that a slow fetch or retry doesn't race it.
  let mediaUrl: string | undefined;
  if (payload.media) {
    const { data: signed, error: signError } = await admin.storage.from(MEDIA_BUCKET).createSignedUrl(payload.media.storage_path, 3600);
    if (signError || !signed) {
      console.error("[channel-send-message] Failed to sign media URL", signError);
      return json({ error: "server_error" }, 500);
    }
    mediaUrl = signed.signedUrl;
  }

  let externalMessageId: string;
  if (conversation.channel_type === "messenger") {
    const { data: fbConnection } = await admin
      .from("facebook_connections")
      .select("page_access_token")
      .eq("tenant_id", conversation.tenant_id)
      .maybeSingle();
    if (!fbConnection) return json({ error: "messenger_not_configured" }, 400);

    const result = await sendViaMessenger({
      pageAccessToken: fbConnection.page_access_token,
      recipientId: conversation.external_contact,
      text: bodyText,
      media: mediaUrl ? { url: mediaUrl, mimeType: payload.media?.mime_type ?? null } : undefined,
    });
    if ("error" in result) return json({ error: "send_failed", message: result.error }, 502);
    externalMessageId = result.mid;
  } else {
    const isWhatsapp = conversation.channel_type === "whatsapp";
    const { data: tenant } = await admin
      .from("tenants")
      .select("sms_phone_number, whatsapp_phone_number")
      .eq("id", conversation.tenant_id)
      .single();
    const fromNumber = isWhatsapp ? tenant?.whatsapp_phone_number : tenant?.sms_phone_number;
    if (!fromNumber) return json({ error: isWhatsapp ? "whatsapp_not_configured" : "sms_not_configured" }, 400);

    const result = await sendViaTwilio({ from: fromNumber, to: conversation.external_contact, body: bodyText, mediaUrl, viaWhatsapp: isWhatsapp });
    if ("error" in result) return json({ error: "send_failed", message: result.error }, 502);
    externalMessageId = result.sid;
  }

  const { data: message, error: insertError } = await admin
    .from("channel_messages")
    .insert({
      conversation_id: conversation.id,
      tenant_id: conversation.tenant_id,
      direction: "outbound",
      body: bodyText ?? null,
      media: payload.media ? [payload.media] : [],
      external_message_id: externalMessageId,
      status: "sent",
      sent_by: authData.user.id,
    })
    .select("id")
    .single();
  if (insertError) {
    console.error("[channel-send-message] Sent but failed to record the message", insertError);
    return json({ error: "server_error" }, 500);
  }

  const preview = bodyText?.slice(0, 200) || (payload.media ? `📎 ${payload.media.file_name}` : null);
  await admin
    .from("channel_conversations")
    .update({ last_message_at: new Date().toISOString(), last_message_preview: preview })
    .eq("id", conversation.id);

  return json({ ok: true, message_id: message.id });
});
