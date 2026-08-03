import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  createJobNoteSchema,
  formatCentsAsAud,
  type Client,
  type Invoice,
  type JobCard,
  type JobFile,
  type JobLifecycleStage,
  type JobNote,
  type JobStatus,
  type Profile,
  type Quote,
  type ServiceCategory,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { formatClientAddress } from "../lib/format";
import { uploadJobPhoto } from "../lib/uploads";
import { TextAreaField } from "../components/FormField";

const STATUSES: JobStatus[] = ["new", "scheduled", "in_progress", "completed", "invoiced"];
const STATUS_LABELS: Record<JobStatus, string> = {
  new: "New",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  invoiced: "Invoiced",
};

async function fetchJob(id: string): Promise<JobCard> {
  const { data, error } = await supabase.from("job_cards").select("*").eq("id", id).single();
  if (error) throw error;
  return data as JobCard;
}

async function fetchClient(clientId: string): Promise<Client> {
  const { data, error } = await supabase.from("clients").select("*").eq("id", clientId).single();
  if (error) throw error;
  return data as Client;
}

async function fetchCategories(): Promise<ServiceCategory[]> {
  const { data, error } = await supabase.from("service_categories").select("*").order("name");
  if (error) throw error;
  return data as ServiceCategory[];
}

async function fetchStages(): Promise<JobLifecycleStage[]> {
  const { data, error } = await supabase.from("job_lifecycle_stages").select("*").order("position");
  if (error) throw error;
  return data as JobLifecycleStage[];
}

async function fetchTechnicians(): Promise<Profile[]> {
  const { data, error } = await supabase.from("profiles").select("*").eq("role", "technician").order("full_name");
  if (error) throw error;
  return data as Profile[];
}

async function fetchNotes(jobId: string): Promise<JobNote[]> {
  const { data, error } = await supabase
    .from("job_notes")
    .select("*")
    .eq("job_card_id", jobId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as JobNote[];
}

async function fetchLinkedQuotes(jobId: string): Promise<Quote[]> {
  const { data, error } = await supabase.from("quotes").select("*").eq("job_card_id", jobId);
  if (error) throw error;
  return data as Quote[];
}

async function fetchLinkedInvoices(jobId: string): Promise<Invoice[]> {
  const { data, error } = await supabase.from("invoices").select("*").eq("job_card_id", jobId);
  if (error) throw error;
  return data as Invoice[];
}

async function fetchFiles(jobId: string): Promise<JobFile[]> {
  const { data, error } = await supabase
    .from("job_files")
    .select("*")
    .eq("job_card_id", jobId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as JobFile[];
}

// Bucket is private (see supabase/migrations/20260720000300_storage.sql) -
// a short-lived signed URL is the correct way to view an already-uploaded
// photo here, not a public URL. Desktop only ever views these - capturing
// new ones from a webcam isn't in scope (see docs/SETUP.md).
async function fetchFileUrls(files: JobFile[]): Promise<Record<string, string>> {
  const entries = await Promise.all(
    files.map(async (f) => {
      const { data } = await supabase.storage.from("job-files").createSignedUrl(f.storage_path, 3600);
      return [f.id, data?.signedUrl ?? ""] as const;
    })
  );
  return Object.fromEntries(entries);
}

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: job } = useQuery({ queryKey: ["job", id], queryFn: () => fetchJob(id!), enabled: !!id });
  const { data: client } = useQuery({
    queryKey: ["client", job?.client_id],
    queryFn: () => fetchClient(job!.client_id),
    enabled: !!job,
  });
  const { data: categories } = useQuery({ queryKey: ["service-categories"], queryFn: fetchCategories });
  const { data: stages } = useQuery({ queryKey: ["job-lifecycle-stages"], queryFn: fetchStages });
  const { data: technicians } = useQuery({ queryKey: ["technicians"], queryFn: fetchTechnicians });
  const { data: notes } = useQuery({ queryKey: ["job-notes", id], queryFn: () => fetchNotes(id!), enabled: !!id });
  const { data: linkedQuotes } = useQuery({
    queryKey: ["job-quotes", id],
    queryFn: () => fetchLinkedQuotes(id!),
    enabled: !!id,
  });
  const { data: linkedInvoices } = useQuery({
    queryKey: ["job-invoices", id],
    queryFn: () => fetchLinkedInvoices(id!),
    enabled: !!id,
  });
  const { data: files } = useQuery({ queryKey: ["job-files", id], queryFn: () => fetchFiles(id!), enabled: !!id });
  const { data: fileUrls } = useQuery({
    queryKey: ["job-file-urls", id, files?.map((f) => f.id).join(",")],
    queryFn: () => fetchFileUrls(files!),
    enabled: !!files && files.length > 0,
  });

  const updateJob = useMutation({
    mutationFn: async (patch: Partial<JobCard>) => {
      const { error } = await supabase.from("job_cards").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job", id] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const [photoError, setPhotoError] = useState<string | null>(null);

  const uploadPhotos = useMutation({
    mutationFn: async (fileList: FileList) => {
      if (!profile) throw new Error("Not signed in");
      // Sequential, not Promise.all - keeps upload order predictable and
      // avoids hammering Storage with a burst of concurrent PUTs for a
      // multi-select of, say, 20 photos.
      for (const file of Array.from(fileList)) {
        await uploadJobPhoto({ tenantId: profile.tenant_id, jobCardId: id!, uploadedBy: profile.id, file });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job-files", id] });
      setPhotoError(null);
    },
    onError: (e) => setPhotoError(getErrorMessage(e, "Failed to upload photo")),
  });

  const [noteBody, setNoteBody] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);

  const addNote = useMutation({
    mutationFn: async () => {
      const result = createJobNoteSchema.safeParse({ job_card_id: id, body: noteBody });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid note");
      if (!profile) throw new Error("Not signed in");

      const { error } = await supabase.from("job_notes").insert({
        tenant_id: profile.tenant_id,
        job_card_id: id,
        author_id: profile.id,
        body: result.data.body,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job-notes", id] });
      setNoteBody("");
      setNoteError(null);
    },
    onError: (e) => setNoteError(getErrorMessage(e, "Failed to add note")),
  });

  if (!job) {
    return <div className="p-8 text-sm text-gray-500">Loading...</div>;
  }

  const address = client ? formatClientAddress(client) : null;

  return (
    <div className="p-8">
      <Link to="/jobs" className="mb-4 inline-block text-sm text-blue-700 hover:underline">
        &larr; Back to Jobs
      </Link>

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6">
        <div className="mb-2 flex items-center gap-3">
          <span className="text-xs font-bold text-blue-700">{job.number ?? "Pending"}</span>
          <h1 className="text-xl font-bold text-gray-900">{job.title}</h1>
        </div>
        {job.description ? <p className="mb-4 text-sm text-gray-600">{job.description}</p> : null}

        {client ? (
          <div className="mb-4 rounded-md bg-gray-50 p-3 text-sm">
            <p className="font-semibold text-gray-900">
              <Link to={`/clients/${client.id}`} className="hover:underline">
                {client.name}
              </Link>
            </p>
            {client.phone ? <p className="text-gray-600">{client.phone}</p> : null}
            {address ? <p className="text-gray-600">{address}</p> : null}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase text-gray-500">Status</label>
            <select
              value={job.status}
              onChange={(e) => updateJob.mutate({ status: e.target.value as JobStatus })}
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase text-gray-500">Category</label>
            <select
              value={job.service_category_id ?? ""}
              onChange={(e) => updateJob.mutate({ service_category_id: e.target.value || null })}
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="">None</option>
              {(categories ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase text-gray-500">Stage</label>
            <select
              value={job.lifecycle_stage_id ?? ""}
              onChange={(e) => updateJob.mutate({ lifecycle_stage_id: e.target.value || null })}
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="">None</option>
              {(stages ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase text-gray-500">Technician</label>
            <select
              value={job.assigned_technician_id ?? ""}
              onChange={(e) => updateJob.mutate({ assigned_technician_id: e.target.value || null })}
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="">Unassigned</option>
              {(technicians ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.full_name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Quotes</h2>
            <Link to={`/quotes/new?clientId=${job.client_id}&jobCardId=${job.id}`} className="text-sm font-semibold text-blue-700 hover:underline">
              + New quote
            </Link>
          </div>
          {!linkedQuotes || linkedQuotes.length === 0 ? (
            <p className="text-sm text-gray-500">No quotes linked to this job.</p>
          ) : (
            <div className="space-y-1">
              {linkedQuotes.map((q) => (
                <Link key={q.id} to={`/quotes/${q.id}`} className="flex justify-between text-sm hover:underline">
                  <span className="text-blue-700">{q.quote_number}</span>
                  <span className="text-gray-600">{formatCentsAsAud(q.total_cents)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Invoices</h2>
            <Link to={`/invoices/new?clientId=${job.client_id}&jobCardId=${job.id}`} className="text-sm font-semibold text-blue-700 hover:underline">
              + New invoice
            </Link>
          </div>
          {!linkedInvoices || linkedInvoices.length === 0 ? (
            <p className="text-sm text-gray-500">No invoices linked to this job.</p>
          ) : (
            <div className="space-y-1">
              {linkedInvoices.map((inv) => (
                <Link key={inv.id} to={`/invoices/${inv.id}`} className="flex justify-between text-sm hover:underline">
                  <span className="text-blue-700">{inv.invoice_number}</span>
                  <span className="text-gray-600">{formatCentsAsAud(inv.total_cents)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Photos</h2>
          <label className="cursor-pointer rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800">
            {uploadPhotos.isPending ? "Uploading..." : "+ Upload photos"}
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              disabled={uploadPhotos.isPending}
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) uploadPhotos.mutate(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        {photoError ? <p className="mb-3 text-sm text-red-600">{photoError}</p> : null}
        {!files || files.length === 0 ? (
          <p className="text-sm text-gray-500">No photos yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-6">
            {files.map((f) => (
              <a
                key={f.id}
                href={fileUrls?.[f.id] || undefined}
                target="_blank"
                rel="noreferrer"
                className="block aspect-square overflow-hidden rounded-md border border-gray-200 bg-gray-100"
              >
                {fileUrls?.[f.id] ? (
                  <img src={fileUrls[f.id]} alt={f.file_name} className="h-full w-full object-cover" />
                ) : null}
              </a>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">Notes</h2>
        <div className="mb-4">
          <TextAreaField label="Add a note" rows={2} value={noteBody} onChange={(e) => setNoteBody(e.target.value)} />
          {noteError ? <p className="mb-2 text-sm text-red-600">{noteError}</p> : null}
          <button
            onClick={() => addNote.mutate()}
            disabled={addNote.isPending || !noteBody.trim()}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {addNote.isPending ? "Adding..." : "Add note"}
          </button>
        </div>
        <div className="space-y-3">
          {(notes ?? []).map((note) => (
            <div key={note.id} className="border-t border-gray-100 pt-3 text-sm">
              <p className="text-gray-800">{note.body}</p>
              <p className="mt-1 text-xs text-gray-400">{new Date(note.created_at).toLocaleString()}</p>
            </div>
          ))}
          {notes && notes.length === 0 ? <p className="text-sm text-gray-500">No notes yet.</p> : null}
        </div>
      </div>
    </div>
  );
}
