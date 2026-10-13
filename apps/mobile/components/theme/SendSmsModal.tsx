import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import type { ChannelMessageTemplate } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { getErrorMessage } from "../../lib/errors";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedFormField } from "./ThemedFormField";
import { ThemedPickerModal } from "./ThemedPickerModal";

// Shared SMS-compose surface for both the Quote detail screen's "Send
// Quote via SMS" button and Channels' "New Message" flow - same shape as
// EmailComposeModal.tsx (editable recipient, editable body, a template
// picker), but phone-only, no subject/cc/bcc/attachments since this is a
// plain-text channel. Loads this tenant's channel_message_templates itself
// (RLS: tenant read) rather than taking them as a prop, since both call
// sites want the exact same list and neither has a reason to fetch it
// separately first.
export interface SendSmsModalProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  defaultPhone: string;
  // Tap-to-fill alternates (e.g. this client's other contacts) - same
  // "chip row under the field" pattern as EmailComposeModal's
  // recipientOptions.
  phoneOptions?: { label: string; phone: string }[];
  defaultBody: string;
  // Gates the "Manage templates" link - everyone can read/insert a
  // template (RLS allows tenant-wide select), only an admin can create,
  // edit or delete one (channel_message_templates: admin writes policies).
  isAdmin: boolean;
  onSend: (payload: { phone: string; body: string }) => Promise<void>;
  sendLabel?: string;
}

export function SendSmsModal({ visible, onClose, title, defaultPhone, phoneOptions, defaultBody, isAdmin, onSend, sendLabel }: SendSmsModalProps) {
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const [phone, setPhone] = useState(defaultPhone);
  const [body, setBody] = useState(defaultBody);
  const [templates, setTemplates] = useState<ChannelMessageTemplate[]>([]);
  const [templatePickerVisible, setTemplatePickerVisible] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setPhone(defaultPhone);
    setBody(defaultBody);
    setError(null);
    supabase
      .from("channel_message_templates")
      .select("*")
      .order("name")
      .then(({ data, error: fetchError }) => {
        if (fetchError) {
          console.error("[SendSmsModal] Failed to load templates", fetchError);
          return;
        }
        setTemplates((data ?? []) as ChannelMessageTemplate[]);
      });
    // Only re-seed when the modal opens, not on every prop change while
    // it's already open - same reasoning as EmailComposeModal's identical
    // effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const handleSend = async () => {
    if (!phone.trim()) {
      setError("Enter a phone number");
      return;
    }
    if (!body.trim()) {
      setError("Message can't be empty");
      return;
    }
    setSending(true);
    setError(null);
    try {
      await onSend({ phone: phone.trim(), body: body.trim() });
      onClose();
    } catch (e) {
      setError(getErrorMessage(e, "Failed to send"));
    } finally {
      setSending(false);
    }
  };

  const openManageTemplates = () => {
    onClose();
    router.push("/channels/templates");
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <Pressable onPress={onClose}>
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>
        <ScrollView style={styles.body} contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <ThemedFormField label="Phone number" placeholder="0491 570 156" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
          {phoneOptions && phoneOptions.length > 0 ? (
            <View style={styles.chipsRow}>
              {phoneOptions.map((opt) => (
                <Pressable key={`${opt.label}-${opt.phone}`} style={styles.chip} onPress={() => setPhone(opt.phone)}>
                  <Text style={styles.chipText}>{opt.label}: {opt.phone}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          <View style={[styles.fieldSpacing, styles.bodyHeaderRow]}>
            <Text style={styles.fieldLabel}>Message</Text>
            <View style={styles.bodyHeaderLinks}>
              <Pressable onPress={() => setTemplatePickerVisible(true)}>
                <Text style={styles.link}>Insert template</Text>
              </Pressable>
              {isAdmin ? (
                <Pressable onPress={openManageTemplates}>
                  <Text style={styles.link}>Manage templates</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
          <TextInput
            style={[styles.input, styles.multiline]}
            placeholderTextColor={styles.placeholder.color}
            placeholder="Type your message..."
            value={body}
            onChangeText={setBody}
            multiline
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable style={styles.sendButton} onPress={handleSend} disabled={sending}>
            <Text style={styles.sendButtonText}>{sending ? "Sending..." : (sendLabel ?? "Send")}</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>

      <ThemedPickerModal
        visible={templatePickerVisible}
        title="Select template"
        items={templates}
        getKey={(t) => t.id}
        getLabel={(t) => t.name}
        onSelect={(t) => setBody(t.body)}
        onClose={() => setTemplatePickerVisible(false)}
      />
    </Modal>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: tokens.background },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      padding: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: tokens.border,
    },
    title: { fontSize: font.title, color: tokens.accent, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", ...mono },
    closeText: { color: tokens.accent, fontWeight: "600", ...mono },
    body: { flex: 1, backgroundColor: tokens.background },
    fieldSpacing: { marginTop: 16 },
    fieldLabel: { fontSize: font.label, fontWeight: "600", color: tokens.textMuted, letterSpacing: 1, textTransform: "uppercase", ...mono },
    bodyHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    bodyHeaderLinks: { flexDirection: "row", gap: 16 },
    input: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, fontSize: font.body, color: tokens.textPrimary, backgroundColor: tokens.background, ...mono },
    placeholder: { color: tokens.textMuted },
    multiline: { minHeight: 140, textAlignVertical: "top", marginTop: 6 },
    chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
    chip: { backgroundColor: tokens.surface, borderWidth: 1, borderColor: tokens.border, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
    chipText: { fontSize: font.label, fontWeight: "600", color: tokens.textPrimary, ...mono },
    link: { color: tokens.accent, fontWeight: "600", ...mono },
    error: { color: tokens.danger, marginTop: 12, ...mono },
    sendButton: {
      backgroundColor: tokens.accent,
      borderRadius: 3,
      paddingHorizontal: 20,
      paddingVertical: 12,
      alignItems: "center",
      marginTop: 16,
      boxShadow: `0 0 12px ${tokens.accentGlow}`,
    },
    sendButtonText: { color: tokens.background, fontWeight: "700", fontSize: font.button, letterSpacing: 0.5, textTransform: "uppercase", ...mono },
  });
}
