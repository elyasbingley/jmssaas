import { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import type { ChannelConversation, ChannelTypeOrEmail, InboxMessage } from "@jmssaas/shared";
import { supabase } from "../../../lib/supabase";
import { useIsOnline } from "../../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { emailConversationId } from "../../../lib/channels";
import { RequiresConnectionNotice } from "../../../components/RequiresConnectionNotice";

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

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Channels" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
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
      <TextInput style={styles.search} placeholder="Search..." value={search} onChangeText={setSearch} />

      <FlatList
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  subtitle: { color: "#6b7280", paddingHorizontal: 16, paddingTop: 12, fontSize: 13 },
  filterBar: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 16, paddingTop: 10 },
  filterChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16, backgroundColor: "#f3f4f6" },
  filterChipActive: { backgroundColor: "#1d4ed8" },
  filterChipText: { color: "#374151", fontWeight: "600", fontSize: 12 },
  filterChipTextActive: { color: "#fff" },
  search: { marginHorizontal: 16, marginTop: 10, marginBottom: 4, borderWidth: 1, borderColor: "#ccc", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d1d5db",
  },
  rowIcon: { fontSize: 20 },
  rowTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowTitle: { fontSize: 15, fontWeight: "600", color: "#374151", flexShrink: 1 },
  rowTitleUnread: { color: "#111827" },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#1d4ed8" },
  rowPreview: { fontSize: 13, color: "#6b7280", marginTop: 2 },
  rowDate: { fontSize: 12, color: "#9ca3af", flexShrink: 0 },
  empty: { textAlign: "center", color: "#6b7280" },
  emptyContainer: { flex: 1, justifyContent: "center", padding: 24 },
});
