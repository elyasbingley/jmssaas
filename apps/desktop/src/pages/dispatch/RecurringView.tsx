import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RECURRING_STATUS_LABELS,
  describeRepeat,
  formatCentsAsAud,
  recurringVisitTotals,
  visitCreatedOn,
  type RecurringService,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { fetchAllRows } from "../../lib/fetch-all-rows";
import { getErrorMessage } from "../../lib/errors";
import { fmtDay } from "../../components/AssetEditor";
import { RecurringEditor } from "../../components/RecurringServicesSection";
import type { DispatchEvent, DispatchJob } from "./data";
import type { JobLifecycleStage } from "@jmssaas/shared";

// Every recurring service in one list (the same ones set up from a job and
// shown on the job and client pages). Edit, pause, resume or stop them
// here without leaving Dispatch. Their visits waiting to be booked are in
// the Jobs panel under "Recurring to book".

type Row = RecurringService & { clients: { id: string; name: string } | null };
type Tab = "active" | "paused" | "stopped";
const KEY = ["recurring-services"];
const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;
const link = { color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" } as const;

export function RecurringView({
  jobs,
  events,
  stagesById,
  onShowToBook,
}: {
  jobs: DispatchJob[];
  events: DispatchEvent[];
  stagesById: Map<string, JobLifecycleStage>;
  onShowToBook: () => void;
}) {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("active");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<RecurringService | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const { data: services, error } = useQuery({
    queryKey: [...KEY, "all"],
    queryFn: () => fetchAllRows<Row>("recurring_services", "*, clients(id, name)", (q) => q.order("next_due_on")),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY });
  const setStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: RecurringService["status"] }) => {
      const { error: e } = await supabase.from("recurring_services").update({ status }).eq("id", id);
      if (e) throw e;
    },
    onSuccess: refresh,
  });

  // Each service's open visit (if any): to book, or booked for when.
  const visitOf = useMemo(() => {
    const booked = new Map<string, string>();
    for (const e of events) if (e.job_card_id && (!booked.has(e.job_card_id) || e.start_at > booked.get(e.job_card_id)!)) booked.set(e.job_card_id, e.start_at);
    const m = new Map<string, { job: DispatchJob; bookedAt: string | null }>();
    for (const j of jobs) {
      if (!j.recurring_service_id) continue;
      if (j.lifecycle_stage_id && stagesById.get(j.lifecycle_stage_id)?.is_closed) continue;
      const prev = m.get(j.recurring_service_id);
      if (!prev || (j.recurring_due_on ?? "") > (prev.job.recurring_due_on ?? "")) m.set(j.recurring_service_id, { job: j, bookedAt: booked.get(j.id) ?? j.scheduled_at ?? null });
    }
    return m;
  }, [jobs, events, stagesById]);

  const counts = { active: 0, paused: 0, stopped: 0 };
  for (const s of services ?? []) counts[s.status] += 1;
  const q = search.trim().toLowerCase();
  const list = (services ?? []).filter((s) => s.status === tab && (!q || s.title.toLowerCase().includes(q) || s.clients?.name.toLowerCase().includes(q)));
  const toBook = [...visitOf.values()].filter((v) => !v.bookedAt).length;

  return (
    <div className="h-full overflow-y-auto p-4" data-testid="recurring-view">
      <div className="mx-auto max-w-5xl">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-1">
            {(["active", "paused", "stopped"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className="rounded px-3 py-1 font-semibold"
                style={{
                  fontSize: "var(--jms-font-label)",
                  color: tab === t ? "var(--jms-accent)" : "var(--jms-text-muted)",
                  backgroundColor: tab === t ? "var(--jms-accent-glow)" : "transparent",
                  border: `1px solid ${tab === t ? "var(--jms-accent)" : "var(--jms-border)"}`,
                }}
              >
                {RECURRING_STATUS_LABELS[t]} {counts[t]}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {toBook ? (
              <button onClick={onShowToBook} className="font-semibold hover:underline" style={{ color: "var(--jms-warning)", fontSize: "var(--jms-font-label)" }}>
                {toBook} visit{toBook === 1 ? "" : "s"} to book →
              </button>
            ) : null}
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search service or client"
              className="rounded border px-2 py-1"
              style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
              aria-label="Search recurring services"
            />
          </div>
        </div>
        {error || setStatus.error ? (
          <p className="mb-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {getErrorMessage(error ?? setStatus.error, "Something went wrong")}
          </p>
        ) : null}
        {message ? <p className="mb-3" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>{message}</p> : null}
        {services && list.length === 0 ? (
          <p style={muted}>
            {tab === "active" && !q ? "No recurring services yet. Open a job and choose \"Make this recurring\" to set one up." : "None here."}
          </p>
        ) : null}

        {list.length ? (
          <div className="overflow-x-auto rounded-md" style={{ border: "1px solid var(--jms-border)" }}>
            <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
              <thead style={{ backgroundColor: "var(--jms-surface)" }}>
                <tr style={muted}>
                  <th className="px-3 py-2 font-semibold uppercase">Client and service</th>
                  <th className="px-3 py-2 font-semibold uppercase">Repeats</th>
                  <th className="px-3 py-2 font-semibold uppercase">Next due</th>
                  <th className="px-3 py-2 font-semibold uppercase">This visit</th>
                  <th className="px-3 py-2 text-right font-semibold uppercase">Per visit</th>
                  {isAdmin ? <th className="px-3 py-2" /> : null}
                </tr>
              </thead>
              <tbody>
                {list.map((s) => {
                  const visit = visitOf.get(s.id);
                  const totals = recurringVisitTotals(s.line_items ?? []);
                  return (
                    <tr key={s.id} style={{ borderTop: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)" }} data-testid="recurring-row">
                      <td className="px-3 py-2">
                        {s.clients ? (
                          <Link to={`/clients/${s.clients.id}`} className="font-semibold hover:underline" style={{ color: "var(--jms-text)" }}>
                            {s.clients.name}
                          </Link>
                        ) : null}
                        <p style={muted}>🔁 {s.title}</p>
                      </td>
                      <td className="px-3 py-2" style={{ color: "var(--jms-text)" }}>
                        {describeRepeat(s.interval_count, s.interval_unit)}
                      </td>
                      <td className="px-3 py-2" style={{ color: "var(--jms-text)" }}>
                        {s.status === "stopped" ? "-" : fmtDay(s.next_due_on)}
                        {s.status === "active" ? <p style={muted}>job made {fmtDay(visitCreatedOn(s.next_due_on, s.lead_days))}</p> : null}
                      </td>
                      <td className="px-3 py-2">
                        {visit ? (
                          <Link to={`/jobs/${visit.job.id}`} className="hover:underline" style={{ color: visit.bookedAt ? "var(--jms-accent)" : "var(--jms-warning)", fontSize: "var(--jms-font-label)" }}>
                            {visit.job.number} {visit.bookedAt ? `booked ${new Date(visit.bookedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}` : "to book"}
                          </Link>
                        ) : (
                          <span style={muted}>None open</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right" style={{ color: "var(--jms-text)" }}>
                        {s.line_items?.length ? formatCentsAsAud(totals.total_cents) : <span style={muted}>on the day</span>}
                      </td>
                      {isAdmin ? (
                        <td className="whitespace-nowrap px-3 py-2 text-right">
                          <span className="inline-flex gap-3">
                            {s.status !== "stopped" ? (
                              <button onClick={() => setEditing(s)} className="font-semibold hover:underline" style={link}>
                                Edit
                              </button>
                            ) : null}
                            {s.status === "active" ? (
                              <button onClick={() => setStatus.mutate({ id: s.id, status: "paused" })} className="font-semibold hover:underline" style={link}>
                                Pause
                              </button>
                            ) : null}
                            {s.status === "paused" ? (
                              <button onClick={() => setStatus.mutate({ id: s.id, status: "active" })} className="font-semibold hover:underline" style={link}>
                                Resume
                              </button>
                            ) : null}
                            {s.status !== "stopped" ? (
                              <button
                                onClick={() => {
                                  if (window.confirm(`Stop "${s.title}" for ${s.clients?.name ?? "this client"}? No more visits will be created. Visits already created stay as they are.`))
                                    setStatus.mutate({ id: s.id, status: "stopped" });
                                }}
                                className="font-semibold hover:underline"
                                style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}
                              >
                                Stop
                              </button>
                            ) : null}
                          </span>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
      {editing ? (
        <RecurringEditor
          job={null}
          service={editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            setMessage(msg);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}
