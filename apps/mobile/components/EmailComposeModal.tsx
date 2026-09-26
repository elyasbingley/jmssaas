import { useEffect, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import type { EmailAttachment } from "@jmssaas/shared";
import { ThemedFormField } from "./theme/ThemedFormField";
import { ThemedPickerModal } from "./theme/ThemedPickerModal";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";

export interface EmailTemplateOption {
  id: string;
  name: string;
  subject: string;
  body: string;
}

// Kept well under Resend's ~40MB total request limit, same guardrail as
// desktop's EmailComposeModal.tsx - a per-file cap, not a running total.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

interface EmailComposeModalProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  defaultTo: string;
  defaultSubject: string;
  defaultBody: string;
  // Every email address linked to this client/job - rendered as
  // tap-to-add chips, same as desktop's RecipientChips.
  recipientOptions: string[];
  templates?: EmailTemplateOption[];
  defaultAttachments?: EmailAttachment[];
  onSend: (payload: { to: string; cc: string; bcc: string; subject: string; body: string; attachments: EmailAttachment[] }) => Promise<void>;
  sendLabel?: string;
}

function extensionFor(mimeType: string | undefined): string {
  return mimeType?.includes("png") ? "png" : "jpg";
}

// One editable-body, To/Cc/Bcc, optional-template compose modal - the
// mobile port of apps/desktop/src/components/EmailComposeModal.tsx, used
// the same way: every "send email" action in the app (quote/invoice
// delivery, job free-form email) gets full CC/BCC, an editable body,
// attachments and an Insert Link button instead of firing a template
// unedited, exactly like desktop already does.
export function EmailComposeModal({
  visible,
  onClose,
  title,
  defaultTo,
  defaultSubject,
  defaultBody,
  recipientOptions,
  templates,
  defaultAttachments,
  onSend,
  sendLabel,
}: EmailComposeModalProps) {
  const [to, setTo] = useState(defaultTo);
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(defaultBody);
  const [bodySelection, setBodySelection] = useState({ start: 0, end: 0 });
  const [templateId, setTemplateId] = useState("");
  const [templatePickerVisible, setTemplatePickerVisible] = useState(false);
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [attachments, setAttachments] = useState<EmailAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkModalVisible, setLinkModalVisible] = useState(false);
  const [linkText, setLinkText] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const styles = useThemedStyles(createStyles);

  useEffect(() => {
    if (visible) {
      setTo(defaultTo);
      setCc("");
      setBcc("");
      setSubject(defaultSubject);
      setBody(defaultBody);
      setTemplateId("");
      setShowCcBcc(false);
      setAttachments(defaultAttachments ?? []);
      setAttachmentError(null);
      setError(null);
    }
    // Only re-seed when the modal opens, not on every prop change while
    // it's already open - see desktop's identical comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const addToField = (field: "to" | "cc" | "bcc", email: string) => {
    const current = field === "to" ? to : field === "cc" ? cc : bcc;
    const parts = current.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.some((p) => p.toLowerCase() === email.toLowerCase())) return;
    const next = [...parts, email].join(", ");
    if (field === "to") setTo(next);
    else if (field === "cc") setCc(next);
    else setBcc(next);
  };

  const openInsertLink = () => {
    const { start, end } = bodySelection;
    setLinkText(start !== end ? body.slice(start, end) : "");
    setLinkUrl("");
    setLinkModalVisible(true);
  };

  const handleInsertLink = () => {
    const trimmedUrl = linkUrl.trim();
    if (!trimmedUrl) return;
    const href = /^[a-z][a-z0-9+.-]*:/i.test(trimmedUrl) ? trimmedUrl : `https://${trimmedUrl}`;
    const text = linkText.trim() || href;
    const tag = `<a href="${href}">${text}</a>`;
    const { start, end } = bodySelection;
    setBody(body.slice(0, start) + tag + body.slice(end));
    setLinkModalVisible(false);
  };

  const addAttachments = (newOnes: EmailAttachment[]) => setAttachments((prev) => [...prev, ...newOnes]);

  // Reads each picked asset back off disk rather than relying on
  // ImagePicker's own `base64: true` option, which is unreliable once
  // `allowsMultipleSelection` triggers the native multi-select picker -
  // same bug as PhotoAttachments.tsx's own comment on this ("Choose
  // photos" silently doing nothing because every asset came back with no
  // base64 and the loop just skipped it).
  const pickAttachmentPhotos = async () => {
    setAttachmentError(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", "Enable photo access in Settings to attach photos.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.7,
      allowsMultipleSelection: true,
      selectionLimit: 10,
    });
    if (result.canceled) return;

    const oversized = result.assets.find((a) => a.fileSize && a.fileSize > MAX_ATTACHMENT_BYTES);
    if (oversized) {
      setAttachmentError(`${oversized.fileName ?? "That photo"} is too large (max 10MB per file)`);
      return;
    }
    const newOnes: EmailAttachment[] = [];
    for (const asset of result.assets) {
      try {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
        const mimeType = asset.mimeType ?? "image/jpeg";
        newOnes.push({
          filename: asset.fileName ?? `photo.${extensionFor(mimeType)}`,
          content: `data:${mimeType};base64,${base64}`,
        });
      } catch (e) {
        console.error("[EmailComposeModal] Failed to read picked photo", e);
        setAttachmentError("One of the selected photos couldn't be read.");
      }
    }
    addAttachments(newOnes);
  };

  const pickAttachmentFiles = async () => {
    setAttachmentError(null);
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return;

    const oversized = result.assets.find((a) => (a.size ?? 0) > MAX_ATTACHMENT_BYTES);
    if (oversized) {
      setAttachmentError(`${oversized.name} is too large (max 10MB per file)`);
      return;
    }
    try {
      const newOnes: EmailAttachment[] = [];
      for (const asset of result.assets) {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
        const mimeType = asset.mimeType ?? "application/octet-stream";
        newOnes.push({ filename: asset.name, content: `data:${mimeType};base64,${base64}` });
      }
      addAttachments(newOnes);
    } catch (e) {
      console.error("[EmailComposeModal] Failed to read picked file", e);
      setAttachmentError("Failed to attach file");
    }
  };

  const handleSend = async () => {
    if (!to.trim()) {
      setError("Add at least one recipient");
      return;
    }
    setSending(true);
    setError(null);
    try {
      await onSend({ to: to.trim(), cc: cc.trim(), bcc: bcc.trim(), subject, body, attachments });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send");
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <Pressable onPress={onClose}>
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>
        <ScrollView style={styles.body} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          {templates && templates.length > 0 ? (
            <View style={styles.fieldSpacing}>
              <Text style={styles.fieldLabel}>Template</Text>
              <Pressable style={styles.pickerField} onPress={() => setTemplatePickerVisible(true)}>
                <Text style={templateId ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
                  {templates.find((t) => t.id === templateId)?.name ?? "Write from scratch"}
                </Text>
              </Pressable>
            </View>
          ) : null}

          <ThemedFormField label="To" placeholder="name@example.com" value={to} onChangeText={setTo} autoCapitalize="none" keyboardType="email-address" />
          {recipientOptions.length > 0 ? (
            <View style={styles.chipsRow}>
              {recipientOptions.map((email) => (
                <Pressable key={email} style={styles.chip} onPress={() => addToField("to", email)}>
                  <Text style={styles.chipText}>+ {email}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          {!showCcBcc ? (
            <Pressable onPress={() => setShowCcBcc(true)} style={styles.fieldSpacing}>
              <Text style={styles.link}>+ Cc / Bcc</Text>
            </Pressable>
          ) : (
            <>
              <View style={styles.fieldSpacing}>
                <ThemedFormField label="Cc" placeholder="name@example.com, another@example.com" value={cc} onChangeText={setCc} autoCapitalize="none" />
              </View>
              {recipientOptions.length > 0 ? (
                <View style={styles.chipsRow}>
                  {recipientOptions.map((email) => (
                    <Pressable key={email} style={styles.chip} onPress={() => addToField("cc", email)}>
                      <Text style={styles.chipText}>+ {email}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              <View style={styles.fieldSpacing}>
                <ThemedFormField label="Bcc" placeholder="name@example.com" value={bcc} onChangeText={setBcc} autoCapitalize="none" />
              </View>
              {recipientOptions.length > 0 ? (
                <View style={styles.chipsRow}>
                  {recipientOptions.map((email) => (
                    <Pressable key={email} style={styles.chip} onPress={() => addToField("bcc", email)}>
                      <Text style={styles.chipText}>+ {email}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </>
          )}

          <View style={styles.fieldSpacing}>
            <ThemedFormField label="Subject" value={subject} onChangeText={setSubject} />
          </View>

          <View style={[styles.fieldSpacing, styles.bodyHeaderRow]}>
            <Text style={styles.fieldLabel}>Body</Text>
            <Pressable onPress={openInsertLink}>
              <Text style={styles.link}>🔗 Insert link</Text>
            </Pressable>
          </View>
          <TextInput
            style={[styles.input, styles.multiline]}
            placeholderTextColor={styles.placeholder.color}
            value={body}
            onChangeText={setBody}
            onSelectionChange={(e) => setBodySelection(e.nativeEvent.selection)}
            multiline
          />

          <View style={[styles.fieldSpacing, styles.bodyHeaderRow]}>
            <Text style={styles.fieldLabel}>Attachments</Text>
          </View>
          {attachments.length > 0 ? (
            <View style={{ gap: 6 }}>
              {attachments.map((a, i) => (
                <View key={`${a.filename}-${i}`} style={styles.attachmentRow}>
                  <Text style={styles.attachmentName} numberOfLines={1}>
                    📎 {a.filename}
                  </Text>
                  <Pressable onPress={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}>
                    <Text style={styles.removeLink}>Remove</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
          <View style={styles.attachmentActions}>
            <Pressable onPress={pickAttachmentPhotos}>
              <Text style={styles.link}>+ Add photo</Text>
            </Pressable>
            <Pressable onPress={pickAttachmentFiles}>
              <Text style={styles.link}>+ Add file</Text>
            </Pressable>
          </View>
          {attachmentError ? <Text style={styles.error}>{attachmentError}</Text> : null}

          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable style={styles.sendButton} onPress={handleSend} disabled={sending}>
            <Text style={styles.sendButtonText}>{sending ? "Sending..." : (sendLabel ?? "Send")}</Text>
          </Pressable>
        </ScrollView>
      </View>

      {templates ? (
        <ThemedPickerModal
          visible={templatePickerVisible}
          title="Select template"
          items={templates}
          getKey={(t) => t.id}
          getLabel={(t) => t.name}
          onSelect={(t) => {
            setTemplateId(t.id);
            setSubject(t.subject);
            setBody(t.body);
          }}
          onClose={() => setTemplatePickerVisible(false)}
        />
      ) : null}

      <Modal visible={linkModalVisible} animationType="fade" transparent onRequestClose={() => setLinkModalVisible(false)}>
        <View style={styles.linkModalOverlay}>
          <View style={styles.linkModalCard}>
            <Text style={styles.linkModalTitle}>Insert link</Text>
            <ThemedFormField label="Link text" placeholder="e.g. View your invoice" value={linkText} onChangeText={setLinkText} />
            <ThemedFormField label="URL" placeholder="https://example.com" value={linkUrl} onChangeText={setLinkUrl} autoCapitalize="none" />
            <View style={styles.linkModalActions}>
              <Pressable onPress={() => setLinkModalVisible(false)}>
                <Text style={styles.link}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.sendButton} onPress={handleInsertLink}>
                <Text style={styles.sendButtonText}>Insert</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
    fieldLabel: { fontSize: font.label, fontWeight: "600", color: tokens.textMuted, marginBottom: 6, letterSpacing: 1, textTransform: "uppercase", ...mono },
    bodyHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 0 },
    pickerField: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, backgroundColor: tokens.background },
    pickerFieldText: { fontSize: font.body, color: tokens.textPrimary, ...mono },
    pickerFieldPlaceholder: { fontSize: font.body, color: tokens.textMuted, ...mono },
    input: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, fontSize: font.body, color: tokens.textPrimary, backgroundColor: tokens.background, ...mono },
    placeholder: { color: tokens.textMuted },
    multiline: { minHeight: 160, textAlignVertical: "top", marginTop: 6 },
    chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
    chip: { backgroundColor: tokens.surface, borderWidth: 1, borderColor: tokens.border, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
    chipText: { fontSize: font.label, fontWeight: "600", color: tokens.textPrimary, ...mono },
    link: { color: tokens.accent, fontWeight: "600", ...mono },
    attachmentActions: { flexDirection: "row", gap: 20, marginTop: 8 },
    attachmentRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      backgroundColor: tokens.surface,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 3,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    attachmentName: { flex: 1, fontSize: font.label, color: tokens.textPrimary, marginRight: 8, ...mono },
    removeLink: { color: tokens.danger, fontWeight: "600", fontSize: font.label, ...mono },
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
    linkModalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center", justifyContent: "center", padding: 20 },
    linkModalCard: {
      backgroundColor: tokens.surface,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 6,
      padding: 20,
      width: "100%",
      maxWidth: 480,
      gap: 4,
      boxShadow: `0 0 16px ${tokens.accentGlow}`,
    },
    linkModalTitle: { fontSize: font.title, color: tokens.accent, fontWeight: "700", marginBottom: 4, ...mono },
    linkModalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 4 },
  });
}
