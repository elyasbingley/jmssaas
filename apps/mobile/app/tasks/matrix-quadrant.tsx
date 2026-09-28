import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePowerSync, useQuery } from "@powersync/react";
import { taskQuadrant, type Profile, type Task, type TaskQuadrant } from "@jmssaas/shared";
import { useAuth } from "../../lib/auth-context";
import { axesForQuadrant, axisParam, isOverdue, quadrantLabel } from "../../lib/task-matrix";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { MoveToQuadrantSheet } from "../../components/theme/MoveToQuadrantSheet";
import { ThemedPickerModal } from "../../components/theme/ThemedPickerModal";

const STATUS_LABELS: Record<Task["status"], string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

// The expanded, full-list view of a single quadrant segment (or Unsorted),
// opened by tapping a segment on the Matrix screen - the mobile-appropriate
// "expand a compact thing into a full list" pattern the brief calls for,
// built as a navigated screen (same Stack the rest of /tasks uses) rather
// than a modal so it gets its own back button and scroll space.
export default function MatrixQuadrantScreen() {
  const { quadrant } = useLocalSearchParams<{ quadrant: TaskQuadrant }>();
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const styles = useThemedStyles(createStyles);

  const { data: tasks } = useQuery<Task>(
    isAdmin
      ? "SELECT * FROM tasks WHERE status != 'done' ORDER BY (due_date IS NULL), due_date, created_at DESC"
      : "SELECT * FROM tasks WHERE assigned_to = ? AND status != 'done' ORDER BY (due_date IS NULL), due_date, created_at DESC",
    isAdmin ? [] : [profile?.id ?? ""]
  );
  const { data: profiles } = useQuery<Profile>("SELECT * FROM profiles ORDER BY full_name");

  const list = useMemo(() => tasks.filter((t) => taskQuadrant(t) === quadrant), [tasks, quadrant]);

  const [moveTaskId, setMoveTaskId] = useState<string | null>(null);
  const [delegatePromptTaskId, setDelegatePromptTaskId] = useState<string | null>(null);

  const handleMove = async (task: Task, target: TaskQuadrant) => {
    const axes = axesForQuadrant(target);
    await powersync.execute("UPDATE tasks SET is_urgent = ?, is_important = ? WHERE id = ?", [
      axisParam(axes.is_urgent),
      axisParam(axes.is_important),
      task.id,
    ]);
    // Behaviour rule: moving a task into Delegate while unassigned prompts
    // for an assignee - doesn't block if dismissed, so this just opens the
    // picker and lets the tech close it with no consequence.
    if (target === "delegate" && !task.assigned_to) {
      setDelegatePromptTaskId(task.id);
    }
  };

  const handleAssignFromPrompt = async (p: Profile | null) => {
    if (!delegatePromptTaskId) return;
    await powersync.execute("UPDATE tasks SET assigned_to = ? WHERE id = ?", [p?.id ?? null, delegatePromptTaskId]);
    setDelegatePromptTaskId(null);
  };

  const moveTask = list.find((t) => t.id === moveTaskId) ?? null;

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
          <Text style={styles.headerTitle}>{quadrant ? quadrantLabel(quadrant) : ""}</Text>
        </View>

        <FlatList
          style={styles.list}
          data={list}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => router.push(`/tasks/${item.id}`)}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.title}
                </Text>
                <View style={styles.rowMetaRow}>
                  {item.due_date ? (
                    <Text style={[styles.rowMeta, isOverdue(item) && styles.rowMetaOverdue]}>
                      {isOverdue(item) ? "⚠ Overdue " : "Due "}
                      {item.due_date}
                    </Text>
                  ) : null}
                  <Text style={styles.rowMeta}>{STATUS_LABELS[item.status]}</Text>
                </View>
              </View>
              <Pressable
                style={styles.moveButton}
                onPress={(e) => {
                  e.stopPropagation();
                  setMoveTaskId(item.id);
                }}
              >
                <Text style={styles.moveButtonText}>Move</Text>
              </Pressable>
            </Pressable>
          )}
          ListEmptyComponent={<Text style={styles.empty}>No tasks in this quadrant.</Text>}
          contentContainerStyle={list.length === 0 ? styles.emptyContainer : styles.listContent}
        />
      </SafeAreaView>

      {moveTask ? (
        <MoveToQuadrantSheet
          visible={moveTaskId !== null}
          onClose={() => setMoveTaskId(null)}
          currentQuadrant={taskQuadrant(moveTask)}
          onSelect={(target) => handleMove(moveTask, target)}
        />
      ) : null}

      <ThemedPickerModal
        visible={delegatePromptTaskId !== null}
        title="Assign to..."
        items={[null, ...profiles]}
        getKey={(p) => p?.id ?? "none"}
        getLabel={(p) => p?.full_name ?? "Leave unassigned"}
        onSelect={handleAssignFromPrompt}
        onClose={() => setDelegatePromptTaskId(null)}
      />
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    backRow: { paddingHorizontal: 16, paddingTop: 12 },
    header: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4 },
    headerTitle: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    list: { flex: 1, marginTop: 8 },
    listContent: { paddingBottom: 24 },
    emptyContainer: { flex: 1, justifyContent: "center" as const, padding: 24 },
    empty: { textAlign: "center" as const, color: tokens.textMuted, ...mono },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      marginHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
      gap: 10,
    },
    rowTitle: { fontSize: font.body, fontWeight: "600" as const, color: tokens.textPrimary, ...mono },
    rowMetaRow: { flexDirection: "row" as const, gap: 10, marginTop: 2 },
    rowMeta: { color: tokens.textMuted, fontSize: font.label, ...mono },
    rowMetaOverdue: { color: tokens.danger, fontWeight: "700" as const },
    moveButton: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 6 },
    moveButtonText: { color: tokens.accent, fontWeight: "700" as const, fontSize: font.label, ...mono },
  };
}
