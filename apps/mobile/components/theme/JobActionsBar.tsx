import { Pressable, Text, View } from "react-native";
import { getActionDefinition, type JobActionId } from "../../lib/job-actions";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";

interface JobActionsBarProps {
  quickActions: JobActionId[];
  onAction: (id: JobActionId) => void;
  onMore: () => void;
}

// Persistent bottom bar - the user's 4 chosen quick-press actions as
// icon-only buttons (no text labels, per spec), plus a 5th "more" button
// opening JobActionsSheet for the rest. See lib/job-actions.ts for how the
// quick set/order is chosen and persisted.
export function JobActionsBar({ quickActions, onAction, onMore }: JobActionsBarProps) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.bar}>
      {quickActions.map((id) => {
        const action = getActionDefinition(id);
        return (
          <Pressable key={id} style={styles.button} onPress={() => onAction(id)} hitSlop={6}>
            <Text style={styles.icon}>{action.icon}</Text>
          </Pressable>
        );
      })}
      <Pressable style={styles.button} onPress={onMore} hitSlop={6}>
        <Text style={styles.icon}>⋮</Text>
      </Pressable>
    </View>
  );
}

function createStyles({ tokens, font }: StyleTheme) {
  return {
    bar: {
      flexDirection: "row" as const,
      borderTopWidth: 1,
      borderTopColor: tokens.border,
      backgroundColor: tokens.surface,
      boxShadow: `0 0 12px ${tokens.accentGlow}`,
    },
    button: {
      flex: 1,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      paddingVertical: 10,
      // Meets the ~44pt/48dp minimum recommended touch target on a Pixel
      // 9 Pro XL's higher density display.
      minHeight: 56,
    },
    icon: { fontSize: font.title + 6, color: tokens.accent },
  };
}
