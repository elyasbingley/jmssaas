import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toE164 } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { fetchAllRows } from "../lib/fetch-all-rows";
import { attachMessageToJob, type AttachSource } from "../lib/attach-to-job";

// Picks an existing job to attach a message to. Jobs for the sender's own
// client are listed first - matched by the conversation's linked client,
// or by the sender's email/phone against clients and their contacts -
// then everything else, newest first, searchable by number, title or
// client name.

type JobOption = { id: string; number: string | null; title: string; client_id: string; created_at: string; clients: { name: string } | null };

async function fetchJobs(): Promise<JobOption[]> {
  const jobs = await fetchAllRows<JobOption>("job_cards", "id, number, title, client_id, created_at, clients(name)");
  return jobs.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function matchingClientIds(email: string | null, phone: string | null): Promise<string[]> {
  const ids = new Set<string>();
  if (email) {
    const [clients, contacts] = await Promise.all([
      supabase.from("clients").select("id").ilike("email", email),
      supabase.from("client_contacts").select("client_id").ilike("email", email),
    ]);
    for (const row of clients.data ?? []) ids.add(row.id);
    for (const row of contacts.data ?? []) ids.add(row.client_id);
  }
  const wanted = phone ? toE164(phone) : null;
  if (wanted) {
    const [clients, contacts] = await Promise.all([
      fetchAllRows<{ id: string; phone: string | null }>("clients", "id, phone", (q) => q.not("phone", "is", null)),
      fetchAllRows<{ id: string; client_id: string; phone: string | null }>("client_contacts", "id, client_id, phone", (q) => q.not("phone", "is", null)),
    ]);
    for (const row of clients) if (row.phone && toE164(row.phone) === wanted) ids.add(row.id);
    for (const row of contacts) if (row.phone && toE164(row.phone) === wanted) ids.add(row.client_id);
  }
  return [...ids];
}

const SHOW_LIMIT = 60;

export function AttachToJobDialog(props: {
  source: AttachSource;
  // Shown under the heading, e.g. the email subject or the SMS text.
  summary: string;
  clientId?: string | null;
  email?: string | null;
  phone?: string | null;
  currentJobId?: string | null;
  onClose: () => void;
  onAttached?: (result: { jobId: string; jobNumber: string | null }) => void;
}) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const jobs = useQuery({ queryKey: ["attach-job-options"], queryFn: fetchJobs, staleTime: 30_000 });
  const suggested = useQuery({
    queryKey: ["attach-job-client-match", props.clientId ?? "", props.email ?? "", props.phone ?? ""],
    queryFn: async () => {
      const ids = await matchingClientIds(props.email ?? null, props.phone ?? null);
      if (props.clientId) ids.push(props.clientId);
      return new Set(ids);
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  const { theirs, others } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const match = (j: JobOption) => !q || `${j.number ?? ""} ${j.title} ${j.clients?.name ?? ""}`.toLowerCase().includes(q);
    const clientIds = suggested.data ?? new Set<string>();
    const all = (jobs.data ?? []).filter(match);
    return { theirs: all.filter((j) => clientIds.has(j.client_id)), others: all.filter((j) => !clientIds.has(j.client_id)) };
  }, [jobs.data, suggested.data, search]);

  const attach = useMutation({
    mutationFn: async (jobId: string) => {
      if (!profile) throw new Error("Not signed in");
      const result = await attachMessageToJob(props.source, jobId, profile);
      return { jobId, jobNumber: result.jobNumber };
    },
    onSuccess: (result) => {
      for (const key of [["inbox-message"], ["inbox-messages"], ["inbox-messages-for-email"], ["channel-messages"], ["job-notes", result.jobId], ["job-files", result.jobId], ["job", result.jobId]]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      props.onAttached?.(result);
      props.onClose();
    },
    onError: (e) => setError(getErrorMessage(e, "Failed to attach to the job")),
  });

  const selectedJob = (jobs.data ?? []).find((j) => j.id === selected);
  const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;

  const row = (j: JobOption) => {
    const already = j.id === props.currentJobId;
    const isSelected = j.id === selected;
    return (
      <button
        key={j.id}
        onClick={() => setSelected(j.id)}
        disabled={already}
        className="jms-analytics-hit flex w-full items-baseline gap-3 rounded px-3 py-2 text-left disabled:opacity-50"
        style={isSelected ? { backgroundColor: "var(--jms-accent-glow)", outline: "1px solid var(--jms-accent)" } : undefined}
      >
        <span className="w-14 shrink-0 font-semibold" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
          {j.number ?? "-"}
        </span>
        <span className="min-w-0 flex-1 truncate" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
          {j.title}
        </span>
        <span className="shrink-0 truncate" style={{ ...muted, maxWidth: "35%" }}>
          {already ? "already attached" : j.clients?.name ?? ""}
        </span>
      </button>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ backgroundColor: "rgba(0,0,0,0.6)" }} onClick={props.onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Attach to a job"
        className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-lg"
        style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", fontFamily: "var(--jms-font)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5" style={{ borderBottom: "1px solid var(--jms-border)" }}>
          <h3 className="font-bold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
            Attach to a job
          </h3>
          <p className="mt-1 truncate" style={muted}>
            {props.summary}
          </p>
          <p className="mt-2" style={muted}>
            It's added to the job as a note, and any attachments or voicemail go into the job's files.
          </p>
          <input
            autoFocus
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search job number, title or client..."
            className="mt-3 w-full rounded-md px-3 py-2 focus:outline-none"
            style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {jobs.error ? (
            <p className="p-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
              {getErrorMessage(jobs.error, "Couldn't load jobs")}
            </p>
          ) : !jobs.data ? (
            <p className="p-3" style={muted}>
              Loading jobs...
            </p>
          ) : theirs.length + others.length === 0 ? (
            <p className="p-3" style={muted}>
              No jobs match "{search}".
            </p>
          ) : (
            <>
              {theirs.length > 0 ? (
                <>
                  <p className="px-3 pb-1 pt-2 font-bold uppercase tracking-wide" style={muted}>
                    This client's jobs
                  </p>
                  {theirs.map(row)}
                </>
              ) : null}
              {others.length > 0 ? (
                <>
                  <p className="px-3 pb-1 pt-3 font-bold uppercase tracking-wide" style={muted}>
                    {theirs.length > 0 ? "Other jobs" : "All jobs"}
                  </p>
                  {others.slice(0, SHOW_LIMIT).map(row)}
                  {others.length > SHOW_LIMIT ? (
                    <p className="px-3 pt-2" style={muted}>
                      Showing the newest {SHOW_LIMIT} of {others.length}. Search to find older jobs.
                    </p>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </div>

        <div className="flex items-center gap-3 p-4" style={{ borderTop: "1px solid var(--jms-border)" }}>
          <button
            onClick={() => selected && attach.mutate(selected)}
            disabled={!selected || attach.isPending}
            className="rounded px-4 py-1.5 font-semibold disabled:opacity-50"
            style={{ backgroundColor: "var(--jms-accent)", color: "var(--jms-bg)", fontSize: "var(--jms-font-body)" }}
          >
            {attach.isPending ? "Attaching..." : selectedJob ? `Attach to ${selectedJob.number ?? "job"}` : "Attach"}
          </button>
          <button onClick={props.onClose} className="font-semibold hover:underline" style={muted}>
            Cancel
          </button>
          {error ? (
            <span className="ml-auto" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>
              {error}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
