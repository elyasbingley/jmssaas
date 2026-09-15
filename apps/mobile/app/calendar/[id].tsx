import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePowerSync, useQuery } from "@powersync/react";
import type { CalendarEvent, Profile } from "@jmssaas/shared";
import { useAuth } from "../../lib/auth-context";
import { useIsOnline } from "../../lib/connectivity";
import { useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { supabase } from "../../lib/supabase";
import { openInMaps } from "../../lib/maps";
import { getErrorMessage } from "../../lib/errors";
import { pushCalendarEventDelete, pushCalendarEventUpsert } from "../../lib/google-calendar-sync";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../../components/theme/ThemedRequiresConnectionNotice";
import { ThemedPickerModal } from "../../components/theme/ThemedPickerModal";
import { ThemedFormField } from "../../components/theme/ThemedFormField";
import { ThemedDateField } from "../../components/theme/ThemedDateField";
import { ThemedButton } from "../../components/theme/ThemedButton";

type CalendarEventRow = CalendarEvent & {
  job_cards: { title: string; assigned_technician_id: string | null } | null;
  tasks: { title: string; assigned_to: string | null } | null;
};

export default function CalendarEventDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";
  const styles = useThemedStyles(createStyles);

  const { data: event, loading, refetch } = useSupabaseFetch<CalendarEventRow>(async () => {
    const { data, error } = await supabase
      .from("calendar_events")
      .select("*, job_cards(title, assigned_technician_id), tasks(title, assigned_to)")
      .eq("id", id)
      .single();
    if (error) throw error;
    const row = data as CalendarEventRow;

    // The base row's title/description/location for a 'google_personal'
    // event is always the literal 'Busy' placeholder (see the migration's
    // own comment on why) - calendar_event_personal_details holds the
    // real detail, readable only by its owner via RLS. A non-owner
    // querying this just gets zero rows back, correctly leaving the
    // placeholder in place.
    if (row.source === "google_personal") {
      const { data: details } = await supabase
        .from("calendar_event_personal_details")
        .select("title, description, location")
        .eq("calendar_event_id", id)
        .maybeSingle();
      if (details) {
        row.title = details.title;
        row.description = details.description;
        row.location = details.location;
      }
    }
    return row;
  }, [id, isOnline]);

  // Any profile can be assigned a job - not just role='technician' - so an
  // admin who also does field work can assign jobs to themselves too.
  const { data: technicians } = useQuery<Profile>("SELECT * FROM profiles ORDER BY full_name");

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
  const [technician, setTechnician] = useState<Profile | null>(null);
  const [technicianPickerVisible, setTechnicianPickerVisible] = useState(false);
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
      setTechnician(technicians.find((t) => t.id === event.job_cards?.assigned_technician_id) ?? null);
    }
    // technicians deliberately excluded from deps - it's a live PowerSync
    // query that shouldn't re-run this seed-from-server effect every time
    // it re-renders, only when the fetched event itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      // Reassignment: admin-only, and only meaningful when this event has a
      // linked job card - job_cards is the offline-capable table, so this
      // goes through execute() like every other job_cards write, not a
      // direct Supabase call.
      if (isAdmin && event.job_card_id && technician?.id !== event.job_cards?.assigned_technician_id) {
        await powersync.execute("UPDATE job_cards SET assigned_technician_id = ? WHERE id = ?", [
          technician?.id ?? null,
          event.job_card_id,
        ]);
      }

      // Must come after the job_cards write above lands, so the push
      // resolves the assignee's fresh (not stale) technician.
      await pushCalendarEventUpsert(id);

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
          // Capture these before the row is gone - nothing left to look
          // them up from afterward.
          const googleEventId = event?.google_event_id;
          const googleConnectionId = event?.google_calendar_connection_id;
          await supabase.from("calendar_events").delete().eq("id", id);
          await pushCalendarEventDelete(id, googleEventId, googleConnectionId);
          router.back();
        },
      },
    ]);
  };

  const header = (
    <View style={styles.header}>
      <Pressable onPress={() => router.back()} hitSlop={8}>
        <Text style={styles.link}>‹ Back</Text>
      </Pressable>
      <Text style={styles.headerTitle}>Event</Text>
    </View>
  );

  if (!isOnline) {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
          {header}
          <ThemedRequiresConnectionNotice label="Calendar" />
        </SafeAreaView>
      </>
    );
  }

  if (loading || !event) {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
          {header}
          <Text style={styles.empty}>Loading...</Text>
        </SafeAreaView>
      </>
    );
  }

  // 'google_personal' events are a mirror of something that lives in
  // someone's own Google Calendar, not an app-owned schedule item -
  // google-calendar-push already no-ops any edit made to a non-'app'
  // event, so letting the form pretend edits here take effect would be
  // misleading. Editing/deleting happens on the Google Calendar side and
  // flows back in automatically (google-calendar-webhook / the reconcile
  // sweep), same "full permissions either way" behavior, just from the
  // other direction.
  if (event.source === "google_personal") {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
          {header}
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
            <Text style={styles.personalTitle}>{event.title}</Text>
            <Text style={styles.personalMeta}>
              {new Date(event.start_at).toLocaleString("en-AU")} - {new Date(event.end_at).toLocaleString("en-AU")}
            </Text>
            {event.location ? <Text style={styles.personalMeta}>{event.location}</Text> : null}
            {event.description ? <Text style={styles.personalDescription}>{event.description}</Text> : null}
            <Text style={styles.personalNotice}>
              Personal Google Calendar event, shown here for scheduling visibility only. To change or remove it, edit it in Google
              Calendar directly - the change syncs back here automatically.
            </Text>
          </ScrollView>
        </SafeAreaView>
      </>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        {header}
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
          <ThemedFormField label="Title" value={title} onChangeText={setTitle} editable={!!canEdit} />

          <View style={styles.fieldSpacing}>
            <ThemedDateField label="Start" value={start} onChange={setStart} mode={event.all_day ? "date" : "datetime"} />
          </View>
          <View style={styles.fieldSpacing}>
            <ThemedDateField label="End" value={end} onChange={setEnd} mode={event.all_day ? "date" : "datetime"} />
          </View>

          <View style={styles.fieldSpacing}>
            <ThemedFormField label="Guests" placeholder="No guests" value={guests} onChangeText={setGuests} editable={!!canEdit} autoCapitalize="none" />
          </View>

          <View style={styles.fieldSpacing}>
            <ThemedFormField label="Location" placeholder="No location" value={location} onChangeText={setLocation} editable={!!canEdit} />
            {location ? (
              <Pressable onPress={() => openInMaps(location)}>
                <Text style={styles.mapsLink}>Open in Maps</Text>
              </Pressable>
            ) : null}
          </View>

          <View style={styles.fieldSpacing}>
            <ThemedFormField
              label="Description / link"
              value={description}
              onChangeText={setDescription}
              multiline
              style={styles.multiline}
              editable={!!canEdit}
            />
          </View>

          {event.job_cards ? (
            <Pressable onPress={() => router.push(`/jobs/${event.job_card_id}`)}>
              <Text style={styles.link}>Linked job: {event.job_cards.title}</Text>
            </Pressable>
          ) : null}

          {event.job_cards && isAdmin ? (
            <View style={styles.fieldSpacing}>
              <Text style={styles.techLabel}>Technician</Text>
              <Pressable style={styles.pickerField} onPress={() => setTechnicianPickerVisible(true)}>
                <Text style={technician ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
                  {technician?.full_name ?? "Unassigned"}
                </Text>
              </Pressable>
            </View>
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
            <View style={styles.saveButtonWrap}>
              <ThemedButton label={saving ? "Saving..." : "Save Changes"} onPress={handleSave} disabled={saving} />
            </View>
          ) : null}

          {isAdmin ? (
            <Pressable style={styles.deleteButton} onPress={handleDelete}>
              <Text style={styles.deleteButtonText}>Delete Event</Text>
            </Pressable>
          ) : null}

          <ThemedPickerModal
            visible={technicianPickerVisible}
            title="Select technician"
            items={technicians}
            getKey={(t) => t.id}
            getLabel={(t) => t.full_name}
            onSelect={setTechnician}
            onClose={() => setTechnicianPickerVisible(false)}
          />
        </ScrollView>
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
    fieldSpacing: { marginTop: 16 },
    multiline: { minHeight: 70, textAlignVertical: "top" as const },
    mapsLink: { color: tokens.accent, fontWeight: "600" as const, marginTop: 6, ...mono },
    link: { color: tokens.accent, fontWeight: "600" as const, marginTop: 16, ...mono },
    techLabel: {
      fontSize: font.label,
      fontWeight: "700" as const,
      color: tokens.textMuted,
      marginBottom: 6,
      letterSpacing: 1,
      textTransform: "uppercase" as const,
      ...mono,
    },
    pickerField: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, backgroundColor: tokens.background },
    pickerFieldText: { fontSize: font.body, color: tokens.textPrimary, ...mono },
    pickerFieldPlaceholder: { fontSize: font.body, color: tokens.textMuted, ...mono },
    googleSyncNotice: { color: tokens.textMuted, fontSize: font.label, marginTop: 16, ...mono },
    personalTitle: { fontSize: font.title - 1, fontWeight: "700" as const, color: tokens.textPrimary, ...mono },
    personalMeta: { fontSize: font.body - 1, color: tokens.textPrimary, marginTop: 6, ...mono },
    personalDescription: { fontSize: font.body - 1, color: tokens.textPrimary, marginTop: 12, ...mono },
    personalNotice: { fontSize: font.label, color: tokens.textMuted, backgroundColor: tokens.surface, borderWidth: 1, borderColor: tokens.border, borderRadius: 4, padding: 12, marginTop: 20, ...mono },
    error: { color: tokens.danger, marginTop: 12, ...mono },
    saveButtonWrap: { marginTop: 20 },
    deleteButton: { borderRadius: 3, padding: 14, alignItems: "center" as const, marginTop: 12, borderWidth: 1, borderColor: tokens.danger },
    deleteButtonText: { color: tokens.danger, fontWeight: "700" as const, letterSpacing: 1, textTransform: "uppercase" as const, ...mono },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 24, ...mono },
  };
}
