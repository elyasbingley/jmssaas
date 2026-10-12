import { supabase } from "./supabase";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

// Calls channel-send-message with the signed-in admin's own bearer token -
// same shape as dispatch-now.ts's triggerImmediateDispatch, just a direct
// send instead of nudging a queued row. Throws with the server's own
// message on failure so the caller can show it (unlike dispatch-now's
// best-effort swallow-and-fall-back, a Channels reply has no cron-sweep
// fallback - the admin needs to know it didn't go out).
export interface ChannelMediaAttachment {
  storage_path: string;
  file_name: string;
  mime_type: string | null;
}

// `media` is one attachment, uploaded first via uploadChannelMedia
// (lib/uploads.ts) - channel-send-message signs it and hands the URL to
// Twilio, same param either channel type uses. At least one of
// body/media is required (matches the WhatsApp UX this mirrors: a
// caption-only, media-only, or text-only reply are all valid).
export async function sendChannelMessage(conversationId: string, body: string, media?: ChannelMediaAttachment): Promise<string> {
  if (!SUPABASE_URL) throw new Error("VITE_SUPABASE_URL is not configured");
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error("Not signed in");

  const res = await fetch(`${SUPABASE_URL}/functions/v1/channel-send-message`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: conversationId, body, media }),
  });
  const responseBody = await res.json();
  if (!res.ok) throw new Error(responseBody?.message ?? responseBody?.error ?? "Failed to send message");
  return responseBody.message_id as string;
}

// Starts a brand new outbound SMS/WhatsApp conversation (no existing
// conversation_id yet) - same channel-send-message Edge Function, just the
// other payload shape it accepts (see that function's own comment on the
// find-or-create this triggers). Returns the conversation_id so the caller
// can navigate straight to the resulting thread, same as if it already
// existed.
export async function startChannelConversation(params: {
  channelType: "sms" | "whatsapp";
  toPhone: string;
  body: string;
  clientId?: string;
  contactName?: string;
}): Promise<{ messageId: string; conversationId: string }> {
  if (!SUPABASE_URL) throw new Error("VITE_SUPABASE_URL is not configured");
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error("Not signed in");

  const res = await fetch(`${SUPABASE_URL}/functions/v1/channel-send-message`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      channel_type: params.channelType,
      to_phone: params.toPhone,
      body: params.body,
      client_id: params.clientId,
      contact_name: params.contactName,
    }),
  });
  const responseBody = await res.json();
  if (!res.ok) throw new Error(responseBody?.message ?? responseBody?.error ?? "Failed to send message");
  return { messageId: responseBody.message_id as string, conversationId: responseBody.conversation_id as string };
}
