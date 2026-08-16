import { useEffect, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import type { EmailAttachment } from "@jmssaas/shared";
import { FormField } from "./FormField";
import { PickerModal } from "./PickerModal";

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

  const pickAttachmentPhotos = async () => {
    setAttachmentError(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", "Enable photo access in Settings to attach photos.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      base64: true,
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
      if (!asset.base64) continue;
      const mimeType = asset.mimeType ?? "image/jpeg";
      newOnes.push({
        filename: asset.fileName ?? `photo.${extensionFor(mimeType)}`,
        content: `data:${mimeType};base64,${asset.base64}`,
      });
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

          <FormField label="To" placeholder="name@example.com" value={to} onChangeText={setTo} autoCapitalize="none" keyboardType="email-address" />
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
                <FormField label="Cc" placeholder="name@example.com, another@example.com" value={cc} onChangeText={setCc} autoCapitalize="none" />
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
                <FormField label="Bcc" placeholder="name@example.com" value={bcc} onChangeText={setBcc} autoCapitalize="none" />
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
            <FormField label="Subject" value={subject} onChangeText={setSubject} />
          </View>

          <View style={[styles.fieldSpacing, styles.bodyHeaderRow]}>
            <Text style={styles.fieldLabel}>Body</Text>
            <Pressable onPress={openInsertLink}>
              <Text style={styles.link}>🔗 Insert link</Text>
            </Pressable>
          </View>
          <TextInput
            style={[styles.input, styles.multiline]}
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
        <PickerModal
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
            <FormField label="Link text" placeholder="e.g. View your invoice" value={linkText} onChangeText={setLinkText} />
            <FormField label="URL" placeholder="https://example.com" value={linkUrl} onChangeText={setLinkUrl} autoCapitalize="none" />
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d1d5db",
  },
  title: { fontSize: 17, fontWeight: "700" },
  closeText: { color: "#1d4ed8", fontWeight: "600" },
  body: { flex: 1 },
  fieldSpacing: { marginTop: 16 },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: "#374151", marginBottom: 6 },
  bodyHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 0 },
  pickerField: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 },
  pickerFieldText: { fontSize: 15, color: "#111827" },
  pickerFieldPlaceholder: { fontSize: 15, color: "#9ca3af" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 16, color: "#111827" },
  multiline: { minHeight: 160, textAlignVertical: "top", marginTop: 6 },
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  chip: { backgroundColor: "#f3f4f6", borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  chipText: { fontSize: 12, fontWeight: "600", color: "#374151" },
  link: { color: "#1d4ed8", fontWeight: "600" },
  attachmentActions: { flexDirection: "row", gap: 20, marginTop: 8 },
  attachmentRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#f3f4f6", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  attachmentName: { flex: 1, fontSize: 13, color: "#374151", marginRight: 8 },
  removeLink: { color: "#dc2626", fontWeight: "600", fontSize: 12 },
  error: { color: "#dc2626", marginTop: 12 },
  sendButton: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 12, alignItems: "center", marginTop: 16 },
  sendButtonText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  linkModalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", alignItems: "center", justifyContent: "center", padding: 20 },
  linkModalCard: { backgroundColor: "#fff", borderRadius: 16, padding: 20, width: "100%", maxWidth: 480, gap: 4 },
  linkModalTitle: { fontSize: 17, fontWeight: "700", marginBottom: 4 },
  linkModalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 4 },
});
