import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Client, Tenant } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { useIsOnline } from "../../lib/connectivity";
import { useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../lib/errors";
import { startChannelConversation } from "../../lib/channels";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../../components/theme/ThemedRequiresConnectionNotice";
import { ThemedFormField } from "../../components/theme/ThemedFormField";
import { ThemedPickerModal } from "../../components/theme/ThemedPickerModal";
import { SendSmsModal } from "../../components/theme/SendSmsModal";

// New outbound SMS conversation - no existing channel_conversations row yet
// (that's RealConversationDetail in [id].tsx, which only ever replies on
// one). Recipient step here (existing client vs. a manually typed number),
// then the actual compose happens in the same SendSmsModal the Quote
// detail screen's "Send Quote via SMS" button uses - startChannelConversation
// (lib/channels.ts) is the one Edge Function call both paths share.
type RecipientMode = "client" | "manual";

export default function NewChannelMessageScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";
  const styles = useThemedStyles(createStyles);

  const { data: tenant, loading: tenantLoading } = useSupabaseFetch<Tenant>(async () => {
    const { data, error } = await supabase.from("tenants").select("*").eq("id", profile?.tenant_id).single();
    if (error) throw error;
    return data as Tenant;
  }, [isOnline, profile?.tenant_id]);

  const { data: clients } = useSupabaseFetch<Client[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("clients").select("*").order("name");
    if (error) throw error;
    return data as Client[];
  }, [isOnline]);

  const [mode, setMode] = useState<RecipientMode>("client");
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [clientPickerVisible, setClientPickerVisible] = useState(false);
  const [manualPhone, setManualPhone] = useState("");
  const [composeVisible, setComposeVisible] = useState(false);
  const [recipientError, setRecipientError] = useState<string | null>(null);

  const availableChannels: ("sms" | "whatsapp")[] = [
    ...(tenant?.sms_phone_number ? (["sms"] as const) : []),
    ...(tenant?.whatsapp_phone_number ? (["whatsapp"] as const) : []),
  ];
  const [channelTypeChoice, setChannelTypeChoice] = useState<"sms" | "whatsapp">("sms");
  // Falls back to whichever channel is actually configured rather than a
  // plain useState default, since the tenant row (and so which numbers
  // exist) only arrives after this component's first render.
  const channelType = availableChannels.includes(channelTypeChoice) ? channelTypeChoice : availableChannels[0];

  const header = (
    <View style={styles.header}>
      <Pressable onPress={() => router.back()} hitSlop={8}>
        <Text style={styles.link}>‹ Back</Text>
      </Pressable>
      <Text style={styles.headerTitle}>New Message</Text>
    </View>
  );

  if (!isOnline) {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
          {header}
          <ThemedRequiresConnectionNotice label="Channels" />
        </SafeAreaView>
      </>
    );
  }

  // Same pre-flight check as the Quote detail screen's "Send Quote via
  // SMS" - blocks before the recipient/compose UI even opens rather than
  // failing later inside channel-send-message with a less helpful error.
  // Now per channel: either number configured is enough to proceed.
  if (!tenantLoading && tenant && availableChannels.length === 0) {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
          {header}
          <View style={styles.notConfiguredWrap}>
            <Text style={styles.notConfigured}>Set up your SMS or WhatsApp number in Settings &gt; Channels before sending a message.</Text>
          </View>
        </SafeAreaView>
      </>
    );
  }

  const resolvedPhone = mode === "client" ? selectedClient?.phone ?? "" : manualPhone.trim();

  const handleContinue = () => {
    setRecipientError(null);
    if (mode === "client" && !selectedClient) {
      setRecipientError("Select a client");
      return;
    }
    if (mode === "client" && !selectedClient?.phone) {
      setRecipientError("This client has no phone number on file - use Manual number instead, or add one on the Client Details screen.");
      return;
    }
    if (mode === "manual" && !manualPhone.trim()) {
      setRecipientError("Enter a phone number");
      return;
    }
    setComposeVisible(true);
  };

  const handleSend = async (payload: { phone: string; body: string }) => {
    const result = await startChannelConversation({
      channelType: channelType ?? "sms",
      toPhone: payload.phone,
      body: payload.body,
      clientId: mode === "client" ? selectedClient?.id : undefined,
      contactName: mode === "client" ? selectedClient?.name : undefined,
    });
    router.replace(`/channels/${result.conversationId}`);
  };

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        {header}
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          {availableChannels.length > 1 ? (
            <>
              <Text style={styles.sectionTitle}>Channel</Text>
              <View style={[styles.modeRow, { marginBottom: 16 }]}>
                {availableChannels.map((ct) => (
                  <Pressable
                    key={ct}
                    style={[styles.modeChip, channelType === ct && styles.modeChipActive]}
                    onPress={() => setChannelTypeChoice(ct)}
                  >
                    <Text style={[styles.modeChipText, channelType === ct && styles.modeChipTextActive]}>
                      {ct === "sms" ? "💬 SMS" : "🟢 WhatsApp"}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}

          <Text style={styles.sectionTitle}>Send to</Text>
          <View style={styles.modeRow}>
            <Pressable
              style={[styles.modeChip, mode === "client" && styles.modeChipActive]}
              onPress={() => {
                setMode("client");
                setRecipientError(null);
              }}
            >
              <Text style={[styles.modeChipText, mode === "client" && styles.modeChipTextActive]}>Existing client</Text>
            </Pressable>
            <Pressable
              style={[styles.modeChip, mode === "manual" && styles.modeChipActive]}
              onPress={() => {
                setMode("manual");
                setRecipientError(null);
              }}
            >
              <Text style={[styles.modeChipText, mode === "manual" && styles.modeChipTextActive]}>Manual number</Text>
            </Pressable>
          </View>

          {mode === "client" ? (
            <View style={styles.fieldSpacing}>
              <Text style={styles.fieldLabel}>Client</Text>
              <Pressable style={styles.pickerField} onPress={() => setClientPickerVisible(true)}>
                <Text style={selectedClient ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
                  {selectedClient?.name ?? "Select a client"}
                </Text>
              </Pressable>
              {selectedClient ? (
                <Text style={styles.clientPhoneHint}>{selectedClient.phone ?? "No phone number on file"}</Text>
              ) : null}
            </View>
          ) : (
            <View style={styles.fieldSpacing}>
              <ThemedFormField label="Phone number" placeholder="0491 570 156" value={manualPhone} onChangeText={setManualPhone} keyboardType="phone-pad" />
            </View>
          )}

          {recipientError ? <Text style={styles.error}>{recipientError}</Text> : null}

          <Pressable style={styles.continueButton} onPress={handleContinue}>
            <Text style={styles.continueButtonText}>Continue</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>

      <ThemedPickerModal
        visible={clientPickerVisible}
        title="Select client"
        items={clients ?? []}
        getKey={(c) => c.id}
        getLabel={(c) => c.name}
        onSelect={setSelectedClient}
        onClose={() => setClientPickerVisible(false)}
      />

      <SendSmsModal
        visible={composeVisible}
        onClose={() => setComposeVisible(false)}
        title="New message"
        defaultPhone={resolvedPhone}
        defaultBody=""
        isAdmin={isAdmin}
        onSend={handleSend}
        sendLabel={channelType === "whatsapp" ? "Send WhatsApp" : "Send SMS"}
      />
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
      marginBottom: 6,
      ...mono,
    },
    modeRow: { flexDirection: "row" as const, gap: 8 },
    modeChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 3, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface },
    modeChipActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    modeChipText: { color: tokens.textMuted, fontWeight: "600" as const, fontSize: font.body - 1, ...mono },
    modeChipTextActive: { color: tokens.accent },
    fieldSpacing: { marginTop: 16, gap: 6 },
    fieldLabel: {
      color: tokens.textMuted,
      fontSize: font.label,
      letterSpacing: 1,
      textTransform: "uppercase" as const,
      ...mono,
    },
    pickerField: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, backgroundColor: tokens.background },
    pickerFieldText: { fontSize: font.body, color: tokens.textPrimary, ...mono },
    pickerFieldPlaceholder: { fontSize: font.body, color: tokens.textMuted, ...mono },
    clientPhoneHint: { fontSize: font.label, color: tokens.textMuted, ...mono },
    error: { color: tokens.danger, marginTop: 12, ...mono },
    continueButton: {
      backgroundColor: tokens.accent,
      borderRadius: 3,
      paddingHorizontal: 20,
      paddingVertical: 12,
      alignItems: "center" as const,
      marginTop: 20,
      boxShadow: `0 0 12px ${tokens.accentGlow}`,
    },
    continueButtonText: { color: tokens.background, fontWeight: "700" as const, fontSize: font.button, letterSpacing: 0.5, textTransform: "uppercase" as const, ...mono },
    notConfiguredWrap: { flex: 1, padding: 24, alignItems: "center" as const, justifyContent: "center" as const },
    notConfigured: { textAlign: "center" as const, color: tokens.textMuted, fontSize: font.body, ...mono },
  };
}
