import { Pressable, Text, View } from "react-native";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";

interface QuadrantToggleRowProps {
  isUrgent: boolean | null;
  isImportant: boolean | null;
  onChange: (next: { is_urgent: boolean | null; is_important: boolean | null }) => void;
  /** Tighter chips for the Job Card's lightweight embedded task list. */
  compact?: boolean;
}

// Presentational + the tap targets for both independent axes - deliberately
// doesn't touch PowerSync itself (see QuadrantToggleRow call sites in
// tasks/[id].tsx and jobs/[id].tsx), since each caller needs to run its own
// UPDATE plus the "moved into Delegate while unassigned" prompt afterwards,
// which only the caller has the context (assignee picker, current
// assignment) to do.
export function QuadrantToggleRow({ isUrgent, isImportant, onChange, compact }: QuadrantToggleRowProps) {
  const styles = useThemedStyles(createStyles);

  const Chip = ({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) => (
    <Pressable style={[styles.chip, compact && styles.chipCompact, active && styles.chipActive]} onPress={onPress}>
      <Text style={[styles.chipText, compact && styles.chipTextCompact, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={styles.wrap}>
      <View style={styles.axisRow}>
        <Chip active={isUrgent === true} label="Urgent" onPress={() => onChange({ is_urgent: true, is_important: isImportant })} />
        <Chip active={isUrgent === false} label="Not Urgent" onPress={() => onChange({ is_urgent: false, is_important: isImportant })} />
      </View>
      <View style={styles.axisRow}>
        <Chip active={isImportant === true} label="Important" onPress={() => onChange({ is_urgent: isUrgent, is_important: true })} />
        <Chip
          active={isImportant === false}
          label="Not Important"
          onPress={() => onChange({ is_urgent: isUrgent, is_important: false })}
        />
      </View>
    </View>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    wrap: { gap: 6 },
    axisRow: { flexDirection: "row" as const, gap: 6 },
    chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 3, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface },
    chipCompact: { paddingHorizontal: 8, paddingVertical: 4 },
    chipActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    chipText: { color: tokens.textMuted, fontWeight: "600" as const, fontSize: font.label, ...mono },
    chipTextCompact: { fontSize: font.label - 1 },
    chipTextActive: { color: tokens.accent },
  };
}
