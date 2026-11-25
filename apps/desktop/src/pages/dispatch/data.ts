import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CalendarEvent, Client, JobCard, JobLifecycleStage, Profile } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { fetchAllRows } from "../../lib/fetch-all-rows";
import { pushCalendarEventDelete, pushCalendarEventUpsert } from "../../lib/google-calendar-sync";

// Data for the Dispatch board. calendar_events is the single source of
// truth for when a job happens (a job is "booked" once it has one), and
// job_cards.assigned_technician_id is whose lane it sits in - the same
// model Dispatch, the Calendar and the phone have always shared.

export type DispatchJob = JobCard & {
  recurring_service_id?: string | null;
  recurring_due_on?: string | null;
  stage_changed_at?: string | null;
  clients: Pick<Client, "id" | "name" | "phone" | "address_line1" | "suburb" | "state" | "postcode"> | null;
};
export type DispatchEvent = CalendarEvent;
export interface Site {
  id: string;
  label: string | null;
  address_line1: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
}
export interface PropertyRow {
  id: string;
  address_line1: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
}

export const DISPATCH_KEY = ["dispatch"];

export function useDispatchData() {
  const jobs = useQuery({
    queryKey: [...DISPATCH_KEY, "jobs"],
    queryFn: () =>
      fetchAllRows<DispatchJob>("job_cards", "*, clients(id, name, phone, address_line1, suburb, state, postcode)", (q) => q.order("created_at", { ascending: false })),
  });
  const events = useQuery({
    queryKey: [...DISPATCH_KEY, "events"],
    queryFn: () => fetchAllRows<DispatchEvent>("calendar_events", "*", (q) => q.not("job_card_id", "is", null).order("start_at")),
  });
  const people = useQuery({
    queryKey: [...DISPATCH_KEY, "people"],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("*").order("full_name");
      if (error) throw error;
      return data as Profile[];
    },
  });
  const stages = useQuery({
    queryKey: [...DISPATCH_KEY, "stages"],
    queryFn: async () => {
      const { data, error } = await supabase.from("job_lifecycle_stages").select("*").order("position");
      if (error) throw error;
      return data as JobLifecycleStage[];
    },
  });
  const places = useQuery({
    queryKey: [...DISPATCH_KEY, "places"],
    queryFn: async () => {
      const [sites, properties] = await Promise.all([
        fetchAllRows<Site>("client_sites", "id, label, address_line1, suburb, state, postcode"),
        fetchAllRows<PropertyRow>("properties", "id, address_line1, suburb, state, postcode"),
      ]);
      return { sites: new Map(sites.map((s) => [s.id, s])), properties: new Map(properties.map((p) => [p.id, p])) };
    },
  });
  const members = useQuery({
    queryKey: [...DISPATCH_KEY, "members"],
    queryFn: async () => {
      const { data, error } = await supabase.from("client_memberships").select("client_id").eq("status", "active");
      if (error) throw error;
      return new Set((data ?? []).map((r) => r.client_id as string));
    },
  });
  return { jobs, events, people, stages, places, members };
}

// Where a job is: its site, else its agency property, else the client.
export function jobAddress(job: DispatchJob, places: { sites: Map<string, Site>; properties: Map<string, PropertyRow> } | undefined): string | null {
  const parts = (r: { address_line1: string | null; suburb: string | null; state: string | null; postcode: string | null } | null | undefined) =>
    r ? [r.address_line1, [r.suburb, r.state, r.postcode].filter(Boolean).join(" ")].filter((x) => x && String(x).trim()).join(", ") : "";
  const site = job.site_id ? places?.sites.get(job.site_id) : undefined;
  if (site && parts(site)) return parts(site);
  const property = job.property_id ? places?.properties.get(job.property_id) : undefined;
  if (property && parts(property)) return parts(property);
  return parts(job.clients) || null;
}
export function jobSuburb(job: DispatchJob, places: { sites: Map<string, Site>; properties: Map<string, PropertyRow> } | undefined): string | null {
  const site = job.site_id ? places?.sites.get(job.site_id) : undefined;
  if (site?.suburb) return site.suburb;
  const property = job.property_id ? places?.properties.get(job.property_id) : undefined;
  return property?.suburb ?? job.clients?.suburb ?? null;
}

export function initials(name: string | null | undefined): string {
  return (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function useDispatchMutations() {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: DISPATCH_KEY });
    void queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
  };

  // Moves an event in the cached list straight away, so a dropped block
  // stays where it was dropped while the save happens.
  const patchEvent = (id: string, patch: Partial<DispatchEvent>) =>
    queryClient.setQueryData<DispatchEvent[]>([...DISPATCH_KEY, "events"], (old) => (old ?? []).map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const patchJob = (id: string, patch: Partial<DispatchJob>) =>
    queryClient.setQueryData<DispatchJob[]>([...DISPATCH_KEY, "jobs"], (old) => (old ?? []).map((j) => (j.id === id ? { ...j, ...patch } : j)));

  const book = useMutation({
    mutationFn: async (p: { job: DispatchJob; start: Date; minutes: number; technicianId: string | null; createdBy: string | null }) => {
      const end = new Date(p.start.getTime() + p.minutes * 60000);
      const { data, error } = await supabase
        .from("calendar_events")
        .insert({ tenant_id: p.job.tenant_id, title: p.job.title, start_at: p.start.toISOString(), end_at: end.toISOString(), all_day: false, job_card_id: p.job.id, created_by: p.createdBy })
        .select("*")
        .single();
      if (error) throw error;
      if (p.technicianId !== p.job.assigned_technician_id) {
        const { error: e } = await supabase.from("job_cards").update({ assigned_technician_id: p.technicianId }).eq("id", p.job.id);
        if (e) throw e;
      }
      await pushCalendarEventUpsert((data as DispatchEvent).id);
      return data as DispatchEvent;
    },
    onMutate: (p) => {
      const end = new Date(p.start.getTime() + p.minutes * 60000);
      const temp = { id: `temp-${Date.now()}`, tenant_id: p.job.tenant_id, title: p.job.title, start_at: p.start.toISOString(), end_at: end.toISOString(), all_day: false, job_card_id: p.job.id } as DispatchEvent;
      queryClient.setQueryData<DispatchEvent[]>([...DISPATCH_KEY, "events"], (old) => [...(old ?? []), temp]);
      patchJob(p.job.id, { assigned_technician_id: p.technicianId });
    },
    onSettled: refresh,
  });

  // Moves (and/or re-assigns) a booking. The technician belongs to the job,
  // so moving one booking to another person's lane re-assigns the job.
  const move = useMutation({
    mutationFn: async (p: { event: DispatchEvent; job: DispatchJob | undefined; start: Date; end: Date; technicianId: string | null | undefined }) => {
      const { error } = await supabase.from("calendar_events").update({ start_at: p.start.toISOString(), end_at: p.end.toISOString() }).eq("id", p.event.id);
      if (error) throw error;
      if (p.job && p.technicianId !== undefined && p.technicianId !== p.job.assigned_technician_id) {
        const { error: e } = await supabase.from("job_cards").update({ assigned_technician_id: p.technicianId }).eq("id", p.job.id);
        if (e) throw e;
      }
      await pushCalendarEventUpsert(p.event.id);
    },
    onMutate: (p) => {
      patchEvent(p.event.id, { start_at: p.start.toISOString(), end_at: p.end.toISOString() });
      if (p.job && p.technicianId !== undefined) patchJob(p.job.id, { assigned_technician_id: p.technicianId });
    },
    onSettled: refresh,
  });

  // Removes a booking. When it was the job's last one, the job goes back
  // to nobody (as the old board did), so it's plainly "to schedule" again.
  const unbook = useMutation({
    mutationFn: async (p: { event: DispatchEvent; clearTech: boolean }) => {
      const { error } = await supabase.from("calendar_events").delete().eq("id", p.event.id);
      if (error) throw error;
      if (p.clearTech && p.event.job_card_id) {
        const { error: e } = await supabase.from("job_cards").update({ assigned_technician_id: null }).eq("id", p.event.job_card_id);
        if (e) throw e;
      }
      await pushCalendarEventDelete(p.event.id, p.event.google_event_id, p.event.google_calendar_connection_id);
    },
    onMutate: (p) => {
      queryClient.setQueryData<DispatchEvent[]>([...DISPATCH_KEY, "events"], (old) => (old ?? []).filter((e) => e.id !== p.event.id));
      if (p.clearTech && p.event.job_card_id) patchJob(p.event.job_card_id, { assigned_technician_id: null });
    },
    onSettled: refresh,
  });

  const setStage = useMutation({
    mutationFn: async (p: { jobId: string; stageId: string }) => {
      const { error } = await supabase.from("job_cards").update({ lifecycle_stage_id: p.stageId }).eq("id", p.jobId);
      if (error) throw error;
    },
    onMutate: (p) => patchJob(p.jobId, { lifecycle_stage_id: p.stageId, stage_changed_at: new Date().toISOString() }),
    onSettled: refresh,
  });

  return { book, move, unbook, setStage };
}
