import { useEffect } from "react";
import type { Notification } from "@jmssaas/shared";
import { supabase } from "./supabase";
import { useAuth } from "./auth-context";
import { useSupabaseFetch, useRefetchOnFocus } from "./use-supabase-fetch";

// Supabase-direct/polled, not PowerSync - see the notifications migration's
// own comment for why. Same 8s polling interval already used for Channels'
// list/open-conversation screens (see those fixes' own commits) - a push
// notification is the "even if the app's closed" signal; this is what
// keeps the tab's own badge/list current while it's actually open.
const POLL_INTERVAL_MS = 8000;

async function fetchNotifications(profileId: string): Promise<Notification[]> {
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return data as Notification[];
}

export function useNotifications() {
  const { profile } = useAuth();
  const { data, loading, error, refetch } = useSupabaseFetch<Notification[]>(async () => {
    if (!profile) return [];
    return fetchNotifications(profile.id);
  }, [profile?.id]);

  useRefetchOnFocus(refetch);

  useEffect(() => {
    const interval = setInterval(() => refetch(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refetch]);

  const markRead = async (id: string) => {
    const { error: updateError } = await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id);
    if (updateError) {
      console.error("[use-notifications] Failed to mark notification read", updateError);
      return;
    }
    refetch();
  };

  return { notifications: data ?? [], loading, error, refetch, markRead };
}

// Lightweight count-only poll for the tab bar badge (app/(tabs)/_layout.tsx)
// - a separate query from useNotifications' full list, kept simple rather
// than threading one shared hook's state across two independent screens.
export function useUnreadNotificationCount(): number {
  const { profile } = useAuth();
  const { data, refetch } = useSupabaseFetch<number>(async () => {
    if (!profile) return 0;
    const { count, error } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profile.id)
      .is("read_at", null);
    if (error) throw error;
    return count ?? 0;
  }, [profile?.id]);

  useEffect(() => {
    const interval = setInterval(() => refetch(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refetch]);

  return data ?? 0;
}
