import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { v4 as uuidv4 } from "uuid";
import { usePowerSync, useQuery } from "@powersync/react";
import {
  SHIFT_FLAG_LABELS,
  TIMESHEET_ACTIVITY_LABELS,
  TIMESHEET_ACTIVITY_TYPES,
  addDays,
  dayKeyOfDate,
  entryMinutes,
  formatMinutes,
  summariseShifts,
  toDayKey,
  weekStartOf,
  type ShiftSummary,
  type TimesheetActivity,
  type TimesheetActivityType,
  type TimesheetShift,
  type TimesheetWeekApproval,
} from "@jmssaas/shared";
import { useAuth } from "../lib/auth-context";
import { useNow } from "../lib/use-timesheet";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedDateField } from "../components/theme/ThemedDateField";
import { ThemedFormField } from "../components/theme/ThemedFormField";
import { ThemedPickerModal } from "../components/theme/ThemedPickerModal";
import { ThemedButton } from "../components/theme/ThemedButton";

// "My Timesheet": one person's own week - every shift, what the time in it
// went on, and the paid total - with the means to fix it: change a time,
// add something that was missed, delete a mistake. All local (PowerSync),
// so it works offline like the timers.
//
// A week an admin has approved is locked. The approval rows are synced to
// the device so this screen can say so without a connection; the database
// independently ignores any change to an approved week, so the lock holds
// even if this screen is somehow bypassed.

type JobOption = { id: string; number: string | null; title: string };

type Editing =
  | { kind: "shift"; entry: TimesheetShift | null }
  | { kind: "activity"; entry: TimesheetActivity | null };

const localMidnightIso = (dayKey: string) => new Date(`${dayKey}T00:00:00`).toISOString();
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
const dayHeading = (dayKey: string) => new Date(`${dayKey}T00:00:00`).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "short" });
const jobLabel = (job: JobOption | undefined) => (job ? `${job.number ?? "Pending"} - ${job.title}` : "a job that's no longer on this phone");

export default function TimesheetScreen() {
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const styles = useThemedStyles(createStyles);
  const now = useNow();
  const profileId = profile?.id ?? "";

  const [weekStart, setWeekStart] = useState(() => weekStartOf(dayKeyOfDate(new Date())));
  const weekEnd = addDays(weekStart, 6);
  const isCurrentWeek = weekStart === weekStartOf(toDayKey(now));

  // A day either side, so an activity that started just before a shift (or
  // a shift running past Sunday midnight) is still loaded.
  const from = localMidnightIso(addDays(weekStart, -1));
  const to = localMidnightIso(addDays(weekStart, 8));
  const { data: shifts } = useQuery<TimesheetShift>(
    "SELECT * FROM timesheet_shifts WHERE profile_id = ? AND started_at >= ? AND started_at < ? ORDER BY started_at",
    [profileId, from, to]
  );
  const { data: activities } = useQuery<TimesheetActivity>(
    "SELECT * FROM timesheet_activities WHERE profile_id = ? AND started_at >= ? AND started_at < ? ORDER BY started_at",
    [profileId, from, to]
  );
  const { data: approvals } = useQuery<TimesheetWeekApproval>("SELECT * FROM timesheet_week_approvals WHERE profile_id = ?", [profileId]);
  const { data: jobs } = useQuery<JobOption>("SELECT id, number, title FROM job_cards ORDER BY created_at DESC");
  const jobById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const approvedWeeks = useMemo(() => new Set(approvals.map((a) => a.week_start)), [approvals]);
  const locked = approvedWeeks.has(weekStart);

  const summaries = useMemo(
    () => summariseShifts(shifts, activities, { from: weekStart, to: weekEnd }, now).reverse(),
    [shifts, activities, weekStart, weekEnd, now]
  );
  // Activities this week that don't sit inside any shift - logged without
  // being clocked on, or left behind when a shift's times were changed.
  const looseActivities = useMemo(() => {
    const inShift = new Set(summaries.flatMap((s) => s.activities.map((a) => a.id)));
    return activities.filter((a) => {
      const day = toDayKey(a.started_at);
      return !inShift.has(a.id) && day >= weekStart && day <= weekEnd;
    });
  }, [activities, summaries, weekStart, weekEnd]);

  const days = useMemo(() => {
    const byDay = new Map<string, ShiftSummary[]>();
    for (const summary of summaries) byDay.set(summary.day, [...(byDay.get(summary.day) ?? []), summary]);
    return [...byDay.entries()];
  }, [summaries]);
  const paidMinutes = summaries.reduce((sum, s) => sum + s.paidMinutes, 0);
  const breakMinutes = summaries.reduce((sum, s) => sum + s.breakMinutes, 0);
  const jobMinutes = summaries.reduce((sum, s) => sum + s.minutesByType.job, 0);

  // --- add / edit ---
  const [editing, setEditing] = useState<Editing | null>(null);
  const [start, setStart] = useState<Date | null>(null);
  const [end, setEnd] = useState<Date | null>(null);
  const [note, setNote] = useState("");
  const [activityType, setActivityType] = useState<TimesheetActivityType>("job");
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobPickerOpen, setJobPickerOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const openEditor = (next: Editing) => {
    const entry = next.entry;
    // A new entry defaults to the week being looked at, not always today.
    const defaultDay = isCurrentWeek ? toDayKey(now) : weekStart;
    setStart(entry ? new Date(entry.started_at) : new Date(`${defaultDay}T07:00:00`));
    setEnd(entry ? (entry.ended_at ? new Date(entry.ended_at) : null) : new Date(`${defaultDay}T15:00:00`));
    setNote(entry?.note ?? "");
    setActivityType(next.kind === "activity" && next.entry ? next.entry.activity_type : "job");
    setJobId(next.kind === "activity" && next.entry ? next.entry.job_card_id : null);
    setFormError(null);
    setEditing(next);
  };

  const isLockedDay = (date: Date) => approvedWeeks.has(weekStartOf(dayKeyOfDate(date)));

  const save = async () => {
    if (!editing || !profile || !start) return;
    const running = editing.entry !== null && editing.entry.ended_at === null && end === null;
    if (!running && !end) return setFormError("Set a finish time.");
    if (end && end.getTime() <= start.getTime()) return setFormError("The finish time has to be after the start time.");
    if (isLockedDay(start)) return setFormError("That week has been approved and is locked. Ask an admin to reopen it.");
    if (editing.kind === "activity" && activityType === "job" && !jobId) return setFormError("Choose which job this time was on.");

    const startedAt = start.toISOString();
    const endedAt = end ? end.toISOString() : null;
    const stamp = new Date().toISOString();
    const trimmedNote = note.trim() || null;

    if (editing.entry) {
      if (editing.kind === "activity") {
        await powersync.execute(
          "UPDATE timesheet_activities SET started_at = ?, ended_at = ?, note = ?, activity_type = ?, job_card_id = ?, updated_at = ? WHERE id = ?",
          [startedAt, endedAt, trimmedNote, activityType, activityType === "job" ? jobId : null, stamp, editing.entry.id]
        );
      } else {
        await powersync.execute("UPDATE timesheet_shifts SET started_at = ?, ended_at = ?, note = ?, updated_at = ? WHERE id = ?", [
          startedAt,
          endedAt,
          trimmedNote,
          stamp,
          editing.entry.id,
        ]);
      }
    } else if (editing.kind === "activity") {
      await powersync.execute(
        "INSERT INTO timesheet_activities (id, tenant_id, profile_id, activity_type, job_card_id, started_at, ended_at, source, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)",
        [uuidv4(), profile.tenant_id, profile.id, activityType, activityType === "job" ? jobId : null, startedAt, endedAt, trimmedNote, stamp, stamp]
      );
    } else {
      await powersync.execute(
        "INSERT INTO timesheet_shifts (id, tenant_id, profile_id, started_at, ended_at, source, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?)",
        [uuidv4(), profile.tenant_id, profile.id, startedAt, endedAt, trimmedNote, stamp, stamp]
      );
    }
    setEditing(null);
  };

  const confirmDelete = () => {
    if (!editing?.entry) return;
    const { kind, entry } = editing;
    Alert.alert(kind === "shift" ? "Delete this shift?" : "Delete this activity?", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await powersync.execute(`DELETE FROM ${kind === "shift" ? "timesheet_shifts" : "timesheet_activities"} WHERE id = ?`, [entry.id]);
          setEditing(null);
        },
      },
    ]);
  };

  const activityLine = (activity: TimesheetActivity) =>
    `${activity.activity_type === "job" ? jobLabel(jobById.get(activity.job_card_id ?? "")) : TIMESHEET_ACTIVITY_LABELS[activity.activity_type]}`;

  const renderActivity = (activity: TimesheetActivity) => (
    <Pressable key={activity.id} style={styles.activityRow} disabled={locked} onPress={() => openEditor({ kind: "activity", entry: activity })}>
      <Text style={styles.activityName} numberOfLines={1}>
        {activityLine(activity)}
      </Text>
      <Text style={styles.activityTime}>
        {clock(activity.started_at)} - {activity.ended_at ? clock(activity.ended_at) : "now"} · {formatMinutes(entryMinutes(activity, now))}
        {activity.edited_at ? " · edited" : ""}
      </Text>
    </Pressable>
  );

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>My Timesheet</Text>
        </View>

        <View style={styles.weekBar}>
          <Pressable onPress={() => setWeekStart(addDays(weekStart, -7))} hitSlop={10}>
            <Text style={styles.weekArrow}>‹</Text>
          </Pressable>
          <Text style={styles.weekLabel}>
            {dayHeading(weekStart).replace(/^\w+ /, "")} - {dayHeading(weekEnd).replace(/^\w+ /, "")}
          </Text>
          <Pressable onPress={() => setWeekStart(addDays(weekStart, 7))} disabled={isCurrentWeek} hitSlop={10}>
            <Text style={[styles.weekArrow, isCurrentWeek && styles.dim]}>›</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
          <View style={styles.totals}>
            <View style={styles.total}>
              <Text style={styles.totalLabel}>Paid</Text>
              <Text style={styles.totalValue}>{formatMinutes(paidMinutes)}</Text>
            </View>
            <View style={styles.total}>
              <Text style={styles.totalLabel}>On jobs</Text>
              <Text style={styles.totalValue}>{formatMinutes(jobMinutes)}</Text>
            </View>
            <View style={styles.total}>
              <Text style={styles.totalLabel}>Breaks</Text>
              <Text style={styles.totalValue}>{formatMinutes(breakMinutes)}</Text>
            </View>
          </View>

          {locked ? (
            <Text style={styles.lockedNotice}>This week has been approved and is locked. Ask an admin to reopen it if something is wrong.</Text>
          ) : (
            <View style={styles.addRow}>
              <View style={{ flex: 1 }}>
                <ThemedButton label="+ Add shift" variant="secondary" onPress={() => openEditor({ kind: "shift", entry: null })} />
              </View>
              <View style={{ flex: 1 }}>
                <ThemedButton label="+ Add activity" variant="secondary" onPress={() => openEditor({ kind: "activity", entry: null })} />
              </View>
            </View>
          )}

          {days.length === 0 && looseActivities.length === 0 ? <Text style={styles.empty}>Nothing recorded this week.</Text> : null}

          {days.map(([day, daySummaries]) => (
            <View key={day} style={styles.day}>
              <View style={styles.dayHeader}>
                <Text style={styles.dayTitle}>{dayHeading(day)}</Text>
                <Text style={styles.dayTotal}>{formatMinutes(daySummaries.reduce((sum, s) => sum + s.paidMinutes, 0))} paid</Text>
              </View>
              {daySummaries.map((summary) => (
                <View key={summary.shift.id} style={styles.shiftCard}>
                  <Pressable disabled={locked} onPress={() => openEditor({ kind: "shift", entry: summary.shift })}>
                    <Text style={styles.shiftTimes}>
                      {clock(summary.shift.started_at)} - {summary.shift.ended_at ? clock(summary.shift.ended_at) : "still clocked on"}
                    </Text>
                    <Text style={styles.shiftMeta}>
                      {formatMinutes(summary.paidMinutes)} paid
                      {summary.breakMinutes > 0 ? ` · ${formatMinutes(summary.breakMinutes)} break` : ""}
                      {summary.unallocatedMinutes >= 1 ? ` · ${formatMinutes(summary.unallocatedMinutes)} not logged to anything` : ""}
                    </Text>
                    {summary.flags.filter((f) => f !== "running" && f !== "no_location").length > 0 ? (
                      <Text style={styles.flags}>
                        {summary.flags
                          .filter((f) => f !== "running" && f !== "no_location")
                          .map((f) => SHIFT_FLAG_LABELS[f])
                          .join(" · ")}
                      </Text>
                    ) : null}
                  </Pressable>
                  {summary.activities.map(renderActivity)}
                </View>
              ))}
            </View>
          ))}

          {looseActivities.length > 0 ? (
            <View style={styles.day}>
              <View style={styles.dayHeader}>
                <Text style={styles.dayTitle}>Not inside a shift</Text>
              </View>
              <Text style={styles.looseNote}>Logged while clocked off, so it isn't in your paid hours. Add or widen a shift to cover it.</Text>
              <View style={styles.shiftCard}>
                {looseActivities.map((activity) => (
                  <View key={activity.id}>
                    <Text style={styles.looseDay}>{dayHeading(toDayKey(activity.started_at))}</Text>
                    {renderActivity(activity)}
                  </View>
                ))}
              </View>
            </View>
          ) : null}
        </ScrollView>
      </SafeAreaView>

      <ThemedModal visible={editing !== null} onClose={() => setEditing(null)}>
        <Text style={styles.modalTitle}>
          {editing?.entry ? "Edit" : "Add"} {editing?.kind === "shift" ? "shift" : "activity"}
        </Text>
        {editing?.kind === "activity" ? (
          <>
            <View style={styles.typeRow}>
              {TIMESHEET_ACTIVITY_TYPES.map((type) => (
                <Pressable key={type} style={[styles.typeChip, activityType === type && styles.typeChipActive]} onPress={() => setActivityType(type)}>
                  <Text style={[styles.typeChipText, activityType === type && styles.typeChipTextActive]}>{TIMESHEET_ACTIVITY_LABELS[type]}</Text>
                </Pressable>
              ))}
            </View>
            {activityType === "job" ? (
              <Pressable style={styles.jobField} onPress={() => setJobPickerOpen(true)}>
                <Text style={styles.jobFieldLabel}>Job</Text>
                <Text style={styles.jobFieldValue}>{jobId ? jobLabel(jobById.get(jobId)) : "Choose a job..."}</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}
        <ThemedDateField label="Start" mode="datetime" value={start} onChange={setStart} />
        <ThemedDateField label="Finish" mode="datetime" value={end} onChange={setEnd} placeholder="Still running" />
        <ThemedFormField label="Note (optional)" value={note} onChangeText={setNote} />
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <View style={styles.modalButtons}>
          <ThemedButton label="Save" onPress={() => void save()} />
          {editing?.entry ? <ThemedButton label="Delete" variant="danger" onPress={confirmDelete} /> : null}
          <ThemedButton label="Cancel" variant="secondary" onPress={() => setEditing(null)} />
        </View>
      </ThemedModal>

      <ThemedPickerModal
        visible={jobPickerOpen}
        title="Which job?"
        items={jobs}
        getLabel={(job) => jobLabel(job)}
        getKey={(job) => job.id}
        onSelect={(job) => {
          setJobId(job.id);
          setJobPickerOpen(false);
        }}
        onClose={() => setJobPickerOpen(false)}
      />
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, gap: 6 },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    title: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    weekBar: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, paddingHorizontal: 16, paddingVertical: 12 },
    weekArrow: { color: tokens.accent, fontSize: 28, fontWeight: "700" as const, paddingHorizontal: 8, ...mono },
    weekLabel: { color: tokens.textPrimary, fontSize: font.body, fontWeight: "700" as const, ...mono },
    dim: { opacity: 0.3 },
    totals: { flexDirection: "row" as const, gap: 8, paddingHorizontal: 16 },
    total: { flex: 1, borderWidth: 1, borderColor: tokens.border, borderRadius: 4, backgroundColor: tokens.surface, padding: 12, gap: 4 },
    totalLabel: { color: tokens.textMuted, fontSize: font.label, fontWeight: "700" as const, textTransform: "uppercase" as const, letterSpacing: 1, ...mono },
    totalValue: { color: tokens.textPrimary, fontSize: font.body + 3, fontWeight: "800" as const, ...mono },
    addRow: { flexDirection: "row" as const, gap: 8, paddingHorizontal: 16, paddingTop: 12 },
    lockedNotice: { marginHorizontal: 16, marginTop: 12, padding: 12, borderWidth: 1, borderColor: tokens.accent, borderRadius: 4, color: tokens.textPrimary, fontSize: font.label, ...mono },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 32, ...mono },
    day: { paddingHorizontal: 16, paddingTop: 20 },
    dayHeader: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "baseline" as const, marginBottom: 8 },
    dayTitle: { color: tokens.textPrimary, fontSize: font.body, fontWeight: "700" as const, ...mono },
    dayTotal: { color: tokens.textMuted, fontSize: font.label, ...mono },
    shiftCard: { borderWidth: 1, borderColor: tokens.border, borderRadius: 4, backgroundColor: tokens.surface, padding: 12, marginBottom: 8, gap: 8 },
    shiftTimes: { color: tokens.textPrimary, fontSize: font.body, fontWeight: "700" as const, ...mono },
    shiftMeta: { color: tokens.textMuted, fontSize: font.label, marginTop: 2, ...mono },
    flags: { color: tokens.warning, fontSize: font.label, marginTop: 2, ...mono },
    activityRow: { borderTopWidth: 1, borderTopColor: tokens.border, paddingTop: 8 },
    activityName: { color: tokens.textPrimary, fontSize: font.body - 1, ...mono },
    activityTime: { color: tokens.textMuted, fontSize: font.label, marginTop: 2, ...mono },
    looseNote: { color: tokens.textMuted, fontSize: font.label, marginBottom: 8, ...mono },
    looseDay: { color: tokens.textMuted, fontSize: font.label, fontWeight: "700" as const, ...mono },
    modalTitle: { fontSize: font.title, fontWeight: "700" as const, color: tokens.textPrimary, marginBottom: 12, ...mono },
    typeRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, marginBottom: 12 },
    typeChip: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 3, borderWidth: 1, borderColor: tokens.border },
    typeChipActive: { borderColor: tokens.accent, backgroundColor: tokens.accentGlow },
    typeChipText: { color: tokens.textMuted, fontWeight: "600" as const, fontSize: font.label, ...mono },
    typeChipTextActive: { color: tokens.accent },
    jobField: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, marginBottom: 12, gap: 4 },
    jobFieldLabel: { color: tokens.textMuted, fontSize: font.label, fontWeight: "700" as const, ...mono },
    jobFieldValue: { color: tokens.textPrimary, fontSize: font.body - 1, ...mono },
    error: { color: tokens.danger, fontSize: font.label, marginBottom: 8, ...mono },
    modalButtons: { gap: 8, marginTop: 4 },
  };
}
