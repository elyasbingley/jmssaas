import { supabase } from "./supabase";

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;

// Port of apps/desktop's lib/google-calendar-sync.ts - identical behavior
// (best-effort immediate push, swallows every failure, google-calendar-
// reconcile's hourly sweep is always the fallback), just EXPO_PUBLIC_
// instead of VITE_ for the env var, same as dispatch-now.ts's own port.
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
