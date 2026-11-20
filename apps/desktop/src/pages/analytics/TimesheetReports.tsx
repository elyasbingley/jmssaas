import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SHIFT_FLAG_LABELS,
  TIMESHEET_ACTIVITY_LABELS,
  TIMESHEET_ACTIVITY_TYPES,
  addDays,
  canApproveWeek,
  entryMinutes,
  formatMinutes,
  minutesToHours,
  summariseShifts,
  toDayKey,
  weekStartOf,
  weekTotals,
  weeklyRows,
  type DateRange,
  type ShiftSummary,
  type TimesheetActivity,
  type TimesheetActivityType,
  type TimesheetShift,
  type TimesheetWeekApproval,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { getErrorMessage } from "../../lib/errors";
import { fetchAllRows, useAnalytics } from "./data";
import { ACCENT, CONTEXT, Columns, DataTable, Empty, ExportButton, PageHeading, Panel, RankedBars, StatTile, downloadCsv, formatDay } from "./ui";
import { TimesheetClock } from "../../components/TimesheetClock";

// Analytics > Timesheets. Time is recorded on phones (apps/mobile's timer
// card and Job Card button), or on the desktop (My Timesheet's clock and
// the job page's timer button); this is where the office reads it,
// corrects it and signs it off:
//
//   My Timesheet           your own clock on/off and entries (main menu >
//                          Timesheets)
//   Activity Timesheet     where the time went - every job/travel/break/
//                          admin entry
//   All Timesheets         every shift (clock on to clock off)
//   Weekly Timesheets      paid hours per person per Mon-Sun week, and
//                          approval, which locks the week
//   Weekly Timesheets Graph  hours per week over time
//
// All the hours maths is @jmssaas/shared's timesheets.ts, the same code
// the phone uses for its own totals.

type Person = { id: string; full_name: string };

interface TimesheetData {
  shifts: TimesheetShift[];
  activities: TimesheetActivity[];
  approvals: TimesheetWeekApproval[];
  people: Person[];
}

async function fetchTimesheetData(): Promise<TimesheetData> {
  const [shifts, activities, approvals, people] = await Promise.all([
    fetchAllRows<TimesheetShift>("timesheet_shifts", "*"),
    fetchAllRows<TimesheetActivity>("timesheet_activities", "*"),
    fetchAllRows<TimesheetWeekApproval>("timesheet_week_approvals", "*"),
    fetchAllRows<Person>("profiles", "id, full_name"),
  ]);
  return { shifts, activities, approvals, people: people.sort((a, b) => a.full_name.localeCompare(b.full_name)) };
}

const TIMESHEET_KEY = ["analytics", "timesheets"];

function useTimesheets() {
  const query = useQuery({ queryKey: TIMESHEET_KEY, queryFn: fetchTimesheetData, staleTime: 30_000 });
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date().toISOString()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const nameOf = useMemo(() => {
    const names = new Map((query.data?.people ?? []).map((p) => [p.id, p.full_name]));
    return (id: string) => names.get(id) ?? "Former staff member";
  }, [query.data]);
  const approvalOf = useMemo(() => {
    const byKey = new Map((query.data?.approvals ?? []).map((a) => [`${a.profile_id}|${a.week_start}`, a]));
    return (profileId: string, startedAt: string) => byKey.get(`${profileId}|${weekStartOf(toDayKey(startedAt))}`);
  }, [query.data]);
  return { data: query.data, error: query.error, now, nameOf, approvalOf };
}

// Whole Mon-Sun weeks covering the timeframe - a weekly total (or an
// approval) for half a week would be wrong, so the weekly reports widen
// the range to week boundaries.
function wholeWeeks(range: DateRange): DateRange {
  return { from: weekStartOf(range.from), to: addDays(weekStartOf(range.to), 6) };
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
const hours = (minutes: number) => minutesToHours(minutes).toFixed(2);
const inputStyle = { border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;
const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;

function LoadState({ error }: { error: unknown }) {
  if (!error) return <Empty>Loading timesheets...</Empty>;
  return (
    <Empty>
      Couldn't load timesheets: {getErrorMessage(error, "unknown error")}. If this mentions a missing table, the latest database migration hasn't been applied yet.
    </Empty>
  );
}

function StaffFilter({ people, value, onChange }: { people: Person[]; value: string; onChange: (id: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Staff member" className="rounded-md px-2 py-1.5" style={inputStyle}>
      <option value="">All staff</option>
      {people.map((p) => (
        <option key={p.id} value={p.id}>
          {p.full_name}
        </option>
      ))}
    </select>
  );
}

function mapUrl(latitude: number, longitude: number): string {
  return `https://www.google.com/maps?q=${latitude},${longitude}`;
}

function LocationLinks({ entry }: { entry: TimesheetShift | TimesheetActivity }) {
  const link = (label: string, latitude: number | null, longitude: number | null) =>
    latitude !== null && longitude !== null ? (
      <a href={mapUrl(latitude, longitude)} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "var(--jms-accent)" }}>
        {label}
      </a>
    ) : null;
  const start = link("on", entry.start_latitude, entry.start_longitude);
  const end = link("off", entry.end_latitude, entry.end_longitude);
  if (!start && !end) return <span style={{ color: "var(--jms-text-muted)" }}>-</span>;
  return (
    <span className="flex gap-2">
      {start}
      {end}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Add / edit an entry
// ---------------------------------------------------------------------------

type EditorTarget = { kind: "shift"; entry: TimesheetShift | null } | { kind: "activity"; entry: TimesheetActivity | null };

// <input type="datetime-local"> speaks local wall time with no zone.
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function EntryEditor({ target, people, isLocked, onClose }: { target: EditorTarget; people: Person[]; isLocked: (profileId: string, startedAt: string) => boolean; onClose: () => void }) {
  const { ix, today } = useAnalytics();
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const entry = target.entry;
  const [profileId, setProfileId] = useState(entry?.profile_id ?? people[0]?.id ?? "");
  const [start, setStart] = useState(entry ? toLocalInput(entry.started_at) : `${today}T07:00`);
  const [end, setEnd] = useState(entry ? toLocalInput(entry.ended_at) : `${today}T15:00`);
  const [note, setNote] = useState(entry?.note ?? "");
  const [activityType, setActivityType] = useState<TimesheetActivityType>(target.kind === "activity" && target.entry ? target.entry.activity_type : "job");
  const [jobId, setJobId] = useState(target.kind === "activity" && target.entry ? target.entry.job_card_id ?? "" : "");
  const [jobSearch, setJobSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const table = target.kind === "shift" ? "timesheet_shifts" : "timesheet_activities";

  const jobOptions = useMemo(() => {
    const q = jobSearch.trim().toLowerCase();
    return ix.jobs
      .filter((j) => j.id === jobId || !q || `${j.number ?? ""} ${j.title}`.toLowerCase().includes(q))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 50);
  }, [ix, jobSearch, jobId]);

  const done = () => {
    queryClient.invalidateQueries({ queryKey: TIMESHEET_KEY });
    queryClient.invalidateQueries({ queryKey: ["analytics", "costing"] });
    onClose();
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      if (!profileId) throw new Error("Choose who this is for.");
      if (!start) throw new Error("Set a start time.");
      const stillRunning = entry !== null && entry.ended_at === null && !end;
      if (!end && !stillRunning) throw new Error("Set a finish time.");
      const startedAt = new Date(start).toISOString();
      const endedAt = end ? new Date(end).toISOString() : null;
      if (endedAt && endedAt <= startedAt) throw new Error("The finish time has to be after the start time.");
      if (target.kind === "activity" && activityType === "job" && !jobId) throw new Error("Choose which job this time was on.");
      if (isLocked(profileId, startedAt)) throw new Error("That week has been approved and is locked. Reopen it on Weekly Timesheets first.");

      const fields = {
        started_at: startedAt,
        ended_at: endedAt,
        note: note.trim() || null,
        ...(target.kind === "activity" ? { activity_type: activityType, job_card_id: activityType === "job" ? jobId : null } : {}),
      };
      if (entry) {
        const { data, error } = await supabase.from(table).update(fields).eq("id", entry.id).select("started_at, ended_at");
        if (error) throw error;
        // The database skips (rather than rejects) a change to an approved
        // week - see the timesheets migration - so "no error" isn't proof
        // it saved.
        const saved = (data ?? [])[0] as { started_at: string; ended_at: string | null } | undefined;
        if (!saved || new Date(saved.started_at).getTime() !== new Date(startedAt).getTime()) {
          throw new Error("Not saved - that week has been approved and is locked. Reopen it on Weekly Timesheets first.");
        }
      } else {
        const { error } = await supabase.from(table).insert({ ...fields, tenant_id: profile.tenant_id, profile_id: profileId, source: "manual" });
        if (error) throw error;
      }
    },
    onSuccess: done,
    onError: (e) => setError(getErrorMessage(e, "Failed to save")),
  });

  const remove = useMutation({
    mutationFn: async () => {
      if (!entry) return;
      const { data, error } = await supabase.from(table).delete().eq("id", entry.id).select("id");
      if (error) throw error;
      if ((data ?? []).length === 0) throw new Error("Not deleted - that week has been approved and is locked.");
    },
    onSuccess: done,
    onError: (e) => setError(getErrorMessage(e, "Failed to delete")),
  });

  const field = "mb-3 block";
  const labelClass = "mb-1 block font-semibold";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ backgroundColor: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${entry ? "Edit" : "Add"} ${target.kind}`}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg p-5"
        style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", fontFamily: "var(--jms-font)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 font-bold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
          {entry ? "Edit" : "Add"} {target.kind === "shift" ? "shift" : "activity"}
        </h3>

        <label className={field}>
          <span className={labelClass} style={muted}>
            Staff member
          </span>
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)} disabled={!!entry} className="w-full rounded-md px-3 py-2" style={inputStyle}>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name}
              </option>
            ))}
          </select>
        </label>

        {target.kind === "activity" ? (
          <>
            <label className={field}>
              <span className={labelClass} style={muted}>
                Activity
              </span>
              <select value={activityType} onChange={(e) => setActivityType(e.target.value as TimesheetActivityType)} className="w-full rounded-md px-3 py-2" style={inputStyle}>
                {TIMESHEET_ACTIVITY_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {TIMESHEET_ACTIVITY_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>
            {activityType === "job" ? (
              <div className={field}>
                <span className={labelClass} style={muted}>
                  Job
                </span>
                <input type="text" value={jobSearch} onChange={(e) => setJobSearch(e.target.value)} placeholder="Search job number or title..." className="mb-2 w-full rounded-md px-3 py-2 focus:outline-none" style={inputStyle} />
                <select value={jobId} onChange={(e) => setJobId(e.target.value)} aria-label="Job" className="w-full rounded-md px-3 py-2" style={inputStyle}>
                  <option value="">Select a job...</option>
                  {jobOptions.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.number ?? "Pending"} - {j.title}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </>
        ) : null}

        <label className={field}>
          <span className={labelClass} style={muted}>
            Start
          </span>
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className="w-full rounded-md px-3 py-2" style={inputStyle} />
        </label>
        <label className={field}>
          <span className={labelClass} style={muted}>
            Finish{entry && entry.ended_at === null ? " (leave blank while it's still running)" : ""}
          </span>
          <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className="w-full rounded-md px-3 py-2" style={inputStyle} />
        </label>
        <label className={field}>
          <span className={labelClass} style={muted}>
            Note (optional)
          </span>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} className="w-full rounded-md px-3 py-2 focus:outline-none" style={inputStyle} />
        </label>

        {error ? (
          <p className="mb-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <button onClick={() => save.mutate()} disabled={save.isPending} className="rounded-md px-4 py-1.5 font-semibold disabled:opacity-50" style={{ border: "1px solid var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
            {save.isPending ? "Saving..." : "Save"}
          </button>
          <button onClick={onClose} className="font-semibold hover:underline" style={muted}>
            Cancel
          </button>
          {entry ? (
            <button
              onClick={() => window.confirm(`Delete this ${target.kind}? This can't be undone.`) && remove.mutate()}
              disabled={remove.isPending}
              className="ml-auto font-semibold hover:underline"
              style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}
            >
              Delete
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function useEditor(people: Person[], approvalOf: (profileId: string, startedAt: string) => TimesheetWeekApproval | undefined) {
  const [target, setTarget] = useState<EditorTarget | null>(null);
  const element = target ? <EntryEditor target={target} people={people} isLocked={(profileId, startedAt) => !!approvalOf(profileId, startedAt)} onClose={() => setTarget(null)} /> : null;
  return { open: setTarget, element };
}

function AddButtons({ open }: { open: (target: EditorTarget) => void }) {
  const style = { border: "1px solid var(--jms-border)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" };
  return (
    <>
      <button onClick={() => open({ kind: "shift", entry: null })} className="rounded-md px-3 py-1.5 font-semibold" style={style}>
        + Add shift
      </button>
      <button onClick={() => open({ kind: "activity", entry: null })} className="rounded-md px-3 py-1.5 font-semibold" style={style}>
        + Add activity
      </button>
    </>
  );
}

function EditCell({ locked, onEdit }: { locked: boolean; onEdit: () => void }) {
  if (locked) return <span style={muted}>Approved</span>;
  return (
    <button onClick={onEdit} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
      Edit
    </button>
  );
}

// ---------------------------------------------------------------------------
// Activity Timesheet
// ---------------------------------------------------------------------------

export function ActivityTimesheetPage() {
  const { ix, range } = useAnalytics();
  const { data, error, now, nameOf, approvalOf } = useTimesheets();
  const [staff, setStaff] = useState("");
  const editor = useEditor(data?.people ?? [], approvalOf);

  const activities = useMemo(
    () =>
      (data?.activities ?? [])
        .filter((a) => {
          const day = toDayKey(a.started_at);
          return day >= range.from && day <= range.to && (!staff || a.profile_id === staff);
        })
        .sort((a, b) => b.started_at.localeCompare(a.started_at)),
    [data, range, staff]
  );
  const summaries = useMemo(
    () => summariseShifts((data?.shifts ?? []).filter((s) => !staff || s.profile_id === staff), data?.activities ?? [], range, now),
    [data, range, staff, now]
  );

  if (!data) return <LoadState error={error} />;

  const minutesByType = TIMESHEET_ACTIVITY_TYPES.map((type) => ({
    type,
    minutes: activities.filter((a) => a.activity_type === type).reduce((sum, a) => sum + entryMinutes(a, now), 0),
  }));
  const unallocated = summaries.reduce((sum, s) => sum + s.unallocatedMinutes, 0);
  const byJob = new Map<string, number>();
  for (const a of activities) if (a.activity_type === "job") byJob.set(a.job_card_id ?? "", (byJob.get(a.job_card_id ?? "") ?? 0) + entryMinutes(a, now));
  const jobName = (id: string | null) => {
    const job = id ? ix.jobById.get(id) : undefined;
    return job ? `${job.number ?? "Pending"} - ${job.title}` : "Deleted job";
  };

  return (
    <>
      <PageHeading
        title="Activity timesheet"
        description="Where the time went: every job, travel, break and admin entry that started in the timeframe. Time on a job is started from the job's screen (phone or desktop); the others from the phone's Home screen or Timesheets > My Timesheet."
      />
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <StaffFilter people={data.people} value={staff} onChange={setStaff} />
        <AddButtons open={editor.open} />
      </div>
      {activities.length === 0 && unallocated === 0 ? (
        <Empty>No activity was recorded in this timeframe.</Empty>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Panel title="Hours by activity" note="'Not logged to anything' is paid shift time with no activity running.">
              <RankedBars
                format={(v) => formatMinutes(v)}
                rows={[
                  ...minutesByType.map((row) => ({ key: row.type, label: TIMESHEET_ACTIVITY_LABELS[row.type], value: row.minutes, detail: `${hours(row.minutes)} hrs` })),
                  { key: "unallocated", label: "Not logged to anything", value: unallocated, detail: `${hours(unallocated)} hrs` },
                ]}
              />
            </Panel>
            <Panel title="Hours by job">
              {byJob.size === 0 ? (
                <Empty>No job time in this timeframe.</Empty>
              ) : (
                <RankedBars
                  limit={10}
                  format={(v) => formatMinutes(v)}
                  rows={[...byJob.entries()].sort((a, b) => b[1] - a[1]).map(([id, minutes]) => ({ key: id || "deleted", label: jobName(id || null), value: minutes }))}
                />
              )}
            </Panel>
          </div>
          <Panel
            title="Every activity, newest first"
            actions={
              <ExportButton
                onClick={() =>
                  downloadCsv(
                    `activity-timesheet-${range.from}-to-${range.to}.csv`,
                    ["Staff", "Date", "Activity", "Job", "Start", "Finish", "Hours", "Entered", "Edited", "Note"],
                    activities.map((a) => [
                      nameOf(a.profile_id),
                      toDayKey(a.started_at),
                      TIMESHEET_ACTIVITY_LABELS[a.activity_type],
                      a.activity_type === "job" ? jobName(a.job_card_id) : "",
                      clock(a.started_at),
                      a.ended_at ? clock(a.ended_at) : "running",
                      minutesToHours(entryMinutes(a, now)),
                      a.source,
                      a.edited_at ? "yes" : "",
                      a.note ?? "",
                    ])
                  )
                }
              />
            }
          >
            <DataTable
              rows={activities}
              rowKey={(a) => a.id}
              columns={[
                { header: "Staff", render: (a) => nameOf(a.profile_id) },
                { header: "Date", render: (a) => formatDay(toDayKey(a.started_at)) },
                { header: "Activity", render: (a) => TIMESHEET_ACTIVITY_LABELS[a.activity_type] },
                {
                  header: "Job",
                  render: (a) =>
                    a.activity_type !== "job" ? (
                      ""
                    ) : a.job_card_id && ix.jobById.has(a.job_card_id) ? (
                      <Link to={`/jobs/${a.job_card_id}`} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                        {jobName(a.job_card_id)}
                      </Link>
                    ) : (
                      jobName(null)
                    ),
                },
                { header: "Start", render: (a) => clock(a.started_at) },
                { header: "Finish", render: (a) => (a.ended_at ? clock(a.ended_at) : <span style={{ color: "var(--jms-accent)" }}>running</span>) },
                { header: "Hours", align: "right", render: (a) => hours(entryMinutes(a, now)) },
                { header: "Notes", render: (a) => <span style={muted}>{[a.source === "manual" ? "Entered manually" : a.source === "desktop" ? "From a computer" : null, a.edited_at ? "Edited" : null, a.note].filter(Boolean).join(" · ")}</span> },
                { header: "Where", render: (a) => <LocationLinks entry={a} /> },
                { header: "", render: (a) => <EditCell locked={!!approvalOf(a.profile_id, a.started_at)} onEdit={() => editor.open({ kind: "activity", entry: a })} /> },
              ]}
            />
          </Panel>
        </>
      )}
      {editor.element}
    </>
  );
}

// ---------------------------------------------------------------------------
// All Timesheets
// ---------------------------------------------------------------------------

function shiftCsvRow(s: ShiftSummary, name: string): (string | number)[] {
  return [
    name,
    s.day,
    clock(s.shift.started_at),
    s.shift.ended_at ? clock(s.shift.ended_at) : "running",
    minutesToHours(s.breakMinutes),
    minutesToHours(s.paidMinutes),
    minutesToHours(s.minutesByType.job),
    minutesToHours(s.minutesByType.travel),
    minutesToHours(s.minutesByType.admin),
    minutesToHours(s.unallocatedMinutes),
    s.flags.map((f) => SHIFT_FLAG_LABELS[f]).join("; "),
    s.shift.note ?? "",
  ];
}

export function AllTimesheetsPage() {
  const { range } = useAnalytics();
  const { data, error, now, nameOf, approvalOf } = useTimesheets();
  const [staff, setStaff] = useState("");
  const editor = useEditor(data?.people ?? [], approvalOf);
  const summaries = useMemo(
    () => summariseShifts((data?.shifts ?? []).filter((s) => !staff || s.profile_id === staff), data?.activities ?? [], range, now),
    [data, range, staff, now]
  );
  if (!data) return <LoadState error={error} />;

  const paid = summaries.reduce((sum, s) => sum + s.paidMinutes, 0);
  const onJobs = summaries.reduce((sum, s) => sum + s.minutesByType.job, 0);
  const needsLook = summaries.filter((s) => s.flags.some((f) => f === "long" || f === "overlap" || (f === "running" && s.day !== toDayKey(now))));

  return (
    <>
      <PageHeading
        title="All timesheets"
        description="Every shift that started in the timeframe - clock on to clock off. Paid hours are the shift less its breaks. Location is one reading taken when the person tapped, where their phone allowed it."
      />
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <StaffFilter people={data.people} value={staff} onChange={setStaff} />
        <AddButtons open={editor.open} />
      </div>
      {summaries.length === 0 ? (
        <Empty>No shifts were recorded in this timeframe.</Empty>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
            <StatTile label="Paid hours" value={hours(paid)} sub={`${summaries.length} shift${summaries.length === 1 ? "" : "s"}`} />
            <StatTile label="On jobs" value={hours(onJobs)} sub={paid > 0 ? `${Math.round((onJobs / paid) * 100)}% of paid time` : undefined} />
            <StatTile label="Breaks" value={hours(summaries.reduce((sum, s) => sum + s.breakMinutes, 0))} sub="Not paid" />
            <StatTile
              label="Worth a look"
              value={String(needsLook.length)}
              sub="Over 12 hours, overlapping, or left running from an earlier day"
              tone={needsLook.length > 0 ? "danger" : undefined}
            />
          </div>
          <Panel
            actions={
              <ExportButton
                onClick={() =>
                  downloadCsv(
                    `timesheets-${range.from}-to-${range.to}.csv`,
                    ["Staff", "Date", "Clock on", "Clock off", "Break hrs", "Paid hrs", "Job hrs", "Travel hrs", "Admin hrs", "Not logged hrs", "Flags", "Note"],
                    summaries.map((s) => shiftCsvRow(s, nameOf(s.shift.profile_id)))
                  )
                }
              />
            }
          >
            <DataTable
              rows={summaries}
              rowKey={(s) => s.shift.id}
              columns={[
                { header: "Staff", render: (s) => nameOf(s.shift.profile_id) },
                { header: "Date", render: (s) => formatDay(s.day) },
                { header: "On", render: (s) => clock(s.shift.started_at) },
                { header: "Off", render: (s) => (s.shift.ended_at ? clock(s.shift.ended_at) : <span style={{ color: "var(--jms-accent)" }}>running</span>) },
                { header: "Break", align: "right", render: (s) => hours(s.breakMinutes) },
                { header: "Paid hrs", align: "right", render: (s) => <span className="font-semibold">{hours(s.paidMinutes)}</span> },
                { header: "On jobs", align: "right", render: (s) => hours(s.minutesByType.job) },
                {
                  header: "Flags",
                  render: (s) => {
                    const serious = s.flags.filter((f) => f === "long" || f === "overlap");
                    const other = s.flags.filter((f) => f !== "long" && f !== "overlap" && f !== "running");
                    return (
                      <span style={{ fontSize: "var(--jms-font-label)" }}>
                        {serious.length > 0 ? <span style={{ color: "var(--jms-danger)" }}>{serious.map((f) => SHIFT_FLAG_LABELS[f]).join(" · ")} </span> : null}
                        <span style={{ color: "var(--jms-text-muted)" }}>{other.map((f) => SHIFT_FLAG_LABELS[f]).join(" · ")}</span>
                      </span>
                    );
                  },
                },
                { header: "Where", render: (s) => <LocationLinks entry={s.shift} /> },
                { header: "", render: (s) => <EditCell locked={!!approvalOf(s.shift.profile_id, s.shift.started_at)} onEdit={() => editor.open({ kind: "shift", entry: s.shift })} /> },
              ]}
            />
          </Panel>
        </>
      )}
      {editor.element}
    </>
  );
}

// ---------------------------------------------------------------------------
// My Timesheet - your own clock, shifts and activities, for office staff
// who work at a computer rather than from the phone app.
// ---------------------------------------------------------------------------

export function MyTimesheetPage() {
  const { ix, range } = useAnalytics();
  const { profile } = useAuth();
  const { data, error, now, approvalOf } = useTimesheets();
  const me = useMemo(() => (profile ? [{ id: profile.id, full_name: profile.full_name }] : []), [profile]);
  const editor = useEditor(me, approvalOf);
  const summaries = useMemo(
    () => summariseShifts((data?.shifts ?? []).filter((s) => s.profile_id === profile?.id), data?.activities ?? [], range, now),
    [data, range, now, profile]
  );
  const activities = useMemo(
    () =>
      (data?.activities ?? [])
        .filter((a) => {
          const day = toDayKey(a.started_at);
          return a.profile_id === profile?.id && day >= range.from && day <= range.to;
        })
        .sort((a, b) => b.started_at.localeCompare(a.started_at)),
    [data, range, profile]
  );
  if (!data || !profile) return <LoadState error={error} />;

  const paid = summaries.reduce((sum, s) => sum + s.paidMinutes, 0);
  const onJobs = summaries.reduce((sum, s) => sum + s.minutesByType.job, 0);
  const thisWeek = weekStartOf(toDayKey(now));
  const thisWeekMinutes = summariseShifts(
    data.shifts.filter((s) => s.profile_id === profile.id),
    data.activities,
    { from: thisWeek, to: addDays(thisWeek, 6) },
    now
  ).reduce((sum, s) => sum + s.paidMinutes, 0);
  const jobName = (id: string | null) => {
    const job = id ? ix.jobById.get(id) : undefined;
    return job ? `${job.number ?? "Pending"} - ${job.title}` : "Deleted job";
  };
  const isLocked = (startedAt: string) => !!approvalOf(profile.id, startedAt);

  return (
    <>
      <PageHeading
        title="My timesheet"
        description="Clock on and off from the computer, and fix your own entries. Time you record on the phone shows here too - it's the same timesheet. Team-wide reports are under Timesheets on the left."
      />
      <TimesheetClock />
      <div className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatTile label="This week" value={hours(thisWeekMinutes)} sub={approvalOf(profile.id, now) ? "Approved" : "Paid hours, Mon-Sun"} />
        <StatTile label="Paid hours" value={hours(paid)} sub={`${summaries.length} shift${summaries.length === 1 ? "" : "s"} in the timeframe`} />
        <StatTile label="On jobs" value={hours(onJobs)} sub={paid > 0 ? `${Math.round((onJobs / paid) * 100)}% of paid time` : undefined} />
        <StatTile label="Breaks" value={hours(summaries.reduce((sum, s) => sum + s.breakMinutes, 0))} sub="Not paid" />
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <AddButtons open={editor.open} />
        <span style={muted}>Forgot to clock on? Add the shift with the times you worked. Approved weeks are locked.</span>
      </div>
      <Panel title="My shifts">
        {summaries.length === 0 ? (
          <Empty>No shifts in this timeframe.</Empty>
        ) : (
          <DataTable
            rows={summaries}
            rowKey={(s) => s.shift.id}
            columns={[
              { header: "Date", render: (s) => formatDay(s.day) },
              { header: "On", render: (s) => clock(s.shift.started_at) },
              { header: "Off", render: (s) => (s.shift.ended_at ? clock(s.shift.ended_at) : <span style={{ color: "var(--jms-accent)" }}>running</span>) },
              { header: "Break", align: "right", render: (s) => hours(s.breakMinutes) },
              { header: "Paid hrs", align: "right", render: (s) => <span className="font-semibold">{hours(s.paidMinutes)}</span> },
              { header: "On jobs", align: "right", render: (s) => hours(s.minutesByType.job) },
              { header: "Notes", render: (s) => <span style={muted}>{[...s.flags.filter((f) => f !== "running").map((f) => SHIFT_FLAG_LABELS[f]), s.shift.note].filter(Boolean).join(" · ")}</span> },
              { header: "", render: (s) => <EditCell locked={isLocked(s.shift.started_at)} onEdit={() => editor.open({ kind: "shift", entry: s.shift })} /> },
            ]}
          />
        )}
      </Panel>
      <Panel title="My activities">
        {activities.length === 0 ? (
          <Empty>No activities in this timeframe.</Empty>
        ) : (
          <DataTable
            rows={activities}
            rowKey={(a) => a.id}
            columns={[
              { header: "Date", render: (a) => formatDay(toDayKey(a.started_at)) },
              { header: "Activity", render: (a) => TIMESHEET_ACTIVITY_LABELS[a.activity_type] },
              {
                header: "Job",
                render: (a) =>
                  a.activity_type !== "job" ? (
                    ""
                  ) : a.job_card_id && ix.jobById.has(a.job_card_id) ? (
                    <Link to={`/jobs/${a.job_card_id}`} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                      {jobName(a.job_card_id)}
                    </Link>
                  ) : (
                    jobName(null)
                  ),
              },
              { header: "Start", render: (a) => clock(a.started_at) },
              { header: "Finish", render: (a) => (a.ended_at ? clock(a.ended_at) : <span style={{ color: "var(--jms-accent)" }}>running</span>) },
              { header: "Hours", align: "right", render: (a) => hours(entryMinutes(a, now)) },
              { header: "", render: (a) => <EditCell locked={isLocked(a.started_at)} onEdit={() => editor.open({ kind: "activity", entry: a })} /> },
            ]}
          />
        )}
      </Panel>
      {editor.element}
    </>
  );
}

// ---------------------------------------------------------------------------
// Weekly Timesheets
// ---------------------------------------------------------------------------

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const weekLabel = (weekStart: string) =>
  `${new Date(`${weekStart}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short" })} - ${formatDay(addDays(weekStart, 6))}`;

export function WeeklyTimesheetsPage() {
  const { range, today } = useAnalytics();
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const { data, error, now, nameOf, approvalOf } = useTimesheets();
  const [staff, setStaff] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const weeks = useMemo(() => wholeWeeks(range), [range]);
  const rows = useMemo(() => {
    if (!data) return [];
    const summaries = summariseShifts(data.shifts.filter((s) => !staff || s.profile_id === staff), data.activities, weeks, now);
    return weeklyRows(summaries, data.people.map((p) => p.id));
  }, [data, weeks, staff, now]);

  const setApproval = useMutation({
    mutationFn: async ({ profileId, weekStart, approve }: { profileId: string; weekStart: string; approve: boolean }) => {
      if (!profile) throw new Error("Not signed in");
      const { error } = approve
        ? await supabase.from("timesheet_week_approvals").insert({ tenant_id: profile.tenant_id, profile_id: profileId, week_start: weekStart })
        : await supabase.from("timesheet_week_approvals").delete().eq("profile_id", profileId).eq("week_start", weekStart);
      if (error) throw error;
    },
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: TIMESHEET_KEY });
    },
    onError: (e) => setActionError(getErrorMessage(e, "Failed to update the approval")),
  });

  if (!data) return <LoadState error={error} />;
  const waiting = rows.filter((r) => !approvalOf(r.profileId, `${r.weekStart}T12:00:00`) && canApproveWeek(r, today)).length;

  return (
    <>
      <PageHeading
        title="Weekly timesheets"
        description="Paid hours per person for each Monday-Sunday week touching the timeframe. Approving a week locks it: nobody can change its entries until it is reopened. A week can be approved once it has finished and nothing in it is still running."
      />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <StaffFilter people={data.people} value={staff} onChange={setStaff} />
        <span style={muted}>
          {waiting === 0 ? "Nothing waiting for approval." : `${waiting} finished week${waiting === 1 ? "" : "s"} waiting for approval.`}
        </span>
      </div>
      {actionError ? (
        <p className="mb-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          {actionError}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <Empty>No shifts were recorded in these weeks.</Empty>
      ) : (
        <Panel
          actions={
            <ExportButton
              onClick={() =>
                downloadCsv(
                  `weekly-timesheets-${weeks.from}-to-${weeks.to}.csv`,
                  ["Week starting", "Staff", ...DAY_NAMES, "Paid hrs", "Job hrs", "Break hrs", "Approved"],
                  rows.map((r) => [
                    r.weekStart,
                    nameOf(r.profileId),
                    ...r.days.map(minutesToHours),
                    minutesToHours(r.paidMinutes),
                    minutesToHours(r.jobMinutes),
                    minutesToHours(r.breakMinutes),
                    approvalOf(r.profileId, `${r.weekStart}T12:00:00`) ? "yes" : "no",
                  ])
                )
              }
            />
          }
        >
          <DataTable
            rows={rows}
            rowKey={(r) => `${r.profileId}|${r.weekStart}`}
            columns={[
              { header: "Week", render: (r) => weekLabel(r.weekStart) },
              { header: "Staff", render: (r) => nameOf(r.profileId) },
              ...DAY_NAMES.map((name, index) => ({
                header: name,
                align: "right" as const,
                render: (r: (typeof rows)[number]) => ((r.days[index] ?? 0) > 0 ? hours(r.days[index] ?? 0) : <span style={{ color: "var(--jms-text-muted)" }}>-</span>),
              })),
              { header: "Paid hrs", align: "right", render: (r) => <span className="font-semibold">{hours(r.paidMinutes)}</span> },
              {
                header: "Status",
                render: (r) => {
                  const approval = approvalOf(r.profileId, `${r.weekStart}T12:00:00`);
                  const link = { color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" };
                  if (approval) {
                    return (
                      <span className="flex items-center gap-2" style={{ fontSize: "var(--jms-font-label)" }}>
                        <span style={{ color: "var(--jms-accent)" }}>✓ Approved{approval.approved_by ? ` by ${nameOf(approval.approved_by)}` : ""}</span>
                        <button onClick={() => setApproval.mutate({ profileId: r.profileId, weekStart: r.weekStart, approve: false })} disabled={setApproval.isPending} className="font-semibold hover:underline" style={{ ...link, color: "var(--jms-text-muted)" }}>
                          Reopen
                        </button>
                      </span>
                    );
                  }
                  if (r.hasRunning) return <span style={muted}>Timer still running</span>;
                  if (!canApproveWeek(r, today)) return <span style={muted}>Week in progress</span>;
                  return (
                    <button onClick={() => setApproval.mutate({ profileId: r.profileId, weekStart: r.weekStart, approve: true })} disabled={setApproval.isPending} className="rounded-md px-3 py-1 font-semibold" style={{ ...link, border: "1px solid var(--jms-accent)" }}>
                      Approve
                    </button>
                  );
                },
              },
            ]}
          />
        </Panel>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Weekly Timesheets Graph
// ---------------------------------------------------------------------------

export function WeeklyTimesheetsGraphPage() {
  const { range } = useAnalytics();
  const { data, error, now } = useTimesheets();
  const [staff, setStaff] = useState("");
  const weeks = useMemo(() => wholeWeeks(range), [range]);
  const totals = useMemo(() => {
    if (!data) return [];
    return weekTotals(summariseShifts(data.shifts.filter((s) => !staff || s.profile_id === staff), data.activities, weeks, now), weeks);
  }, [data, weeks, staff, now]);
  if (!data) return <LoadState error={error} />;

  const paid = totals.reduce((sum, w) => sum + w.paidMinutes, 0);
  const onJobs = totals.reduce((sum, w) => sum + w.jobMinutes, 0);
  const shortLabel = (weekStart: string) => new Date(`${weekStart}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short" });

  return (
    <>
      <PageHeading
        title="Weekly timesheets graph"
        description="Paid hours for each Monday-Sunday week touching the timeframe, split into time on jobs and other paid time (travel, admin and anything not logged). Weeks are labelled by their Monday."
      />
      <div className="mb-5">
        <StaffFilter people={data.people} value={staff} onChange={setStaff} />
      </div>
      {paid === 0 ? (
        <Empty>No shifts were recorded in these weeks.</Empty>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-3 gap-4">
            <StatTile label="Paid hours" value={hours(paid)} sub={`${totals.length} week${totals.length === 1 ? "" : "s"}`} />
            <StatTile label="Average per week" value={hours(paid / totals.length)} />
            <StatTile label="On jobs" value={`${Math.round((onJobs / paid) * 100)}%`} sub={`${hours(onJobs)} of ${hours(paid)} hrs`} />
          </div>
          <Panel>
            <Columns
              series={[
                { name: "On jobs", color: ACCENT },
                { name: "Other paid time", color: CONTEXT },
              ]}
              format={(v) => `${v.toFixed(1)} hrs`}
              tick={(v) => String(v)}
              periods={totals.map((w) => ({ key: w.weekStart, label: shortLabel(w.weekStart), values: [minutesToHours(w.jobMinutes), minutesToHours(w.otherPaidMinutes)] }))}
            />
          </Panel>
          <Panel
            actions={
              <ExportButton
                onClick={() =>
                  downloadCsv(
                    `weekly-hours-${weeks.from}-to-${weeks.to}.csv`,
                    ["Week starting", "Paid hrs", "Job hrs", "Other paid hrs"],
                    totals.map((w) => [w.weekStart, minutesToHours(w.paidMinutes), minutesToHours(w.jobMinutes), minutesToHours(w.otherPaidMinutes)])
                  )
                }
              />
            }
          >
            <DataTable
              rows={totals}
              rowKey={(w) => w.weekStart}
              columns={[
                { header: "Week", render: (w) => weekLabel(w.weekStart) },
                { header: "Paid hrs", align: "right", render: (w) => hours(w.paidMinutes) },
                { header: "On jobs", align: "right", render: (w) => hours(w.jobMinutes) },
                { header: "Other paid", align: "right", render: (w) => hours(w.otherPaidMinutes) },
                { header: "On jobs %", align: "right", render: (w) => (w.paidMinutes > 0 ? `${Math.round((w.jobMinutes / w.paidMinutes) * 100)}%` : "-") },
              ]}
              footer={["Total", hours(paid), hours(onJobs), hours(paid - onJobs), paid > 0 ? `${Math.round((onJobs / paid) * 100)}%` : "-"]}
            />
          </Panel>
        </>
      )}
    </>
  );
}
