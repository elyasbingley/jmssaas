// Cron sweep (pg_cron + pg_net, same one-time-manual-SQL pattern as
// process-scheduled-comms etc. - see docs/SETUP.md): Google push-
// notification channels expire and can't be renewed in place, only
// recreated (events.watch again with a fresh channel id). Runs daily,
// finds every connection whose channel is missing or expiring within the
// next 24h, and recreates it. Only handles channel lifecycle - a
// connection missing its initial sync_token entirely (baseline
// import/first channel never completed during connect) is
// google-calendar-reconcile's job, not this one.
//
// Duplicates ensureFreshToken()/createWatchChannel() from google-oauth-
// callback/google-calendar-push - Edge Functions in this repo can't import
// code from outside their own function directory (established precedent).

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const GOOGLE_CHANNEL_TOKEN = Deno.env.get("GOOGLE_CHANNEL_TOKEN") ?? "";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/google-calendar-webhook`;

// Same as process-scheduled-comms etc: pg_net calls this with
// Authorization: Bearer <service-role-key> exactly, checked by string
// match - not a Supabase JWT, this endpoint is never called by a client.
function isAuthorized(req: Request): boolean {
  const authHeader = req.headers.get("Authorization") ?? "";
  return SUPABASE_SERVICE_ROLE_KEY.length > 0 && authHeader === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function ensureFreshToken(
  admin: ReturnType<typeof createClient>,
  connection: Record<string, any>
): Promise<{ accessToken: string } | { error: string }> {
  const expiresAt = new Date(connection.token_expires_at).getTime();
  if (expiresAt - Date.now() > 60_000) {
    return { accessToken: connection.access_token };
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: connection.refresh_token,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
    }).toString(),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error("[google-calendar-renew-channels] Token refresh failed", connection.id, body);
    return { error: "google_reauth_required" };
  }
  await admin
    .from("google_calendar_connections")
    .update({
      access_token: body.access_token,
      token_expires_at: new Date(Date.now() + body.expires_in * 1000).toISOString(),
    })
    .eq("id", connection.id);
  return { accessToken: body.access_token };
}

async function stopOldChannel(accessToken: string, channelId: string, resourceId: string): Promise<void> {
  // Best-effort - an expired or already-stopped channel returning an error
  // here is expected and fine, we're recreating it either way.
  try {
    await fetch(`${CALENDAR_API}/channels/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: channelId, resourceId }),
    });
  } catch (err) {
    console.error("[google-calendar-renew-channels] channels.stop failed (non-fatal)", err);
  }
}

async function createWatchChannel(accessToken: string, calendarId: string): Promise<{ channelId: string; resourceId: string; expiration: number } | { error: string }> {
  const channelId = crypto.randomUUID();
  const res = await fetch(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/watch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: channelId, type: "web_hook", address: WEBHOOK_URL, token: GOOGLE_CHANNEL_TOKEN }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error("[google-calendar-renew-channels] watch channel creation failed", body);
    return { error: "watch_channel_failed" };
  }
  return { channelId, resourceId: body.resourceId, expiration: Number(body.expiration) };
}

Deno.serve(async (req: Request) => {
  if (!isAuthorized(req)) return json({ error: "unauthorized" }, 401);
  if (!SUPABASE_SERVICE_ROLE_KEY || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_CHANNEL_TOKEN) {
    return json({ error: "google_not_configured" }, 500);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const renewBefore = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const { data: connections, error } = await admin
    .from("google_calendar_connections")
    .select("*")
    .not("sync_token", "is", null) // Not yet fully connected - reconcile's job, not this one.
    .or(`channel_id.is.null,channel_expires_at.is.null,channel_expires_at.lt.${renewBefore}`);
  if (error) {
    console.error("[google-calendar-renew-channels] failed to list connections", error.message);
    return json({ error: "server_error" }, 500);
  }

  let renewed = 0;
  let failed = 0;

  for (const connection of connections ?? []) {
    const tokenResult = await ensureFreshToken(admin, connection);
    if ("error" in tokenResult) {
      failed++;
      continue;
    }

    if (connection.channel_id && connection.channel_resource_id) {
      await stopOldChannel(tokenResult.accessToken, connection.channel_id, connection.channel_resource_id);
    }

    const channel = await createWatchChannel(tokenResult.accessToken, connection.google_calendar_id);
    if ("error" in channel) {
      failed++;
      continue;
    }

    await admin
      .from("google_calendar_connections")
      .update({
        channel_id: channel.channelId,
        channel_resource_id: channel.resourceId,
        channel_expires_at: new Date(channel.expiration).toISOString(),
      })
      .eq("id", connection.id);
    renewed++;
  }

  return json({ ok: true, renewed, failed, total: connections?.length ?? 0 });
});
