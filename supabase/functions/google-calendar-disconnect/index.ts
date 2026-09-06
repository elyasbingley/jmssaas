// Disconnects a Google Calendar connection. Self-serve by default (any
// profile disconnects their own account); an admin may also pass a
// different profileId to disconnect someone else's connection on their
// behalf (e.g. an offboarded technician), same "admin manages the whole
// tenant's connections" scope list_google_calendar_connections() already
// grants for viewing.
//
// Revoking the OAuth grant and stopping the push channel are both best-
// effort - the connection row is the source of truth for "connected or
// not" in this app, so neither failing should block the disconnect from
// completing locally.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS }),
  });
}

async function stopChannel(accessToken: string, channelId: string, resourceId: string): Promise<void> {
  try {
    await fetch(`${CALENDAR_API}/channels/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: channelId, resourceId }),
    });
  } catch (err) {
    console.error("[google-calendar-disconnect] channels.stop failed (non-fatal)", err);
  }
}

async function revokeToken(token: string): Promise<void> {
  try {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch (err) {
    console.error("[google-calendar-disconnect] token revoke failed (non-fatal)", err);
  }
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

  let payload: { profileId?: string } = {};
  try {
    payload = await req.json();
  } catch {
    // Empty body is fine - defaults to disconnecting the caller's own connection.
  }

  const targetProfileId = payload.profileId ?? authData.user.id;
  if (targetProfileId !== authData.user.id && callerProfile.role !== "admin") {
    return json({ error: "forbidden" }, 403);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: connection } = await admin
    .from("google_calendar_connections")
    .select("*")
    .eq("profile_id", targetProfileId)
    .maybeSingle();
  if (!connection) return json({ ok: true, wasConnected: false });
  if (connection.tenant_id !== callerProfile.tenant_id) return json({ error: "forbidden" }, 403);

  if (connection.channel_id && connection.channel_resource_id) {
    await stopChannel(connection.access_token, connection.channel_id, connection.channel_resource_id);
  }
  await revokeToken(connection.refresh_token);

  // Personal busy-block placeholders only make sense while connected -
  // remove them (cascades to calendar_event_personal_details). 'app'-
  // sourced events (job schedules pushed to this person's calendar) stay,
  // just no longer linked to a live Google sync.
  await admin
    .from("calendar_events")
    .delete()
    .eq("google_calendar_connection_id", connection.id)
    .eq("source", "google_personal");
  await admin
    .from("calendar_events")
    .update({ google_calendar_id: null, google_event_id: null, google_calendar_connection_id: null, last_synced_at: null })
    .eq("google_calendar_connection_id", connection.id)
    .eq("source", "app");

  await admin.from("google_calendar_connections").delete().eq("id", connection.id);

  return json({ ok: true, wasConnected: true });
});
