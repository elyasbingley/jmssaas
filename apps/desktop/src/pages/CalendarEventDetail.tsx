import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { CalendarEvent, Profile } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { FormField, SelectField, TextAreaField } from "../components/FormField";

type CalendarEventRow = CalendarEvent & {
  job_cards: { title: string; assigned_technician_id: string | null } | null;
  tasks: { title: string } | null;
};

async function fetchEvent(id: string): Promise<CalendarEventRow> {
  const { data, error } = await supabase
    .from("calendar_events")
    .select("*, job_cards(title, assigned_technician_id), tasks(title)")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data as CalendarEventRow;
}
async function fetchTechnicians(): Promise<Profile[]> {
  const { data, error } = await supabase.from("profiles").select("*").eq("role", "technician").order("full_name");
  if (error) throw error;
  return data as Profile[];
}

export default function CalendarEventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: event, isLoading } = useQuery({ queryKey: ["calendar-event", id], queryFn: () => fetchEvent(id!), enabled: !!id });
  const { data: technicians } = useQuery({ queryKey: ["technicians"], queryFn: fetchTechnicians });

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [guests, setGuests] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [technicianId, setTechnicianId] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (event) {
      setTitle(event.title);
      setDescription(event.description ?? "");
      setLocation(event.location ?? "");
      setGuests(event.guests ?? "");
      setStart(event.start_at.slice(0, 16));
      setEnd(event.end_at.slice(0, 16));
      setTechnicianId(event.job_cards?.assigned_technician_id ?? "");
    }
  }, [event]);

  const save = useMutation({
    mutationFn: async () => {
      if (!event || !title.trim()) throw new Error("Title, start and end are required");

      const { error } = await supabase
        .from("calendar_events")
        .update({
          title: title.trim(),
          description: description || null,
          location: location || null,
          guests: guests || null,
          start_at: new Date(start).toISOString(),
          end_at: new Date(end).toISOString(),
        })
        .eq("id", id);
      if (error) throw error;

      // Reassignment - only meaningful when this event has a linked job.
      if (event.job_card_id && technicianId !== (event.job_cards?.assigned_technician_id ?? "")) {
        const { error: jobError } = await supabase
          .from("job_cards")
          .update({ assigned_technician_id: technicianId || null })
          .eq("id", event.job_card_id);
        if (jobError) throw jobError;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["calendar-event", id] });
      queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
      setSaveError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setSaveError(getErrorMessage(e, "Failed to save")),
  });

  const deleteEvent = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("calendar_events").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
      navigate("/calendar");
    },
  });

  if (isLoading || !event) {
    return <div className="p-8 text-sm text-gray-500">Loading...</div>;
  }

  return (
    <div className="mx-auto max-w-2xl p-8">
      <Link to="/calendar" className="mb-4 inline-block text-sm text-blue-700 hover:underline">
        &larr; Back to Calendar
      </Link>

      <FormField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />

      <div className="grid grid-cols-2 gap-3">
        <div className="mb-4">
          <label className="mb-1 block text-sm font-semibold text-gray-700">Start</label>
          <input
            type={event.all_day ? "date" : "datetime-local"}
            value={event.all_day ? start.slice(0, 10) : start}
            onChange={(e) => setStart(event.all_day ? `${e.target.value}T00:00` : e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="mb-4">
          <label className="mb-1 block text-sm font-semibold text-gray-700">End</label>
          <input
            type={event.all_day ? "date" : "datetime-local"}
            value={event.all_day ? end.slice(0, 10) : end}
            onChange={(e) => setEnd(event.all_day ? `${e.target.value}T00:00` : e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
      </div>

      <FormField label="Guests" value={guests} onChange={(e) => setGuests(e.target.value)} placeholder="No guests" />

      <FormField label="Location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="No location" />
      {location ? (
        <a
          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`}
          target="_blank"
          rel="noreferrer"
          className="-mt-3 mb-4 inline-block text-sm font-semibold text-blue-700 hover:underline"
        >
          Open in Google Maps
        </a>
      ) : null}

      <TextAreaField label="Description / link" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />

      {event.job_cards ? (
        <Link to={`/jobs/${event.job_card_id}`} className="mb-4 block text-sm text-blue-700 hover:underline">
          Linked job: {event.job_cards.title}
        </Link>
      ) : null}

      {event.job_cards ? (
        <SelectField
          label="Technician"
          value={technicianId}
          onChange={setTechnicianId}
          options={(technicians ?? []).map((t) => ({ value: t.id, label: t.full_name }))}
          placeholder="Unassigned"
        />
      ) : null}

      {event.tasks ? <p className="mb-4 text-sm text-blue-700">Linked task: {event.tasks.title}</p> : null}

      <p className="mb-4 text-xs text-gray-400">
        {event.google_event_id ? "Synced with Google Calendar" : "Not synced with Google Calendar yet"}
      </p>

      {saveError ? <p className="mb-2 text-sm text-red-600">{saveError}</p> : null}
      {saved ? <p className="mb-2 text-sm text-green-700">Saved.</p> : null}

      <div className="flex gap-3">
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="rounded-md bg-blue-700 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
        >
          {save.isPending ? "Saving..." : "Save changes"}
        </button>
        <button
          onClick={() => deleteEvent.mutate()}
          className="rounded-md bg-red-50 px-6 py-3 text-sm font-semibold text-red-600 hover:bg-red-100"
        >
          Delete event
        </button>
      </div>
    </div>
  );
}
