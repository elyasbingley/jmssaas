import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { CalendarEvent, Client, JobCard, JobLifecycleStage, Profile } from "@jmssaas/shared";
import { useAuth } from "../lib/auth-context";
import { useIsOnline } from "../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../lib/use-supabase-fetch";
import { supabase } from "../lib/supabase";
import { addDays, formatEventTimeRange, isSameDay } from "../lib/datetime";
import { formatClientAddress } from "../lib/format";
import { RequiresConnectionNotice } from "../components/RequiresConnectionNotice";

type JobCardRow = JobCard & { clients: Client | null };
type CalendarEventRow = CalendarEvent & { job_cards: JobCardRow | null };

// Dispatch MVP - see docs/SETUP.md "Schedule / dispatch board" for the full
// writeup of why this is a tap-to-assign list view rather than the
// drag-and-drop timeline grid the original reference spec described (no
// desktop app exists yet to make that interaction pattern viable), and why
// calendar_events (not a new field on job_cards) is the source of truth
// for "when is this job happening."
//
// Reached via a small admin-only link on the Calendar tab rather than its
// own tab or a Home tile - it's fundamentally a different view over
// calendar_events (who's got what, not just what's on what day), and
// Home's tile grid deliberately only mirrors the actual tab bar (see
// app/(tabs)/index.tsx's own comment). Admin-only, same as every other
// assignment/creation action in this app - technicians see their own
// schedule via the ordinary Calendar tab.
export default function ScheduleScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";

  const { data, loading, refetch } = useSupabaseFetch(async () => {
    const [
      { data: jobCards, error: jobsError },
      { data: technicians, error: techError },
      { data: events, error: eventsError },
      { data: stages, error: stagesError },
    ] = await Promise.all([
      supabase.from("job_cards").select("*, clients(*)").order("created_at", { ascending: false }),
      supabase.from("profiles").select("*").eq("role", "technician").order("full_name"),
      supabase
        .from("calendar_events")
        .select("*, job_cards(*, clients(*))")
        .not("job_card_id", "is", null)
        .order("start_at", { ascending: true }),
      supabase.from("job_lifecycle_stages").select("*"),
    ]);
    if (jobsError) throw jobsError;
    if (techError) throw techError;
    if (eventsError) throw eventsError;
    if (stagesError) throw stagesError;
    return {
      jobCards: (jobCards ?? []) as JobCardRow[],
      technicians: (technicians ?? []) as Profile[],
      events: (events ?? []) as CalendarEventRow[],
      stages: (stages ?? []) as JobLifecycleStage[],
    };
  }, [isOnline]);
  useRefetchOnFocus(refetch);

  const [selectedDate, setSelectedDate] = useState(new Date());

  // "Unassigned" = no calendar event linking this job that's still in the
  // future - a job whose only scheduled visit already happened is back in
  // the queue, same as one that was never scheduled at all. Jobs already in
  // a closed stage (is_closed on job_lifecycle_stages - the default
  // Completed/Invoiced stages, or any custom stage an admin marks the same
  // way) are excluded since there's nothing left to dispatch.
  const unassignedJobs = useMemo(() => {
    if (!data) return [];
    const now = new Date();
    const scheduledJobIds = new Set(
      data.events.filter((e) => new Date(e.start_at) >= now).map((e) => e.job_card_id)
    );
    const closedStageIds = new Set(data.stages.filter((s) => s.is_closed).map((s) => s.id));
    return data.jobCards.filter(
      (job) => !scheduledJobIds.has(job.id) && !closedStageIds.has(job.lifecycle_stage_id ?? "")
    );
  }, [data]);

  const stageById = useMemo(() => new Map((data?.stages ?? []).map((s) => [s.id, s])), [data]);

  const eventsByTechnician = useMemo(() => {
    const map = new Map<string, CalendarEventRow[]>();
    if (!data) return map;
    for (const event of data.events) {
      if (!isSameDay(new Date(event.start_at), selectedDate)) continue;
      const techId = event.job_cards?.assigned_technician_id;
      if (!techId) continue;
      if (!map.has(techId)) map.set(techId, []);
      map.get(techId)!.push(event);
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
    }
    return map;
  }, [data, selectedDate]);

  const goToUnassignedJob = (job: JobCardRow) => {
    router.push({
      pathname: "/calendar/new",
      params: { jobCardId: job.id, date: selectedDate.toISOString().slice(0, 10) },
    });
  };

  if (!isAdmin) {
    return (
      <View style={styles.container}>
        <Text style={styles.empty}>Only admins can view the schedule.</Text>
      </View>
    );
  }

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Schedule" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <View style={styles.navRow}>
        <Pressable onPress={() => setSelectedDate((d) => addDays(d, -1))} style={styles.navButton}>
          <Text style={styles.navButtonText}>‹</Text>
        </Pressable>
        <Pressable onPress={() => setSelectedDate(new Date())} style={styles.navHeading}>
          <Text style={styles.navHeadingText}>
            {selectedDate.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })}
          </Text>
        </Pressable>
        <Pressable onPress={() => setSelectedDate((d) => addDays(d, 1))} style={styles.navButton}>
          <Text style={styles.navButtonText}>›</Text>
        </Pressable>
      </View>

      {loading || !data ? (
        <Text style={styles.empty}>Loading...</Text>
      ) : (
        <>
          <Text style={styles.sectionTitle}>Unassigned jobs</Text>
          {unassignedJobs.length === 0 ? (
            <Text style={styles.empty}>Nothing waiting to be scheduled.</Text>
          ) : (
            unassignedJobs.map((job) => {
              const stage = stageById.get(job.lifecycle_stage_id ?? "");
              return (
                <Pressable key={job.id} style={styles.jobRow} onPress={() => goToUnassignedJob(job)}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.jobTitle}>{job.title}</Text>
                    <Text style={styles.jobSubtitle}>{job.clients?.name ?? "Unknown client"}</Text>
                    {job.clients && formatClientAddress(job.clients) ? (
                      <Text style={styles.jobSubtitle}>{formatClientAddress(job.clients)}</Text>
                    ) : null}
                  </View>
                  {stage ? <Text style={styles.jobStatusBadge}>{stage.name}</Text> : null}
                </Pressable>
              );
            })
          )}

          <Text style={styles.sectionTitle}>Technicians</Text>
          {data.technicians.length === 0 ? (
            <Text style={styles.empty}>No technicians yet.</Text>
          ) : (
            data.technicians.map((tech) => {
              const techEvents = eventsByTechnician.get(tech.id) ?? [];
              return (
                <View key={tech.id} style={styles.techSection}>
                  <Text style={styles.techName}>{tech.full_name}</Text>
                  {techEvents.length === 0 ? (
                    <Text style={styles.techEmpty}>No jobs scheduled.</Text>
                  ) : (
                    techEvents.map((event) => (
                      <Pressable key={event.id} style={styles.eventRow} onPress={() => router.push(`/calendar/${event.id}`)}>
                        <Text style={styles.eventTime}>{formatEventTimeRange(event.start_at, event.end_at, event.all_day)}</Text>
                        <Text style={styles.eventTitle}>{event.job_cards?.title ?? event.title}</Text>
                        {event.job_cards?.clients?.name ? (
                          <Text style={styles.eventSubtitle}>{event.job_cards.clients.name}</Text>
                        ) : null}
                      </Pressable>
                    ))
                  )}
                </View>
              );
            })
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 16,
  },
  navButton: { padding: 8 },
  navButtonText: { fontSize: 22, color: "#1d4ed8", fontWeight: "700" },
  navHeading: { flex: 1, alignItems: "center" },
  navHeadingText: { fontSize: 16, fontWeight: "700" },
  sectionTitle: { fontWeight: "700", color: "#6b7280", marginTop: 20, marginBottom: 10 },
  jobRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#f0f0f0",
  },
  jobTitle: { fontSize: 15, fontWeight: "600", color: "#111827" },
  jobSubtitle: { fontSize: 13, color: "#6b7280", marginTop: 2 },
  jobStatusBadge: { color: "#1d4ed8", fontWeight: "600", fontSize: 12 },
  techSection: { marginBottom: 18 },
  techName: { fontWeight: "700", color: "#111827", fontSize: 15, marginBottom: 6 },
  techEmpty: { color: "#9ca3af", fontSize: 13 },
  eventRow: { paddingVertical: 8, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: "#1d4ed8", marginBottom: 4 },
  eventTime: { color: "#1d4ed8", fontWeight: "600", fontSize: 12 },
  eventTitle: { fontSize: 15, fontWeight: "600", color: "#111827", marginTop: 2 },
  eventSubtitle: { fontSize: 13, color: "#6b7280", marginTop: 1 },
  empty: { textAlign: "center", color: "#6b7280", padding: 16 },
});
