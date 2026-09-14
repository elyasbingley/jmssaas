// Inbound sync: Google calls this directly (no Supabase auth) whenever a
// watched calendar changes - a technician moves/edits/deletes an event in
// their own Google Calendar app, or creates a brand-new one there. Google
// push notifications carry no body, only headers (X-Goog-Channel-ID,
// X-Goog-Channel-Token, X-Goog-Resource-State) - the actual change content
// always has to be pulled separately via events.list with the connection's
// stored sync_token, same incremental-sync API events.watch is paired with
// throughout the Calendar API.
//
// Access control here is the channel token, not a Supabase JWT (see
// [functions.google-calendar-webhook] in supabase/config.toml) - the token
// is a shared secret set once via GOOGLE_CHANNEL_TOKEN and echoed back by
// Google on every notification for a channel created with that token.
//
// Duplicates ensureFreshToken() from google-calendar-push - Edge Functions
// in this repo can't import code from outside their own function
// directory (established precedent: xero-webhook/xero-sync).

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const GOOGLE_CHANNEL_TOKEN = Deno.env.get("GOOGLE_CHANNEL_TOKEN") ?? "";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

// Same rolling window importBaselineEvents (google-oauth-callback) uses -
// a full resync after a 410 Gone re-derives from the same window so the
// resulting local state matches what a fresh connect would have produced.
const FULL_RESYNC_WINDOW_PAST_MS = 7 * 24 * 60 * 60 * 1000;
const FULL_RESYNC_WINDOW_FUTURE_MS = 180 * 24 * 60 * 60 * 1000;

function ok(): Response {
  // Google only cares about the status code - always ack fast with 200 so
  // it doesn't retry with backoff, even when we've decided to ignore a
  // notification (unknown channel, sync ping, bad token).
  return new Response(null, { status: 200 });
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
    console.error("[google-calendar-webhook] Token refresh failed", body);
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

// Applies one changed (non-cancelled) Google event to local state: updates
// the matching calendar_events/calendar_event_personal_details row if one
// already exists for this (connection, google_event_id), or inserts a
// brand-new 'google_personal' row if the technician created this event
// directly in Google Calendar and the app has never seen it before.
// job_card_id/task_id and any assignment linkage are deliberately never
// touched here - those stay app-controlled regardless of what happens on
// the Google side.
async function applyChangedEvent(
  admin: ReturnType<typeof createClient>,
  event: Record<string, any>,
  tenantId: string,
  profileId: string,
  connectionId: string,
  googleCalendarId: string
): Promise<void> {
  const fields = toLocalEventFields(event);
  if (!fields) return; // No resolvable start/end - nothing usable to store.

  const { data: existing } = await admin
    .from("calendar_events")
    .select("id, source")
    .eq("google_calendar_connection_id", connectionId)
    .eq("google_event_id", event.id)
    .maybeSingle();

  if (existing && existing.source === "app") {
    // Edited directly on the technician's phone - sync the schedule fields
    // back, but never job/task linkage.
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
    // Base row's title stays the literal 'Busy' placeholder - only the
    // schedule fields and the satellite detail row change.
    await admin
      .from("calendar_events")
      .update({
        start_at: fields.start,
        end_at: fields.end,
        all_day: fields.allDay,
        last_synced_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    await admin
      .from("calendar_event_personal_details")
      .update({
        title: fields.title,
        description: fields.description,
        location: fields.location,
      })
      .eq("calendar_event_id", existing.id);
    return;
  }

  // Brand new event, never seen before - insert as 'google_personal'.
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
    console.error("[google-calendar-webhook] failed to insert new event", event.id, insertError.message);
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
  // Deletion propagates regardless of source: cascades to
  // calendar_event_personal_details via ON DELETE CASCADE for
  // 'google_personal' rows.
  await admin
    .from("calendar_events")
    .delete()
    .eq("google_calendar_connection_id", connectionId)
    .eq("google_event_id", event.id);
}

// Pulls every page of an incremental diff for a given syncToken, applying
// each item as it's read. Returns the final nextSyncToken (only present on
// the last page), or { fullSyncRequired: true } on a 410 Gone.
async function pullIncrementalDiff(
  admin: ReturnType<typeof createClient>,
  accessToken: string,
  connection: Record<string, any>
): Promise<{ syncToken: string | null } | { fullSyncRequired: true }> {
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
      console.error("[google-calendar-webhook] incremental events.list failed", body);
      return { syncToken: connection.sync_token }; // Leave sync_token as-is, retry next notification.
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

// A 410 Gone means the stored sync_token is too old to resume from -
// re-derive local state from a fresh full listing over the same window
// importBaselineEvents uses, reconciling deletions by diffing against what
// currently exists locally for this connection (anything local that no
// longer appears in the fresh listing must have been deleted during the
// dead-token gap).
async function fullResync(
  admin: ReturnType<typeof createClient>,
  accessToken: string,
  connection: Record<string, any>
): Promise<string | null> {
  const timeMin = new Date(Date.now() - FULL_RESYNC_WINDOW_PAST_MS).toISOString();
  const timeMax = new Date(Date.now() + FULL_RESYNC_WINDOW_FUTURE_MS).toISOString();
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
      console.error("[google-calendar-webhook] full resync events.list failed", body);
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

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return ok();
  if (!SUPABASE_SERVICE_ROLE_KEY || !GOOGLE_CHANNEL_TOKEN) return ok();

  const channelId = req.headers.get("X-Goog-Channel-ID");
  const channelToken = req.headers.get("X-Goog-Channel-Token");
  const resourceState = req.headers.get("X-Goog-Resource-State");
  if (!channelId) return ok();

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: connection } = await admin
    .from("google_calendar_connections")
    .select("*")
    .eq("channel_id", channelId)
    .maybeSingle();
  // Unknown channel - most likely superseded by a later renewal
  // (google-calendar-renew-channels creates a new channel_id rather than
  // updating in place), not an error.
  if (!connection) return ok();

  if (channelToken !== GOOGLE_CHANNEL_TOKEN) {
    console.error("[google-calendar-webhook] channel token mismatch for channel", channelId);
    return ok();
  }

  // Google's own subscription-confirmation ping sent the moment a channel
  // is created - not a real change, no diff to pull.
  if (resourceState === "sync") return ok();

  if (!connection.sync_token) {
    // No sync_token yet (e.g. importBaselineEvents failed during connect,
    // never got as far as saving one) - nothing to diff from incrementally.
    // google-calendar-reconcile's hourly sweep is the real backstop for
    // this; skip here rather than guessing.
    return ok();
  }

  const tokenResult = await ensureFreshToken(admin, connection);
  if ("error" in tokenResult) return ok();
  const accessToken = tokenResult.accessToken;

  const diffResult = await pullIncrementalDiff(admin, accessToken, connection);

  let newSyncToken: string | null;
  if ("fullSyncRequired" in diffResult) {
    newSyncToken = await fullResync(admin, accessToken, connection);
  } else {
    newSyncToken = diffResult.syncToken;
  }

  if (newSyncToken) {
    await admin.from("google_calendar_connections").update({ sync_token: newSyncToken }).eq("id", connection.id);
  }

  return ok();
});
