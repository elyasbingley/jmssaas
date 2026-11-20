import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { timerWrites, type TimerAction, type TimesheetActivity, type TimesheetShift } from "@jmssaas/shared";
import { supabase } from "./supabase";
import { useAuth } from "./auth-context";

// The desktop's own timer buttons (Timesheets > My Timesheet, and the job
// page) - the same clock on / clock off / start an activity rules the phone
// uses (@jmssaas/shared's timerWrites, unit tested there), written straight
// to the database instead of through PowerSync. Entries are marked
// source 'desktop': a computer has no location to stamp, and the reports
// say "From a computer" rather than "No location".

export const MY_TIMER_KEY = ["my-timer"];

async function fetchOpen(profileId: string) {
  const [shifts, activities] = await Promise.all([
    supabase.from("timesheet_shifts").select("*").eq("profile_id", profileId).is("ended_at", null).order("started_at"),
    supabase.from("timesheet_activities").select("*").eq("profile_id", profileId).is("ended_at", null).order("started_at"),
  ]);
  if (shifts.error) throw shifts.error;
  if (activities.error) throw activities.error;
  return { openShifts: (shifts.data ?? []) as TimesheetShift[], openActivities: (activities.data ?? []) as TimesheetActivity[] };
}

export function useTimesheetTimer() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [...MY_TIMER_KEY, profile?.id],
    queryFn: () => fetchOpen(profile!.id),
    enabled: !!profile,
    // Picks up a clock-on made on the phone without a reload.
    refetchInterval: 60_000,
  });

  const mutation = useMutation({
    mutationFn: async (action: TimerAction) => {
      if (!profile) throw new Error("Not signed in");
      // Fresh state, not what's on screen - the phone may have changed it.
      const state = await fetchOpen(profile.id);
      const writes = timerWrites(state, action);
      const at = new Date().toISOString();
      for (const write of writes) {
        if (write.kind === "open_shift") {
          const { error } = await supabase.from("timesheet_shifts").insert({
            id: crypto.randomUUID(),
            tenant_id: profile.tenant_id,
            profile_id: profile.id,
            started_at: at,
            source: "desktop",
          });
          if (error) throw error;
        } else if (write.kind === "open_activity") {
          const { error } = await supabase.from("timesheet_activities").insert({
            id: crypto.randomUUID(),
            tenant_id: profile.tenant_id,
            profile_id: profile.id,
            activity_type: write.activityType,
            job_card_id: write.jobCardId,
            started_at: at,
            source: "desktop",
          });
          if (error) throw error;
        } else {
          const table = write.kind === "close_shift" ? "timesheet_shifts" : "timesheet_activities";
          const { error } = await supabase.from(table).update({ ended_at: at }).eq("id", write.id);
          if (error) throw error;
        }
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: MY_TIMER_KEY });
      queryClient.invalidateQueries({ queryKey: ["analytics", "timesheets"] });
    },
  });

  const perform = useCallback((action: TimerAction) => mutation.mutate(action), [mutation]);

  return {
    shift: query.data?.openShifts[0] ?? null,
    activity: query.data?.openActivities[0] ?? null,
    loading: query.isLoading,
    busy: mutation.isPending,
    error: mutation.error ?? query.error,
    perform,
  };
}
