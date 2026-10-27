import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Client, WhatsappTemplate } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { useIsOnline } from "../../lib/connectivity";
import { useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../lib/errors";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../../components/theme/ThemedRequiresConnectionNotice";
import { ThemedButton } from "../../components/theme/ThemedButton";

// Mobile version of desktop's WhatsappBroadcast.tsx - same flow (pick a
// template, fill its variables, pick recipients, send, repeat-call the
// processor until done). See that page's own comment and the
// whatsapp_broadcasts/process-whatsapp-broadcast migrations/function for
// why this exists and how it actually sends.

async function dispatchUntilDone(broadcastId: string, onProgress: (sent: number, failed: number) => void): Promise<void> {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) throw new Error("Supabase URL not configured");
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) throw new Error("Not signed in");

  let totalSent = 0;
  let totalFailed = 0;
  for (;;) {
    const res = await fetch(`${supabaseUrl}/functions/v1/process-whatsapp-broadcast`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ broadcast_id: broadcastId }),
    });
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(body.detail || body.error || "Failed to send broadcast");
    totalSent += body.sent ?? 0;
    totalFailed += body.failed ?? 0;
    onProgress(totalSent, totalFailed);
    if (!body.remaining) break;
  }
}

export default function WhatsappBroadcastScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";
  const styles = useThemedStyles(createStyles);

  const { data: templates } = useSupabaseFetch<WhatsappTemplate[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("whatsapp_templates").select("*").eq("is_active", true).order("name");
    if (error) throw error;
    return data as WhatsappTemplate[];
  }, [isOnline]);

  const { data: clients } = useSupabaseFetch<Pick<Client, "id" | "name" | "company_name" | "phone">[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("clients").select("id, name, company_name, phone").order("name");
    if (error) throw error;
    return data as Pick<Client, "id" | "name" | "company_name" | "phone">[];
  }, [isOnline]);

  const [templateId, setTemplateId] = useState<string | null>(null);
  const selectedTemplate = (templates ?? []).find((t) => t.id === templateId) ?? null;

  const [variableModes, setVariableModes] = useState<Record<number, "client_name" | "fixed">>({});
  const [variableFixedValues, setVariableFixedValues] = useState<Record<number, string>>({});
  const [clientSearch, setClientSearch] = useState("");
  const [selectedClientIds, setSelectedClientIds] = useState<Set<string>>(new Set());
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<{ sent: number; failed: number } | null>(null);

  const filteredClients = (clients ?? []).filter((c) => `${c.company_name ?? ""} ${c.name}`.toLowerCase().includes(clientSearch.trim().toLowerCase()));
  const selectedClients = (clients ?? []).filter((c) => selectedClientIds.has(c.id));
  const recipientsWithPhone = selectedClients.filter((c) => !!c.phone);

  const toggleClient = (id: string) => {
    setSelectedClientIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSend = async () => {
    if (!selectedTemplate) {
      setSendError("Choose a template first");
      return;
    }
    if (recipientsWithPhone.length === 0) {
      setSendError("Select at least one client with a phone number on file");
      return;
    }
    setSendError(null);
    setSending(true);
    setProgress({ sent: 0, failed: 0 });
    try {
      const { data: broadcast, error: broadcastError } = await supabase
        .from("whatsapp_broadcasts")
        .insert({
          tenant_id: profile!.tenant_id,
          template_id: selectedTemplate.id,
          name: `${selectedTemplate.name} - ${new Date().toLocaleDateString("en-AU")}`,
          total_recipients: recipientsWithPhone.length,
          created_by: profile!.id,
        })
        .select("id")
        .single();
      if (broadcastError || !broadcast) throw broadcastError ?? new Error("Failed to create broadcast");

      const recipientRows = recipientsWithPhone.map((c) => ({
        broadcast_id: broadcast.id,
        tenant_id: profile!.tenant_id,
        client_id: c.id,
        phone: c.phone,
        variable_values: selectedTemplate.variable_labels.map((_, i) => (variableModes[i] === "client_name" ? c.name : variableFixedValues[i] ?? "")),
      }));
      const { error: recipientsError } = await supabase.from("whatsapp_broadcast_recipients").insert(recipientRows);
      if (recipientsError) throw recipientsError;

      await dispatchUntilDone(broadcast.id, (sent, failed) => setProgress({ sent, failed }));
      router.back();
    } catch (e) {
      setSendError(getErrorMessage(e, "Failed to send broadcast"));
    } finally {
      setSending(false);
    }
  };

  const header = (
    <View style={styles.header}>
      <Pressable onPress={() => router.back()} hitSlop={8}>
        <Text style={styles.link}>‹ Back</Text>
      </Pressable>
      <Text style={styles.headerTitle}>WhatsApp Broadcast</Text>
    </View>
  );

  if (!isOnline) {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
          {header}
          <ThemedRequiresConnectionNotice label="Broadcast" />
        </SafeAreaView>
      </>
    );
  }

  if (!isAdmin) {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
          {header}
          <Text style={styles.empty}>Only an admin can send a broadcast.</Text>
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
          <Text style={styles.sectionTitle}>Template</Text>
          {(templates ?? []).length === 0 ? (
            <Text style={styles.empty}>No active templates - register one in Settings &gt; WhatsApp Templates first.</Text>
          ) : (
            (templates ?? []).map((t) => (
              <Pressable
                key={t.id}
                style={[styles.templateRow, templateId === t.id && styles.templateRowActive]}
                onPress={() => {
                  setTemplateId(t.id);
                  setVariableModes({});
                  setVariableFixedValues({});
                }}
              >
                <Text style={styles.templateRowTitle}>{t.name}</Text>
                <Text style={styles.templateRowBody} numberOfLines={2}>
                  {t.body_preview}
                </Text>
              </Pressable>
            ))
          )}

          {selectedTemplate && selectedTemplate.variable_labels.length > 0 ? (
            <>
              <Text style={styles.sectionTitle}>Variables</Text>
              {selectedTemplate.variable_labels.map((label, i) => (
                <View key={i} style={styles.variableBlock}>
                  <Text style={styles.fieldLabel}>{`{{${i + 1}}} ${label}`}</Text>
                  <View style={styles.modeRow}>
                    <Pressable style={[styles.modeChip, (variableModes[i] ?? "fixed") === "client_name" && styles.modeChipActive]} onPress={() => setVariableModes({ ...variableModes, [i]: "client_name" })}>
                      <Text style={[styles.modeChipText, (variableModes[i] ?? "fixed") === "client_name" && styles.modeChipTextActive]}>Client's own name</Text>
                    </Pressable>
                    <Pressable style={[styles.modeChip, (variableModes[i] ?? "fixed") === "fixed" && styles.modeChipActive]} onPress={() => setVariableModes({ ...variableModes, [i]: "fixed" })}>
                      <Text style={[styles.modeChipText, (variableModes[i] ?? "fixed") === "fixed" && styles.modeChipTextActive]}>Same for everyone</Text>
                    </Pressable>
                  </View>
                  {(variableModes[i] ?? "fixed") === "fixed" ? (
                    <TextInput
                      style={styles.textInput}
                      value={variableFixedValues[i] ?? ""}
                      onChangeText={(v) => setVariableFixedValues({ ...variableFixedValues, [i]: v })}
                      placeholder="Value for every recipient"
                      placeholderTextColor={styles.placeholderColor.color}
                    />
                  ) : null}
                </View>
              ))}
            </>
          ) : null}

          <Text style={styles.sectionTitle}>Recipients ({recipientsWithPhone.length} selected)</Text>
          <TextInput
            style={styles.textInput}
            value={clientSearch}
            onChangeText={setClientSearch}
            placeholder="Search clients..."
            placeholderTextColor={styles.placeholderColor.color}
          />
          {filteredClients.slice(0, 200).map((c) => (
            <Pressable key={c.id} style={styles.clientRow} onPress={() => toggleClient(c.id)}>
              <Text style={styles.checkbox}>{selectedClientIds.has(c.id) ? "☑" : "☐"}</Text>
              <Text style={styles.clientRowText}>
                {c.name}
                {c.company_name ? ` - ${c.company_name}` : ""}
                {!c.phone ? " (no phone)" : ""}
              </Text>
            </Pressable>
          ))}

          {sendError ? <Text style={styles.error}>{sendError}</Text> : null}
          {sending && progress ? <Text style={styles.progress}>Sending... {progress.sent} sent, {progress.failed} failed</Text> : null}

          <View style={{ marginTop: 16 }}>
            <ThemedButton
              label={sending ? "Sending..." : `Send to ${recipientsWithPhone.length} client${recipientsWithPhone.length === 1 ? "" : "s"}`}
              onPress={handleSend}
              disabled={sending || !selectedTemplate || recipientsWithPhone.length === 0}
            />
          </View>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 6 },
    headerTitle: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    sectionTitle: {
      fontSize: font.label,
      fontWeight: "700" as const,
      color: tokens.accent,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      marginTop: 16,
      marginBottom: 6,
      ...mono,
    },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 16, ...mono },
    templateRow: { borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 4, padding: 10, marginBottom: 8 },
    templateRowActive: { borderColor: tokens.accent, backgroundColor: tokens.accentGlow },
    templateRowTitle: { fontWeight: "700" as const, color: tokens.textPrimary, fontSize: font.body - 1, ...mono },
    templateRowBody: { color: tokens.textMuted, fontSize: font.label, ...mono },
    variableBlock: { marginBottom: 12 },
    fieldLabel: { color: tokens.textMuted, fontSize: font.label, marginBottom: 6, ...mono },
    modeRow: { flexDirection: "row" as const, gap: 8, marginBottom: 6 },
    modeChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 3, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface },
    modeChipActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    modeChipText: { color: tokens.textMuted, fontWeight: "600" as const, fontSize: font.label, ...mono },
    modeChipTextActive: { color: tokens.accent },
    textInput: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 10, backgroundColor: tokens.background, color: tokens.textPrimary, fontSize: font.body, marginBottom: 8, ...mono },
    placeholderColor: { color: tokens.textMuted },
    clientRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingVertical: 6 },
    checkbox: { fontSize: font.body, color: tokens.accent, ...mono },
    clientRowText: { color: tokens.textPrimary, fontSize: font.body - 1, flexShrink: 1, ...mono },
    error: { color: tokens.danger, marginTop: 8, ...mono },
    progress: { color: tokens.textMuted, marginTop: 8, ...mono },
  };
}
