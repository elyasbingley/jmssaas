import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import type { CalendarEvent, Client, JobCard, JobLifecycleStage, Profile } from "@jmssaas/shared";
import { useAuth } from "../lib/auth-context";
import { useIsOnline } from "../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../lib/use-supabase-fetch";
import { supabase } from "../lib/supabase";
import { addDays, formatEventTimeRange, isSameDay } from "../lib/datetime";
import { formatClientAddress } from "../lib/format";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../components/theme/ThemedRequiresConnectionNotice";

type JobCardRow = JobCard & { clients: Client | null };
type CalendarEventRow = CalendarEvent & { job_cards: JobCardRow | null };

// Dispatch MVP - see docs/SETUP.md "Schedule / dispatch board" for the full
// writeup of why this is a tap-to-assign list view rather than the
// drag-and-drop timeline grid the original reference spec described (no
// desktop app exists yet to make that interaction pattern viable), and why
// calendar_events (not a new field on job_cards) is the source of truth
// for "when is this job happening."
//
// Reached via More rather than its own tab or a Home tile - it's
// fundamentally a different view over calendar_events (who's got what, not
// just what's on what day). Admin-only, same as every other assignment/
// creation action in this app - technicians see their own schedule via the
// ordinary Calendar tab.
export default function ScheduleScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";
  const styles = useThemedStyles(createStyles);

  const { data, loading, refetch } = useSupabaseFetch(async () => {
    const [
      { data: jobCards, error: jobsError },
      { data: technicians, error: techError },
      { data: events, error: eventsError },
      { data: stages, error: stagesError },
    ] = await Promise.all([
      supabase.from("job_cards").select("*, clients(*)").order("created_at", { ascending: false }),
      // Any profile can be dispatched a job - not just role='technician' -
      // so an admin who also does field work can assign jobs to themselves.
      supabase.from("profiles").select("*").order("full_name"),
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

  // "Unassigned" = no calendar event linking this job scheduled today or
  // later - a job whose only scheduled visit is a past *day* is back in
  // the queue, same as one that was never scheduled at all. Compared
  // against the start of today, not the exact current moment: comparing
  // against "now" meant a job scheduled for later today at a time earlier
  // than the current clock time (e.g. this screen's own "new event"
  // default of 9am, picked mid-afternoon) was already "in the past" the
  // instant it was created, so it never left this list - the "assign an
  // unassigned job but it stays in Unassigned" bug. Jobs already in a
  // closed stage (is_closed on job_lifecycle_stages - the default
  // Completed/Invoiced stages, or any custom stage an admin marks the same
  // way) are excluded since there's nothing left to dispatch.
  const unassignedJobs = useMemo(() => {
    if (!data) return [];
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const scheduledJobIds = new Set(
      data.events.filter((e) => new Date(e.start_at) >= startOfToday).map((e) => e.job_card_id)
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

  const header = (
    <View style={styles.header}>
      <Pressable onPress={() => router.back()} hitSlop={8}>
        <Text style={styles.link}>‹ Back</Text>
      </Pressable>
      <Text style={styles.title}>Schedule / Dispatch</Text>
    </View>
  );

  if (!isAdmin) {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
          {header}
          <Text style={styles.empty}>Only admins can view the schedule.</Text>
        </SafeAreaView>
      </>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        {header}
        {!isOnline ? (
          <ThemedRequiresConnectionNotice label="Schedule" />
        ) : (
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
                <Text style={styles.sectionTitle}>Unassigned Jobs</Text>
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
        )}
      </SafeAreaView>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    screen: { flex: 1, backgroundColor: tokens.background },
    container: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 6 },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    title: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    navRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingBottom: 16,
    },
    navButton: { padding: 8 },
    navButtonText: { fontSize: 22, color: tokens.accent, fontWeight: "700" as const, ...mono },
    navHeading: { flex: 1, alignItems: "center" as const },
    navHeadingText: { fontSize: font.body, fontWeight: "700" as const, color: tokens.textPrimary, ...mono },
    sectionTitle: {
      fontSize: font.label,
      fontWeight: "700" as const,
      color: tokens.accent,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      marginTop: 20,
      marginBottom: 10,
      ...mono,
    },
    jobRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    jobTitle: { fontSize: font.body - 1, fontWeight: "600" as const, color: tokens.textPrimary, ...mono },
    jobSubtitle: { fontSize: font.label, color: tokens.textMuted, marginTop: 2, ...mono },
    jobStatusBadge: { color: tokens.accent, fontWeight: "600" as const, fontSize: font.label, ...mono },
    techSection: { marginBottom: 18 },
    techName: { fontWeight: "700" as const, color: tokens.textPrimary, fontSize: font.body - 1, marginBottom: 6, ...mono },
    techEmpty: { color: tokens.textMuted, fontSize: font.label, ...mono },
    eventRow: { paddingVertical: 8, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: tokens.accent, marginBottom: 4 },
    eventTime: { color: tokens.accent, fontWeight: "600" as const, fontSize: font.label - 1, ...mono },
    eventTitle: { fontSize: font.body - 1, fontWeight: "600" as const, color: tokens.textPrimary, marginTop: 2, ...mono },
    eventSubtitle: { fontSize: font.label, color: tokens.textMuted, marginTop: 1, ...mono },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 16, ...mono },
  };
}
