import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import { createCalendarEventSchema, type JobCard, type Task } from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { useIsOnline } from "../../../lib/connectivity";
import { supabase } from "../../../lib/supabase";
import { RequiresConnectionNotice } from "../../../components/RequiresConnectionNotice";
import { PickerModal } from "../../../components/PickerModal";
import { FormField } from "../../../components/FormField";
import { DateField } from "../../../components/DateField";
import { getErrorMessage } from "../../../lib/errors";

// Google-Calendar-style single creation flow: title, start, end, guests,
// location, description/link, all in one screen rather than a multi-step
// wizard. Start/end use DateField in "datetime" mode (one control per
// field, not separate date+time text inputs like the previous version).
export default function NewCalendarEventScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();

  const { data: jobCards } = useQuery<JobCard>("SELECT * FROM job_cards ORDER BY title");
  const { data: tasks } = useQuery<Task>("SELECT * FROM tasks ORDER BY title");

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [guests, setGuests] = useState("");
  const now = new Date();
  const [start, setStart] = useState<Date>(now);
  const [end, setEnd] = useState<Date>(new Date(now.getTime() + 60 * 60 * 1000));
  const [allDay, setAllDay] = useState(false);
  const [jobCard, setJobCard] = useState<JobCard | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [jobPickerVisible, setJobPickerVisible] = useState(false);
  const [taskPickerVisible, setTaskPickerVisible] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const result = createCalendarEventSchema.safeParse({
      title,
      description,
      location,
      guests,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      all_day: allDay,
      job_card_id: jobCard?.id,
      task_id: task?.id,
    });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Check the form for errors");
      return;
    }
    if (!profile) return;

    setSubmitting(true);
    setFormError(null);
    try {
      const { data, error } = await supabase
        .from("calendar_events")
        .insert({
          id: uuidv4(),
          tenant_id: profile.tenant_id,
          title: result.data.title,
          description: result.data.description || null,
          location: result.data.location || null,
          guests: result.data.guests || null,
          start_at: result.data.start_at,
          end_at: result.data.end_at,
          all_day: result.data.all_day,
          job_card_id: result.data.job_card_id ?? null,
          task_id: result.data.task_id ?? null,
          created_by: profile.id,
        })
        .select()
        .single();
      if (error) throw error;
      router.replace(`/calendar/${data.id}`);
    } catch (e) {
      // Log the full error object, not just its message - PostgrestError's
      // most useful field is often `hint` (the actionable fix), which
      // getErrorMessage below folds into the displayed string, but the
      // full object (code/details too) is worth having in the console for
      // anything that isn't self-explanatory from hint alone.
      console.error("[Calendar] Failed to create event", e);
      setFormError(getErrorMessage(e, "Failed to create event (see console for details)"));
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Calendar" />
      </View>
    );
  }

  return (
    <>
      <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <FormField
          label="Title"
          placeholder="e.g. Roof inspection - Smith residence"
          value={title}
          onChangeText={setTitle}
        />

        <Pressable style={styles.allDayRow} onPress={() => setAllDay((v) => !v)}>
          <View style={[styles.checkbox, allDay && styles.checkboxChecked]} />
          <Text style={styles.allDayLabel}>All day</Text>
        </Pressable>

        <View style={styles.fieldSpacing}>
          <DateField label="Start" value={start} onChange={setStart} mode={allDay ? "date" : "datetime"} />
        </View>
        <View style={styles.fieldSpacing}>
          <DateField label="End" value={end} onChange={setEnd} mode={allDay ? "date" : "datetime"} />
        </View>

        <View style={styles.fieldSpacing}>
          <FormField label="Guests (optional)" placeholder="email@example.com, another@example.com" value={guests} onChangeText={setGuests} autoCapitalize="none" />
        </View>

        <View style={styles.fieldSpacing}>
          <FormField label="Location (optional)" placeholder="Address" value={location} onChangeText={setLocation} />
        </View>

        <View style={styles.fieldSpacing}>
          <FormField
            label="Description / link (optional)"
            placeholder="Notes, video call link, etc."
            value={description}
            onChangeText={setDescription}
            multiline
            style={styles.multiline}
          />
        </View>

        <Text style={styles.sectionTitle}>Linked job (optional)</Text>
        <Pressable style={styles.pickerField} onPress={() => setJobPickerVisible(true)}>
          <Text style={jobCard ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
            {jobCard?.title ?? "None"}
          </Text>
        </Pressable>

        <Text style={styles.sectionTitle}>Linked task (optional)</Text>
        <Pressable style={styles.pickerField} onPress={() => setTaskPickerVisible(true)}>
          <Text style={task ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>{task?.title ?? "None"}</Text>
        </Pressable>

        {formError ? <Text style={styles.error}>{formError}</Text> : null}

        <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
          <Text style={styles.submitButtonText}>{submitting ? "Saving..." : "Create event"}</Text>
        </Pressable>
      </ScrollView>

      <PickerModal
        visible={jobPickerVisible}
        title="Select a job"
        items={jobCards}
        getKey={(j) => j.id}
        getLabel={(j) => j.title}
        onSelect={setJobCard}
        onClose={() => setJobPickerVisible(false)}
      />
      <PickerModal
        visible={taskPickerVisible}
        title="Select task"
        items={tasks}
        getKey={(t) => t.id}
        getLabel={(t) => t.title}
        onSelect={setTask}
        onClose={() => setTaskPickerVisible(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  sectionTitle: { fontWeight: "700", color: "#6b7280", marginTop: 16, marginBottom: 6 },
  fieldSpacing: { marginTop: 16 },
  multiline: { minHeight: 70, textAlignVertical: "top" },
  allDayRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 16 },
  checkbox: { width: 20, height: 20, borderRadius: 4, borderWidth: 1, borderColor: "#9ca3af" },
  checkboxChecked: { backgroundColor: "#1d4ed8", borderColor: "#1d4ed8" },
  allDayLabel: { fontSize: 15 },
  pickerField: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 },
  pickerFieldText: { fontSize: 16, color: "#111827" },
  pickerFieldPlaceholder: { fontSize: 16, color: "#9ca3af" },
  error: { color: "#dc2626", marginTop: 12 },
  submitButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 20 },
  submitButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
