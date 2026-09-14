import { useEffect, useState } from "react";
import {
  categoryForEvent,
  describeRecurrence,
  type CalendarCategoryColors,
  type CalendarEvent,
  type CalendarEventCategory,
  type Profile,
  type RecurrenceRule,
  type Task,
} from "@jmssaas/shared";
import { FormField, SelectField, TextAreaField } from "./FormField";
import { RecurrenceScopeDialog, type RecurrenceEditScope } from "./RecurrenceScopeDialog";
import type { JobCardWithClient } from "../pages/Calendar";

// "JobNumber - Title (Client)" instead of just the title - previously an
// admin picking a job here had nothing but the free-text title to go on
// and had to remember which job that actually was.
function jobOptionLabel(job: JobCardWithClient): string {
  const client = job.clients ? job.clients.company_name || job.clients.name : null;
  return [job.number ?? "Pending", job.title].join(" - ") + (client ? ` (${client})` : "");
}

type CalendarEventRow = CalendarEvent & {
  job_cards:
    | { id: string; title: string; number: string | null; assigned_technician_id: string | null; clients: { name: string; company_name: string | null } | null }
    | null;
  tasks: { id: string; title: string } | null;
};

type OverridableCategory = Exclude<CalendarEventCategory, "personal">;

export interface CalendarEventSavePayload {
  title: string;
  description: string | null;
  location: string | null;
  guests: string | null;
  start_at: string;
  end_at: string;
  all_day: boolean;
  job_card_id: string | null;
  task_id: string | null;
  technician_id: string | null;
  recurrence_rule: RecurrenceRule | null;
  category_override: OverridableCategory | null;
}

const CATEGORY_LABELS: Record<string, string> = { job: "Job", task: "Task", personal: "Personal (Google)", general: "General" };

type RecurrenceMode = "none" | "daily" | "weekly" | "monthly" | "custom";
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function toTimeInput(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function combineDateTime(dateStr: string, timeStr: string): Date {
  return new Date(`${dateStr}T${timeStr || "00:00"}:00`);
}

// Reduces an arbitrary RecurrenceRule down to which dropdown preset (if
// any) it matches, so re-opening an event created via a preset shows that
// same preset selected rather than always falling back to "Custom".
function modeForRule(rule: RecurrenceRule | null, start: Date): RecurrenceMode {
  if (!rule) return "none";
  if (rule.endType !== "never") return "custom";
  if (rule.freq === "daily" && rule.interval === 1) return "daily";
  if (rule.freq === "weekly" && rule.interval === 1 && (!rule.byWeekday || (rule.byWeekday.length === 1 && rule.byWeekday[0] === start.getDay())))
    return "weekly";
  if (rule.freq === "monthly" && rule.interval === 1) return "monthly";
  return "custom";
}

// Google-Calendar-style edit overlay - matches the screenshot's structure
// (X/Save top bar, borderless title, date/time row, all-day, recurrence
// dropdown, details below) while adapting away controls with no real
// backing capability here (Meet, Find a time, notifications, rich-text
// description, per-guest permissions) - see the chat thread's own
// scoping discussion for why. Pure form component: it never talks to
// Supabase itself, `onSave` hands the resolved payload (+ recurrence
// scope, when editing one occurrence of a series) up to Calendar.tsx,
// which owns every actual database write and Google push call.
export function CalendarEventEditor({
  mode,
  event,
  initialDate,
  jobCards,
  tasks,
  technicians,
  categoryColors,
  onClose,
  onSave,
  onDeleteRequested,
}: {
  mode: "new" | "edit";
  event?: CalendarEventRow;
  initialDate?: Date;
  jobCards: JobCardWithClient[];
  tasks: Task[];
  technicians: Profile[];
  categoryColors: CalendarCategoryColors;
  onClose: () => void;
  onSave: (payload: CalendarEventSavePayload, scope: RecurrenceEditScope | null) => Promise<void>;
  onDeleteRequested: (event: CalendarEventRow) => void;
}) {
  const defaultStart = event ? new Date(event.start_at) : initialDate ?? new Date();
  const defaultEnd = event ? new Date(event.end_at) : new Date(defaultStart.getTime() + 60 * 60 * 1000);

  const [title, setTitle] = useState(event?.title ?? "");
  const [description, setDescription] = useState(event?.description ?? "");
  const [location, setLocation] = useState(event?.location ?? "");
  const [guests, setGuests] = useState(event?.guests ?? "");
  const [allDay, setAllDay] = useState(event?.all_day ?? false);
  const [startDate, setStartDate] = useState(toDateInput(defaultStart));
  const [startTime, setStartTime] = useState(toTimeInput(defaultStart));
  const [endDate, setEndDate] = useState(toDateInput(defaultEnd));
  const [endTime, setEndTime] = useState(toTimeInput(defaultEnd));
  const [jobCardId, setJobCardId] = useState(event?.job_card_id ?? "");
  const [taskId, setTaskId] = useState(event?.task_id ?? "");
  const [technicianId, setTechnicianId] = useState(event?.job_cards?.assigned_technician_id ?? "");
  const [categoryOverride, setCategoryOverride] = useState<OverridableCategory | "">(event?.category_override ?? "");

  const [recurrenceMode, setRecurrenceMode] = useState<RecurrenceMode>(modeForRule(event?.recurrence_rule ?? null, defaultStart));
  const [customInterval, setCustomInterval] = useState(event?.recurrence_rule?.interval ?? 1);
  const [customFreq, setCustomFreq] = useState<RecurrenceRule["freq"]>(event?.recurrence_rule?.freq ?? "weekly");
  const [customWeekdays, setCustomWeekdays] = useState<number[]>(event?.recurrence_rule?.byWeekday ?? [defaultStart.getDay()]);
  const [customEndType, setCustomEndType] = useState<RecurrenceRule["endType"]>(event?.recurrence_rule?.endType ?? "never");
  const [customEndDate, setCustomEndDate] = useState(event?.recurrence_rule?.endDate ?? "");
  const [customCount, setCustomCount] = useState(event?.recurrence_rule?.count ?? 10);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showScopeDialog, setShowScopeDialog] = useState(false);

  useEffect(() => {
    if (jobCardId) {
      const job = jobCards.find((j) => j.id === jobCardId);
      if (job?.assigned_technician_id && !technicianId) setTechnicianId(job.assigned_technician_id);
      if (job && !title) setTitle(job.title);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobCardId]);

  const start = combineDateTime(startDate, allDay ? "00:00" : startTime);
  // Reflects the live form state (including the "Event type" picker
  // below), not the original event - so the color dot updates
  // immediately as the user changes it, before Save.
  const category = categoryForEvent({
    source: "app",
    job_card_id: jobCardId || null,
    task_id: taskId || null,
    category_override: categoryOverride || null,
  });

  function buildRecurrenceRule(): RecurrenceRule | null {
    if (recurrenceMode === "none") return null;
    if (recurrenceMode === "daily") return { freq: "daily", interval: 1, endType: "never" };
    if (recurrenceMode === "weekly") return { freq: "weekly", interval: 1, byWeekday: [start.getDay()], endType: "never" };
    if (recurrenceMode === "monthly") return { freq: "monthly", interval: 1, endType: "never" };
    // custom
    return {
      freq: customFreq,
      interval: Math.max(1, customInterval),
      byWeekday: customFreq === "weekly" ? (customWeekdays.length ? customWeekdays : [start.getDay()]) : undefined,
      endType: customEndType,
      endDate: customEndType === "on" ? customEndDate : undefined,
      count: customEndType === "after" ? customCount : undefined,
    };
  }

  function buildPayload(): CalendarEventSavePayload | null {
    if (!title.trim()) {
      setError("Title is required");
      return null;
    }
    const end = combineDateTime(endDate, allDay ? "23:59" : endTime);
    if (end <= start) {
      setError("End must be after start");
      return null;
    }
    return {
      title: title.trim(),
      description: description || null,
      location: location || null,
      guests: guests || null,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      all_day: allDay,
      job_card_id: jobCardId || null,
      task_id: taskId || null,
      technician_id: technicianId || null,
      recurrence_rule: buildRecurrenceRule(),
      category_override: categoryOverride || null,
    };
  }

  async function handleSaveClick() {
    setError(null);
    const payload = buildPayload();
    if (!payload) return;

    // Editing one occurrence of an existing series is ambiguous the
    // moment recurrence_group_id is set - Google always asks which
    // events to apply the change to, even if only the title changed.
    if (mode === "edit" && event?.recurrence_group_id) {
      setShowScopeDialog(true);
      return;
    }

    setSaving(true);
    try {
      await onSave(payload, null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleScopeConfirm(scope: RecurrenceEditScope) {
    setShowScopeDialog(false);
    const payload = buildPayload();
    if (!payload) return;
    setSaving(true);
    try {
      await onSave(payload, scope);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function handleDeleteClick() {
    if (!event) return;
    onDeleteRequested(event);
  }

  const toggleCustomWeekday = (day: number) => {
    setCustomWeekdays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()));
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto py-10 px-4" onClick={onClose}>
        <div className="w-full max-w-xl rounded-xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
            <button onClick={onClose} className="text-2xl leading-none text-gray-500 hover:text-gray-900" aria-label="Close">
              &times;
            </button>
            <div className="flex items-center gap-4">
              {mode === "edit" ? (
                <button onClick={handleDeleteClick} className="text-sm font-semibold text-red-600 hover:underline">
                  Delete
                </button>
              ) : null}
              <button
                onClick={handleSaveClick}
                disabled={saving}
                className="rounded-md bg-blue-700 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>

          <div className="max-h-[75vh] overflow-y-auto px-5 py-4">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Add title"
              className="mb-4 w-full border-b border-gray-300 pb-2 text-xl font-medium text-gray-900 focus:border-blue-500 focus:outline-none"
            />

            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-gray-700">
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="rounded-md border border-gray-300 px-2 py-1.5"
              />
              {!allDay ? (
                <>
                  <input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="rounded-md border border-gray-300 px-2 py-1.5"
                  />
                  <span>to</span>
                  <input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className="rounded-md border border-gray-300 px-2 py-1.5"
                  />
                </>
              ) : (
                <span>to</span>
              )}
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="rounded-md border border-gray-300 px-2 py-1.5"
              />
            </div>

            <label className="mb-3 flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
              All day
            </label>

            <div className="mb-4">
              <select
                value={recurrenceMode}
                onChange={(e) => setRecurrenceMode(e.target.value as RecurrenceMode)}
                className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
              >
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly on {WEEKDAY_LABELS[start.getDay()]}</option>
                <option value="monthly">Monthly on day {start.getDate()}</option>
                <option value="custom">Custom...</option>
              </select>

              {recurrenceMode === "custom" ? (
                <div className="mt-3 rounded-md border border-gray-300 bg-gray-50 p-3">
                  <div className="mb-2 flex items-center gap-2 text-sm text-gray-700">
                    <span>Repeat every</span>
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={customInterval}
                      onChange={(e) => setCustomInterval(Number(e.target.value) || 1)}
                      className="w-16 rounded-md border border-gray-300 px-2 py-1"
                    />
                    <select
                      value={customFreq}
                      onChange={(e) => setCustomFreq(e.target.value as RecurrenceRule["freq"])}
                      className="rounded-md border border-gray-300 bg-white px-2 py-1"
                    >
                      <option value="daily">day(s)</option>
                      <option value="weekly">week(s)</option>
                      <option value="monthly">month(s)</option>
                    </select>
                  </div>

                  {customFreq === "weekly" ? (
                    <div className="mb-2 flex gap-1">
                      {WEEKDAY_LABELS.map((label, i) => (
                        <button
                          key={label}
                          type="button"
                          onClick={() => toggleCustomWeekday(i)}
                          className={`h-8 w-8 rounded-full text-xs font-semibold ${
                            customWeekdays.includes(i) ? "bg-blue-700 text-white" : "bg-white text-gray-600 border border-gray-300"
                          }`}
                        >
                          {label[0]}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  <div className="flex flex-col gap-1.5 text-sm text-gray-700">
                    <label className="flex items-center gap-2">
                      <input type="radio" checked={customEndType === "never"} onChange={() => setCustomEndType("never")} />
                      Never ends
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="radio" checked={customEndType === "on"} onChange={() => setCustomEndType("on")} />
                      Ends on
                      <input
                        type="date"
                        value={customEndDate}
                        onChange={(e) => setCustomEndDate(e.target.value)}
                        disabled={customEndType !== "on"}
                        className="rounded-md border border-gray-300 px-2 py-1 disabled:opacity-50"
                      />
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="radio" checked={customEndType === "after"} onChange={() => setCustomEndType("after")} />
                      Ends after
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={customCount}
                        onChange={(e) => setCustomCount(Number(e.target.value) || 1)}
                        disabled={customEndType !== "after"}
                        className="w-16 rounded-md border border-gray-300 px-2 py-1 disabled:opacity-50"
                      />
                      occurrences
                    </label>
                  </div>
                </div>
              ) : null}

              {recurrenceMode !== "none" ? (
                <p className="mt-2 text-xs text-gray-400">{describeRecurrence(buildRecurrenceRule(), start)}</p>
              ) : null}
            </div>

            <div className="mb-4 flex items-center gap-2">
              <span className="h-3 w-3 flex-shrink-0 rounded-sm" style={{ backgroundColor: categoryColors[category] }} />
              <select
                value={categoryOverride}
                onChange={(e) => setCategoryOverride(e.target.value as OverridableCategory | "")}
                className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-700"
              >
                <option value="">
                  Auto ({CATEGORY_LABELS[categoryForEvent({ source: "app", job_card_id: jobCardId || null, task_id: taskId || null, category_override: null })]})
                </option>
                <option value="job">Job</option>
                <option value="task">Task</option>
                <option value="general">General</option>
              </select>
            </div>

            <FormField label="Location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Add location" />
            <TextAreaField
              label="Description"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add description or notes"
            />
            <FormField
              label="Guests"
              value={guests}
              onChange={(e) => setGuests(e.target.value)}
              placeholder="email@example.com, another@example.com"
            />

            <SelectField
              label="Linked job"
              value={jobCardId}
              onChange={setJobCardId}
              options={jobCards.map((j) => ({ value: j.id, label: jobOptionLabel(j) }))}
            />
            {jobCardId ? (
              <SelectField
                label="Technician"
                value={technicianId}
                onChange={setTechnicianId}
                options={technicians.map((t) => ({ value: t.id, label: t.full_name }))}
                placeholder="Unassigned"
              />
            ) : null}
            <SelectField
              label="Linked task"
              value={taskId}
              onChange={setTaskId}
              options={tasks.map((t) => ({ value: t.id, label: t.title }))}
            />

            {error ? <p className="mb-2 text-sm text-red-600">{error}</p> : null}
          </div>
        </div>
      </div>

      {showScopeDialog ? (
        <RecurrenceScopeDialog action="save" onConfirm={handleScopeConfirm} onCancel={() => setShowScopeDialog(false)} />
      ) : null}
    </>
  );
}
