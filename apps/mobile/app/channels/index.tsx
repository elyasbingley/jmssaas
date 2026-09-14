import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ChannelConversation, ChannelTypeOrEmail, InboxMessage } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useIsOnline } from "../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { emailConversationId } from "../../lib/channels";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../../components/theme/ThemedRequiresConnectionNotice";

// Mobile port of apps/desktop/src/pages/Channels.tsx - same unified list
// (real channel_conversations + a virtual "email" row per distinct
// inbox_messages sender), same reasoning for why email isn't duplicated
// into a new table. Not a PowerSync table, so Supabase-direct/connection-
// gated like Inbox/Knowledge.

interface UnifiedRow {
  id: string;
  channelType: ChannelTypeOrEmail;
  title: string;
  subtitle: string;
  preview: string | null;
  timestamp: string;
  unread: boolean;
}

const CHANNEL_ICONS: Record<ChannelTypeOrEmail, string> = { email: "✉️", sms: "💬", whatsapp: "🟢", messenger: "🔵", instagram: "📷" };
const CHANNEL_LABELS: Record<ChannelTypeOrEmail, string> = { email: "Email", sms: "SMS", whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram" };

async function fetchConversations(): Promise<(ChannelConversation & { clients: { name: string } | null })[]> {
  const { data, error } = await supabase.from("channel_conversations").select("*, clients(name)").order("last_message_at", { ascending: false });
  if (error) throw error;
  return data as (ChannelConversation & { clients: { name: string } | null })[];
}
async function fetchInboxMessages(): Promise<InboxMessage[]> {
  const { data, error } = await supabase.from("inbox_messages").select("*").order("received_at", { ascending: false });
  if (error) throw error;
  return data as InboxMessage[];
}

export default function ChannelsScreen() {
  const router = useRouter();
  const isOnline = useIsOnline();
  const styles = useThemedStyles(createStyles);

  const { data: conversations, loading: conversationsLoading, refetch: refetchConversations } = useSupabaseFetch<
    (ChannelConversation & { clients: { name: string } | null })[]
  >(async () => {
    if (!isOnline) return [];
    return fetchConversations();
  }, [isOnline]);
  const { data: inboxMessages, loading: inboxLoading, refetch: refetchInbox } = useSupabaseFetch<InboxMessage[]>(async () => {
    if (!isOnline) return [];
    return fetchInboxMessages();
  }, [isOnline]);
  useRefetchOnFocus(() => {
    refetchConversations();
    refetchInbox();
  });

  const [channelFilter, setChannelFilter] = useState<ChannelTypeOrEmail | "all">("all");
  const [search, setSearch] = useState("");

  const rows = useMemo((): UnifiedRow[] => {
    const realRows: UnifiedRow[] = (conversations ?? []).map((c) => ({
      id: c.id,
      channelType: c.channel_type,
      title: c.clients?.name || c.contact_name || c.external_contact,
      subtitle: c.external_contact,
      preview: c.last_message_preview,
      timestamp: c.last_message_at,
      unread: c.unread_count > 0,
    }));

    const emailBySender = new Map<string, InboxMessage[]>();
    for (const m of inboxMessages ?? []) {
      const list = emailBySender.get(m.from_email) ?? [];
      list.push(m);
      emailBySender.set(m.from_email, list);
    }
    const emailRows: UnifiedRow[] = [...emailBySender.entries()].map(([fromEmail, messages]) => {
      const latest = messages[0]!;
      return {
        id: emailConversationId(fromEmail),
        channelType: "email",
        title: latest.from_name || fromEmail,
        subtitle: fromEmail,
        preview: latest.subject || latest.body_text,
        timestamp: latest.received_at,
        unread: latest.status === "unprocessed" || latest.status === "needs_review",
      };
    });

    const merged = [...realRows, ...emailRows].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const trimmedSearch = search.trim().toLowerCase();
    return merged.filter((r) => {
      if (channelFilter !== "all" && r.channelType !== channelFilter) return false;
      if (trimmedSearch && !r.title.toLowerCase().includes(trimmedSearch) && !r.subtitle.toLowerCase().includes(trimmedSearch)) return false;
      return true;
    });
  }, [conversations, inboxMessages, channelFilter, search]);

  const loading = conversationsLoading || inboxLoading;

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Channels</Text>
        </View>

        {!isOnline ? (
          <ThemedRequiresConnectionNotice label="Channels" />
        ) : (
          <>
            <Text style={styles.subtitle}>Every conversation with a client, in one place.</Text>

            <View style={styles.filterBar}>
              {(["all", "sms", "whatsapp", "messenger", "instagram", "email"] as (ChannelTypeOrEmail | "all")[]).map((f) => (
                <Pressable key={f} style={[styles.filterChip, channelFilter === f && styles.filterChipActive]} onPress={() => setChannelFilter(f)}>
                  <Text style={[styles.filterChipText, channelFilter === f && styles.filterChipTextActive]}>
                    {f === "all" ? "All" : `${CHANNEL_ICONS[f]} ${CHANNEL_LABELS[f]}`}
                  </Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              style={styles.search}
              placeholder="Search..."
              placeholderTextColor={styles.searchPlaceholder.color}
              value={search}
              onChangeText={setSearch}
            />

            <FlatList
              style={{ flex: 1 }}
              data={rows}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <Pressable style={styles.row} onPress={() => router.push(`/channels/${item.id}`)}>
                  <Text style={styles.rowIcon}>{CHANNEL_ICONS[item.channelType]}</Text>
                  <View style={{ flex: 1 }}>
                    <View style={styles.rowTitleRow}>
                      <Text style={[styles.rowTitle, item.unread && styles.rowTitleUnread]} numberOfLines={1}>
                        {item.title}
                      </Text>
                      {item.unread ? <View style={styles.unreadDot} /> : null}
                    </View>
                    <Text style={styles.rowPreview} numberOfLines={1}>
                      {item.preview || item.subtitle}
                    </Text>
                  </View>
                  <Text style={styles.rowDate}>{new Date(item.timestamp).toLocaleDateString("en-AU")}</Text>
                </Pressable>
              )}
              ListEmptyComponent={!loading ? <Text style={styles.empty}>No conversations yet.</Text> : null}
              contentContainerStyle={rows.length === 0 ? styles.emptyContainer : undefined}
            />
          </>
        )}
      </SafeAreaView>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 6 },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    title: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    subtitle: { color: tokens.textMuted, paddingHorizontal: 16, paddingTop: 4, fontSize: font.label, ...mono },
    filterBar: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, paddingHorizontal: 16, paddingTop: 10 },
    filterChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 3, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface },
    filterChipActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    filterChipText: { color: tokens.textMuted, fontWeight: "600" as const, fontSize: font.label - 1, ...mono },
    filterChipTextActive: { color: tokens.accent },
    search: {
      marginHorizontal: 16,
      marginTop: 10,
      marginBottom: 4,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 3,
      paddingHorizontal: 12,
      paddingVertical: 8,
      fontSize: font.body - 1,
      color: tokens.textPrimary,
      backgroundColor: tokens.background,
      ...mono,
    },
    searchPlaceholder: { color: tokens.textMuted },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    rowIcon: { fontSize: 20 },
    rowTitleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    rowTitle: { fontSize: font.body - 1, fontWeight: "600" as const, color: tokens.textMuted, flexShrink: 1, ...mono },
    rowTitleUnread: { color: tokens.textPrimary },
    unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: tokens.accent },
    rowPreview: { fontSize: font.label, color: tokens.textMuted, marginTop: 2, ...mono },
    rowDate: { fontSize: font.label - 1, color: tokens.textMuted, flexShrink: 0, ...mono },
    empty: { textAlign: "center" as const, color: tokens.textMuted, ...mono },
    emptyContainer: { flex: 1, justifyContent: "center" as const, padding: 24 },
  };
}
