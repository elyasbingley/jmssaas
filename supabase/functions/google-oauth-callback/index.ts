// Step 2 of the Google Calendar OAuth2 connect flow - Google redirects the
// user's own browser here (GET, with ?code=...&state=...) after they
// approve the connection on Google's own consent screen. No Supabase
// session/auth header exists on this request (it's the browser being
// redirected by Google, not an app fetch() call) - `state` (created by
// google-oauth-start, looked up and burned here) is what recovers which
// PROFILE this belongs to, standard OAuth2 CSRF-protection pattern, same
// shape as xero-oauth-callback.
//
// Unlike Xero's callback, this also finishes setting the connection up
// end-to-end in one pass (resolve the real calendar ID, pull a baseline
// listing of existing events, create the first push-notification watch
// channel) rather than leaving that to the next cron sweep - the user was
// told "connect your calendar" is close to instant, so their own personal
// events and the push channel should be live by the time their browser
// lands back on the app, not up to an hour later. google-calendar-renew-
// channels re-runs the same watch-channel-creation logic for renewals -
// duplicated rather than shared, since Edge Functions in this repo can't
// import code from outside their own function directory (see xero-webhook/
// xero-sync's duplicated ensureFreshToken() for the established precedent).
//
// Ends with an HTTP redirect (302), not an HTML response body - Supabase
// force-downgrades HTML responses from Edge Functions on the shared
// *.supabase.co domain to inert text/plain, but a redirect's Location
// header still works regardless, since the browser navigates off the
// status code, not the body.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
// Where to send the browser back to once the connection is resolved (with
// or without success) - e.g. https://jmssaas.vercel.app/settings. Set as
// an Edge Function secret since it's server-side redirect logic, not
// client-bundled config.
const GOOGLE_APP_REDIRECT_URL = Deno.env.get("GOOGLE_APP_REDIRECT_URL") ?? "";
// Echoed back on every push notification Google sends to the webhook, so
// the webhook can confirm a notification really is for a channel we
// created (Google's push notifications carry no signature of their own -
// this shared-secret token is the actual authentication mechanism, same
// role Xero's HMAC signature plays for xero-webhook).
const GOOGLE_CHANNEL_TOKEN = Deno.env.get("GOOGLE_CHANNEL_TOKEN") ?? "";

const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/google-oauth-callback`;
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/google-calendar-webhook`;
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

function redirect(status: "connected" | "error", message?: string): Response {
  if (!GOOGLE_APP_REDIRECT_URL) {
    return new Response(JSON.stringify({ error: "google_app_redirect_url_not_configured", status, message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const url = new URL(GOOGLE_APP_REDIRECT_URL);
  url.searchParams.set("google_calendar", status);
  if (message) url.searchParams.set("google_calendar_message", message);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

// Creates a push-notification channel for a connection's calendar. Google
// channels aren't renewable in place and expire (the requested ttl isn't
// guaranteed to be honoured) - google-calendar-renew-channels re-creates
// this the same way whenever channel_expires_at is approaching.
async function createWatchChannel(accessToken: string, calendarId: string): Promise<{ channelId: string; resourceId: string; expiration: number } | { error: string }> {
  const channelId = crypto.randomUUID();
  const res = await fetch(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/watch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      id: channelId,
      type: "web_hook",
      address: WEBHOOK_URL,
      token: GOOGLE_CHANNEL_TOKEN,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error("[google-oauth-callback] watch channel creation failed", body);
    return { error: "watch_channel_failed" };
  }
  return { channelId, resourceId: body.resourceId, expiration: Number(body.expiration) };
}

// Baseline import: everything in a rolling window around "now" becomes a
// 'google_personal' calendar_events row (with the real detail split into
// calendar_event_personal_details - see the migration's own comment for
// why), and the resulting nextSyncToken is stored so every later change is
// an incremental diff instead of a full re-scan. singleEvents expands
// recurring series into individual occurrences (simpler than rendering an
// RRULE this app has no concept of); showDeleted is required even on this
// first call for the sync token itself to later report deletions
// correctly.
async function importBaselineEvents(
  admin: ReturnType<typeof createClient>,
  accessToken: string,
  calendarId: string,
  tenantId: string,
  profileId: string,
  connectionId: string
): Promise<string | null> {
  const timeMin = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
  let pageToken: string | undefined;
  let syncToken: string | null = null;

  do {
    const listUrl = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`);
    listUrl.searchParams.set("timeMin", timeMin);
    listUrl.searchParams.set("timeMax", timeMax);
    listUrl.searchParams.set("singleEvents", "true");
    listUrl.searchParams.set("showDeleted", "true");
    listUrl.searchParams.set("maxResults", "250");
    if (pageToken) listUrl.searchParams.set("pageToken", pageToken);

    const res = await fetch(listUrl.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    const body = await res.json();
    if (!res.ok) {
      console.error("[google-oauth-callback] initial events.list failed", body);
      return null;
    }

    for (const event of body.items ?? []) {
      if (event.status === "cancelled") continue;
      const start = event.start?.dateTime ?? (event.start?.date ? `${event.start.date}T00:00:00Z` : null);
      const end = event.end?.dateTime ?? (event.end?.date ? `${event.end.date}T00:00:00Z` : null);
      if (!start || !end) continue;

      const { data: row, error: insertError } = await admin
        .from("calendar_events")
        .insert({
          tenant_id: tenantId,
          title: "Busy",
          all_day: !event.start?.dateTime,
          start_at: start,
          end_at: end,
          source: "google_personal",
          owner_profile_id: profileId,
          google_calendar_id: calendarId,
          google_event_id: event.id,
          google_calendar_connection_id: connectionId,
          last_synced_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (insertError) {
        console.error("[google-oauth-callback] failed to insert baseline event", event.id, insertError.message);
        continue;
      }

      await admin.from("calendar_event_personal_details").insert({
        calendar_event_id: row.id,
        owner_profile_id: profileId,
        title: event.summary || "(no title)",
        description: event.description ?? null,
        location: event.location ?? null,
      });
    }

    pageToken = body.nextPageToken;
    if (body.nextSyncToken) syncToken = body.nextSyncToken;
  } while (pageToken);

  return syncToken;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const googleError = url.searchParams.get("error");

  if (googleError) return redirect("error", googleError);
  if (!code || !state) return redirect("error", "missing_code_or_state");
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return redirect("error", "google_not_configured");
  if (!SUPABASE_SERVICE_ROLE_KEY) return redirect("error", "server_error");

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Single-use: look up and immediately delete, so a replayed/leaked
  // callback URL can't be used twice.
  const { data: stateRow } = await admin.from("google_oauth_states").select("*").eq("state", state).maybeSingle();
  if (!stateRow) return redirect("error", "invalid_or_expired_state");
  await admin.from("google_oauth_states").delete().eq("state", state);

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
    }).toString(),
  });
  const tokenBody = await tokenRes.json();
  if (!tokenRes.ok) {
    console.error("[google-oauth-callback] Token exchange failed", tokenBody);
    return redirect("error", "token_exchange_failed");
  }
  const { access_token, refresh_token, expires_in } = tokenBody;
  if (!refresh_token) {
    // Shouldn't happen given access_type=offline&prompt=consent in
    // google-oauth-start, but without one this connection could never
    // refresh past the first hour - fail loudly rather than storing a
    // connection quietly doomed to expire.
    console.error("[google-oauth-callback] No refresh_token in response - access_type/prompt not honoured?");
    return redirect("error", "no_refresh_token");
  }

  const userinfoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const userinfo = await userinfoRes.json();
  const email: string | null = userinfoRes.ok ? (userinfo.email ?? null) : null;

  const calendarRes = await fetch(`${CALENDAR_API}/calendars/primary`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const calendarBody = await calendarRes.json();
  if (!calendarRes.ok) {
    console.error("[google-oauth-callback] Failed to resolve primary calendar", calendarBody);
    return redirect("error", "calendar_lookup_failed");
  }
  const googleCalendarId: string = calendarBody.id;

  const { data: connection, error: upsertError } = await admin
    .from("google_calendar_connections")
    .upsert(
      {
        tenant_id: stateRow.tenant_id,
        profile_id: stateRow.profile_id,
        google_account_email: email,
        google_calendar_id: googleCalendarId,
        access_token,
        refresh_token,
        token_expires_at: new Date(Date.now() + expires_in * 1000).toISOString(),
        connected_at: new Date().toISOString(),
        // Reset sync state on (re)connect - a stale sync_token/channel from
        // a previous connection to this same profile would otherwise be
        // reused against a possibly-different Google account.
        sync_token: null,
        channel_id: null,
        channel_resource_id: null,
        channel_expires_at: null,
      },
      { onConflict: "profile_id" }
    )
    .select("id")
    .single();
  if (upsertError || !connection) {
    console.error("[google-oauth-callback] Failed to store connection", upsertError?.message);
    return redirect("error", "server_error");
  }

  // Best-effort from here - the connection itself is already saved, so a
  // failure in baseline import or channel creation shouldn't strand the
  // user on an error page. google-calendar-renew-channels' daily sweep and
  // google-calendar-reconcile's hourly sweep both pick up any connection
  // still missing a channel/sync_token and finish the job.
  const syncToken = await importBaselineEvents(
    admin,
    access_token,
    googleCalendarId,
    stateRow.tenant_id,
    stateRow.profile_id,
    connection.id
  );

  const channel = await createWatchChannel(access_token, googleCalendarId);

  await admin
    .from("google_calendar_connections")
    .update({
      sync_token: syncToken,
      ...("channelId" in channel
        ? {
            channel_id: channel.channelId,
            channel_resource_id: channel.resourceId,
            channel_expires_at: new Date(channel.expiration).toISOString(),
          }
        : {}),
    })
    .eq("id", connection.id);

  return redirect("connected");
});
