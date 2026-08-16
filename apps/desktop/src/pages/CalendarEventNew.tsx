import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { createCalendarEventSchema, type JobCard, type Profile, type Task } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { toDateTimeLocalInput } from "../lib/datetime";
import { pushCalendarEventUpsert } from "../lib/google-calendar-sync";
import { FormField, SelectField, TextAreaField } from "../components/FormField";

async function fetchJobCards(): Promise<JobCard[]> {
  const { data, error } = await supabase.from("job_cards").select("*").order("title");
  if (error) throw error;
  return data as JobCard[];
}
async function fetchTasks(): Promise<Task[]> {
  const { data, error } = await supabase.from("tasks").select("*").order("title");
  if (error) throw error;
  return data as Task[];
}
// Any profile can be assigned a job - not just role='technician' - so an
// admin who also does field work can assign jobs to themselves too.
async function fetchTechnicians(): Promise<Profile[]> {
  const { data, error } = await supabase.from("profiles").select("*").order("full_name");
  if (error) throw error;
  return data as Profile[];
}

export default function CalendarEventNewPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  // Cross-linking from a job card's own "New event" action, matching
  // apps/mobile's ?jobCardId=&date= params from the Schedule screen.
  const [searchParams] = useSearchParams();
  const jobCardIdParam = searchParams.get("jobCardId");
  const dateParam = searchParams.get("date");
  const lockedFromJob = !!jobCardIdParam;

  const { data: jobCards } = useQuery({ queryKey: ["job-cards-all"], queryFn: fetchJobCards });
  const { data: tasks } = useQuery({ queryKey: ["tasks-all"], queryFn: fetchTasks });
  const { data: technicians } = useQuery({ queryKey: ["technicians"], queryFn: fetchTechnicians });

  const defaultStart = dateParam ? new Date(`${dateParam}T09:00:00`) : new Date();
  const defaultEnd = new Date(defaultStart.getTime() + 60 * 60 * 1000);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [guests, setGuests] = useState("");
  const [start, setStart] = useState(toDateTimeLocalInput(defaultStart));
  const [end, setEnd] = useState(toDateTimeLocalInput(defaultEnd));
  const [allDay, setAllDay] = useState(false);
  const [jobCardId, setJobCardId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [technicianId, setTechnicianId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (jobCardIdParam) setJobCardId(jobCardIdParam);
  }, [jobCardIdParam]);

  useEffect(() => {
    if (!jobCardId) return;
    const job = (jobCards ?? []).find((j) => j.id === jobCardId);
    if (job?.assigned_technician_id) setTechnicianId(job.assigned_technician_id);
    if (job && !title) setTitle(job.title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobCardId, jobCards]);

  const createEvent = useMutation({
    mutationFn: async () => {
      const result = createCalendarEventSchema.safeParse({
        title,
        description,
        location,
        guests,
        start_at: new Date(start).toISOString(),
        end_at: new Date(end).toISOString(),
        all_day: allDay,
        job_card_id: jobCardId || undefined,
        task_id: taskId || undefined,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the form for errors");
      if (!profile) throw new Error("Not signed in");

      const { data, error } = await supabase
        .from("calendar_events")
        .insert({
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

      // Dispatching a technician to a job here. This used to also bump a
      // "new" job to "scheduled" (matching apps/mobile's calendar/new.tsx) -
      // removed along with the status column itself (see the
      // job_status_lifecycle_consolidation migration); there's no generic
      // equivalent stage to bump to once a tenant's pipeline is fully
      // custom, so an admin now moves the stage themselves if they want to.
      if (jobCardId && technicianId) {
        const { error: jobError } = await supabase
          .from("job_cards")
          .update({ assigned_technician_id: technicianId })
          .eq("id", jobCardId);
        if (jobError) throw jobError;
      }

      // Must come after the job_cards write above lands, so the push
      // resolves the assignee's fresh (not stale) technician.
      await pushCalendarEventUpsert(data.id as string);

      return data.id as string;
    },
    onSuccess: (eventId) => navigate(`/calendar/${eventId}`),
    onError: (e) => setFormError(getErrorMessage(e, "Failed to create event")),
  });

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="mb-6 text-xl font-bold text-gray-900">New event</h1>

      <FormField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Roof inspection - Smith residence" />

      <label className="mb-4 flex items-center gap-2 text-sm font-medium text-gray-700">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        All day
      </label>

      <div className="grid grid-cols-2 gap-3">
        <div className="mb-4">
          <label className="mb-1 block text-sm font-semibold text-gray-700">Start</label>
          <input
            type={allDay ? "date" : "datetime-local"}
            value={allDay ? start.slice(0, 10) : start}
            onChange={(e) => setStart(allDay ? `${e.target.value}T00:00` : e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="mb-4">
          <label className="mb-1 block text-sm font-semibold text-gray-700">End</label>
          <input
            type={allDay ? "date" : "datetime-local"}
            value={allDay ? end.slice(0, 10) : end}
            onChange={(e) => setEnd(allDay ? `${e.target.value}T00:00` : e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
      </div>

      <FormField label="Guests (optional)" value={guests} onChange={(e) => setGuests(e.target.value)} placeholder="email@example.com, another@example.com" />
      <FormField label="Location (optional)" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Address" />
      <TextAreaField
        label="Description / link (optional)"
        rows={3}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Notes, video call link, etc."
      />

      <SelectField
        label={`Linked job${lockedFromJob ? "" : " (optional)"}`}
        value={jobCardId}
        onChange={(v) => !lockedFromJob && setJobCardId(v)}
        options={(jobCards ?? []).map((j) => ({ value: j.id, label: j.title }))}
      />

      {jobCardId ? (
        <SelectField
          label="Technician (optional)"
          value={technicianId}
          onChange={setTechnicianId}
          options={(technicians ?? []).map((t) => ({ value: t.id, label: t.full_name }))}
          placeholder="Unassigned"
        />
      ) : null}

      <SelectField
        label="Linked task (optional)"
        value={taskId}
        onChange={setTaskId}
        options={(tasks ?? []).map((t) => ({ value: t.id, label: t.title }))}
      />

      {formError ? <p className="mb-4 text-sm text-red-600">{formError}</p> : null}

      <button
        onClick={() => createEvent.mutate()}
        disabled={createEvent.isPending}
        className="rounded-md bg-blue-700 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
      >
        {createEvent.isPending ? "Saving..." : "Create event"}
      </button>
    </div>
  );
}
