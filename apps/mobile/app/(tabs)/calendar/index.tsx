import { useMemo } from "react";
import { Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { CalendarEvent } from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { useIsOnline } from "../../../lib/connectivity";
import { useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { supabase } from "../../../lib/supabase";
import { formatEventDateHeading, formatEventTimeRange, isoToLocalDateInput } from "../../../lib/datetime";
import { AppNavBar } from "../../../components/AppNavBar";
import { RequiresConnectionNotice } from "../../../components/RequiresConnectionNotice";

export default function CalendarScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();

  const { data: events, loading } = useSupabaseFetch<CalendarEvent[]>(async () => {
    const { data, error } = await supabase.from("calendar_events").select("*").order("start_at", { ascending: true });
    if (error) throw error;
    return (data ?? []) as CalendarEvent[];
  }, [isOnline]);

  const sections = useMemo(() => {
    const groups = new Map<string, CalendarEvent[]>();
    for (const event of events ?? []) {
      const key = isoToLocalDateInput(event.start_at);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(event);
    }
    return Array.from(groups.entries()).map(([key, data]) => ({
      title: formatEventDateHeading(data[0].start_at),
      key,
      data,
    }));
  }, [events]);

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <AppNavBar />
        <RequiresConnectionNotice label="Calendar" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <AppNavBar />
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionHeaderText}>{section.title}</Text>
          </View>
        )}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => router.push(`/calendar/${item.id}`)}>
            <Text style={styles.rowTime}>{formatEventTimeRange(item.start_at, item.end_at, item.all_day)}</Text>
            <Text style={styles.rowTitle}>{item.title}</Text>
          </Pressable>
        )}
        ListEmptyComponent={!loading ? <Text style={styles.empty}>No events yet.</Text> : null}
        contentContainerStyle={sections.length === 0 ? styles.emptyContainer : undefined}
      />
      {profile?.role === "admin" ? (
        <Pressable style={styles.fab} onPress={() => router.push("/calendar/new")}>
          <Text style={styles.fabText}>+ New event</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  sectionHeader: { backgroundColor: "#f9fafb", paddingHorizontal: 16, paddingVertical: 6 },
  sectionHeaderText: { fontWeight: "700", color: "#6b7280", fontSize: 13 },
  row: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#f0f0f0" },
  rowTime: { color: "#1d4ed8", fontWeight: "600", fontSize: 12 },
  rowTitle: { fontSize: 16, fontWeight: "600", marginTop: 2 },
  empty: { textAlign: "center", color: "#6b7280" },
  emptyContainer: { flex: 1, justifyContent: "center", padding: 24 },
  fab: {
    position: "absolute",
    right: 16,
    bottom: 24,
    backgroundColor: "#1d4ed8",
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  fabText: { color: "#fff", fontWeight: "700" },
});
