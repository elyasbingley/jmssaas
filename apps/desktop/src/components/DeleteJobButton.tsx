import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { pushCalendarEventDelete } from "../lib/google-calendar-sync";

// "Delete job" on the job page. The database function delete_job_card
// (job_delete_and_numbering migration) does the deleting in one
// transaction and decides what blocks it; this shows its preview first so
// nothing is removed without the admin seeing what goes with it, then
// tidies what lives outside the database: the job's photos/files in
// storage and its bookings in Google Calendar.

interface Blocker {
  id: string;
  number: string | null;
  status?: string;
}

interface DeletePreview {
  number: string | null;
  blocking_invoices: Blocker[];
  blocking_quotes: Blocker[];
  blocking_purchase_orders: Blocker[];
  draft_quotes: number;
  calendar_events: number;
  tasks: number;
  notes: number;
  files: number;
  pending_messages: number;
  timesheet_minutes: number;
  next_number_after: string;
}

interface DeleteResult {
  number: string | null;
  calendar_events: { id: string; google_event_id: string | null; google_calendar_connection_id: string | null }[];
  storage_paths: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function hoursText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ""}` : `${m}m`;
}

export function DeleteJobButton({ jobCardId }: { jobCardId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ["job-delete-preview", jobCardId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("job_card_delete_preview", { p_job_card_id: jobCardId });
      if (error) throw error;
      return data as DeletePreview;
    },
    enabled: open,
    staleTime: 0,
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const remove = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("delete_job_card", { p_job_card_id: jobCardId });
      if (error) throw error;
      const result = data as DeleteResult;
      // Both best-effort: the job is already gone, and a leftover file or
      // Google event doesn't affect anything in the app (Google Calendar's
      // hourly reconcile also removes events whose booking no longer exists).
      if (result.storage_paths.length > 0) {
        const { error: storageError } = await supabase.storage.from("job-files").remove(result.storage_paths);
        if (storageError) console.error("Job deleted, but some of its files could not be removed from storage", storageError);
      }
      for (const event of result.calendar_events) void pushCalendarEventDelete(event.id, event.google_event_id, event.google_calendar_connection_id);
      return result;
    },
    onSuccess: () => {
      navigate("/jobs");
      // Removed rather than invalidated: refetching the job page's own
      // queries would ask for a row that no longer exists.
      queryClient.removeQueries({ queryKey: ["job", jobCardId] });
      queryClient.removeQueries({ queryKey: ["job-delete-preview", jobCardId] });
      for (const key of [["jobs"], ["analytics"], ["calendar-events"], ["quotes"]]) queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setError(getErrorMessage(e, "Failed to delete the job")),
  });

  const p = preview.data;
  const blockers = p ? [...p.blocking_invoices.map((b) => ({ ...b, kind: "Invoice", to: `/invoices/${b.id}` })), ...p.blocking_quotes.map((b) => ({ ...b, kind: "Quote", to: `/quotes/${b.id}` })), ...p.blocking_purchase_orders.map((b) => ({ ...b, kind: "Purchase order", to: `/subcontractors/purchase-orders/${b.id}` }))] : [];
  const removed = p
    ? [
        p.draft_quotes > 0 ? `${plural(p.draft_quotes, "draft quote")} (never sent)` : null,
        p.calendar_events > 0 ? `${plural(p.calendar_events, "calendar booking")}, including in Google Calendar` : null,
        p.tasks > 0 ? plural(p.tasks, "task") : null,
        p.notes > 0 ? plural(p.notes, "note") : null,
        p.files > 0 ? plural(p.files, "photo/file", "photos/files") : null,
        p.pending_messages > 0 ? `${plural(p.pending_messages, "scheduled SMS/email", "scheduled SMS/emails")} - cancelled, not sent` : null,
      ].filter((line): line is string => line !== null)
    : [];
  const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;
  const body = { color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;

  return (
    <>
      <button
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        className="rounded px-3 py-1.5 font-semibold"
        style={{ border: "1px solid var(--jms-danger)", color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}
      >
        Delete
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ backgroundColor: "rgba(0,0,0,0.6)" }} onClick={() => setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Delete job"
            className="w-full max-w-md rounded-lg p-5"
            style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", fontFamily: "var(--jms-font)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 font-bold" style={body}>
              Delete job {p?.number ?? ""}?
            </h3>

            {preview.error ? (
              <p style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
                {getErrorMessage(preview.error, "Couldn't check this job")}. If this mentions a missing function, the latest database migration hasn't been applied yet.
              </p>
            ) : !p ? (
              <p style={muted}>Checking what's attached to this job...</p>
            ) : blockers.length > 0 ? (
              <>
                <p className="mb-2" style={body}>
                  This job can't be deleted, because it has:
                </p>
                <ul className="mb-3 flex flex-col gap-1">
                  {blockers.map((b) => (
                    <li key={`${b.kind}-${b.id}`} style={body}>
                      <Link to={b.to} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                        {b.kind} {b.number ?? ""}
                      </Link>
                      {b.status ? <span style={muted}> ({b.status})</span> : null}
                    </li>
                  ))}
                </ul>
                <p className="mb-4" style={muted}>
                  Invoices, purchase orders and quotes that have been sent are kept as records, so the job they belong to is kept too.
                </p>
              </>
            ) : (
              <>
                <p className="mb-2" style={body}>
                  This permanently removes the job{removed.length > 0 ? " and:" : "."}
                </p>
                {removed.length > 0 ? (
                  <ul className="mb-3 list-disc pl-5" style={body}>
                    {removed.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : null}
                {p.timesheet_minutes > 0 ? (
                  <p className="mb-2" style={muted}>
                    The {hoursText(p.timesheet_minutes)} logged on it in timesheets is kept, shown as "Deleted job".
                  </p>
                ) : null}
                <p className="mb-3" style={muted}>
                  The next new job will be numbered {p.next_number_after}.
                </p>
                <p className="mb-4" style={muted}>
                  This can't be undone.
                </p>
              </>
            )}

            {error ? (
              <p className="mb-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
                {error}
              </p>
            ) : null}

            <div className="flex items-center gap-3">
              {p && blockers.length === 0 ? (
                <button
                  onClick={() => remove.mutate()}
                  disabled={remove.isPending}
                  className="rounded px-4 py-1.5 font-semibold disabled:opacity-50"
                  style={{ backgroundColor: "var(--jms-danger)", color: "var(--jms-bg)", fontSize: "var(--jms-font-body)" }}
                >
                  {remove.isPending ? "Deleting..." : "Delete job"}
                </button>
              ) : null}
              <button onClick={() => setOpen(false)} className="font-semibold hover:underline" style={muted}>
                {p && blockers.length > 0 ? "Close" : "Cancel"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
