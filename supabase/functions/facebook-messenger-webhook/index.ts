// Channels - Facebook Messenger's inbound webhook. Entirely different
// verification/signature mechanism from Twilio's (see twilio-sms-webhook's
// own comment on that one):
//
//   - GET: Meta calls this once when the webhook URL is (re)saved in the
//     Meta App's Messenger > Settings > Webhooks config, as a handshake -
//     it must echo back ?hub.challenge= as plain text, but only if
//     ?hub.verify_token= matches a secret this app itself picked
//     (FACEBOOK_WEBHOOK_VERIFY_TOKEN) and entered into that same config
//     screen. There is no equivalent GET step for Twilio.
//   - POST: every actual inbound message. Signed via header
//     X-Hub-Signature-256: sha256=<hex-hmac-sha256-of-raw-body>, keyed with
//     the Meta App Secret - HMAC-SHA256 over the whole raw body, not
//     Twilio's per-field HMAC-SHA1-over-sorted-params-plus-URL scheme.
//
// A tenant's Page only starts calling this at all once connected via
// facebook-oauth-start/facebook-oauth-callback (which both stores the Page
// token in facebook_connections AND subscribes the Page to this app's
// webhook - see that callback's own comment). See docs/SETUP.md's Channels
// section for the full Meta App / webhook config setup.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FACEBOOK_APP_SECRET = Deno.env.get("FACEBOOK_APP_SECRET") ?? "";
const FACEBOOK_WEBHOOK_VERIFY_TOKEN = Deno.env.get("FACEBOOK_WEBHOOK_VERIFY_TOKEN") ?? "";
const MEDIA_BUCKET = "channel-media";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function verifySignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!signatureHeader || !FACEBOOK_APP_SECRET) return false;
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const expectedHex = signatureHeader.slice(prefix.length);

  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(FACEBOOK_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBytes = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(rawBody));
  const computedHex = [...new Uint8Array(sigBytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return computedHex === expectedHex;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "application/pdf": "pdf",
};
const EXTENSION_BY_ATTACHMENT_TYPE: Record<string, string> = { image: "jpg", video: "mp4", audio: "mp3", file: "bin" };

interface MessengerAttachment {
  type: string;
  payload?: { url?: string };
}
interface MessengerEntry {
  id: string;
  messaging?: {
    sender?: { id?: string };
    message?: { mid?: string; text?: string; attachments?: MessengerAttachment[]; is_echo?: boolean };
  }[];
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token && FACEBOOK_WEBHOOK_VERIFY_TOKEN && token === FACEBOOK_WEBHOOK_VERIFY_TOKEN && challenge) {
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return json({ error: "verification_failed" }, 403);
  }

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: "server_error" }, 500);

  const rawBody = await req.text();
  const signatureHeader = req.headers.get("x-hub-signature-256");

  const valid = await verifySignature(rawBody, signatureHeader);
  console.log("[facebook-messenger-webhook] signature check", { valid, hasSignatureHeader: !!signatureHeader });
  if (!valid) return json({ error: "invalid_signature" }, 401);

  let payload: { object?: string; entry?: MessengerEntry[] };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (payload.object !== "page" || !Array.isArray(payload.entry)) return json({ ok: true, skipped: "not_a_page_event" });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  for (const entry of payload.entry) {
    for (const event of entry.messaging ?? []) {
      // is_echo: this app's own outbound Send API call, mirrored back -
      // only arrives if the "message_echoes" webhook field is subscribed,
      // which facebook-oauth-callback deliberately does not request, but
      // skip defensively in case that ever changes.
      if (event.message?.is_echo) continue;
      const senderId = event.sender?.id;
      const message = event.message;
      if (!senderId || !message) continue;

      const { data: connection, error: connectionError } = await admin
        .from("facebook_connections")
        .select("tenant_id, page_access_token")
        .eq("page_id", entry.id)
        .maybeSingle();
      if (connectionError) {
        console.error("[facebook-messenger-webhook] Failed to look up Page connection", connectionError);
        continue;
      }
      if (!connection) continue; // Page not connected to any tenant (any more) - nothing to do.

      const { data: existingConversation, error: fetchConvoError } = await admin
        .from("channel_conversations")
        .select("id, unread_count")
        .eq("tenant_id", connection.tenant_id)
        .eq("channel_type", "messenger")
        .eq("external_contact", senderId)
        .maybeSingle();
      if (fetchConvoError) {
        console.error("[facebook-messenger-webhook] Failed to look up conversation", fetchConvoError);
        continue;
      }

      const preview = (message.text ?? "").slice(0, 200) || (message.attachments?.length ? "(attachment)" : null);
      let conversationId: string;

      if (existingConversation) {
        conversationId = existingConversation.id;
        const { error: updateError } = await admin
          .from("channel_conversations")
          .update({ last_message_at: new Date().toISOString(), last_message_preview: preview, unread_count: existingConversation.unread_count + 1 })
          .eq("id", conversationId);
        if (updateError) console.error("[facebook-messenger-webhook] Failed to update conversation", updateError);
      } else {
        // Best-effort display name lookup - Meta's User Profile API is
        // subject to change/restriction independent of this app, so a
        // failure here just leaves contact_name null (the UI falls back to
        // the raw PSID) rather than failing the whole webhook.
        let contactName: string | null = null;
        try {
          const profileRes = await fetch(
            `https://graph.facebook.com/v21.0/${senderId}?fields=first_name,last_name&access_token=${encodeURIComponent(connection.page_access_token)}`
          );
          const profileBody = await profileRes.json();
          if (profileRes.ok && (profileBody.first_name || profileBody.last_name)) {
            contactName = [profileBody.first_name, profileBody.last_name].filter(Boolean).join(" ");
          }
        } catch (e) {
          console.error("[facebook-messenger-webhook] Failed to fetch sender profile", e);
        }

        // No phone/email on a Messenger sender (just an opaque, per-Page
        // PSID) - unlike SMS/WhatsApp there's nothing to auto-match a
        // client by, so client_id starts null here every time.
        const { data: newConversation, error: insertConvoError } = await admin
          .from("channel_conversations")
          .insert({
            tenant_id: connection.tenant_id,
            channel_type: "messenger",
            external_contact: senderId,
            contact_name: contactName,
            last_message_at: new Date().toISOString(),
            last_message_preview: preview,
            unread_count: 1,
          })
          .select("id")
          .single();
        if (insertConvoError || !newConversation) {
          console.error("[facebook-messenger-webhook] Failed to create conversation", insertConvoError);
          continue;
        }
        conversationId = newConversation.id;
      }

      const media: { storage_path: string; file_name: string; mime_type: string | null }[] = [];
      for (const [i, attachment] of (message.attachments ?? []).entries()) {
        const attachmentUrl = attachment.payload?.url;
        if (!attachmentUrl) continue;
        try {
          const mediaRes = await fetch(attachmentUrl);
          if (!mediaRes.ok) throw new Error(`Attachment fetch failed: ${mediaRes.status}`);
          const contentType = mediaRes.headers.get("content-type");
          const bytes = new Uint8Array(await mediaRes.arrayBuffer());
          const extension = (contentType && EXTENSION_BY_MIME[contentType]) || EXTENSION_BY_ATTACHMENT_TYPE[attachment.type] || "bin";
          const fileName = `media-${i}.${extension}`;
          const storagePath = `${connection.tenant_id}/${conversationId}/${crypto.randomUUID()}-${fileName}`;
          const { error: uploadError } = await admin.storage.from(MEDIA_BUCKET).upload(storagePath, bytes, { contentType: contentType ?? undefined });
          if (uploadError) throw uploadError;
          media.push({ storage_path: storagePath, file_name: fileName, mime_type: contentType });
        } catch (e) {
          console.error("[facebook-messenger-webhook] Failed to store attachment", attachmentUrl, e);
        }
      }

      const { error: messageError } = await admin.from("channel_messages").insert({
        conversation_id: conversationId,
        tenant_id: connection.tenant_id,
        direction: "inbound",
        body: message.text ?? null,
        media,
        external_message_id: message.mid,
        status: "received",
      });
      if (messageError) console.error("[facebook-messenger-webhook] Failed to insert message", messageError);
    }
  }

  return json({ ok: true });
});
