import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePowerSync, useQuery } from "@powersync/react";
import type { Task } from "@jmssaas/shared";
import { useAuth } from "../../lib/auth-context";
import { isOverdue } from "../../lib/task-matrix";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedButton } from "../../components/theme/ThemedButton";

// One-at-a-time triage for Unsorted tasks, per the brief - showing the
// whole Unsorted list at once (as the Matrix's own Unsorted segment does)
// is fine for browsing, but classifying a backlog is a different job, so
// this is a separate focused flow: one task, big Urgent/Important choices,
// or skip, then straight on to the next.
export default function TriageScreen() {
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const styles = useThemedStyles(createStyles);

  const { data: unsortedTasks } = useQuery<Task>(
    isAdmin
      ? "SELECT * FROM tasks WHERE (is_urgent IS NULL OR is_important IS NULL) AND status != 'done' ORDER BY (due_date IS NULL), due_date, created_at DESC"
      : "SELECT * FROM tasks WHERE assigned_to = ? AND (is_urgent IS NULL OR is_important IS NULL) AND status != 'done' ORDER BY (due_date IS NULL), due_date, created_at DESC",
    isAdmin ? [] : [profile?.id ?? ""]
  );

  // Tapping "Skip for now" doesn't change the task, so it would otherwise
  // stay first in the query and never let the tech move on - skipped ids
  // are excluded here (session-local only, not persisted) so skipping
  // advances the queue without touching the task's data.
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const queue = useMemo(() => unsortedTasks.filter((t) => !skippedIds.has(t.id)), [unsortedTasks, skippedIds]);
  const current = queue[0] ?? null;

  // axis is always one of the two literal column names below (never
  // user-entered text), so interpolating it directly is safe.
  const setAxis = async (axis: "is_urgent" | "is_important", value: boolean) => {
    if (!current) return;
    await powersync.execute(`UPDATE tasks SET ${axis} = ? WHERE id = ?`, [value ? 1 : 0, current.id]);
  };

  const skip = () => {
    if (!current) return;
    setSkippedIds((prev) => new Set(prev).add(current.id));
  };

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.backRow}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>‹ Back to Matrix</Text>
          </Pressable>
        </View>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Quick Triage</Text>
          <Text style={styles.progress}>{queue.length} remaining</Text>
        </View>

        {current ? (
          <View style={styles.card}>
            <Text style={styles.taskTitle}>{current.title}</Text>
            {current.description ? (
              <Text style={styles.taskDescription} numberOfLines={3}>
                {current.description}
              </Text>
            ) : null}
            {current.due_date ? (
              <Text style={[styles.taskMeta, isOverdue(current) && styles.taskMetaOverdue]}>
                {isOverdue(current) ? "⚠ Overdue - due " : "Due "}
                {current.due_date}
              </Text>
            ) : null}

            <Text style={styles.sectionLabel}>Is it urgent?</Text>
            <View style={styles.choiceRow}>
              <View style={styles.choiceButton}>
                <ThemedButton
                  label="Urgent"
                  variant={current.is_urgent === true ? "primary" : "secondary"}
                  onPress={() => setAxis("is_urgent", true)}
                />
              </View>
              <View style={styles.choiceButton}>
                <ThemedButton
                  label="Not Urgent"
                  variant={current.is_urgent === false ? "primary" : "secondary"}
                  onPress={() => setAxis("is_urgent", false)}
                />
              </View>
            </View>

            <Text style={styles.sectionLabel}>Is it important?</Text>
            <View style={styles.choiceRow}>
              <View style={styles.choiceButton}>
                <ThemedButton
                  label="Important"
                  variant={current.is_important === true ? "primary" : "secondary"}
                  onPress={() => setAxis("is_important", true)}
                />
              </View>
              <View style={styles.choiceButton}>
                <ThemedButton
                  label="Not Important"
                  variant={current.is_important === false ? "primary" : "secondary"}
                  onPress={() => setAxis("is_important", false)}
                />
              </View>
            </View>

            <Pressable onPress={skip} style={styles.skipButton}>
              <Text style={styles.skipText}>Skip for now</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.doneCard}>
            <Text style={styles.doneTitle}>All caught up</Text>
            <Text style={styles.doneSubtitle}>Nothing left to triage right now.</Text>
            <View style={styles.doneButton}>
              <ThemedButton label="Back to Matrix" onPress={() => router.back()} />
            </View>
          </View>
        )}
      </SafeAreaView>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    backRow: { paddingHorizontal: 16, paddingTop: 12 },
    header: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      alignItems: "flex-end" as const,
      paddingHorizontal: 16,
      paddingTop: 4,
      paddingBottom: 12,
    },
    headerTitle: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    progress: { color: tokens.textMuted, fontSize: font.label, ...mono },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },

    card: {
      margin: 16,
      padding: 20,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 6,
      backgroundColor: tokens.surface,
      gap: 4,
    },
    taskTitle: { fontSize: font.title + 2, fontWeight: "700" as const, color: tokens.textPrimary, ...mono },
    taskDescription: { color: tokens.textMuted, marginTop: 6, ...mono },
    taskMeta: { color: tokens.textMuted, marginTop: 8, fontSize: font.label, ...mono },
    taskMetaOverdue: { color: tokens.danger, fontWeight: "700" as const },
    sectionLabel: {
      fontWeight: "700" as const,
      color: tokens.accent,
      marginTop: 18,
      marginBottom: 8,
      fontSize: font.label,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      ...mono,
    },
    choiceRow: { flexDirection: "row" as const, gap: 10 },
    choiceButton: { flex: 1 },
    skipButton: { marginTop: 20, alignSelf: "center" as const },
    skipText: { color: tokens.textMuted, fontWeight: "600" as const, textDecorationLine: "underline" as const, ...mono },

    doneCard: { margin: 16, padding: 24, alignItems: "center" as const, gap: 6 },
    doneTitle: { fontSize: font.title + 2, fontWeight: "700" as const, color: tokens.accent, ...mono },
    doneSubtitle: { color: tokens.textMuted, ...mono },
    doneButton: { marginTop: 12, alignSelf: "stretch" as const },
  };
}
