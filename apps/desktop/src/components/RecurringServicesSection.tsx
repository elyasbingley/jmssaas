import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RECURRING_STATUS_LABELS,
  addRecurringInterval,
  describeRepeat,
  formatCentsAsAud,
  recurringVisitTotals,
  sydneyToday,
  upcomingVisits,
  visitCreatedOn,
  type JobCard,
  type RecurringLineItem,
  type RecurringService,
  type RecurringUnit,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { fetchAllRows } from "../lib/fetch-all-rows";
import { ThemedButton } from "./theme/ThemedButton";
import { ThemedModal } from "./theme/ThemedModal";
import { fmtDay } from "./AssetEditor";

// Recurring jobs (recurring_jobs migration). On a job: "Make this
// recurring", the service it belongs to (Edit / Pause / Stop), and "Skip
// this visit" for an unbooked visit. On a client: all their recurring
// services.

type RecurringJob = JobCard & { recurring_service_id?: string | null; recurring_due_on?: string | null };
interface Visit {
  id: string;
  number: string | null;
  recurring_service_id: string;
  recurring_due_on: string;
  scheduled_at: string | null;
  booked: boolean;
  stage: string | null;
  closed: boolean;
}

const KEY = ["recurring-services"];
const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;
const body = { color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;
const link = { color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" } as const;
const inputClass = "w-full rounded border px-2 py-1.5 focus:outline-none";
const inputStyle = { backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;
const labelClass = "mb-1 block uppercase tracking-wide";

export function RecurringServicesSection(props: { job: RecurringJob } | { clientId: string }) {
  const job = "job" in props ? props.job : null;
  const clientId = job ? job.client_id : (props as { clientId: string }).clientId;
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<{ service: RecurringService | null } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const { data: services, error } = useQuery({
    queryKey: [...KEY, job ? `job-${job.id}` : `client-${clientId}`],
    queryFn: async () => {
      let q = supabase.from("recurring_services").select("*");
      if (job) {
        const ors = [`source_job_id.eq.${job.id}`];
        if (job.recurring_service_id) ors.push(`id.eq.${job.recurring_service_id}`);
        q = q.or(ors.join(","));
      } else {
        q = q.eq("client_id", clientId);
      }
      const { data, error: e } = await q.order("created_at");
      if (e) throw e;
      return data as RecurringService[];
    },
  });
  const ids = (services ?? []).map((s) => s.id);
  const { data: visits } = useQuery({
    queryKey: [...KEY, "visits", ids.join(",")],
    enabled: ids.length > 0,
    queryFn: async () => {
      const rows = await fetchAllRows<{
        id: string;
        number: string | null;
        recurring_service_id: string;
        recurring_due_on: string;
        scheduled_at: string | null;
        job_lifecycle_stages: { name: string; is_closed: boolean } | null;
      }>("job_cards", "id, number, recurring_service_id, recurring_due_on, scheduled_at, job_lifecycle_stages(name, is_closed)", (q) => q.in("recurring_service_id", ids));
      // Booked = on the calendar (how JMS books jobs) or scheduled_at set.
      const onCalendar = new Set(
        rows.length ? (await fetchAllRows<{ job_card_id: string }>("calendar_events", "job_card_id", (q) => q.in("job_card_id", rows.map((r) => r.id)))).map((e) => e.job_card_id) : []
      );
      return rows.map((r) => ({ ...r, booked: !!r.scheduled_at || onCalendar.has(r.id), stage: r.job_lifecycle_stages?.name ?? null, closed: !!r.job_lifecycle_stages?.is_closed })) as Visit[];
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY });
  const setStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: RecurringService["status"] }) => {
      const { error: e } = await supabase.from("recurring_services").update({ status }).eq("id", id);
      if (e) throw e;
    },
    onSuccess: refresh,
  });
  const skip = useMutation({
    mutationFn: async (jobId: string) => {
      const { error: e } = await supabase.rpc("recurring_skip_visit", { p_job_card_id: jobId });
      if (e) throw e;
    },
    onSuccess: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      navigate("/jobs");
    },
  });

  const thisVisitService = job?.recurring_service_id ? (services ?? []).find((s) => s.id === job.recurring_service_id) : null;
  const thisVisitBooked = !!job?.scheduled_at || !!(visits ?? []).find((v) => v.id === job?.id)?.booked;
  const canSkip = !!job?.recurring_service_id && !thisVisitBooked && !!visits;
  const list = services ?? [];
  if (!job && list.length === 0) return null;

  return (
    <div className="mb-6 rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }} data-testid="recurring-section">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)", letterSpacing: "0.1em" }}>
          Recurring
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          {job && isAdmin && !job.recurring_service_id ? (
            <ThemedButton onClick={() => setEditing({ service: null })} style={{ paddingBlock: 4, paddingInline: 12 }}>
              Make this recurring
            </ThemedButton>
          ) : null}
          {canSkip && isAdmin ? (
            <button
              onClick={() => {
                if (window.confirm("Skip this visit? The job and its draft invoice are removed, and the next visit still comes round on schedule.")) skip.mutate(job!.id);
              }}
              className="font-semibold hover:underline"
              style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}
              disabled={skip.isPending}
            >
              Skip this visit
            </button>
          ) : null}
        </div>
      </div>
      {thisVisitService && job?.recurring_due_on ? (
        <p className="mb-2" style={body}>
          This is the {fmtDay(job.recurring_due_on)} visit of <strong>{thisVisitService.title}</strong>, {describeRepeat(thisVisitService.interval_count, thisVisitService.interval_unit)}.
          {thisVisitBooked ? "" : " Not booked yet."}
        </p>
      ) : null}
      {error || setStatus.error || skip.error ? (
        <p className="mb-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          {getErrorMessage(error ?? setStatus.error ?? skip.error, "Something went wrong")}
        </p>
      ) : null}
      {message ? <p className="mb-2" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>{message}</p> : null}
      {job && list.length === 0 ? (
        <p style={muted}>
          Not recurring. For ongoing work like gutter cleans, make it recurring: the next job is created four weeks before it's due, ready to book, with the same line items.
        </p>
      ) : null}
      <div className="space-y-3">
        {list.map((s) => {
          const totals = recurringVisitTotals(s.line_items ?? []);
          const mine = (visits ?? []).filter((v) => v.recurring_service_id === s.id).sort((a, b) => b.recurring_due_on.localeCompare(a.recurring_due_on));
          const next = upcomingVisits(s.next_due_on, s.interval_count, s.interval_unit, 3);
          return (
            <div key={s.id} className="rounded p-3" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", opacity: s.status === "stopped" ? 0.6 : 1 }} data-testid="recurring-service">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
                    🔁 {s.title} - {describeRepeat(s.interval_count, s.interval_unit)}
                    {s.status !== "active" ? <span style={{ color: s.status === "paused" ? "var(--jms-warning)" : "var(--jms-text-muted)" }}> ({RECURRING_STATUS_LABELS[s.status].toLowerCase()})</span> : null}
                  </p>
                  <p style={muted}>
                    {s.status === "active"
                      ? `Next due ${fmtDay(s.next_due_on)} (job made ${fmtDay(visitCreatedOn(s.next_due_on, s.lead_days))}), then ${next.slice(1).map((d) => fmtDay(d)).join(", ")}`
                      : s.status === "paused"
                        ? `Paused - next due ${fmtDay(s.next_due_on)} when resumed`
                        : "Stopped - no more visits"}
                  </p>
                  <p style={muted}>
                    {s.line_items?.length ? `${formatCentsAsAud(totals.total_cents)} per visit (${s.line_items.length} line${s.line_items.length === 1 ? "" : "s"})` : "No line items - priced on the day"}
                    {" · "}
                    {s.is_real_estate_job || s.property_id ? "agency job, no text" : s.confirm_text ? "confirm text on" : "no confirm text"}
                    {s.asset_service_id ? " · ticks off the asset's service" : ""}
                  </p>
                </div>
                {isAdmin ? (
                  <div className="flex flex-wrap gap-3">
                    {s.status !== "stopped" ? (
                      <button onClick={() => setEditing({ service: s })} className="font-semibold hover:underline" style={link}>
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
                          if (window.confirm(`Stop "${s.title}"? No more visits will be created. Visits already created stay as they are.`)) setStatus.mutate({ id: s.id, status: "stopped" });
                        }}
                        className="font-semibold hover:underline"
                        style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}
                      >
                        Stop
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {mine.length ? (
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1" style={muted}>
                  Visits:
                  {mine.slice(0, 6).map((v) => (
                    <Link key={v.id} to={`/jobs/${v.id}`} className="hover:underline" style={{ color: v.id === job?.id ? "var(--jms-text)" : "var(--jms-accent)" }}>
                      {fmtDay(v.recurring_due_on)} {v.closed ? "done" : v.booked ? "booked" : (v.stage ?? "to book").toLowerCase()}
                    </Link>
                  ))}
                </div>
              ) : null}
              {!job && s.source_job_id ? (
                <Link to={`/jobs/${s.source_job_id}`} className="mt-1 inline-block hover:underline" style={muted}>
                  Set up from this job
                </Link>
              ) : null}
            </div>
          );
        })}
      </div>
      {editing && job ? (
        <RecurringEditor
          job={job}
          service={editing.service}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            setMessage(msg);
            refresh();
          }}
        />
      ) : null}
      {editing && !job && editing.service ? (
        <RecurringEditor
          job={null}
          service={editing.service}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            setMessage(msg);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

// The first due date to suggest: one interval after the job was done (or
// booked), else from today.
function suggestFirstDue(job: RecurringJob | null, count: number, unit: RecurringUnit): string {
  const from = job?.completed_at ?? job?.scheduled_at ?? null;
  const today = sydneyToday();
  let next = addRecurringInterval(from ? new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date(from)) : today, count, unit);
  // An old job: the next one after today, not a date already gone.
  for (let i = 0; next <= today && i < 600; i++) next = addRecurringInterval(next, count, unit);
  return next;
}

function RecurringEditor({
  job,
  service,
  onClose,
  onSaved,
}: {
  job: RecurringJob | null;
  service: RecurringService | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { profile } = useAuth();
  const clientId = service?.client_id ?? job!.client_id;
  const [title, setTitle] = useState(service?.title ?? job?.title ?? "");
  const [description, setDescription] = useState(service?.description ?? job?.description ?? "");
  const [count, setCount] = useState(String(service?.interval_count ?? 6));
  const [unit, setUnit] = useState<RecurringUnit>(service?.interval_unit ?? "month");
  const [nextDue, setNextDue] = useState(service?.next_due_on ?? suggestFirstDue(job, 6, "month"));
  const [dueTouched, setDueTouched] = useState(!!service);
  const [leadDays, setLeadDays] = useState(String(service?.lead_days ?? 28));
  const [confirmText, setConfirmText] = useState(service?.confirm_text ?? true);
  const [assetServiceId, setAssetServiceId] = useState(service?.asset_service_id ?? "");
  const [lines, setLines] = useState<RecurringLineItem[] | null>(service ? service.line_items ?? [] : null);
  const [error, setError] = useState<string | null>(null);

  // A new one starts from the job's own invoice (or accepted quote) lines.
  useQuery({
    queryKey: [...KEY, "lines", job?.id],
    enabled: !service && !!job,
    queryFn: async () => {
      const { data, error: e } = await supabase.rpc("recurring_line_items_from_job", { p_job_card_id: job!.id });
      if (e) throw e;
      setLines((current) => current ?? ((data ?? []) as RecurringLineItem[]));
      return data;
    },
  });
  const { data: assetServices } = useQuery({
    queryKey: [...KEY, "asset-services", clientId],
    queryFn: async () => {
      const { data, error: e } = await supabase
        .from("asset_services")
        .select("id, name, next_due_on, property_assets!inner(asset_name, client_id, status)")
        .eq("property_assets.client_id", clientId)
        .eq("property_assets.status", "active");
      if (e) throw e;
      return (data ?? []) as unknown as { id: string; name: string; next_due_on: string | null; property_assets: { asset_name: string } }[];
    },
  });

  const n = Math.max(1, Math.min(104, Math.round(Number(count) || 1)));
  const lead = Math.max(0, Math.min(365, Math.round(Number(leadDays) || 0)));
  const totals = recurringVisitTotals(lines ?? []);
  const isAgency = !!(service?.is_real_estate_job || service?.property_id || job?.is_real_estate_job || job?.property_id);
  const changeInterval = (c: string, u: RecurringUnit) => {
    setCount(c);
    setUnit(u);
    if (!dueTouched) setNextDue(suggestFirstDue(job, Math.max(1, Math.round(Number(c) || 1)), u));
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!title.trim()) throw new Error("Give it a title (it becomes each job's title).");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDue)) throw new Error("Pick when the next visit is due.");
      const cleanLines = (lines ?? [])
        .filter((l) => String(l.description ?? "").trim())
        .map((l, i) => ({ ...l, description: String(l.description).trim(), quantity: Number(l.quantity) || 0, unit_price_cents: Math.round(Number(l.unit_price_cents) || 0), sort_order: i }));
      const row = {
        title: title.trim(),
        description: description.trim() || null,
        interval_count: n,
        interval_unit: unit,
        next_due_on: nextDue,
        lead_days: lead,
        confirm_text: confirmText,
        asset_service_id: assetServiceId || null,
        line_items: cleanLines,
      };
      if (service) {
        const { error: e } = await supabase.from("recurring_services").update(row).eq("id", service.id);
        if (e) throw e;
        return `Saved. Next visit due ${fmtDay(nextDue)}.`;
      }
      const { error: e } = await supabase.from("recurring_services").insert({
        ...row,
        tenant_id: profile!.tenant_id,
        client_id: job!.client_id,
        site_id: job!.site_id ?? null,
        is_real_estate_job: !!job!.is_real_estate_job,
        agency_id: job!.agency_id ?? null,
        property_manager_id: job!.property_manager_id ?? null,
        property_id: job!.property_id ?? null,
        source_job_id: job!.id,
        service_category_id: job!.service_category_id ?? null,
        created_by: profile!.id,
      });
      if (e) throw e;
      const made = visitCreatedOn(nextDue, lead);
      return `Recurring set up. The ${fmtDay(nextDue)} visit's job will be created ${made <= sydneyToday() ? "within a few minutes" : `on ${fmtDay(made)}`}, in "To book".`;
    },
    onSuccess: onSaved,
    onError: (e) => setError(getErrorMessage(e, "Couldn't save")),
  });

  const setLine = (i: number, patch: Partial<RecurringLineItem>) => setLines((ls) => (ls ?? []).map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <ThemedModal open onClose={onClose} title={service ? `Edit ${service.title}` : "Make this recurring"}>
      <div style={body}>
        <label className={labelClass} style={muted}>
          Title (each job's title)
        </label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={`${inputClass} mb-3`} style={inputStyle} aria-label="Title" />
        <label className={labelClass} style={muted}>
          Description
        </label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={`${inputClass} mb-3`} style={inputStyle} aria-label="Description" />

        <div className="mb-3 grid grid-cols-[auto_5rem_8rem] items-end gap-2">
          <span className="pb-2" style={muted}>
            REPEATS EVERY
          </span>
          <input value={count} onChange={(e) => changeInterval(e.target.value, unit)} className={inputClass} style={inputStyle} inputMode="numeric" aria-label="Every" />
          <select value={unit} onChange={(e) => changeInterval(count, e.target.value as RecurringUnit)} className={inputClass} style={inputStyle} aria-label="Unit">
            <option value="week">{n === 1 ? "week" : "weeks"}</option>
            <option value="month">{n === 1 ? "month" : "months"}</option>
          </select>
        </div>
        <div className="mb-1 grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass} style={muted}>
              Next visit due
            </label>
            <input
              type="date"
              value={nextDue}
              onChange={(e) => {
                setNextDue(e.target.value);
                setDueTouched(true);
              }}
              className={inputClass}
              style={inputStyle}
              aria-label="Next visit due"
            />
          </div>
          <div>
            <label className={labelClass} style={muted}>
              Create the job (days before)
            </label>
            <input value={leadDays} onChange={(e) => setLeadDays(e.target.value)} className={inputClass} style={inputStyle} inputMode="numeric" aria-label="Days before" />
          </div>
        </div>
        {/^\d{4}-\d{2}-\d{2}$/.test(nextDue) ? (
          <p className="mb-3" style={muted}>
            Visits due {upcomingVisits(nextDue, n, unit, 3).map((d) => fmtDay(d)).join(", ")}... Each job is created {lead} days before, in "To book". Counted from each due date, so a late visit
            doesn't push the schedule out.
          </p>
        ) : null}

        <p className="mb-1 uppercase tracking-wide" style={muted}>
          Line items for each visit {lines === null ? "(loading...)" : ""}
        </p>
        <div className="mb-1 space-y-1">
          {(lines ?? []).map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_3.5rem_6rem_2.5rem_1.2rem] items-center gap-1">
              <input value={String(l.description ?? "")} onChange={(e) => setLine(i, { description: e.target.value })} className={inputClass} style={inputStyle} aria-label={`Line ${i + 1}`} />
              <input value={String(l.quantity)} onChange={(e) => setLine(i, { quantity: e.target.value as unknown as number })} className={inputClass} style={inputStyle} inputMode="decimal" aria-label={`Line ${i + 1} quantity`} />
              <input
                defaultValue={(Number(l.unit_price_cents) / 100).toFixed(2)}
                onBlur={(e) => setLine(i, { unit_price_cents: Math.round(Number(e.target.value.replace(/[$,]/g, "")) * 100) || 0 })}
                className={inputClass}
                style={inputStyle}
                inputMode="decimal"
                aria-label={`Line ${i + 1} price`}
              />
              <label className="flex items-center gap-1" style={muted} title="GST">
                <input type="checkbox" checked={!!l.gst_applicable} onChange={(e) => setLine(i, { gst_applicable: e.target.checked })} />
                GST
              </label>
              <button type="button" onClick={() => setLines((ls) => (ls ?? []).filter((_, j) => j !== i))} aria-label="Remove line" style={{ color: "var(--jms-text-muted)" }}>
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="mb-3 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setLines((ls) => [...(ls ?? []), { description: "", quantity: 1, unit_price_cents: 0, gst_applicable: true }])}
            className="font-semibold hover:underline"
            style={link}
          >
            + Add a line
          </button>
          <span style={muted}>{lines?.length ? `${formatCentsAsAud(totals.total_cents)} per visit incl. GST - goes on each visit's draft invoice` : "No lines: the visit is priced on the day"}</span>
        </div>

        {assetServices && assetServices.length ? (
          <>
            <label className={labelClass} style={muted}>
              Looks after an asset's service
            </label>
            <select value={assetServiceId} onChange={(e) => setAssetServiceId(e.target.value)} className={`${inputClass} mb-1`} style={inputStyle} aria-label="Asset service">
              <option value="">None</option>
              {assetServices.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.property_assets.asset_name} - {a.name}
                </option>
              ))}
            </select>
            <p className="mb-3" style={muted}>
              Completing each visit ticks that service off in the asset register, and the asset's own service-due text is skipped so they aren't texted twice.
            </p>
          </>
        ) : null}

        {isAgency ? (
          <p className="mb-3" style={muted}>
            Agency job: no confirm text is sent - book it with the property manager.
          </p>
        ) : (
          <label className="mb-3 flex items-start gap-2" style={muted}>
            <input type="checkbox" checked={confirmText} onChange={(e) => setConfirmText(e.target.checked)} className="mt-1" />
            <span>
              Text the client when the job is created to check the week suits (wording under{" "}
              <Link to="/follow-ups" className="underline">
                Follow-ups &gt; Recurring due
              </Link>
              , off until you switch it on there).
            </span>
          </label>
        )}

        {error ? <p className="mb-2" style={{ color: "var(--jms-danger)" }}>{error}</p> : null}
        <div className="flex justify-end gap-2">
          <ThemedButton variant="secondary" onClick={onClose}>
            Cancel
          </ThemedButton>
          <ThemedButton
            onClick={() => {
              setError(null);
              save.mutate();
            }}
            disabled={save.isPending || lines === null}
          >
            {save.isPending ? "Saving..." : service ? "Save" : "Make recurring"}
          </ThemedButton>
        </div>
      </div>
    </ThemedModal>
  );
}
