import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import { createCalendarEventSchema, type JobCard, type Profile, type Task } from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { useIsOnline } from "../../../lib/connectivity";
import { supabase } from "../../../lib/supabase";
import { RequiresConnectionNotice } from "../../../components/RequiresConnectionNotice";
import { PickerModal } from "../../../components/PickerModal";
import { FormField } from "../../../components/FormField";
import { DateField } from "../../../components/DateField";
import { getErrorMessage } from "../../../lib/errors";
import { pushCalendarEventUpsert } from "../../../lib/google-calendar-sync";

// Google-Calendar-style single creation flow: title, start, end, guests,
// location, description/link, all in one screen rather than a multi-step
// wizard. Start/end use DateField in "datetime" mode (one control per
// field, not separate date+time text inputs like the previous version).
export default function NewCalendarEventScreen() {
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  // Arriving here from the Schedule/dispatch screen's "tap an unassigned
  // job" flow (see app/schedule.tsx) pre-fills and locks the job the same
  // way "+ New quote for this job" does on quotes/new.tsx, and defaults the
  // date to the day the dispatcher was looking at - they still pick the
  // actual time themselves.
  const { jobCardId, date: dateParam } = useLocalSearchParams<{ jobCardId?: string; date?: string }>();
  const lockedFromJob = !!jobCardId;

  const { data: jobCards } = useQuery<JobCard>("SELECT * FROM job_cards ORDER BY title");
  const { data: tasks } = useQuery<Task>("SELECT * FROM tasks ORDER BY title");
  // Any profile can be assigned a job - not just role='technician' - so an
  // admin who also does field work can assign jobs to themselves too.
  const { data: technicians } = useQuery<Profile>("SELECT * FROM profiles ORDER BY full_name");

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [guests, setGuests] = useState("");
  const defaultStart = dateParam ? new Date(`${dateParam}T09:00:00`) : new Date();
  const [start, setStart] = useState<Date>(defaultStart);
  const [end, setEnd] = useState<Date>(new Date(defaultStart.getTime() + 60 * 60 * 1000));
  const [allDay, setAllDay] = useState(false);
  const [jobCard, setJobCard] = useState<JobCard | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [technician, setTechnician] = useState<Profile | null>(null);
  const [jobPickerVisible, setJobPickerVisible] = useState(false);
  const [taskPickerVisible, setTaskPickerVisible] = useState(false);
  const [technicianPickerVisible, setTechnicianPickerVisible] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (jobCardId && jobCards.length > 0 && !jobCard) {
      const preselected = jobCards.find((j) => j.id === jobCardId) ?? null;
      setJobCard(preselected);
      if (preselected?.assigned_technician_id) {
        setTechnician(technicians.find((t) => t.id === preselected.assigned_technician_id) ?? null);
      }
      if (preselected && !title) setTitle(preselected.title);
    }
  }, [jobCardId, jobCards, jobCard, technicians, title]);

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

      // Dispatching a technician to a job here (not a bare/task-linked
      // event) - job_cards is the offline-capable, PowerSync-synced table,
      // so this goes through execute() rather than a direct Supabase call,
      // same as every other job_cards write in the app. Only touches the
      // row when a technician was actually picked, so linking a job to an
      // event without picking anyone doesn't clobber an existing
      // assignment. This used to also bump a "new" job to "scheduled" -
      // removed along with the status column itself (see the
      // job_status_lifecycle_consolidation migration); there's no generic
      // equivalent stage to bump to once a tenant's pipeline is fully
      // custom, so an admin now moves the stage themselves if they want to.
      if (jobCard && technician) {
        await powersync.execute("UPDATE job_cards SET assigned_technician_id = ? WHERE id = ?", [
          technician.id,
          jobCard.id,
        ]);
      }

      // Must come after the job_cards write above lands, so the push
      // resolves the assignee's fresh (not stale) technician.
      await pushCalendarEventUpsert(data.id);

      // Not router.replace() - this screen can be reached from two
      // different places (Schedule's "tap an unassigned job" flow, which
      // lives outside this tab's own Calendar stack, and the Calendar
      // tab's own "+ New event" FAB). replace() only swaps this screen
      // for the event detail *within the Calendar tab's nested stack*, so
      // arriving from Schedule left the detail screen with nothing left
      // to pop back to (no back arrow, no way out - the reported "stuck
      // on the event card" bug). Popping this form first, then pushing
      // the new event's detail on top of whatever screen is actually
      // still underneath, keeps a real, working back step regardless of
      // where the flow started.
      if (router.canGoBack()) router.back();
      router.push(`/calendar/${data.id}`);
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

        <Text style={styles.sectionTitle}>Linked job{lockedFromJob ? "" : " (optional)"}</Text>
        <Pressable
          style={styles.pickerField}
          onPress={() => !lockedFromJob && setJobPickerVisible(true)}
          disabled={lockedFromJob}
        >
          <Text style={jobCard ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
            {jobCard?.title ?? "None"}
          </Text>
        </Pressable>

        {jobCard ? (
          <View style={styles.fieldSpacing}>
            <Text style={styles.sectionTitle}>Technician (optional)</Text>
            <Pressable style={styles.pickerField} onPress={() => setTechnicianPickerVisible(true)}>
              <Text style={technician ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
                {technician?.full_name ?? "Unassigned"}
              </Text>
            </Pressable>
          </View>
        ) : null}

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
        visible={technicianPickerVisible}
        title="Select technician"
        items={technicians}
        getKey={(t) => t.id}
        getLabel={(t) => t.full_name}
        onSelect={setTechnician}
        onClose={() => setTechnicianPickerVisible(false)}
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
