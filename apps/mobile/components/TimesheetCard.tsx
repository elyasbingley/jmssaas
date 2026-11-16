import { Alert, Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@powersync/react";
import { TIMESHEET_ACTIVITY_LABELS, entryMinutes, formatMinutes, toDayKey, type TimesheetActivityType } from "@jmssaas/shared";
import { useNow, useTimesheet } from "../lib/use-timesheet";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";

// Home-screen timer: clock on/off for the day, plus the three non-job
// activities. Time on a job is started from that job's own screen (see
// JobTimerButton). Works offline - see lib/use-timesheet.ts.

const QUICK_ACTIVITIES: TimesheetActivityType[] = ["travel", "break", "admin"];

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
}

export function TimesheetCard() {
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const { shift, activity, busy, perform } = useTimesheet();
  const now = useNow();
  const { data: jobRows } = useQuery<{ number: string | null; title: string }>("SELECT number, title FROM job_cards WHERE id = ?", [
    activity?.job_card_id ?? "",
  ]);
  const job = jobRows[0];

  const startedEarlierDay = shift ? toDayKey(shift.started_at) !== toDayKey(now) : false;
  const activityLabel = activity
    ? activity.activity_type === "job"
      ? `Job: ${job ? `${job.number ?? "Pending"} - ${job.title}` : "a job"}`
      : TIMESHEET_ACTIVITY_LABELS[activity.activity_type]
    : null;

  const confirmClockOff = () => {
    Alert.alert("Clock off?", "This ends your shift and anything still running.", [
      { text: "Cancel", style: "cancel" },
      { text: "Clock off", onPress: () => void perform({ kind: "clock_off" }) },
    ]);
  };

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.heading}>Timesheet</Text>
        <Pressable onPress={() => router.push("/timesheet")} hitSlop={8}>
          <Text style={styles.link}>My timesheet ›</Text>
        </Pressable>
      </View>

      {!shift ? (
        <>
          <Text style={styles.status}>You're clocked off.</Text>
          <Pressable style={[styles.primaryButton, busy && styles.disabled]} disabled={busy} onPress={() => void perform({ kind: "clock_on" })}>
            <Text style={styles.primaryButtonText}>Clock on</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.status}>
            Clocked on since {startedEarlierDay ? `${new Date(shift.started_at).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}, ` : ""}
            {clock(shift.started_at)} · {formatMinutes(entryMinutes(shift, now))}
          </Text>
          {startedEarlierDay ? (
            <Text style={styles.warning}>This shift started on an earlier day. If you forgot to clock off, clock off now and fix the finish time in My timesheet.</Text>
          ) : null}
          <Text style={styles.current}>
            {activity && activityLabel ? `Now: ${activityLabel} · ${formatMinutes(entryMinutes(activity, now))}` : "Nothing running. Start an activity below, or open a job to time it."}
          </Text>

          <View style={styles.activityRow}>
            {QUICK_ACTIVITIES.map((type) => {
              const active = activity?.activity_type === type;
              return (
                <Pressable
                  key={type}
                  style={[styles.activityButton, active && styles.activityButtonActive, busy && styles.disabled]}
                  disabled={busy}
                  onPress={() => void perform(active ? { kind: "stop_activity" } : { kind: "start", activityType: type })}
                >
                  <Text style={[styles.activityButtonText, active && styles.activityButtonTextActive]}>
                    {active ? `End ${TIMESHEET_ACTIVITY_LABELS[type].toLowerCase()}` : TIMESHEET_ACTIVITY_LABELS[type]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {activity?.activity_type === "job" ? (
            <Pressable style={[styles.secondaryButton, busy && styles.disabled]} disabled={busy} onPress={() => void perform({ kind: "stop_activity" })}>
              <Text style={styles.secondaryButtonText}>Stop job time</Text>
            </Pressable>
          ) : null}
          <Pressable style={[styles.secondaryButton, busy && styles.disabled]} disabled={busy} onPress={confirmClockOff}>
            <Text style={styles.secondaryButtonText}>Clock off</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  const button = { borderRadius: 3, borderWidth: 1, paddingVertical: 12, alignItems: "center" as const };
  return {
    card: {
      marginHorizontal: 12,
      marginBottom: 12,
      padding: 16,
      gap: 10,
      backgroundColor: tokens.surface,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 4,
    },
    headerRow: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const },
    heading: { fontSize: font.label, fontWeight: "700" as const, color: tokens.textMuted, letterSpacing: 1, textTransform: "uppercase" as const, ...mono },
    link: { color: tokens.accent, fontWeight: "600" as const, fontSize: font.label, ...mono },
    status: { color: tokens.textPrimary, fontSize: font.body, fontWeight: "700" as const, ...mono },
    current: { color: tokens.textMuted, fontSize: font.label, ...mono },
    warning: { color: tokens.warning, fontSize: font.label, ...mono },
    activityRow: { flexDirection: "row" as const, gap: 8 },
    activityButton: { ...button, flex: 1, borderColor: tokens.border, backgroundColor: tokens.background },
    activityButtonActive: { borderColor: tokens.accent, backgroundColor: tokens.accentGlow },
    activityButtonText: { color: tokens.textPrimary, fontWeight: "600" as const, fontSize: font.label, ...mono },
    activityButtonTextActive: { color: tokens.accent },
    primaryButton: { ...button, borderColor: tokens.accent, backgroundColor: tokens.accent },
    primaryButtonText: { color: tokens.background, fontWeight: "700" as const, fontSize: font.body, textTransform: "uppercase" as const, letterSpacing: 1, ...mono },
    secondaryButton: { ...button, borderColor: tokens.accent },
    secondaryButtonText: { color: tokens.accent, fontWeight: "700" as const, fontSize: font.body - 1, ...mono },
    disabled: { opacity: 0.5 },
  };
}
