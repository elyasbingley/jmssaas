import { Pressable, Text, View } from "react-native";
import { entryMinutes, formatMinutes } from "@jmssaas/shared";
import { useNow, useTimesheet } from "../lib/use-timesheet";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";

// Start/stop time on one job, from that job's screen. Starting clocks the
// person on if they weren't, and ends whatever else was running (another
// job, travel, a break) - see timerWrites in @jmssaas/shared.
export function JobTimerButton({ jobCardId }: { jobCardId: string }) {
  const styles = useThemedStyles(createStyles);
  const { shift, activity, busy, perform } = useTimesheet();
  const now = useNow();
  const running = activity?.activity_type === "job" && activity.job_card_id === jobCardId;

  return (
    <View style={styles.wrapper}>
      <Pressable
        style={[styles.button, running && styles.buttonRunning, busy && styles.disabled]}
        disabled={busy}
        onPress={() => void perform(running ? { kind: "stop_activity" } : { kind: "start", activityType: "job", jobCardId })}
      >
        <Text style={[styles.buttonText, running && styles.buttonTextRunning]}>
          {running && activity ? `Stop time on this job · ${formatMinutes(entryMinutes(activity, now))}` : "Start time on this job"}
        </Text>
      </Pressable>
      {!running ? (
        <Text style={styles.hint}>
          {!shift ? "Also clocks you on for the day." : activity ? "Ends what you're currently timing and switches to this job." : "Logs your time against this job until you stop or switch."}
        </Text>
      ) : null}
    </View>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    wrapper: { marginVertical: 10, gap: 6 },
    button: { borderRadius: 3, borderWidth: 1, borderColor: tokens.accent, paddingVertical: 12, alignItems: "center" as const },
    buttonRunning: { backgroundColor: tokens.accentGlow },
    buttonText: { color: tokens.accent, fontWeight: "700" as const, fontSize: font.body - 1, ...mono },
    buttonTextRunning: { color: tokens.accent },
    hint: { color: tokens.textMuted, fontSize: font.label, ...mono },
    disabled: { opacity: 0.5 },
  };
}
