// Outbound sync: called by the client (desktop/mobile) right after it
// creates, updates, or deletes a calendar_events row - same "insert then
// immediately call an Edge Function, best-effort" shape as
// triggerImmediateDispatch(), not a DB trigger. Must be called only after
// BOTH the calendar_events write AND any linked job_cards.
// assigned_technician_id write have landed - this function resolves the
// assignee with a fresh read at call time, so calling it before a
// reassignment's job_cards update lands would sync to the wrong (old)
// technician.
//
// Only 'app'-sourced events with a resolved assignee (via job_card_id ->
// job_cards.assigned_technician_id, or task_id -> tasks.assigned_to) who
// has a connected Google Calendar are ever pushed - an event with no
// linked job/task, or whose assignee hasn't connected Google, has nothing
// to sync to and this is a no-op, not an error.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";

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

// Duplicated per-function rather than shared - Edge Functions in this repo
// can't import code from outside their own function directory (see xero-
// sync/xero-webhook's own copies of this same helper). Google refresh
// tokens don't rotate on use the way Xero's do, so unlike Xero's version
// this never needs to write a new refresh_token back, only the rotated
// access_token/expiry.
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
    console.error("[google-calendar-push] Token refresh failed", body);
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

function toGoogleEventBody(row: Record<string, any>) {
  const asDate = (iso: string) => iso.slice(0, 10);
  return {
    summary: row.title,
    description: row.description ?? undefined,
    location: row.location ?? undefined,
    start: row.all_day ? { date: asDate(row.start_at) } : { dateTime: row.start_at },
    end: row.all_day ? { date: asDate(row.end_at) } : { dateTime: row.end_at },
  };
}

// Resolves who a calendar_events row is currently assigned to, via
// job_card_id -> job_cards.assigned_technician_id or task_id ->
// tasks.assigned_to - calendar_events itself carries no direct technician
// column, the same derivation its RLS policies already use.
async function resolveAssigneeProfileId(admin: ReturnType<typeof createClient>, row: Record<string, any>): Promise<string | null> {
  if (row.job_card_id) {
    const { data: job } = await admin.from("job_cards").select("assigned_technician_id").eq("id", row.job_card_id).maybeSingle();
    if (job?.assigned_technician_id) return job.assigned_technician_id;
  }
  if (row.task_id) {
    const { data: task } = await admin.from("tasks").select("assigned_to").eq("id", row.task_id).maybeSingle();
    if (task?.assigned_to) return task.assigned_to;
  }
  return null;
}

async function deleteGoogleEvent(
  admin: ReturnType<typeof createClient>,
  connectionId: string,
  googleCalendarId: string,
  googleEventId: string
): Promise<void> {
  const { data: connection } = await admin.from("google_calendar_connections").select("*").eq("id", connectionId).maybeSingle();
  if (!connection) return; // Connection since removed - nothing to clean up on Google's side.
  const tokenResult = await ensureFreshToken(admin, connection);
  if ("error" in tokenResult) return;
  const res = await fetch(`${CALENDAR_API}/calendars/${encodeURIComponent(googleCalendarId)}/events/${encodeURIComponent(googleEventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${tokenResult.accessToken}` },
  });
  // 404/410 just means it's already gone on Google's side - fine either way.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const body = await res.text();
    console.error("[google-calendar-push] Failed to delete Google event", res.status, body);
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
  const { data: callerProfile } = await callerClient.from("profiles").select("tenant_id").eq("id", authData.user.id).single();
  if (!callerProfile) return json({ error: "unauthorized" }, 401);

  let payload: {
    operation: "upsert" | "delete";
    calendarEventId: string;
    deletedGoogleEventId?: string | null;
    deletedGoogleCalendarConnectionId?: string | null;
  };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  if (!payload.calendarEventId || (payload.operation !== "upsert" && payload.operation !== "delete")) {
    return json({ error: "invalid_body" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  if (payload.operation === "delete") {
    // The row is already gone from the DB by the time this is called - the
    // client must have captured google_event_id/google_calendar_connection_id
    // from the row BEFORE deleting it and pass them through here. Using the
    // service-role client to look these up bypasses RLS, so the tenant_id
    // check below is this function's own access control, not a formality -
    // without it, any authenticated user could pass an arbitrary
    // connection id belonging to a different tenant and trigger a delete
    // against someone else's Google Calendar.
    if (payload.deletedGoogleEventId && payload.deletedGoogleCalendarConnectionId) {
      const { data: connection } = await admin
        .from("google_calendar_connections")
        .select("google_calendar_id, tenant_id")
        .eq("id", payload.deletedGoogleCalendarConnectionId)
        .maybeSingle();
      if (connection && connection.tenant_id === callerProfile.tenant_id) {
        await deleteGoogleEvent(admin, payload.deletedGoogleCalendarConnectionId, connection.google_calendar_id, payload.deletedGoogleEventId);
      }
    }
    return json({ ok: true });
  }

  // operation === "upsert"
  const { data: row } = await admin.from("calendar_events").select("*").eq("id", payload.calendarEventId).maybeSingle();
  if (!row) return json({ ok: true }); // Already gone (e.g. deleted again right after) - nothing to do.
  if (row.tenant_id !== callerProfile.tenant_id) return json({ error: "forbidden" }, 403);
  if (row.source !== "app") return json({ ok: true }); // google_personal rows are never pushed back out.

  const assigneeProfileId = await resolveAssigneeProfileId(admin, row);
  if (!assigneeProfileId) return json({ ok: true, synced: false, reason: "no_assignee" });

  const { data: connection } = await admin
    .from("google_calendar_connections")
    .select("*")
    .eq("profile_id", assigneeProfileId)
    .maybeSingle();
  if (!connection) return json({ ok: true, synced: false, reason: "assignee_not_connected" });

  const tokenResult = await ensureFreshToken(admin, connection);
  if ("error" in tokenResult) return json({ ok: true, synced: false, reason: tokenResult.error });
  const accessToken = tokenResult.accessToken;

  const reassigned = row.google_calendar_connection_id && row.google_calendar_connection_id !== connection.id;

  if (reassigned && row.google_event_id) {
    // Google has no "move an event to a different account" operation -
    // delete from the previous assignee's calendar, then fall through to
    // create fresh in the new one below.
    const { data: oldConnection } = await admin
      .from("google_calendar_connections")
      .select("google_calendar_id")
      .eq("id", row.google_calendar_connection_id)
      .maybeSingle();
    if (oldConnection) {
      await deleteGoogleEvent(admin, row.google_calendar_connection_id, oldConnection.google_calendar_id, row.google_event_id);
    }
    row.google_event_id = null;
  }

  const eventBody = toGoogleEventBody(row);

  if (!row.google_event_id) {
    const res = await fetch(`${CALENDAR_API}/calendars/${encodeURIComponent(connection.google_calendar_id)}/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(eventBody),
    });
    const body = await res.json();
    if (!res.ok) {
      console.error("[google-calendar-push] Failed to create Google event", body);
      return json({ ok: false, error: "google_create_failed" }, 502);
    }
    await admin
      .from("calendar_events")
      .update({
        google_calendar_id: connection.google_calendar_id,
        google_event_id: body.id,
        google_calendar_connection_id: connection.id,
        last_synced_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return json({ ok: true, synced: true, created: true });
  }

  const res = await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(connection.google_calendar_id)}/events/${encodeURIComponent(row.google_event_id)}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(eventBody),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    console.error("[google-calendar-push] Failed to update Google event", res.status, body);
    return json({ ok: false, error: "google_update_failed" }, 502);
  }
  await admin.from("calendar_events").update({ last_synced_at: new Date().toISOString() }).eq("id", row.id);
  return json({ ok: true, synced: true, updated: true });
});
