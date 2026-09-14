// Cron sweep (pg_cron + pg_net, same one-time-manual-SQL pattern as
// process-scheduled-comms etc. - see docs/SETUP.md). Two jobs, both
// backstops for things that are normally instant:
//
// 1. Finish any connection where google-oauth-callback's best-effort
//    inline setup didn't fully complete (missing sync_token and/or
//    channel_id/channel_resource_id) - runs the same baseline-import
//    and/or watch-channel-creation steps that callback already tried.
// 2. Pull an incremental diff for every fully-connected calendar, exactly
//    like google-calendar-webhook does per notification - in case a push
//    notification was ever dropped (Google delivery isn't 100%
//    guaranteed), this hourly sweep is what keeps the app's copy from
//    silently drifting out of sync forever.
//
// Duplicates ensureFreshToken()/createWatchChannel()/importBaselineEvents
// from google-oauth-callback and the diff-application logic from
// google-calendar-webhook - Edge Functions in this repo can't import code
// from outside their own function directory (established precedent).

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const GOOGLE_CHANNEL_TOKEN = Deno.env.get("GOOGLE_CHANNEL_TOKEN") ?? "";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/google-calendar-webhook`;

const FULL_WINDOW_PAST_MS = 7 * 24 * 60 * 60 * 1000;
const FULL_WINDOW_FUTURE_MS = 180 * 24 * 60 * 60 * 1000;

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
    console.error("[google-calendar-reconcile] Token refresh failed", connection.id, body);
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

async function createWatchChannel(accessToken: string, calendarId: string): Promise<{ channelId: string; resourceId: string; expiration: number } | { error: string }> {
  const channelId = crypto.randomUUID();
  const res = await fetch(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/watch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: channelId, type: "web_hook", address: WEBHOOK_URL, token: GOOGLE_CHANNEL_TOKEN }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error("[google-calendar-reconcile] watch channel creation failed", body);
    return { error: "watch_channel_failed" };
  }
  return { channelId, resourceId: body.resourceId, expiration: Number(body.expiration) };
}

function toLocalEventFields(event: Record<string, any>): {
  start: string;
  end: string;
  allDay: boolean;
  title: string;
  description: string | null;
  location: string | null;
} | null {
  const start = event.start?.dateTime ?? (event.start?.date ? `${event.start.date}T00:00:00Z` : null);
  const end = event.end?.dateTime ?? (event.end?.date ? `${event.end.date}T00:00:00Z` : null);
  if (!start || !end) return null;
  return {
    start,
    end,
    allDay: !event.start?.dateTime,
    title: event.summary || "(no title)",
    description: event.description ?? null,
    location: event.location ?? null,
  };
}

async function applyChangedEvent(
  admin: ReturnType<typeof createClient>,
  event: Record<string, any>,
  tenantId: string,
  profileId: string,
  connectionId: string,
  googleCalendarId: string
): Promise<void> {
  const fields = toLocalEventFields(event);
  if (!fields) return;

  const { data: existing } = await admin
    .from("calendar_events")
    .select("id, source")
    .eq("google_calendar_connection_id", connectionId)
    .eq("google_event_id", event.id)
    .maybeSingle();

  if (existing && existing.source === "app") {
    await admin
      .from("calendar_events")
      .update({
        title: fields.title,
        description: fields.description,
        location: fields.location,
        start_at: fields.start,
        end_at: fields.end,
        all_day: fields.allDay,
        last_synced_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    return;
  }

  if (existing && existing.source === "google_personal") {
    await admin
      .from("calendar_events")
      .update({ start_at: fields.start, end_at: fields.end, all_day: fields.allDay, last_synced_at: new Date().toISOString() })
      .eq("id", existing.id);
    await admin
      .from("calendar_event_personal_details")
      .update({ title: fields.title, description: fields.description, location: fields.location })
      .eq("calendar_event_id", existing.id);
    return;
  }

  const { data: row, error: insertError } = await admin
    .from("calendar_events")
    .insert({
      tenant_id: tenantId,
      title: "Busy",
      all_day: fields.allDay,
      start_at: fields.start,
      end_at: fields.end,
      source: "google_personal",
      owner_profile_id: profileId,
      google_calendar_id: googleCalendarId,
      google_event_id: event.id,
      google_calendar_connection_id: connectionId,
      last_synced_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (insertError) {
    console.error("[google-calendar-reconcile] failed to insert event", event.id, insertError.message);
    return;
  }
  await admin.from("calendar_event_personal_details").insert({
    calendar_event_id: row.id,
    owner_profile_id: profileId,
    title: fields.title,
    description: fields.description,
    location: fields.location,
  });
}

async function applyCancelledEvent(admin: ReturnType<typeof createClient>, event: Record<string, any>, connectionId: string): Promise<void> {
  await admin.from("calendar_events").delete().eq("google_calendar_connection_id", connectionId).eq("google_event_id", event.id);
}

// Full listing over the standard window, used both for finishing a
// connection whose baseline import never ran and for re-deriving state
// after a 410 Gone during the incremental pull below.
async function fullResync(admin: ReturnType<typeof createClient>, accessToken: string, connection: Record<string, any>): Promise<string | null> {
  const timeMin = new Date(Date.now() - FULL_WINDOW_PAST_MS).toISOString();
  const timeMax = new Date(Date.now() + FULL_WINDOW_FUTURE_MS).toISOString();
  let pageToken: string | undefined;
  let syncToken: string | null = null;
  const seenEventIds = new Set<string>();

  do {
    const listUrl = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(connection.google_calendar_id)}/events`);
    listUrl.searchParams.set("timeMin", timeMin);
    listUrl.searchParams.set("timeMax", timeMax);
    listUrl.searchParams.set("singleEvents", "true");
    listUrl.searchParams.set("showDeleted", "true");
    listUrl.searchParams.set("maxResults", "250");
    if (pageToken) listUrl.searchParams.set("pageToken", pageToken);

    const res = await fetch(listUrl.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    const body = await res.json();
    if (!res.ok) {
      console.error("[google-calendar-reconcile] full resync events.list failed", connection.id, body);
      return null;
    }

    for (const event of body.items ?? []) {
      if (event.status === "cancelled") continue;
      seenEventIds.add(event.id);
      await applyChangedEvent(admin, event, connection.tenant_id, connection.profile_id, connection.id, connection.google_calendar_id);
    }

    pageToken = body.nextPageToken;
    if (body.nextSyncToken) syncToken = body.nextSyncToken;
  } while (pageToken);

  // Only meaningful when this connection already had local rows (i.e. a
  // real reconciliation, not the very first baseline import into an empty
  // set) - harmless no-op otherwise since seenEventIds already covers
  // everything that exists.
  const { data: localRows } = await admin
    .from("calendar_events")
    .select("id, google_event_id")
    .eq("google_calendar_connection_id", connection.id)
    .not("google_event_id", "is", null);
  for (const local of localRows ?? []) {
    if (local.google_event_id && !seenEventIds.has(local.google_event_id)) {
      await admin.from("calendar_events").delete().eq("id", local.id);
    }
  }

  return syncToken;
}

async function incrementalPull(admin: ReturnType<typeof createClient>, accessToken: string, connection: Record<string, any>): Promise<{ syncToken: string | null } | { fullSyncRequired: true }> {
  let pageToken: string | undefined;
  let syncToken: string | null = null;

  do {
    const listUrl = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(connection.google_calendar_id)}/events`);
    listUrl.searchParams.set("syncToken", connection.sync_token);
    listUrl.searchParams.set("showDeleted", "true");
    listUrl.searchParams.set("singleEvents", "true");
    listUrl.searchParams.set("maxResults", "250");
    if (pageToken) listUrl.searchParams.set("pageToken", pageToken);

    const res = await fetch(listUrl.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 410) return { fullSyncRequired: true };
    const body = await res.json();
    if (!res.ok) {
      console.error("[google-calendar-reconcile] incremental events.list failed", connection.id, body);
      return { syncToken: connection.sync_token };
    }

    for (const event of body.items ?? []) {
      if (event.status === "cancelled") {
        await applyCancelledEvent(admin, event, connection.id);
      } else {
        await applyChangedEvent(admin, event, connection.tenant_id, connection.profile_id, connection.id, connection.google_calendar_id);
      }
    }

    pageToken = body.nextPageToken;
    if (body.nextSyncToken) syncToken = body.nextSyncToken;
  } while (pageToken);

  return { syncToken };
}

Deno.serve(async (req: Request) => {
  if (!isAuthorized(req)) return json({ error: "unauthorized" }, 401);
  if (!SUPABASE_SERVICE_ROLE_KEY || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_CHANNEL_TOKEN) {
    return json({ error: "google_not_configured" }, 500);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: connections, error } = await admin.from("google_calendar_connections").select("*");
  if (error) {
    console.error("[google-calendar-reconcile] failed to list connections", error.message);
    return json({ error: "server_error" }, 500);
  }

  let completed = 0;
  let synced = 0;
  let failed = 0;

  for (const connection of connections ?? []) {
    const tokenResult = await ensureFreshToken(admin, connection);
    if ("error" in tokenResult) {
      failed++;
      continue;
    }
    const accessToken = tokenResult.accessToken;

    if (!connection.sync_token) {
      // google-oauth-callback's inline baseline import never completed -
      // finish it now.
      const syncToken = await fullResync(admin, accessToken, connection);
      if (syncToken) {
        await admin.from("google_calendar_connections").update({ sync_token: syncToken }).eq("id", connection.id);
        completed++;
      } else {
        failed++;
        continue;
      }
    } else {
      const diffResult = await incrementalPull(admin, accessToken, connection);
      const newSyncToken = "fullSyncRequired" in diffResult ? await fullResync(admin, accessToken, connection) : diffResult.syncToken;
      if (newSyncToken) {
        await admin.from("google_calendar_connections").update({ sync_token: newSyncToken }).eq("id", connection.id);
      }
      synced++;
    }

    if (!connection.channel_id || !connection.channel_resource_id) {
      // google-oauth-callback's inline channel creation never completed -
      // finish it now rather than waiting for google-calendar-renew-
      // channels' daily sweep, since without a channel this connection
      // gets no push notifications at all until then.
      const channel = await createWatchChannel(accessToken, connection.google_calendar_id);
      if (!("error" in channel)) {
        await admin
          .from("google_calendar_connections")
          .update({
            channel_id: channel.channelId,
            channel_resource_id: channel.resourceId,
            channel_expires_at: new Date(channel.expiration).toISOString(),
          })
          .eq("id", connection.id);
      }
    }
  }

  return json({ ok: true, completed, synced, failed, total: connections?.length ?? 0 });
});
