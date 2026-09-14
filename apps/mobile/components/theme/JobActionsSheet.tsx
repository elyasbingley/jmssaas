import { Pressable, Text, View } from "react-native";
import {
  JOB_ACTION_DEFINITIONS,
  QUICK_ACTION_COUNT,
  type JobActionId,
} from "../../lib/job-actions";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedModal } from "./ThemedModal";

interface JobActionsSheetProps {
  visible: boolean;
  onClose: () => void;
  order: JobActionId[];
  onReorder: (order: JobActionId[]) => void;
  onAction: (id: JobActionId) => void;
}

function moveInOrder(order: JobActionId[], index: number, direction: -1 | 1): JobActionId[] {
  const target = index + direction;
  if (target < 0 || target >= order.length) return order;
  const next = [...order];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved as JobActionId);
  return next;
}

// Opened from the bottom bar's "more" button - lists every job action, not
// just the ones off the bar, since tapping one here should run it directly
// (the spec's "more" sheet opens the remaining actions). The up/down
// buttons let the tech move any action across the first-4-are-quick line,
// which is this app's stand-in for "long-press-and-drag reordering" - see
// lib/job-actions.ts for why a real drag gesture wasn't used.
export function JobActionsSheet({ visible, onClose, order, onReorder, onAction }: JobActionsSheetProps) {
  const styles = useThemedStyles(createStyles);

  return (
    <ThemedModal visible={visible} onClose={onClose}>
      <Text style={styles.title}>Job Actions</Text>
      <Text style={styles.hint}>Tap an action to use it. Use ↑/↓ to change what's on the bottom bar.</Text>
      <View style={{ gap: 6 }}>
        {order.map((id, index) => {
          const action = JOB_ACTION_DEFINITIONS.find((a) => a.id === id);
          if (!action) return null;
          const onBar = index < QUICK_ACTION_COUNT;
          return (
            <View key={id} style={styles.row}>
              <Pressable
                style={styles.rowMain}
                onPress={() => {
                  onAction(id);
                  onClose();
                }}
              >
                <Text style={styles.icon}>{action.icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>{action.label}</Text>
                  <Text style={onBar ? styles.badgeOnBar : styles.badgeMore}>{onBar ? "ON BAR" : "MORE"}</Text>
                </View>
              </Pressable>
              <View style={styles.moveButtons}>
                <Pressable
                  disabled={index === 0}
                  onPress={() => onReorder(moveInOrder(order, index, -1))}
                  hitSlop={6}
                  style={styles.moveButton}
                >
                  <Text style={[styles.moveArrow, index === 0 && styles.moveArrowDisabled]}>↑</Text>
                </Pressable>
                <Pressable
                  disabled={index === order.length - 1}
                  onPress={() => onReorder(moveInOrder(order, index, 1))}
                  hitSlop={6}
                  style={styles.moveButton}
                >
                  <Text style={[styles.moveArrow, index === order.length - 1 && styles.moveArrowDisabled]}>↓</Text>
                </Pressable>
              </View>
            </View>
          );
        })}
      </View>
      <Pressable onPress={onClose} style={styles.closeButton}>
        <Text style={styles.closeText}>Close</Text>
      </Pressable>
    </ThemedModal>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  return {
    title: {
      fontSize: font.title,
      fontWeight: "700" as const,
      color: tokens.accent,
      fontFamily: fontFamily.mobileFontFamily,
      textTransform: "uppercase" as const,
      letterSpacing: 1,
    },
    hint: { color: tokens.textMuted, fontSize: font.label, marginBottom: 6, fontFamily: fontFamily.mobileFontFamily },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 3,
      padding: 8,
      gap: 8,
    },
    rowMain: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, flex: 1 },
    icon: { fontSize: font.title },
    label: { color: tokens.textPrimary, fontSize: font.body, fontFamily: fontFamily.mobileFontFamily },
    badgeOnBar: { color: tokens.accent, fontSize: font.label - 2, letterSpacing: 1, fontFamily: fontFamily.mobileFontFamily },
    badgeMore: { color: tokens.textMuted, fontSize: font.label - 2, letterSpacing: 1, fontFamily: fontFamily.mobileFontFamily },
    moveButtons: { gap: 2 },
    moveButton: { paddingHorizontal: 8, paddingVertical: 2 },
    moveArrow: { color: tokens.accent, fontSize: font.body },
    moveArrowDisabled: { color: tokens.textMuted, opacity: 0.4 },
    closeButton: { marginTop: 8, alignSelf: "center" as const },
    closeText: { color: tokens.accent, fontWeight: "600" as const, fontFamily: fontFamily.mobileFontFamily },
  };
}
