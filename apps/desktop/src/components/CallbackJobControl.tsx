import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";

// Marks a job as a return visit ("callback") for an earlier job of the
// same client - job_cards.callback_of_job_card_id. Analytics' First Time
// Fix Rate is the share of completed jobs that never had one of these
// raised against them, so the link is the only thing that feeds it.

type JobOption = { id: string; number: string | null; title: string; created_at: string };

async function fetchClientJobs(clientId: string, excludeJobId: string): Promise<JobOption[]> {
  const { data, error } = await supabase
    .from("job_cards")
    .select("id, number, title, created_at")
    .eq("client_id", clientId)
    .neq("id", excludeJobId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as JobOption[];
}

const jobLabel = (job: JobOption) => `${job.number ?? "Pending"} - ${job.title}`;

export function CallbackJobControl({ jobId, clientId, callbackOfJobCardId }: { jobId: string; clientId: string; callbackOfJobCardId: string | null }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { data: jobs } = useQuery({
    queryKey: ["client-jobs-for-callback", clientId, jobId],
    queryFn: () => fetchClientJobs(clientId, jobId),
    enabled: editing || !!callbackOfJobCardId,
  });
  const original = (jobs ?? []).find((j) => j.id === callbackOfJobCardId);

  const save = useMutation({
    mutationFn: async (originalJobId: string | null) => {
      const { error } = await supabase.from("job_cards").update({ callback_of_job_card_id: originalJobId }).eq("id", jobId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job", jobId] });
      queryClient.invalidateQueries({ queryKey: ["analytics"] });
      setEditing(false);
      setError(null);
    },
    onError: (e) => setError(getErrorMessage(e, "Failed to save")),
  });

  const linkStyle = { color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" };

  return (
    <div className="mb-4 rounded p-3" style={{ border: "1px solid var(--jms-border)", fontSize: "var(--jms-font-body)" }}>
      <div className="flex items-center justify-between gap-3">
        <span style={{ color: "var(--jms-text-muted)" }}>
          Callback for:{" "}
          {callbackOfJobCardId ? (
            <Link to={`/jobs/${callbackOfJobCardId}`} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
              {original ? jobLabel(original) : "an earlier job"}
            </Link>
          ) : (
            "Not a callback"
          )}
        </span>
        {editing ? null : (
          <span className="flex shrink-0 gap-3">
            <button
              onClick={() => {
                setChoice(callbackOfJobCardId ?? "");
                setEditing(true);
              }}
              className="font-semibold hover:underline"
              style={linkStyle}
            >
              {callbackOfJobCardId ? "Change" : "+ Mark as a callback"}
            </button>
            {callbackOfJobCardId ? (
              <button onClick={() => save.mutate(null)} disabled={save.isPending} className="font-semibold hover:underline" style={linkStyle}>
                Remove
              </button>
            ) : null}
          </span>
        )}
      </div>
      {editing ? (
        <div className="mt-3">
          <p className="mb-2" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Choose the earlier job this one is going back to fix. That job then counts as not fixed first time.
          </p>
          {jobs && jobs.length === 0 ? (
            <p style={{ color: "var(--jms-text-muted)" }}>This client has no other jobs to link to.</p>
          ) : (
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              aria-label="Original job"
              className="w-full rounded-md px-3 py-2"
              style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
            >
              <option value="">{jobs ? "Select the original job..." : "Loading jobs..."}</option>
              {(jobs ?? []).map((j) => (
                <option key={j.id} value={j.id}>
                  {jobLabel(j)} ({new Date(j.created_at).toLocaleDateString("en-AU")})
                </option>
              ))}
            </select>
          )}
          <div className="mt-3 flex gap-3">
            <button onClick={() => save.mutate(choice)} disabled={!choice || save.isPending} className="font-semibold hover:underline disabled:opacity-50" style={linkStyle}>
              {save.isPending ? "Saving..." : "Save"}
            </button>
            <button onClick={() => setEditing(false)} className="font-semibold hover:underline" style={{ ...linkStyle, color: "var(--jms-text-muted)" }}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="mt-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
