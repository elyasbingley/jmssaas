import { useEffect, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, Text, TextInput, View, type TextStyle } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import {
  createClientSchema,
  splitTextWithLinks,
  type ChannelConversation,
  type ChannelMessage,
  type InboxMessage,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { useIsOnline } from "../../lib/connectivity";
import { useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../lib/errors";
import { sendChannelMessage, uploadChannelMedia, decodeEmailConversationId, type ChannelMediaAttachment } from "../../lib/channels";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedFormField } from "../../components/theme/ThemedFormField";
import { ThemedButton } from "../../components/theme/ThemedButton";
import { ThemedRequiresConnectionNotice } from "../../components/theme/ThemedRequiresConnectionNotice";

// Mobile port of apps/desktop/src/pages/ChannelConversationDetail.tsx - a
// plain pushed Stack screen (not a modal/bottom sheet), same as every
// other detail screen in this app including Tasks' own [id].tsx - see
// this feature's own design note on why "opens like a Task" means that on
// mobile, not a new sheet pattern nothing else here uses.

const CHANNEL_ICONS: Record<string, string> = { sms: "💬", whatsapp: "🟢", messenger: "🔵", instagram: "📷" };
const CHANNEL_LABELS: Record<string, string> = { sms: "SMS", whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram" };

// Renders a message body with any http(s) URLs (splitTextWithLinks, shared
// with desktop) as tappable, underlined spans - RN's <Text> doesn't
// auto-linkify plain text the way a browser can, so this is the mobile
// equivalent of desktop's <a> rendering for the same message body.
function LinkifiedText({ body, style, linkStyle }: { body: string; style: TextStyle; linkStyle: TextStyle }) {
  const segments = splitTextWithLinks(body);
  return (
    <Text style={style}>
      {segments.map((seg, i) =>
        seg.isUrl ? (
          <Text
            key={i}
            style={linkStyle}
            onPress={() => Linking.openURL(seg.text).catch(() => Alert.alert("Couldn't open link", seg.text))}
          >
            {seg.text}
          </Text>
        ) : (
          <Text key={i}>{seg.text}</Text>
        )
      )}
    </Text>
  );
}

async function fetchConversation(id: string): Promise<ChannelConversation & { clients: { id: string; name: string } | null }> {
  const { data, error } = await supabase.from("channel_conversations").select("*, clients(id, name)").eq("id", id).single();
  if (error) throw error;
  return data as ChannelConversation & { clients: { id: string; name: string } | null };
}
async function fetchMessages(conversationId: string): Promise<ChannelMessage[]> {
  const { data, error } = await supabase.from("channel_messages").select("*").eq("conversation_id", conversationId).order("created_at");
  if (error) throw error;
  return data as ChannelMessage[];
}
async function fetchInboxMessagesFor(email: string): Promise<InboxMessage[]> {
  const { data, error } = await supabase.from("inbox_messages").select("*").eq("from_email", email).order("received_at", { ascending: false });
  if (error) throw error;
  return data as InboxMessage[];
}

function CreateJobTaskSection(props: { prefillName: string; prefillEmail: string; prefillPhone: string; prefillTitle: string; prefillDescription: string }) {
  const { profile } = useAuth();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const [open, setOpen] = useState(false);
  const [clientName, setClientName] = useState(props.prefillName);
  const [jobTitle, setJobTitle] = useState(props.prefillTitle);
  const [jobDescription, setJobDescription] = useState(props.prefillDescription);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskCreated, setTaskCreated] = useState(false);

  const createJob = async () => {
    if (!profile) return;
    setBusy(true);
    setError(null);
    try {
      const result = createClientSchema.safeParse({ name: clientName, email: props.prefillEmail, phone: props.prefillPhone });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Enter a name");
      if (!jobTitle.trim()) throw new Error("Title is required");

      const { data: newClient, error: clientError } = await supabase
        .from("clients")
        .insert({ ...result.data, tenant_id: profile.tenant_id, created_by: profile.id })
        .select("id")
        .single();
      if (clientError) throw clientError;

      const { data: job, error: jobError } = await supabase
        .from("job_cards")
        .insert({ tenant_id: profile.tenant_id, client_id: newClient.id, title: jobTitle.trim(), description: jobDescription || null, created_by: profile.id })
        .select("id")
        .single();
      if (jobError) throw jobError;

      router.push(`/jobs/${job.id}`);
    } catch (e) {
      setError(getErrorMessage(e, "Failed to create job"));
    } finally {
      setBusy(false);
    }
  };

  const createTask = async () => {
    if (!profile) return;
    setBusy(true);
    setError(null);
    try {
      if (!jobTitle.trim()) throw new Error("Title is required");
      const { error: taskError } = await supabase
        .from("tasks")
        .insert({ tenant_id: profile.tenant_id, title: jobTitle.trim(), description: jobDescription || null, status: "todo", priority: "medium", created_by: profile.id });
      if (taskError) throw taskError;
      setTaskCreated(true);
    } catch (e) {
      setError(getErrorMessage(e, "Failed to create task"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.createSection}>
      {!open ? (
        <View style={styles.createButtonsRow}>
          <Pressable onPress={() => setOpen(true)}>
            <Text style={styles.link}>+ Create job</Text>
          </Pressable>
          <Pressable onPress={createTask} disabled={busy}>
            <Text style={styles.link}>{busy ? "Creating..." : "+ Create task"}</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <ThemedFormField label="Client name" value={clientName} onChangeText={setClientName} />
          <ThemedFormField label="Job title" value={jobTitle} onChangeText={setJobTitle} />
          <ThemedFormField label="Description" value={jobDescription} onChangeText={setJobDescription} multiline style={styles.multiline} />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.createButtonsRow}>
            <Pressable onPress={() => setOpen(false)}>
              <Text style={styles.cancelLink}>Cancel</Text>
            </Pressable>
            <ThemedButton label={busy ? "Creating..." : "Create Job"} onPress={createJob} disabled={busy} />
          </View>
        </>
      )}
      {taskCreated ? <Text style={styles.success}>Task created.</Text> : null}
      {!open && error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function RealConversationDetail({ conversationId }: { conversationId: string }) {
  const styles = useThemedStyles(createStyles);
  const { data: conversation, refetch } = useSupabaseFetch(async () => fetchConversation(conversationId), [conversationId]);
  const { data: messages, refetch: refetchMessages } = useSupabaseFetch(async () => fetchMessages(conversationId), [conversationId]);

  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries: [string, string][] = [];
      for (const m of messages ?? []) {
        for (const media of m.media) {
          const { data } = await supabase.storage.from("channel-media").createSignedUrl(media.storage_path, 3600);
          if (data?.signedUrl) entries.push([media.storage_path, data.signedUrl]);
        }
      }
      if (!cancelled) setMediaUrls(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [messages]);

  useEffect(() => {
    if (conversation && conversation.unread_count > 0) {
      supabase.from("channel_conversations").update({ unread_count: 0 }).eq("id", conversationId).then();
    }
  }, [conversation?.id]);

  const { profile } = useAuth();
  const [reply, setReply] = useState("");
  const [attachment, setAttachment] = useState<ChannelMediaAttachment | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const pickAttachment = async () => {
    if (!profile) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", "Enable photo access in Settings to attach a photo.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], base64: true, quality: 0.9 });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset?.base64) return;

    setAttaching(true);
    setSendError(null);
    try {
      const mimeType = asset.mimeType ?? "image/jpeg";
      const fileName = asset.fileName ?? `photo-${Date.now()}.${mimeType.includes("png") ? "png" : "jpg"}`;
      const uploaded = await uploadChannelMedia({ tenantId: profile.tenant_id, conversationId, base64: asset.base64, fileName, mimeType });
      setAttachment(uploaded);
    } catch (e) {
      setSendError(getErrorMessage(e, "Failed to attach photo"));
    } finally {
      setAttaching(false);
    }
  };

  const send = async () => {
    if (!reply.trim() && !attachment) return;
    setSending(true);
    setSendError(null);
    try {
      await sendChannelMessage(conversationId, reply.trim(), attachment ?? undefined);
      setReply("");
      setAttachment(null);
      refetchMessages();
      refetch();
    } catch (e) {
      setSendError(getErrorMessage(e, "Failed to send"));
    } finally {
      setSending(false);
    }
  };

  if (!conversation) return <View style={{ flex: 1 }} />;

  const canSend = conversation.channel_type === "sms" || conversation.channel_type === "whatsapp" || conversation.channel_type === "messenger";
  const title = conversation.clients?.name || conversation.contact_name || conversation.external_contact;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 24 }}>
        <Text style={styles.title}>
          {CHANNEL_ICONS[conversation.channel_type]} {title}
        </Text>
        <Text style={styles.meta}>
          {CHANNEL_LABELS[conversation.channel_type]} · {conversation.external_contact}
        </Text>

        {(messages ?? []).map((m) => (
          <View key={m.id} style={[styles.bubbleRow, m.direction === "outbound" ? styles.bubbleRowOutbound : styles.bubbleRowInbound]}>
            <View style={[styles.bubble, m.direction === "outbound" ? styles.bubbleOutbound : styles.bubbleInbound]}>
              {m.body ? (
                <LinkifiedText
                  body={m.body}
                  style={m.direction === "outbound" ? styles.bubbleTextOutbound : styles.bubbleTextInbound}
                  linkStyle={styles.bubbleLink}
                />
              ) : null}
              {m.media.map((media) =>
                mediaUrls[media.storage_path] ? (
                  <Text
                    key={media.storage_path}
                    style={styles.mediaLink}
                    onPress={() => Linking.openURL(mediaUrls[media.storage_path]!).catch(() => Alert.alert("Couldn't open attachment"))}
                  >
                    📎 {media.file_name}
                  </Text>
                ) : null
              )}
              <Text style={m.direction === "outbound" ? styles.bubbleTimeOutbound : styles.bubbleTimeInbound}>
                {new Date(m.created_at).toLocaleString("en-AU")}
              </Text>
            </View>
          </View>
        ))}

        <CreateJobTaskSection
          prefillName={conversation.clients?.name || conversation.contact_name || ""}
          prefillEmail=""
          prefillPhone={conversation.channel_type === "sms" || conversation.channel_type === "whatsapp" ? conversation.external_contact : ""}
          prefillTitle=""
          prefillDescription=""
        />
      </ScrollView>

      <View style={styles.composer}>
        {canSend ? (
          <>
            {attachment ? (
              <View style={styles.attachmentPreview}>
                <Text style={styles.attachmentPreviewText} numberOfLines={1}>
                  📎 {attachment.file_name}
                </Text>
                <Pressable onPress={() => setAttachment(null)}>
                  <Text style={styles.attachmentRemove}>Remove</Text>
                </Pressable>
              </View>
            ) : null}
            <View style={styles.composerRow}>
              <Pressable style={styles.attachButton} onPress={pickAttachment} disabled={attaching}>
                <Text style={styles.attachButtonText}>📎</Text>
              </Pressable>
              <TextInput
                style={styles.composerInput}
                value={reply}
                onChangeText={setReply}
                placeholder="Type a reply..."
                placeholderTextColor={styles.composerInputPlaceholder.color}
                multiline
              />
              <Pressable style={styles.sendButton} onPress={send} disabled={sending || attaching || (!reply.trim() && !attachment)}>
                <Text style={styles.sendButtonText}>{sending ? "..." : attaching ? "..." : "Send"}</Text>
              </Pressable>
            </View>
            {sendError ? <Text style={styles.error}>{sendError}</Text> : null}
          </>
        ) : (
          <Text style={styles.notConnected}>Sending isn't available on {CHANNEL_LABELS[conversation.channel_type]} yet - see Settings.</Text>
        )}
      </View>
    </View>
  );
}

function EmailConversationDetail({ email }: { email: string }) {
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const { data: messages } = useSupabaseFetch(async () => fetchInboxMessagesFor(email), [email]);
  const latest = messages?.[0];

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 24 }}>
      <Text style={styles.title}>✉️ {latest?.from_name || email}</Text>
      <Text style={styles.meta}>Email · {email}</Text>

      {(messages ?? []).map((m) => (
        <View key={m.id} style={styles.emailCard}>
          <View style={styles.emailCardHeaderRow}>
            <Text style={styles.emailSubject} numberOfLines={1}>
              {m.subject || "(no subject)"}
            </Text>
            <Text style={styles.emailDate}>{new Date(m.received_at).toLocaleString("en-AU")}</Text>
          </View>
          {m.body_text ? <Text style={styles.emailBody}>{m.body_text}</Text> : null}
          <Pressable onPress={() => router.push(`/inbox/${m.id}`)}>
            <Text style={styles.link}>Open in Inbox →</Text>
          </Pressable>
        </View>
      ))}

      <Text style={styles.notConnected}>Replying, attaching files, and AI-drafted job suggestions all still happen from the Inbox screen.</Text>

      <CreateJobTaskSection
        prefillName={latest?.from_name || ""}
        prefillEmail={email}
        prefillPhone=""
        prefillTitle={latest?.subject || ""}
        prefillDescription={latest?.body_text || ""}
      />
    </ScrollView>
  );
}

export default function ChannelConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isOnline = useIsOnline();
  const styles = useThemedStyles(createStyles);

  const header = (
    <View style={styles.header}>
      <Pressable onPress={() => router.back()} hitSlop={8}>
        <Text style={styles.link}>‹ Back</Text>
      </Pressable>
      <Text style={styles.headerTitle}>Conversation</Text>
    </View>
  );

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        {header}
        {!isOnline ? (
          <ThemedRequiresConnectionNotice label="Channels" />
        ) : !id ? null : (() => {
          const email = decodeEmailConversationId(id);
          return email ? <EmailConversationDetail email={email} /> : <RealConversationDetail conversationId={id} />;
        })()}
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
    title: { fontSize: font.title - 1, fontWeight: "700" as const, color: tokens.textPrimary, ...mono },
    meta: { fontSize: font.label, color: tokens.textMuted, marginTop: 4, marginBottom: 16, ...mono },
    bubbleRow: { marginBottom: 8, flexDirection: "row" as const },
    bubbleRowOutbound: { justifyContent: "flex-end" as const },
    bubbleRowInbound: { justifyContent: "flex-start" as const },
    bubble: { maxWidth: "80%" as const, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 8 },
    bubbleOutbound: { backgroundColor: tokens.accentGlow, borderWidth: 1, borderColor: tokens.accent },
    bubbleInbound: { backgroundColor: tokens.surface, borderWidth: 1, borderColor: tokens.border },
    bubbleTextOutbound: { color: tokens.textPrimary, fontSize: font.body - 1, ...mono },
    bubbleTextInbound: { color: tokens.textPrimary, fontSize: font.body - 1, ...mono },
    bubbleLink: { color: tokens.accent, textDecorationLine: "underline" as const, fontSize: font.body - 1, ...mono },
    bubbleTimeOutbound: { color: tokens.textMuted, fontSize: font.label - 1, marginTop: 4, ...mono },
    bubbleTimeInbound: { color: tokens.textMuted, fontSize: font.label - 1, marginTop: 4, ...mono },
    mediaLink: { color: tokens.accent, textDecorationLine: "underline" as const, marginTop: 4, ...mono },
    composer: { borderTopWidth: 1, borderTopColor: tokens.border, padding: 12 },
    composerRow: { flexDirection: "row" as const, gap: 8, alignItems: "flex-end" as const },
    attachButton: { borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 8, justifyContent: "center" as const },
    attachButtonText: { fontSize: 18 },
    attachmentPreview: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, backgroundColor: tokens.surface, borderWidth: 1, borderColor: tokens.border, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 6, marginBottom: 8 },
    attachmentPreviewText: { flex: 1, fontSize: font.label, color: tokens.textPrimary, ...mono },
    attachmentRemove: { fontSize: font.label, fontWeight: "700" as const, color: tokens.danger, ...mono },
    composerInput: {
      flex: 1,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 3,
      paddingHorizontal: 12,
      paddingVertical: 8,
      maxHeight: 100,
      fontSize: font.body - 1,
      color: tokens.textPrimary,
      backgroundColor: tokens.background,
      ...mono,
    },
    composerInputPlaceholder: { color: tokens.textMuted },
    sendButton: { borderWidth: 1, borderColor: tokens.accent, backgroundColor: tokens.accentGlow, borderRadius: 3, paddingHorizontal: 16, paddingVertical: 10 },
    sendButtonText: { color: tokens.accent, fontWeight: "700" as const, ...mono },
    notConnected: { fontSize: font.label, color: tokens.textMuted, marginVertical: 12, ...mono },
    emailCard: { borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 4, padding: 12, marginBottom: 10 },
    emailCardHeaderRow: { flexDirection: "row" as const, justifyContent: "space-between" as const, marginBottom: 4, gap: 8 },
    emailSubject: { fontSize: font.body - 1, fontWeight: "700" as const, color: tokens.textPrimary, flex: 1, ...mono },
    emailDate: { fontSize: font.label - 1, color: tokens.textMuted, ...mono },
    emailBody: { fontSize: font.label, color: tokens.textMuted, marginBottom: 6, ...mono },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    cancelLink: { color: tokens.textMuted, fontWeight: "600" as const, ...mono },
    createSection: { borderTopWidth: 1, borderTopColor: tokens.border, paddingTop: 16, marginTop: 8, gap: 8 },
    createButtonsRow: { flexDirection: "row" as const, gap: 20, alignItems: "center" as const },
    multiline: { minHeight: 70, textAlignVertical: "top" as const },
    error: { color: tokens.danger, fontSize: font.label, ...mono },
    success: { color: tokens.accent, fontSize: font.label, ...mono },
  };
}
