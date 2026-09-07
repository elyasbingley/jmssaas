import { supabase } from "./supabase";

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;

// Port of apps/desktop/src/lib/channels.ts's sendChannelMessage - same
// channel-send-message Edge Function, EXPO_PUBLIC_ instead of VITE_ for
// the env var. Throws with the server's own message on failure (unlike
// dispatch-now's best-effort swallow) - a Channels reply has no cron-sweep
// fallback, the admin needs to know it didn't go out.
export async function sendChannelMessage(conversationId: string, body: string): Promise<string> {
  if (!SUPABASE_URL) throw new Error("EXPO_PUBLIC_SUPABASE_URL is not configured");
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error("Not signed in");

  const res = await fetch(`${SUPABASE_URL}/functions/v1/channel-send-message`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: conversationId, body }),
  });
  const responseBody = await res.json();
  if (!res.ok) throw new Error(responseBody?.message ?? responseBody?.error ?? "Failed to send message");
  return responseBody.message_id as string;
}

// Same synthetic-id scheme as apps/desktop/src/pages/Channels.tsx's
// emailConversationId/decodeEmailConversationId - a virtual "email"
// conversation (grouped from inbox_messages) has no real
// channel_conversations.id to route with, so this encodes the sender's
// address into the [id] route param instead.
const EMAIL_ID_PREFIX = "email:";
export function emailConversationId(fromEmail: string): string {
  return `${EMAIL_ID_PREFIX}${encodeURIComponent(fromEmail)}`;
}
export function decodeEmailConversationId(id: string): string | null {
  return id.startsWith(EMAIL_ID_PREFIX) ? decodeURIComponent(id.slice(EMAIL_ID_PREFIX.length)) : null;
}
