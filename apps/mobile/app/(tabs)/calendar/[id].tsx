import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { CalendarEvent } from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { useIsOnline } from "../../../lib/connectivity";
import { useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { supabase } from "../../../lib/supabase";
import { openInMaps } from "../../../lib/maps";
import { getErrorMessage } from "../../../lib/errors";
import { RequiresConnectionNotice } from "../../../components/RequiresConnectionNotice";
import { FormField } from "../../../components/FormField";
import { DateField } from "../../../components/DateField";

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
  const [location, setLocation] = useState("");
  const [guests, setGuests] = useState("");
  const [start, setStart] = useState<Date | null>(null);
  const [end, setEnd] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (event) {
      setTitle(event.title);
      setDescription(event.description ?? "");
      setLocation(event.location ?? "");
      setGuests(event.guests ?? "");
      setStart(new Date(event.start_at));
      setEnd(new Date(event.end_at));
    }
  }, [event]);

  const handleSave = async () => {
    if (!event || !start || !end || !title.trim()) {
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
          location: location || null,
          guests: guests || null,
          start_at: start.toISOString(),
          end_at: end.toISOString(),
        })
        .eq("id", id);
      if (error) throw error;
      refetch();
    } catch (e) {
      console.error("[Calendar] Failed to save event", e);
      setSaveError(getErrorMessage(e, "Failed to save (see console for details)"));
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
      <FormField label="Title" value={title} onChangeText={setTitle} editable={!!canEdit} />

      <View style={styles.fieldSpacing}>
        <DateField label="Start" value={start} onChange={setStart} mode={event.all_day ? "date" : "datetime"} />
      </View>
      <View style={styles.fieldSpacing}>
        <DateField label="End" value={end} onChange={setEnd} mode={event.all_day ? "date" : "datetime"} />
      </View>

      <View style={styles.fieldSpacing}>
        <FormField label="Guests" placeholder="No guests" value={guests} onChangeText={setGuests} editable={!!canEdit} autoCapitalize="none" />
      </View>

      <View style={styles.fieldSpacing}>
        <FormField label="Location" placeholder="No location" value={location} onChangeText={setLocation} editable={!!canEdit} />
        {location ? (
          <Pressable onPress={() => openInMaps(location)}>
            <Text style={styles.mapsLink}>Open in Maps</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.fieldSpacing}>
        <FormField
          label="Description / link"
          value={description}
          onChangeText={setDescription}
          multiline
          style={styles.multiline}
          editable={!!canEdit}
        />
      </View>

      {event.job_cards ? (
        <Pressable onPress={() => router.push(`/sales/jobs/${event.job_card_id}`)}>
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
  fieldSpacing: { marginTop: 16 },
  multiline: { minHeight: 70, textAlignVertical: "top" },
  mapsLink: { color: "#1d4ed8", fontWeight: "600", marginTop: 6 },
  link: { color: "#1d4ed8", fontWeight: "600", marginTop: 16 },
  googleSyncNotice: { color: "#9ca3af", fontSize: 12, marginTop: 16 },
  error: { color: "#dc2626", marginTop: 12 },
  saveButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 20 },
  saveButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  deleteButton: { borderRadius: 8, padding: 14, alignItems: "center", marginTop: 12, backgroundColor: "#fef2f2" },
  deleteButtonText: { color: "#dc2626", fontWeight: "700" },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
});
