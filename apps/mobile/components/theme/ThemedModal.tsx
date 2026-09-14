import type { ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView } from "react-native";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";

interface ThemedModalProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}

// Theme-aware sibling of components/CenteredModal.tsx (same centered +
// keyboard-avoiding behaviour), used only from screens that have opted into
// the CRT theme (currently the mobile Job Card) so every other screen's
// modals are left exactly as they were.
export function ThemedModal({ visible, onClose, children }: ThemedModalProps) {
  const styles = useThemedStyles(createStyles);
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <Pressable style={styles.overlay} onPress={onClose}>
          <Pressable style={styles.cardWrapper} onPress={(e) => e.stopPropagation()}>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.card}>
              {children}
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function createStyles({ tokens }: StyleTheme) {
  return {
    flex: { flex: 1 },
    overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center" as const, justifyContent: "center" as const, padding: 20 },
    cardWrapper: { width: "100%" as const, maxWidth: 480, maxHeight: "85%" as const },
    card: {
      backgroundColor: tokens.surface,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 6,
      padding: 20,
      gap: 12,
      boxShadow: `0 0 16px ${tokens.accentGlow}`,
    },
  };
}
