import { supabase } from "./supabase";

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;

// Best-effort "send this right now" call to the process-scheduled-comms
// Edge Function's immediate-dispatch path (POST { id } with the caller's
// own session token, not the service-role key the cron sweep uses - see
// that function's own comment). Used right after queueing an "On The Way"/
// review-request row so it goes out immediately instead of waiting for the
// next cron tick, since those are time-sensitive in a way quote/invoice
// follow-ups aren't.
//
// Deliberately swallows every failure (no network, function cold-started
// and timed out, provider not configured, ...) rather than surfacing an
// error to the caller - the row is already safely queued in
// scheduled_communications either way, and the cron sweep will pick it up
// on its own regardless of whether this call succeeds. This is a latency
// optimisation only, never a correctness requirement, so a failure here
// should never look like the message itself failed to queue.
export async function triggerImmediateDispatch(scheduledCommunicationId: string): Promise<boolean> {
  if (!SUPABASE_URL) return false;
  try {
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    if (!accessToken) return false;

    const res = await fetch(`${SUPABASE_URL}/functions/v1/process-scheduled-comms`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: scheduledCommunicationId }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { outcome?: string };
    return body.outcome === "sent";
  } catch (e) {
    console.warn("[dispatch-now] Immediate dispatch failed, will fall back to the next cron sweep", e);
    return false;
  }
}
