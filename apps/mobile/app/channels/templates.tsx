import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { createChannelMessageTemplateSchema, updateChannelMessageTemplateSchema, type ChannelMessageTemplate } from "@jmssaas/shared";
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

// Reachable from SendSmsModal's "Manage templates" link (both the Quote
// "Send via SMS" button and Channels' "New Message" compose use that same
// modal) - plain admin-only CRUD over channel_message_templates. Everyone
// on the tenant can read the list (RLS: tenant read), same as the picker
// itself; only an admin sees the create/edit/delete affordances (RLS:
// admin writes - this screen mirrors that in the UI rather than letting a
// non-admin tap something that fails server-side).
export default function ChannelMessageTemplatesScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";
  const styles = useThemedStyles(createStyles);

  const { data: templates, loading, error, refetch } = useSupabaseFetch<ChannelMessageTemplate[]>(async () => {
    if (!isOnline) return [];
    const { data, error: fetchError } = await supabase.from("channel_message_templates").select("*").order("name");
    if (fetchError) throw fetchError;
    return data as ChannelMessageTemplate[];
  }, [isOnline]);
  useRefetchOnFocus(refetch);

  const [editorVisible, setEditorVisible] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const openNew = () => {
    setEditingId(null);
    setName("");
    setBody("");
    setFormError(null);
    setEditorVisible(true);
  };

  const openEdit = (template: ChannelMessageTemplate) => {
    setEditingId(template.id);
    setName(template.name);
    setBody(template.body);
    setFormError(null);
    setEditorVisible(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setFormError(null);
    try {
      if (editingId) {
        const result = updateChannelMessageTemplateSchema.safeParse({ name, body });
        if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid template");
        const { error: updateError } = await supabase.from("channel_message_templates").update(result.data).eq("id", editingId);
        if (updateError) throw updateError;
      } else {
        const result = createChannelMessageTemplateSchema.safeParse({ name, body });
        if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid template");
        const { error: insertError } = await supabase
          .from("channel_message_templates")
          .insert({ ...result.data, tenant_id: profile?.tenant_id, created_by: profile?.id });
        if (insertError) throw insertError;
      }
      setEditorVisible(false);
      refetch();
    } catch (e) {
      setFormError(getErrorMessage(e, "Failed to save template"));
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
          const { error: deleteError } = await supabase.from("channel_message_templates").delete().eq("id", editingId);
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
        <Text style={styles.headerTitle}>SMS Templates</Text>
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
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {loading ? <Text style={styles.empty}>Loading...</Text> : null}
          {!loading && (templates ?? []).length === 0 ? (
            <Text style={styles.empty}>No templates yet{isAdmin ? " - tap + New to add one." : "."}</Text>
          ) : null}
          {(templates ?? []).map((t) => (
            <Pressable key={t.id} style={styles.row} disabled={!isAdmin} onPress={() => openEdit(t)}>
              <Text style={styles.rowTitle}>{t.name}</Text>
              <Text style={styles.rowBody} numberOfLines={2}>
                {t.body}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </SafeAreaView>

      <ThemedModal visible={editorVisible} onClose={() => setEditorVisible(false)}>
        <Text style={styles.modalTitle}>{editingId ? "Edit template" : "New template"}</Text>
        <ThemedFormField label="Name" placeholder="e.g. Quote follow-up" value={name} onChangeText={setName} />
        <ThemedFormField label="Message" placeholder="Hi {client_first_name}, ..." value={body} onChangeText={setBody} multiline style={styles.multiline} />
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
    row: { borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 4, padding: 12, marginBottom: 10, gap: 4 },
    rowTitle: { fontSize: font.body - 1, fontWeight: "700" as const, color: tokens.textPrimary, ...mono },
    rowBody: { fontSize: font.label, color: tokens.textMuted, ...mono },
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
    multiline: { minHeight: 100, textAlignVertical: "top" as const },
    modalActions: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, marginTop: 8 },
    modalActionsRight: { flexDirection: "row" as const, alignItems: "center" as const, gap: 20 },
    deleteLink: { color: tokens.danger, fontWeight: "600" as const, ...mono },
  };
}
