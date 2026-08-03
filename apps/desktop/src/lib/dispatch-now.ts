import { supabase } from "./supabase";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

// Port of apps/mobile/lib/dispatch-now.ts - identical behavior (best-effort
// immediate send, swallows every failure, the cron sweep is always the
// fallback), just VITE_ instead of EXPO_PUBLIC_ for the env var.
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
