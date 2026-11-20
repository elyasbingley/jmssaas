import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { TIMESHEET_ACTIVITY_LABELS, entryMinutes, formatMinutes, type TimesheetActivityType } from "@jmssaas/shared";
import { useTimesheetTimer } from "../lib/use-timesheet-timer";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { ThemedButton } from "./theme/ThemedButton";

// Clock on/off and what you're doing now, from the desktop - the same as
// the phone's Timesheet card. Shown on Timesheets > My Timesheet.

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date().toISOString()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" };
const NON_JOB: TimesheetActivityType[] = ["travel", "break", "admin"];

export function TimesheetClock() {
  const { shift, activity, busy, error, perform, loading } = useTimesheetTimer();
  const now = useNow();
  const { data: job } = useQuery({
    queryKey: ["job-label", activity?.job_card_id],
    enabled: !!activity?.job_card_id,
    queryFn: async () => {
      const { data } = await supabase.from("job_cards").select("id, number, title").eq("id", activity!.job_card_id!).single();
      return data as { id: string; number: string | null; title: string } | null;
    },
  });

  if (loading) return null;

  return (
    <div className="mb-5 rounded-lg p-4" style={{ border: `1px solid ${shift ? "var(--jms-accent)" : "var(--jms-border)"}`, backgroundColor: "var(--jms-surface)" }} data-testid="timesheet-clock">
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1">
          <p className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
            My time
          </p>
          {shift ? (
            <p style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
              Clocked on at {clock(shift.started_at)} · <span className="font-semibold">{formatMinutes(entryMinutes(shift, now))}</span>
              {activity ? (
                <>
                  {" "}
                  · Now: <span className="font-semibold">{TIMESHEET_ACTIVITY_LABELS[activity.activity_type]}</span>
                  {activity.activity_type === "job" && job ? (
                    <>
                      {" "}
                      <Link to={`/jobs/${job.id}`} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                        {job.number ?? ""} {job.title}
                      </Link>
                    </>
                  ) : null}{" "}
                  ({formatMinutes(entryMinutes(activity, now))})
                </>
              ) : (
                <span style={muted}> · nothing started - pick what you're doing below, or start a job's timer from its page</span>
              )}
            </p>
          ) : (
            <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Not clocked on.</p>
          )}
        </div>
        {shift ? (
          <ThemedButton variant="danger" onClick={() => perform({ kind: "clock_off" })} disabled={busy}>
            Clock off
          </ThemedButton>
        ) : (
          <ThemedButton onClick={() => perform({ kind: "clock_on" })} disabled={busy}>
            Clock on
          </ThemedButton>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {NON_JOB.map((type) => {
          const running = activity?.activity_type === type;
          return (
            <button
              key={type}
              onClick={() => perform(running ? { kind: "stop_activity" } : { kind: "start", activityType: type })}
              disabled={busy}
              className="rounded-full border px-3 py-1.5 font-semibold disabled:opacity-50"
              style={
                running
                  ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }
                  : { borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }
              }
            >
              {running ? `Stop ${TIMESHEET_ACTIVITY_LABELS[type]}` : TIMESHEET_ACTIVITY_LABELS[type]}
            </button>
          );
        })}
        {activity?.activity_type === "job" ? (
          <button
            onClick={() => perform({ kind: "stop_activity" })}
            disabled={busy}
            className="rounded-full border px-3 py-1.5 font-semibold"
            style={{ backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
          >
            Stop job timer
          </button>
        ) : null}
        <span style={muted}>Starting one ends the last, and clocks you on if you aren't. Computers don't record a location.</span>
      </div>
      {error ? <p className="mt-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{getErrorMessage(error, "Couldn't update your timesheet")}</p> : null}
    </div>
  );
}

// The job page's button: start/stop time on this job. Styled like the
// header's other buttons (Email, SMS).
export function JobTimerButton({ jobCardId }: { jobCardId: string }) {
  const { activity, busy, error, perform, loading } = useTimesheetTimer();
  const now = useNow();
  if (loading) return null;
  const onThisJob = activity?.activity_type === "job" && activity.job_card_id === jobCardId;
  return (
    <button
      onClick={() => perform(onThisJob ? { kind: "stop_activity" } : { kind: "start", activityType: "job", jobCardId })}
      disabled={busy}
      title={
        error
          ? getErrorMessage(error, "Couldn't update your timesheet")
          : onThisJob
            ? "Stops your timer. You stay clocked on - clock off from Timesheets."
            : "Logs your time to this job on your timesheet. Clocks you on if you aren't, and ends whatever you were doing."
      }
      className="rounded px-3 py-1.5 font-semibold disabled:opacity-50"
      style={
        onThisJob
          ? { border: "1px solid var(--jms-accent)", backgroundColor: "var(--jms-accent-glow)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }
          : { border: `1px solid ${error ? "var(--jms-danger)" : "var(--jms-border)"}`, color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }
      }
      data-testid="job-timer"
    >
      {onThisJob ? `■ Stop timer · ${formatMinutes(entryMinutes(activity!, now))}` : activity ? "▶ Switch timer here" : "▶ Start timer"}
    </button>
  );
}
