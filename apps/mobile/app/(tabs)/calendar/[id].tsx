import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { CalendarEvent } from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { useIsOnline } from "../../../lib/connectivity";
import { useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { supabase } from "../../../lib/supabase";
import { combineLocalDateTimeToIso, isoToLocalDateInput, isoToLocalTimeInput } from "../../../lib/datetime";
import { RequiresConnectionNotice } from "../../../components/RequiresConnectionNotice";

type CalendarEventRow = CalendarEvent & {
  job_cards: { title: string; assigned_technician_id: string | null } | null;
  tasks: { title: string; assigned_to: string | null } | null;
};

export default function CalendarEventDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";

  const { data: event, loading, refetch } = useSupabaseFetch<CalendarEventRow>(async () => {
    const { data, error } = await supabase
      .from("calendar_events")
      .select("*, job_cards(title, assigned_technician_id), tasks(title, assigned_to)")
      .eq("id", id)
      .single();
    if (error) throw error;
    return data as CalendarEventRow;
  }, [id, isOnline]);

  const canEdit =
    isAdmin ||
    (event?.job_cards && event.job_cards.assigned_technician_id === profile?.id) ||
    (event?.tasks && event.tasks.assigned_to === profile?.id);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (event) {
      setTitle(event.title);
      setDescription(event.description ?? "");
      setStartDate(isoToLocalDateInput(event.start_at));
      setStartTime(isoToLocalTimeInput(event.start_at));
      setEndDate(isoToLocalDateInput(event.end_at));
      setEndTime(isoToLocalTimeInput(event.end_at));
    }
  }, [event]);

  const handleSave = async () => {
    if (!event) return;
    const startIso = combineLocalDateTimeToIso(startDate, event.all_day ? "00:00" : startTime);
    const endIso = combineLocalDateTimeToIso(endDate, event.all_day ? "23:59" : endTime);
    if (!startIso || !endIso || !title.trim()) {
      setSaveError("Title, start and end are required");
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const { error } = await supabase
        .from("calendar_events")
        .update({
          title: title.trim(),
          description: description || null,
          start_at: startIso,
          end_at: endIso,
        })
        .eq("id", id);
      if (error) throw error;
      refetch();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    Alert.alert("Delete event", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await supabase.from("calendar_events").delete().eq("id", id);
          router.back();
        },
      },
    ]);
  };

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Calendar" />
      </View>
    );
  }

  if (loading || !event) {
    return (
      <View style={styles.container}>
        <Text style={styles.empty}>Loading...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <Text style={styles.sectionTitle}>Title</Text>
      <TextInput style={styles.input} value={title} onChangeText={setTitle} editable={!!canEdit} />

      <Text style={styles.sectionTitle}>Description</Text>
      <TextInput
        style={[styles.input, styles.multiline]}
        value={description}
        onChangeText={setDescription}
        multiline
        editable={!!canEdit}
      />

      <Text style={styles.sectionTitle}>Start</Text>
      <View style={styles.dateTimeRow}>
        <TextInput style={[styles.input, { flex: 1 }]} value={startDate} onChangeText={setStartDate} editable={!!canEdit} />
        {!event.all_day ? (
          <TextInput style={[styles.input, styles.timeInput]} value={startTime} onChangeText={setStartTime} editable={!!canEdit} />
        ) : null}
      </View>

      <Text style={styles.sectionTitle}>End</Text>
      <View style={styles.dateTimeRow}>
        <TextInput style={[styles.input, { flex: 1 }]} value={endDate} onChangeText={setEndDate} editable={!!canEdit} />
        {!event.all_day ? (
          <TextInput style={[styles.input, styles.timeInput]} value={endTime} onChangeText={setEndTime} editable={!!canEdit} />
        ) : null}
      </View>

      {event.job_cards ? (
        <Pressable onPress={() => router.push(`/jobs/${event.job_card_id}`)}>
          <Text style={styles.link}>Linked job: {event.job_cards.title}</Text>
        </Pressable>
      ) : null}
      {event.tasks ? (
        <Pressable onPress={() => router.push(`/tasks/${event.task_id}`)}>
          <Text style={styles.link}>Linked task: {event.tasks.title}</Text>
        </Pressable>
      ) : null}

      <Text style={styles.googleSyncNotice}>
        {event.google_event_id ? "Synced with Google Calendar" : "Not synced with Google Calendar yet"}
      </Text>

      {saveError ? <Text style={styles.error}>{saveError}</Text> : null}

      {canEdit ? (
        <Pressable style={styles.saveButton} onPress={handleSave} disabled={saving}>
          <Text style={styles.saveButtonText}>{saving ? "Saving..." : "Save changes"}</Text>
        </Pressable>
      ) : null}

      {isAdmin ? (
        <Pressable style={styles.deleteButton} onPress={handleDelete}>
          <Text style={styles.deleteButtonText}>Delete event</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  sectionTitle: { fontWeight: "700", color: "#6b7280", marginTop: 16, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 16 },
  multiline: { minHeight: 70, textAlignVertical: "top" },
  dateTimeRow: { flexDirection: "row", gap: 8 },
  timeInput: { width: 90 },
  link: { color: "#1d4ed8", fontWeight: "600", marginTop: 16 },
  googleSyncNotice: { color: "#9ca3af", fontSize: 12, marginTop: 16 },
  error: { color: "#dc2626", marginTop: 12 },
  saveButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 20 },
  saveButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  deleteButton: { borderRadius: 8, padding: 14, alignItems: "center", marginTop: 12, backgroundColor: "#fef2f2" },
  deleteButtonText: { color: "#dc2626", fontWeight: "700" },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
});
