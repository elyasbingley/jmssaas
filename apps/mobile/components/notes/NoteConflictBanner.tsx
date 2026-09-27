import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { NoteRevision } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useIsOnline } from "../../lib/connectivity";
import { useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedModal } from "../theme/ThemedModal";

// note_revisions isn't a PowerSync table (see the notes_module migration's
// own comment: history-browsing isn't a "need it in the field" offline
// case), so this - like every other Supabase-direct, connection-gated
// screen in this app - only ever reads it live when online. Offline, this
// renders nothing rather than a stale or misleading banner: a real
// conflict can only be detected once this device's own edit has actually
// synced up and the Postgres trigger has had a chance to compare
// revisions (see notes_handle_revision() in that migration).
export function NoteConflictBanner({ noteId }: { noteId: string }) {
  const isOnline = useIsOnline();
  const styles = useThemedStyles(createStyles);
  const [historyVisible, setHistoryVisible] = useState(false);

  const { data: latest } = useSupabaseFetch<NoteRevision | null>(async () => {
    if (!isOnline) return null;
    const { data, error } = await supabase
      .from("note_revisions")
      .select("*")
      .eq("note_id", noteId)
      .order("edited_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data as NoteRevision | null;
  }, [isOnline, noteId]);

  const { data: history } = useSupabaseFetch<NoteRevision[]>(async () => {
    if (!isOnline || !historyVisible) return [];
    const { data, error } = await supabase
      .from("note_revisions")
      .select("*")
      .eq("note_id", noteId)
      .order("edited_at", { ascending: false })
      .limit(25);
    if (error) throw error;
    return (data as NoteRevision[]) ?? [];
  }, [isOnline, historyVisible, noteId]);

  if (!isOnline || !latest || latest.reason !== "conflict_lost") return null;

  return (
    <>
      <Pressable style={styles.banner} onPress={() => setHistoryVisible(true)}>
        <Text style={styles.bannerText}>
          {"⚠"} This note may have a conflicting edit from another device - tap to view history
        </Text>
      </Pressable>

      <ThemedModal visible={historyVisible} onClose={() => setHistoryVisible(false)}>
        <Text style={styles.title}>Revision History</Text>
        {(history ?? []).map((rev) => (
          <View key={rev.id} style={styles.revisionRow}>
            <View style={styles.revisionHeader}>
              <Text style={styles.revisionDate}>{new Date(rev.edited_at).toLocaleString("en-AU")}</Text>
              {rev.reason === "conflict_lost" ? <Text style={styles.conflictTag}>CONFLICT</Text> : null}
            </View>
            <Text style={styles.revisionTitle}>{rev.title}</Text>
            <Text style={styles.revisionBody} numberOfLines={3}>
              {rev.body || "(empty)"}
            </Text>
          </View>
        ))}
        {(history ?? []).length === 0 ? <Text style={styles.empty}>No earlier revisions yet.</Text> : null}
      </ThemedModal>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    banner: {
      marginHorizontal: 12,
      marginTop: 12,
      padding: 10,
      borderWidth: 1,
      borderColor: tokens.warning,
      borderRadius: 4,
      backgroundColor: tokens.surface,
    },
    bannerText: { color: tokens.warning, fontSize: font.body - 2, fontWeight: "700" as const, ...mono },
    title: { color: tokens.accent, fontSize: font.title, fontWeight: "700" as const, letterSpacing: 1, textTransform: "uppercase" as const, ...mono },
    revisionRow: { borderBottomWidth: 1, borderBottomColor: tokens.border, paddingVertical: 8, gap: 2 },
    revisionHeader: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const },
    revisionDate: { color: tokens.textMuted, fontSize: font.label - 1, ...mono },
    conflictTag: { color: tokens.warning, fontSize: font.label - 1, fontWeight: "700" as const, ...mono },
    revisionTitle: { color: tokens.textPrimary, fontWeight: "700" as const, fontSize: font.body - 1, ...mono },
    revisionBody: { color: tokens.textMuted, fontSize: font.body - 2, ...mono },
    empty: { color: tokens.textMuted, fontSize: font.body - 1, padding: 8, ...mono },
  };
}
