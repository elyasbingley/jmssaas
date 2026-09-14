import { supabase } from "./supabase";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

// Best-effort outbound push to google-calendar-push, called right after a
// calendar_events write (and any linked job_cards.assigned_technician_id
// write) lands - same "insert then immediately call an Edge Function,
// swallow failures" shape as triggerImmediateDispatch() in dispatch-now.ts.
// google-calendar-reconcile's hourly sweep is the fallback for anything
// that fails here (network blip, Edge Function cold-start timeout, etc.),
// so a caught error here is never surfaced to the user - the local write
// already succeeded, which is what the UI actually reflects.
async function callPush(body: Record<string, unknown>): Promise<void> {
  if (!SUPABASE_URL) return;
  try {
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    if (!accessToken) return;
    await fetch(`${SUPABASE_URL}/functions/v1/google-calendar-push`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.warn("[google-calendar-sync] push failed, google-calendar-reconcile's hourly sweep will catch it", e);
  }
}

export async function pushCalendarEventUpsert(calendarEventId: string): Promise<void> {
  await callPush({ operation: "upsert", calendarEventId });
}

// Must be called with the google_event_id/google_calendar_connection_id
// captured from the row BEFORE it's deleted - once gone, there's nothing
// left in the DB to look them up from (see google-calendar-push's own
// comment on why the client, not the function, carries these through).
export async function pushCalendarEventDelete(
  calendarEventId: string,
  deletedGoogleEventId: string | null | undefined,
  deletedGoogleCalendarConnectionId: string | null | undefined
): Promise<void> {
  if (!deletedGoogleEventId || !deletedGoogleCalendarConnectionId) return;
  await callPush({
    operation: "delete",
    calendarEventId,
    deletedGoogleEventId,
    deletedGoogleCalendarConnectionId,
  });
}
