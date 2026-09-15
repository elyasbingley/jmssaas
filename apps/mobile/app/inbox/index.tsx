import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import type { InboxAttachment, InboxMessage, InboxMessageStatus } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useIsOnline } from "../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../../components/theme/ThemedRequiresConnectionNotice";

// Admin-only triage inbox (see More > Settings), mirroring the desktop
// Inbox/InboxMessage pages - not a PowerSync table (inbox_messages/
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
  const styles = useThemedStyles(createStyles);

  const { data: messages, loading, refetch } = useSupabaseFetch<(InboxMessage & { inbox_attachments: InboxAttachment[] })[]>(async () => {
    if (!isOnline) return [];
    return fetchMessages();
  }, [isOnline]);
  useRefetchOnFocus(refetch);

  const filtered = useMemo(() => (messages ?? []).filter((m) => TAB_STATUSES[tab].includes(m.status)), [messages, tab]);
  const queueCount = useMemo(() => (messages ?? []).filter((m) => TAB_STATUSES.queue.includes(m.status)).length, [messages]);

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Inbox</Text>
        </View>

        {!isOnline ? (
          <ThemedRequiresConnectionNotice label="Inbox" />
        ) : (
          <>
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
    subtitle: { color: tokens.textMuted, padding: 16, paddingBottom: 8, fontSize: font.label, ...mono },
    tabBar: { flexDirection: "row" as const, gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
    tab: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 3, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface },
    tabActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    tabText: { color: tokens.textMuted, fontWeight: "600" as const, fontSize: font.label, ...mono },
    tabTextActive: { color: tokens.accent },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    rowTitle: { fontSize: font.body - 1, fontWeight: "600" as const, color: tokens.textPrimary, ...mono },
    rowSubtitle: { fontSize: font.label, color: tokens.textMuted, marginTop: 2, ...mono },
    attachmentBadge: { fontSize: font.label, color: tokens.textMuted, flexShrink: 0, ...mono },
    statusBadge: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 0 },
    statusBadgeText: { fontSize: font.label - 1, fontWeight: "700" as const, color: tokens.textMuted, ...mono },
    empty: { textAlign: "center" as const, color: tokens.textMuted, ...mono },
    emptyContainer: { flex: 1, justifyContent: "center" as const, padding: 24 },
  };
}
