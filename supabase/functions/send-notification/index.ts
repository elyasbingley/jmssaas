// General-purpose "create a notification + push it" primitive - internal
// only (service-role bearer token, same as pg_cron-invoked sweeps like
// process-scheduled-comms' runSweep), called by other Edge Functions after
// something notification-worthy happens, never called directly by the app.
// Deployed as a Supabase Edge Function (Deno runtime, npm: specifiers
// supported).
//
// Two things, always together: an in-app notifications row per recipient
// (what the Notifications tab reads - see that table's own migration
// comment for why it's Supabase-direct/polled, not PowerSync) and an Expo
// push notification to each recipient's registered devices (what reaches
// the phone even when the app's closed). A push failing (expired/invalid
// token, Expo API hiccup) never blocks the notifications row from being
// written - the in-app feed is the source of truth, push is a best-effort
// nudge on top of it.
//
// First caller: the three inbound-message webhooks (twilio-sms-webhook,
// twilio-whatsapp-webhook, facebook-messenger-webhook) for type
// "channel_message". Designed to be reused as-is for the rest of the
// Notifications tab's own documented roadmap (quote_accepted, task_due,
// job_booking_reminder, stale_job) - none of that is Channels-specific
// here, only the caller's choice of `type`/`title`/`body`/`data` is.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const EXPO_PUSH_API = "https://exp.host/--/api/v2/push/send";
// Expo's own documented batch cap per request to this endpoint.
const EXPO_PUSH_BATCH_SIZE = 100;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface SendNotificationBody {
  tenant_id?: string;
  type?: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  // Every profile in the tenant when omitted (the Channels case - nothing
  // like an "assigned to me" concept exists for a conversation, see the
  // channels migration's own comment on note_tenant_data for the same
  // reasoning applied there). A future type with a clear single recipient
  // (e.g. quote_accepted -> whoever created the quote) passes this
  // explicitly instead.
  recipient_profile_ids?: string[];
}

async function sendExpoPushBatch(messages: { to: string; title: string; body: string; data: Record<string, unknown> }[]): Promise<void> {
  for (let i = 0; i < messages.length; i += EXPO_PUSH_BATCH_SIZE) {
    const batch = messages.slice(i, i + EXPO_PUSH_BATCH_SIZE);
    try {
      const res = await fetch(EXPO_PUSH_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Encoding": "gzip, deflate" },
        body: JSON.stringify(batch),
      });
      if (!res.ok) {
        console.error("[send-notification] Expo push API request failed", res.status, await res.text());
      }
      // Per-ticket errors (DeviceNotRegistered etc.) are intentionally not
      // parsed out to prune push_tokens here - Expo's receipt API is a
      // separate follow-up call this pass doesn't add; a dead token just
      // keeps failing silently on each future send, which is harmless
      // (Expo itself drops it) rather than something worth the extra
      // moving part yet.
    } catch (e) {
      console.error("[send-notification] Expo push request threw", e);
    }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: "server_error" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) return json({ error: "unauthorized" }, 401);

  let body: SendNotificationBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (!body.tenant_id || !body.type || !body.title || !body.body) {
    return json({ error: "bad_request" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let recipientIds = body.recipient_profile_ids;
  if (!recipientIds) {
    const { data: profiles, error: profilesError } = await admin.from("profiles").select("id").eq("tenant_id", body.tenant_id);
    if (profilesError) {
      console.error("[send-notification] Failed to list tenant profiles", profilesError);
      return json({ error: "server_error" }, 500);
    }
    recipientIds = (profiles ?? []).map((p) => p.id as string);
  }
  if (recipientIds.length === 0) return json({ ok: true, notified: 0 });

  const notificationRows = recipientIds.map((profileId) => ({
    tenant_id: body.tenant_id,
    profile_id: profileId,
    type: body.type,
    title: body.title,
    body: body.body,
    data: body.data ?? {},
  }));
  const { error: insertError } = await admin.from("notifications").insert(notificationRows);
  if (insertError) {
    console.error("[send-notification] Failed to insert notification rows", insertError);
    return json({ error: "server_error" }, 500);
  }

  const { data: tokens, error: tokensError } = await admin.from("push_tokens").select("token").in("profile_id", recipientIds);
  if (tokensError) {
    console.error("[send-notification] Failed to fetch push tokens", tokensError);
    // Notifications rows are already written - a push-token lookup
    // failure shouldn't report this call as failed overall.
    return json({ ok: true, notified: recipientIds.length, pushed: 0 });
  }

  const pushMessages = (tokens ?? []).map((t) => ({ to: t.token as string, title: body.title!, body: body.body!, data: body.data ?? {} }));
  if (pushMessages.length > 0) await sendExpoPushBatch(pushMessages);

  return json({ ok: true, notified: recipientIds.length, pushed: pushMessages.length });
});
