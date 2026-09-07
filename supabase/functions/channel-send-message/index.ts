// Channels - sends an admin's reply out through the conversation's own
// channel and records it. Called from the app with the signed-in admin's
// own bearer token (same auth pattern as xero-oauth-start) rather than
// --no-verify-jwt, since - unlike the inbound webhooks - this is only ever
// invoked by a real app user, never by an external provider.
//
// SMS and WhatsApp (both via Twilio's Messages API - WhatsApp is the same
// endpoint with a "whatsapp:" prefix on From/To) - Messenger/Instagram
// still need Meta App Review finished first before there's anywhere to
// actually send to; see docs/SETUP.md.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: new Headers({ "Content-Type": "application/json", ...CORS_HEADERS }) });
}

// `viaWhatsapp` prefixes both numbers "whatsapp:" - the only difference
// between an SMS and a WhatsApp send through Twilio's Messages API.
async function sendViaTwilio(params: { from: string; to: string; body: string; viaWhatsapp: boolean }): Promise<{ sid: string } | { error: string }> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return { error: "twilio_not_configured" };
  const prefix = params.viaWhatsapp ? "whatsapp:" : "";
  const basicAuth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const form = new URLSearchParams({ To: `${prefix}${params.to}`, From: `${prefix}${params.from}`, Body: params.body });
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

  let payload: { conversation_id?: string; body?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!payload.conversation_id || !payload.body?.trim()) return json({ error: "conversation_id_and_body_required" }, 400);

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

  if (conversation.channel_type !== "sms" && conversation.channel_type !== "whatsapp") {
    return json({ error: "channel_not_connected", message: "Sending isn't available on this channel yet." }, 400);
  }
  const isWhatsapp = conversation.channel_type === "whatsapp";

  const { data: tenant } = await admin
    .from("tenants")
    .select("sms_phone_number, whatsapp_phone_number")
    .eq("id", conversation.tenant_id)
    .single();
  const fromNumber = isWhatsapp ? tenant?.whatsapp_phone_number : tenant?.sms_phone_number;
  if (!fromNumber) return json({ error: isWhatsapp ? "whatsapp_not_configured" : "sms_not_configured" }, 400);

  const result = await sendViaTwilio({ from: fromNumber, to: conversation.external_contact, body: payload.body, viaWhatsapp: isWhatsapp });
  if ("error" in result) return json({ error: "send_failed", message: result.error }, 502);

  const { data: message, error: insertError } = await admin
    .from("channel_messages")
    .insert({
      conversation_id: conversation.id,
      tenant_id: conversation.tenant_id,
      direction: "outbound",
      body: payload.body,
      external_message_id: result.sid,
      status: "sent",
      sent_by: authData.user.id,
    })
    .select("id")
    .single();
  if (insertError) {
    console.error("[channel-send-message] Sent via Twilio but failed to record the message", insertError);
    return json({ error: "server_error" }, 500);
  }

  await admin
    .from("channel_conversations")
    .update({ last_message_at: new Date().toISOString(), last_message_preview: payload.body.slice(0, 200) })
    .eq("id", conversation.id);

  return json({ ok: true, message_id: message.id });
});
