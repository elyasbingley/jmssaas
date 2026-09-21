import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView } from "react-native";
import type { ReactNode } from "react";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";

interface CenteredModalProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}

// Every modal with a text input used to slide up from the bottom of the
// screen, anchored under the keyboard - so the keyboard would cover
// whichever field was focused, on smaller screens especially. This centers
// the card instead and wraps it in KeyboardAvoidingView so the visible
// keyboard always pushes the card up rather than covering it.
export function CenteredModal({ visible, onClose, children }: CenteredModalProps) {
  const styles = useThemedStyles(createStyles);
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
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
    overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", alignItems: "center" as const, justifyContent: "center" as const, padding: 20 },
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
