import { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { InboxAttachment, InboxMessage, InboxMessageStatus } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useIsOnline } from "../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { RequiresConnectionNotice } from "../../components/RequiresConnectionNotice";

// Admin-only triage inbox (see (tabs)/settings/index.tsx), mirroring the
// desktop Inbox/InboxMessage pages - not a PowerSync table (inbox_messages/
// inbox_attachments don't need offline access), so this is Supabase-direct/
// connection-gated like Knowledge and the quotes/invoices/calendar screens.

type Tab = "queue" | "attached" | "dismissed";

const TAB_STATUSES: Record<Tab, InboxMessageStatus[]> = {
  queue: ["unprocessed", "needs_review"],
  attached: ["attached"],
  dismissed: ["dismissed"],
};

const STATUS_LABELS: Record<InboxMessageStatus, string> = {
  unprocessed: "New",
  needs_review: "Needs review",
  attached: "Attached",
  dismissed: "Dismissed",
};

async function fetchMessages(): Promise<(InboxMessage & { inbox_attachments: InboxAttachment[] })[]> {
  const { data, error } = await supabase.from("inbox_messages").select("*, inbox_attachments(*)").order("received_at", { ascending: false });
  if (error) throw error;
  return data as (InboxMessage & { inbox_attachments: InboxAttachment[] })[];
}

export default function InboxScreen() {
  const router = useRouter();
  const isOnline = useIsOnline();
  const [tab, setTab] = useState<Tab>("queue");

  const { data: messages, loading, refetch } = useSupabaseFetch<(InboxMessage & { inbox_attachments: InboxAttachment[] })[]>(async () => {
    if (!isOnline) return [];
    return fetchMessages();
  }, [isOnline]);
  useRefetchOnFocus(refetch);

  const filtered = useMemo(() => (messages ?? []).filter((m) => TAB_STATUSES[tab].includes(m.status)), [messages, tab]);
  const queueCount = useMemo(() => (messages ?? []).filter((m) => TAB_STATUSES.queue.includes(m.status)).length, [messages]);

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Inbox" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.subtitle}>
        Emails forwarded to your Inbox address. See Settings &gt; Company Details for your Inbox address and forwarding
        instructions.
      </Text>

      <View style={styles.tabBar}>
        {(["queue", "attached", "dismissed"] as Tab[]).map((t) => (
          <Pressable key={t} style={[styles.tab, tab === t && styles.tabActive]} onPress={() => setTab(t)}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === "queue" ? `Queue${queueCount ? ` (${queueCount})` : ""}` : t === "attached" ? "Attached" : "Dismissed"}
            </Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => router.push(`/inbox/${item.id}`)}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.subject || "(no subject)"}
              </Text>
              <Text style={styles.rowSubtitle} numberOfLines={1}>
                {item.from_name ? `${item.from_name} · ` : ""}
                {item.from_email}
              </Text>
            </View>
            {item.inbox_attachments.length > 0 ? (
              <Text style={styles.attachmentBadge}>📎 {item.inbox_attachments.length}</Text>
            ) : null}
            <View style={styles.statusBadge}>
              <Text style={styles.statusBadgeText}>{STATUS_LABELS[item.status]}</Text>
            </View>
          </Pressable>
        )}
        ListEmptyComponent={!loading ? <Text style={styles.empty}>Nothing here.</Text> : null}
        contentContainerStyle={filtered.length === 0 ? styles.emptyContainer : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  subtitle: { color: "#6b7280", padding: 16, paddingBottom: 8, fontSize: 13 },
  tabBar: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  tab: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: "#f3f4f6" },
  tabActive: { backgroundColor: "#1d4ed8" },
  tabText: { color: "#374151", fontWeight: "600", fontSize: 13 },
  tabTextActive: { color: "#fff" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d1d5db",
  },
  rowTitle: { fontSize: 15, fontWeight: "600", color: "#111827" },
  rowSubtitle: { fontSize: 13, color: "#6b7280", marginTop: 2 },
  attachmentBadge: { fontSize: 12, color: "#6b7280", flexShrink: 0 },
  statusBadge: { backgroundColor: "#e5e7eb", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 0 },
  statusBadgeText: { fontSize: 11, fontWeight: "700", color: "#374151" },
  empty: { textAlign: "center", color: "#6b7280" },
  emptyContainer: { flex: 1, justifyContent: "center", padding: 24 },
});
