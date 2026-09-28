import { Pressable, Text, View } from "react-native";
import type { TaskQuadrant } from "@jmssaas/shared";
import { MOVE_TARGETS } from "../../lib/task-matrix";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedModal } from "./ThemedModal";

interface MoveToQuadrantSheetProps {
  visible: boolean;
  onClose: () => void;
  currentQuadrant: TaskQuadrant;
  onSelect: (quadrant: TaskQuadrant) => void;
}

// Mobile's stand-in for drag-and-drop between quadrants (no precise
// drag-and-drop on a phone, per the brief) - a bottom-sheet-style list of
// the 4 quadrants plus Unsorted, built on the same ThemedModal every other
// "expand a compact thing" affordance in this app already uses.
export function MoveToQuadrantSheet({ visible, onClose, currentQuadrant, onSelect }: MoveToQuadrantSheetProps) {
  const styles = useThemedStyles(createStyles);
  return (
    <ThemedModal visible={visible} onClose={onClose}>
      <Text style={styles.title}>Move to...</Text>
      <View style={{ gap: 6 }}>
        {MOVE_TARGETS.map((target) => (
          <Pressable
            key={target.quadrant}
            style={[styles.row, target.quadrant === currentQuadrant && styles.rowActive]}
            onPress={() => {
              onSelect(target.quadrant);
              onClose();
            }}
          >
            <Text style={styles.rowLabel}>{target.label}</Text>
            {target.subtitle ? <Text style={styles.rowSubtitle}>{target.subtitle}</Text> : null}
          </Pressable>
        ))}
      </View>
      <Pressable onPress={onClose} style={styles.closeButton}>
        <Text style={styles.closeText}>Cancel</Text>
      </Pressable>
    </ThemedModal>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    title: {
      fontSize: font.title,
      fontWeight: "700" as const,
      color: tokens.accent,
      marginBottom: 4,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      ...mono,
    },
    row: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, backgroundColor: tokens.surface },
    rowActive: { borderColor: tokens.accent, backgroundColor: tokens.accentGlow },
    rowLabel: { color: tokens.textPrimary, fontWeight: "700" as const, fontSize: font.body, ...mono },
    rowSubtitle: { color: tokens.textMuted, fontSize: font.label, marginTop: 2, ...mono },
    closeButton: { marginTop: 12, alignSelf: "center" as const },
    closeText: { color: tokens.accent, fontWeight: "600" as const, ...mono },
  };
}
