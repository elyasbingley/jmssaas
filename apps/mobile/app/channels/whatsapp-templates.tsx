import { useState } from "react";
import { Alert, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { createWhatsappTemplateSchema, updateWhatsappTemplateSchema, type WhatsappTemplate } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { useIsOnline } from "../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../lib/errors";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../../components/theme/ThemedRequiresConnectionNotice";
import { ThemedModal } from "../../components/theme/ThemedModal";
import { ThemedFormField } from "../../components/theme/ThemedFormField";
import { ThemedButton } from "../../components/theme/ThemedButton";

// Mirrors channels/templates.tsx's own shape (admin-only CRUD, tenant
// read), but for whatsapp_templates - registering a Meta-approved Content
// Template (built/submitted in the Twilio Console, not here) rather than
// authoring free text. See that table's own migration comment for why
// this is a separate concept from the plain SMS templates screen.
export default function WhatsappTemplatesScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";
  const styles = useThemedStyles(createStyles);

  const { data: templates, loading, error, refetch } = useSupabaseFetch<WhatsappTemplate[]>(async () => {
    if (!isOnline) return [];
    const { data, error: fetchError } = await supabase.from("whatsapp_templates").select("*").order("name");
    if (fetchError) throw fetchError;
    return data as WhatsappTemplate[];
  }, [isOnline]);
  useRefetchOnFocus(refetch);

  const [editorVisible, setEditorVisible] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [contentSid, setContentSid] = useState("");
  const [bodyPreview, setBodyPreview] = useState("");
  const [variableLabels, setVariableLabels] = useState<string[]>([]);
  const [isActive, setIsActive] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const openNew = () => {
    setEditingId(null);
    setName("");
    setContentSid("");
    setBodyPreview("");
    setVariableLabels([]);
    setIsActive(true);
    setFormError(null);
    setEditorVisible(true);
  };

  const openEdit = (template: WhatsappTemplate) => {
    setEditingId(template.id);
    setName(template.name);
    setContentSid(template.content_sid);
    setBodyPreview(template.body_preview);
    setVariableLabels([...template.variable_labels]);
    setIsActive(template.is_active);
    setFormError(null);
    setEditorVisible(true);
  };

  const updateVariableLabel = (index: number, value: string) => {
    setVariableLabels((prev) => prev.map((l, i) => (i === index ? value : l)));
  };
  const addVariableLabel = () => setVariableLabels((prev) => [...prev, ""]);
  const removeVariableLabel = (index: number) => setVariableLabels((prev) => prev.filter((_, i) => i !== index));

  const handleSave = async () => {
    setSaving(true);
    setFormError(null);
    try {
      const cleanedLabels = variableLabels.map((l) => l.trim()).filter(Boolean);
      const input = { name, content_sid: contentSid, body_preview: bodyPreview, variable_labels: cleanedLabels };
      if (editingId) {
        const result = updateWhatsappTemplateSchema.safeParse(input);
        if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid template");
        const { error: updateError } = await supabase.from("whatsapp_templates").update({ ...result.data, is_active: isActive }).eq("id", editingId);
        if (updateError) throw updateError;
      } else {
        const result = createWhatsappTemplateSchema.safeParse(input);
        if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid template");
        const { error: insertError } = await supabase
          .from("whatsapp_templates")
          .insert({ ...result.data, tenant_id: profile?.tenant_id, created_by: profile?.id });
        if (insertError) throw insertError;
      }
      setEditorVisible(false);
      refetch();
    } catch (e) {
      setFormError(getErrorMessage(e, "Failed to save template - check the Content SID isn't already registered"));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    if (!editingId) return;
    Alert.alert("Delete template", `Delete "${name}"? This can't be undone.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const { error: deleteError } = await supabase.from("whatsapp_templates").delete().eq("id", editingId);
          if (deleteError) {
            setFormError(getErrorMessage(deleteError, "Failed to delete template"));
            return;
          }
          setEditorVisible(false);
          refetch();
        },
      },
    ]);
  };

  const header = (
    <View style={styles.header}>
      <Pressable onPress={() => router.back()} hitSlop={8}>
        <Text style={styles.link}>‹ Back</Text>
      </Pressable>
      <View style={styles.headerRow}>
        <Text style={styles.headerTitle}>WhatsApp Templates</Text>
        {isAdmin ? (
          <Pressable style={styles.newButton} onPress={openNew}>
            <Text style={styles.newButtonText}>+ New</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );

  if (!isOnline) {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
          {header}
          <ThemedRequiresConnectionNotice label="Templates" />
        </SafeAreaView>
      </>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        {header}
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          <Text style={styles.hint}>
            Meta-approved templates for messaging someone first, or broadcasting to many clients. Build and submit the
            template itself in the Twilio Console - register its Content SID here once approved.
          </Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {loading ? <Text style={styles.empty}>Loading...</Text> : null}
          {!loading && (templates ?? []).length === 0 ? (
            <Text style={styles.empty}>No templates registered yet{isAdmin ? " - tap + New once you have an approved Content SID." : "."}</Text>
          ) : null}
          {(templates ?? []).map((t) => (
            <Pressable key={t.id} style={[styles.row, !t.is_active && styles.rowInactive]} disabled={!isAdmin} onPress={() => openEdit(t)}>
              <View style={styles.rowTitleRow}>
                <Text style={styles.rowTitle}>{t.name}</Text>
                {!t.is_active ? <Text style={styles.inactiveBadge}>Inactive</Text> : null}
              </View>
              <Text style={styles.rowBody} numberOfLines={2}>
                {t.body_preview}
              </Text>
              <Text style={styles.rowSid}>{t.content_sid}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </SafeAreaView>

      <ThemedModal visible={editorVisible} onClose={() => setEditorVisible(false)}>
        <ScrollView>
          <Text style={styles.modalTitle}>{editingId ? "Edit template" : "Register template"}</Text>
          <ThemedFormField label="Template name" placeholder="e.g. Winter checkup reminder" value={name} onChangeText={setName} />
          <ThemedFormField label="Content SID" placeholder="HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" value={contentSid} onChangeText={setContentSid} />
          <ThemedFormField
            label="Approved template text (for reference only)"
            placeholder="Hi {{1}}, time for your seasonal checkup from {{2}}. Reply to book."
            value={bodyPreview}
            onChangeText={setBodyPreview}
            multiline
            style={styles.multiline}
          />

          <View style={styles.variablesHeaderRow}>
            <Text style={styles.fieldLabel}>Variables (in {"{{1}}, {{2}}"}... order)</Text>
            <Pressable onPress={addVariableLabel}>
              <Text style={styles.link}>+ Add</Text>
            </Pressable>
          </View>
          {variableLabels.length === 0 ? (
            <Text style={styles.empty}>No variables - this template sends as-is to everyone.</Text>
          ) : (
            variableLabels.map((label, i) => (
              <View key={i} style={styles.variableRow}>
                <Text style={styles.variableIndex}>{`{{${i + 1}}}`}</Text>
                <View style={styles.variableField}>
                  <ThemedFormField label="" placeholder="e.g. Client first name" value={label} onChangeText={(v) => updateVariableLabel(i, v)} />
                </View>
                <Pressable onPress={() => removeVariableLabel(i)} hitSlop={8}>
                  <Text style={styles.deleteLink}>🗑</Text>
                </Pressable>
              </View>
            ))
          )}

          {editingId ? (
            <View style={styles.defaultRow}>
              <Text style={styles.fieldLabel}>Active (off retires without deleting)</Text>
              <Switch value={isActive} onValueChange={setIsActive} />
            </View>
          ) : null}

          {formError ? <Text style={styles.error}>{formError}</Text> : null}
          <View style={styles.modalActions}>
            {editingId ? (
              <Pressable onPress={handleDelete}>
                <Text style={styles.deleteLink}>Delete</Text>
              </Pressable>
            ) : (
              <View />
            )}
            <View style={styles.modalActionsRight}>
              <Pressable onPress={() => setEditorVisible(false)}>
                <Text style={styles.link}>Cancel</Text>
              </Pressable>
              <ThemedButton label={saving ? "Saving..." : "Save"} onPress={handleSave} disabled={saving} />
            </View>
          </View>
        </ScrollView>
      </ThemedModal>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 6 },
    headerRow: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const },
    headerTitle: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    newButton: { borderWidth: 1, borderColor: tokens.accent, borderRadius: 3, paddingVertical: 6, paddingHorizontal: 10 },
    newButtonText: { color: tokens.accent, fontWeight: "700" as const, fontSize: font.label, textTransform: "uppercase" as const, ...mono },
    hint: { color: tokens.textMuted, fontSize: font.label, marginBottom: 12, ...mono },
    row: { borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 4, padding: 12, marginBottom: 10, gap: 4 },
    rowInactive: { opacity: 0.6 },
    rowTitleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    rowTitle: { fontSize: font.body - 1, fontWeight: "700" as const, color: tokens.textPrimary, ...mono },
    inactiveBadge: { fontSize: font.label, fontWeight: "700" as const, color: tokens.textMuted, ...mono },
    rowBody: { fontSize: font.label, color: tokens.textMuted, ...mono },
    rowSid: { fontSize: font.label, color: tokens.textMuted, ...mono },
    fieldLabel: {
      color: tokens.textMuted,
      fontSize: font.label,
      letterSpacing: 1,
      textTransform: "uppercase" as const,
      marginTop: 12,
      marginBottom: 6,
      ...mono,
    },
    variablesHeaderRow: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, marginTop: 12 },
    variableRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, marginBottom: 4 },
    variableIndex: { fontSize: font.label, color: tokens.textMuted, ...mono },
    variableField: { flex: 1 },
    defaultRow: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, marginTop: 12 },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 24, ...mono },
    error: { color: tokens.danger, marginBottom: 8, ...mono },
    modalTitle: {
      fontSize: font.title,
      fontWeight: "700" as const,
      color: tokens.accent,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      ...mono,
    },
    multiline: { minHeight: 80, textAlignVertical: "top" as const },
    modalActions: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, marginTop: 8 },
    modalActionsRight: { flexDirection: "row" as const, alignItems: "center" as const, gap: 20 },
    deleteLink: { color: tokens.danger, fontWeight: "600" as const, ...mono },
  };
}
