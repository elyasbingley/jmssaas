import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@powersync/react";
import { QUADRANT_META, QUADRANT_ORDER, taskQuadrant, type Task, type TaskQuadrant } from "@jmssaas/shared";
import { useAuth } from "../../lib/auth-context";
import { isOverdue } from "../../lib/task-matrix";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";

const QUADRANT_ICON: Record<TaskQuadrant, string> = {
  do_first: "🔥",
  schedule: "🗓",
  delegate: "🤝",
  eliminate: "🗑",
  unsorted: "❔",
};

// The 2x2 body in reading order: [row][col] = do_first/schedule on top
// (Important), delegate/eliminate on the bottom (Not Important), Urgent on
// the left column, Not Urgent on the right - matches the classic Eisenhower
// layout and QUADRANT_ORDER's own do_first/schedule/delegate/eliminate
// ordering (QUADRANT_ORDER laid out as two rows of two).
type RealQuadrant = Exclude<TaskQuadrant, "unsorted">;

// QUADRANT_ORDER is typed as plain TaskQuadrant[] (a general-purpose
// export), even though its 4 runtime values are never "unsorted" - this
// cast just tells TS what QUADRANT_META's own keys already prove.
const ORDER = QUADRANT_ORDER as RealQuadrant[];
const GRID: RealQuadrant[][] = [
  [ORDER[0]!, ORDER[1]!],
  [ORDER[2]!, ORDER[3]!],
];

export default function MatrixScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const styles = useThemedStyles(createStyles);

  // Same "tenant syncs everything, technician sees only their own" split
  // tasks/index.tsx already applies - the matrix is a working view of open
  // tasks, so done tasks are left out (a completed task has nothing left to
  // prioritise).
  const { data: tasks } = useQuery<Task>(
    isAdmin
      ? "SELECT * FROM tasks WHERE status != 'done' ORDER BY (due_date IS NULL), due_date, created_at DESC"
      : "SELECT * FROM tasks WHERE assigned_to = ? AND status != 'done' ORDER BY (due_date IS NULL), due_date, created_at DESC",
    isAdmin ? [] : [profile?.id ?? ""]
  );

  const grouped = useMemo(() => {
    const map: Record<TaskQuadrant, Task[]> = { do_first: [], schedule: [], delegate: [], eliminate: [], unsorted: [] };
    for (const t of tasks) map[taskQuadrant(t)].push(t);
    return map;
  }, [tasks]);

  const unsortedCount = grouped.unsorted.length;

  const openQuadrant = (quadrant: TaskQuadrant) => {
    router.push({ pathname: "/tasks/matrix-quadrant", params: { quadrant } });
  };

  // Divider borders: each segment only carries the border(s) on the side(s)
  // facing the shared cross, so together the four segments draw exactly one
  // continuous "+" through the grid rather than each having its own
  // four-sided box (which read as four separate floating cards with gaps
  // between them, not one matrix). Same divider-assignment shape as the
  // desktop Matrix view's own QuadrantSection.
  const DIVIDER: Record<RealQuadrant, object> = {
    do_first: { borderRightWidth: 1, borderBottomWidth: 1 },
    schedule: { borderBottomWidth: 1 },
    delegate: { borderRightWidth: 1 },
    eliminate: {},
  };

  const Segment = ({ quadrant }: { quadrant: RealQuadrant }) => {
    const meta = QUADRANT_META[quadrant];
    const items = grouped[quadrant];
    const preview = items.slice(0, 2);
    const overflow = items.length - preview.length;
    return (
      <Pressable style={[styles.segment, DIVIDER[quadrant]]} onPress={() => openQuadrant(quadrant)}>
        <View style={styles.segmentHeader}>
          <Text style={styles.segmentIcon}>{QUADRANT_ICON[quadrant]}</Text>
          <View style={styles.segmentTitleGroup}>
            <Text style={styles.segmentLabel} numberOfLines={1}>
              {meta.label}
            </Text>
            <Text style={styles.segmentCount}>{items.length}</Text>
          </View>
        </View>
        <Text style={styles.segmentSubtitle} numberOfLines={1}>
          {meta.subtitle}
        </Text>
        <View style={styles.segmentBody}>
          {preview.length === 0 ? (
            <Text style={styles.segmentEmpty}>No tasks</Text>
          ) : (
            preview.map((t) => (
              <Text key={t.id} style={[styles.segmentTaskTitle, isOverdue(t) && styles.segmentTaskOverdue]} numberOfLines={1}>
                {isOverdue(t) ? "⚠ " : ""}
                {t.title}
              </Text>
            ))
          )}
          {overflow > 0 ? <Text style={styles.segmentMore}>+{overflow} more</Text> : null}
        </View>
      </Pressable>
    );
  };

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.backRow}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>‹ Back</Text>
          </Pressable>
        </View>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Matrix</Text>
        </View>

        <View style={styles.grid}>
          <View style={styles.topHeaderRow}>
            <View style={styles.cornerCell} />
            <View style={styles.colHeaderCell}>
              <Text style={styles.axisText}>URGENT</Text>
            </View>
            <View style={styles.colHeaderCell}>
              <Text style={styles.axisText}>NOT URGENT</Text>
            </View>
          </View>
          {GRID.map((row, rowIndex) => (
            <View key={rowIndex} style={styles.bodyRow}>
              <View style={styles.rowHeaderCell}>
                <Text style={[styles.axisText, styles.axisTextVertical]}>{rowIndex === 0 ? "IMPORTANT" : "NOT IMPORTANT"}</Text>
              </View>
              <View style={styles.bodyRowContent}>
                {row.map((quadrant) => (
                  <Segment key={quadrant} quadrant={quadrant} />
                ))}
              </View>
            </View>
          ))}
        </View>

        <Pressable
          style={styles.unsortedBar}
          onPress={() => openQuadrant("unsorted")}
        >
          <Text style={styles.unsortedText}>
            {unsortedCount === 0 ? "Nothing Unsorted" : `${unsortedCount} Unsorted task${unsortedCount === 1 ? "" : "s"}`}
          </Text>
          {unsortedCount > 0 ? (
            <Pressable style={styles.triageButton} onPress={() => router.push("/tasks/triage")}>
              <Text style={styles.triageButtonText}>Triage</Text>
            </Pressable>
          ) : null}
        </Pressable>
      </SafeAreaView>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    backRow: { paddingHorizontal: 16, paddingTop: 12 },
    header: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
    headerTitle: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },

    // One continuous bordered box holding the whole cross, not a grid of
    // separately-boxed segments with gaps between them - each segment below
    // carries only the border(s) it needs (see DIVIDER) so together they
    // draw a single "+" through the middle, same shape as the desktop
    // Matrix view's own divider.
    grid: { flex: 1, marginHorizontal: 12, marginBottom: 8, borderWidth: 1, borderColor: tokens.border, borderRadius: 4, overflow: "hidden" as const },
    topHeaderRow: { flexDirection: "row" as const, height: 30, borderBottomWidth: 1, borderColor: tokens.border },
    cornerCell: { width: 26, borderRightWidth: 1, borderColor: tokens.border },
    colHeaderCell: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const },
    bodyRow: { flex: 1, flexDirection: "row" as const },
    bodyRowContent: { flex: 1, flexDirection: "row" as const },
    rowHeaderCell: { width: 26, alignItems: "center" as const, justifyContent: "center" as const, borderRightWidth: 1, borderColor: tokens.border },
    axisText: { color: tokens.textMuted, fontSize: font.label - 1, fontWeight: "700" as const, letterSpacing: 1, ...mono },
    axisTextVertical: { transform: [{ rotate: "-90deg" }], width: 100, textAlign: "center" as const },

    segment: { flex: 1, padding: 12, borderColor: tokens.border },
    segmentHeader: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    segmentIcon: { fontSize: font.body },
    segmentTitleGroup: { flexDirection: "row" as const, alignItems: "baseline" as const, gap: 6, flexShrink: 1 },
    segmentLabel: {
      color: tokens.accent,
      fontWeight: "900" as const,
      fontSize: font.body + 2,
      letterSpacing: 0.5,
      borderBottomWidth: 2,
      borderBottomColor: tokens.accent,
      paddingBottom: 1,
      ...mono,
    },
    segmentCount: { color: tokens.textMuted, fontWeight: "700" as const, fontSize: font.label, ...mono },
    segmentSubtitle: { color: tokens.textMuted, fontSize: font.label - 2, marginTop: 4, ...mono },
    segmentBody: { marginTop: 8, gap: 3 },
    segmentEmpty: { color: tokens.textMuted, fontSize: font.label, fontStyle: "italic" as const, ...mono },
    segmentTaskTitle: { color: tokens.textPrimary, fontSize: font.label, ...mono },
    segmentTaskOverdue: { color: tokens.danger, fontWeight: "700" as const },
    segmentMore: { color: tokens.textMuted, fontSize: font.label - 1, ...mono },

    unsortedBar: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      marginHorizontal: 16,
      marginBottom: 12,
      padding: 12,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 4,
      backgroundColor: tokens.surface,
    },
    unsortedText: { color: tokens.textMuted, fontWeight: "600" as const, fontSize: font.body - 1, ...mono },
    triageButton: { borderWidth: 1, borderColor: tokens.accent, borderRadius: 3, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: tokens.accentGlow },
    triageButtonText: { color: tokens.accent, fontWeight: "700" as const, fontSize: font.label, letterSpacing: 1, ...mono },
  };
}
