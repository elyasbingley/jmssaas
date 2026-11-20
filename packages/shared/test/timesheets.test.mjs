// Run with `pnpm --filter @jmssaas/shared test` (TZ=Australia/Sydney).
import test from "node:test";
import assert from "node:assert/strict";
import * as t from "../src/timesheets.ts";

const NOW = "2026-11-16T05:00:00+00:00"; // Mon 16 Nov 2026, 4pm Sydney
// Sydney-local wall time on a November (UTC+11) date -> ISO
const at = (day, time) => new Date(`${day}T${time}:00+11:00`).toISOString();
const base = { tenant_id: "t", profile_id: "p1", start_latitude: -33.9, start_longitude: 151.2, start_accuracy_m: 10, end_latitude: null, end_longitude: null, end_accuracy_m: null, source: "timer", note: null, edited_at: null, edited_by: null, created_at: NOW, updated_at: NOW };
let n = 0;
const shift = (day, on, off, over = {}) => ({ ...base, id: `s${++n}`, started_at: at(day, on), ended_at: off ? at(day, off) : null, ...over });
const act = (type, day, on, off, over = {}) => ({ ...base, id: `a${++n}`, activity_type: type, job_card_id: type === "job" ? "j1" : null, started_at: at(day, on), ended_at: off ? at(day, off) : null, ...over });

test("durations clamp at zero and format", () => {
  assert.equal(t.entryMinutes({ started_at: at("2026-11-10", "07:00"), ended_at: at("2026-11-10", "15:30") }, NOW), 510);
  assert.equal(t.entryMinutes({ started_at: at("2026-11-10", "15:00"), ended_at: at("2026-11-10", "07:00") }, NOW), 0);
  assert.equal(t.entryMinutes({ started_at: at("2026-11-16", "15:00"), ended_at: null }, NOW), 60);
  assert.equal(t.formatMinutes(510), "8h 30m");
  assert.equal(t.formatMinutes(45), "45m");
  assert.equal(t.formatMinutes(480), "8h");
  assert.equal(t.formatMinutes(125), "2h 05m");
  assert.equal(t.minutesToHours(455), 7.58);
});

test("week starts on Monday", () => {
  assert.equal(t.weekStartOf("2026-11-16"), "2026-11-16"); // Monday
  assert.equal(t.weekStartOf("2026-11-22"), "2026-11-16"); // Sunday
  assert.equal(t.weekStartOf("2026-11-15"), "2026-11-09"); // previous Sunday
  assert.equal(t.weekStartOf("2027-01-01"), "2026-12-28"); // across a year
  assert.deepEqual(t.weeksInRange({ from: "2026-11-04", to: "2026-11-16" }), ["2026-11-02", "2026-11-09", "2026-11-16"]);
});

test("paid time is the shift minus breaks; unlogged time is unallocated", () => {
  const s = shift("2026-11-10", "07:00", "15:30");
  const activities = [
    act("travel", "2026-11-10", "07:00", "07:30"),
    act("job", "2026-11-10", "07:30", "12:00"),
    act("break", "2026-11-10", "12:00", "12:30"),
    act("job", "2026-11-10", "12:30", "15:00"),
    act("job", "2026-11-10", "08:00", "09:00", { profile_id: "someone-else" }),
    act("admin", "2026-11-11", "08:00", "09:00"),
  ];
  const r = t.summariseShift(s, activities, [s], NOW);
  assert.equal(r.totalMinutes, 510);
  assert.equal(r.breakMinutes, 30);
  assert.equal(r.paidMinutes, 480);
  assert.deepEqual(r.minutesByType, { job: 420, travel: 30, break: 30, admin: 0 });
  assert.equal(r.unallocatedMinutes, 30);
  assert.equal(r.activities.length, 4);
  assert.deepEqual(r.flags, []);
  assert.equal(r.day, "2026-11-10");
});

test("an activity running past clock-off only counts up to clock-off", () => {
  const s = shift("2026-11-10", "07:00", "15:00");
  const r = t.summariseShift(s, [act("job", "2026-11-10", "14:00", "17:00"), act("break", "2026-11-10", "06:00", "07:15")], [s], NOW);
  assert.equal(r.minutesByType.job, 60);
  assert.equal(r.breakMinutes, 15);
  assert.equal(r.paidMinutes, 465);
});

test("flags: running, long, edited, manual, no location, overlap", () => {
  const running = shift("2026-11-16", "07:00", null);
  assert.deepEqual(t.summariseShift(running, [], [running], NOW).flags, ["running"]);
  assert.equal(t.summariseShift(running, [], [running], NOW).totalMinutes, 540);

  const leftOn = shift("2026-11-14", "07:00", null);
  assert.deepEqual(t.summariseShift(leftOn, [], [leftOn], NOW).flags, ["running", "long"]);

  const manual = shift("2026-11-10", "07:00", "15:00", { source: "manual", start_latitude: null, edited_at: NOW });
  assert.deepEqual(t.summariseShift(manual, [], [manual], NOW).flags, ["edited", "manual"]);

  const noGps = shift("2026-11-10", "07:00", "15:00", { start_latitude: null });
  assert.deepEqual(t.summariseShift(noGps, [], [noGps], NOW).flags, ["no_location"]);

  const a = shift("2026-11-11", "07:00", "12:00");
  const b = shift("2026-11-11", "11:00", "15:00");
  const other = shift("2026-11-11", "08:00", "09:00", { profile_id: "p2" });
  assert.deepEqual(t.summariseShift(a, [], [a, b, other], NOW).flags, ["overlap"]);
  assert.deepEqual(t.summariseShift(other, [], [a, b, other], NOW).flags, []);
  const adjacent = shift("2026-11-11", "15:00", "16:00");
  assert.deepEqual(t.summariseShift(adjacent, [], [a, b, adjacent], NOW).flags, []);
});

test("shifts are picked by the local day they started on", () => {
  // 30 Nov 23:30 UTC is 1 Dec 10:30 in Sydney.
  const s = { ...shift("2026-12-01", "10:30", "12:00") };
  assert.equal(s.started_at.slice(0, 10), "2026-11-30");
  assert.equal(t.summariseShifts([s], [], { from: "2026-12-01", to: "2026-12-31" }, NOW).length, 1);
  assert.equal(t.summariseShifts([s], [], { from: "2026-11-01", to: "2026-11-30" }, NOW).length, 0);
});

test("weekly rows: daily paid hours, Monday first, per person per week", () => {
  const shifts = [
    shift("2026-11-09", "07:00", "15:00"),
    shift("2026-11-09", "16:00", "17:00"),
    shift("2026-11-11", "07:00", "15:30"),
    shift("2026-11-15", "08:00", "10:00"),
    shift("2026-11-16", "07:00", null),
    shift("2026-11-10", "07:00", "11:00", { profile_id: "p2" }),
  ];
  const activities = [act("break", "2026-11-11", "12:00", "12:30"), act("job", "2026-11-09", "07:00", "13:00")];
  const rows = t.weeklyRows(t.summariseShifts(shifts, activities, { from: "2026-11-01", to: "2026-11-30" }, NOW), ["p2", "p1"]);
  assert.deepEqual(rows.map((r) => [r.weekStart, r.profileId, r.days, r.paidMinutes, r.jobMinutes, r.hasRunning]), [
    ["2026-11-16", "p1", [540, 0, 0, 0, 0, 0, 0], 540, 0, true],
    ["2026-11-09", "p2", [0, 240, 0, 0, 0, 0, 0], 240, 0, false],
    ["2026-11-09", "p1", [540, 0, 480, 0, 0, 0, 120], 1140, 360, false],
  ]);
  assert.equal(t.canApproveWeek(rows[2], "2026-11-16"), true);
  assert.equal(t.canApproveWeek(rows[2], "2026-11-15"), false);
  assert.equal(t.canApproveWeek(rows[0], "2026-11-30"), false);
});

test("week totals include empty weeks and split job from other paid time", () => {
  const shifts = [shift("2026-11-03", "07:00", "15:00"), shift("2026-11-16", "07:00", "09:00")];
  const activities = [act("job", "2026-11-03", "08:00", "12:00"), act("break", "2026-11-03", "12:00", "13:00")];
  const range = { from: "2026-11-02", to: "2026-11-16" };
  assert.deepEqual(t.weekTotals(t.summariseShifts(shifts, activities, range, NOW), range), [
    { weekStart: "2026-11-02", paidMinutes: 420, jobMinutes: 240, otherPaidMinutes: 180 },
    { weekStart: "2026-11-09", paidMinutes: 0, jobMinutes: 0, otherPaidMinutes: 0 },
    { weekStart: "2026-11-16", paidMinutes: 120, jobMinutes: 0, otherPaidMinutes: 120 },
  ]);
});

test("job actuals cost each person at their own rate, others at the fallback", () => {
  const activities = [
    act("job", "2026-11-10", "07:00", "09:00"),
    act("job", "2026-11-10", "07:00", "08:30", { profile_id: "p2" }),
    act("job", "2026-11-11", "07:00", "08:00", { job_card_id: "j2" }),
    act("travel", "2026-11-10", "09:00", "10:00"),
    act("job", "2026-11-10", "10:00", "11:00", { job_card_id: null }),
  ];
  const actuals = t.jobActuals(activities, new Map([["p1", 6000]]), 4000, NOW);
  assert.equal(actuals.size, 2);
  assert.equal(actuals.get("j1").minutes, 210);
  assert.equal(actuals.get("j1").costCents, 2 * 6000 + 1.5 * 4000);
  assert.deepEqual([...actuals.get("j1").minutesByProfile], [["p1", 120], ["p2", 90]]);
  assert.equal(actuals.get("j2").costCents, 6000);
});

test("timer buttons", () => {
  const off = { openShifts: [], openActivities: [] };
  const on = { openShifts: [{ id: "s1", started_at: NOW }], openActivities: [] };
  const onJob = { openShifts: [{ id: "s1", started_at: NOW }], openActivities: [{ id: "a1", started_at: NOW, activity_type: "job", job_card_id: "j1" }] };

  assert.deepEqual(t.timerWrites(off, { kind: "clock_on" }), [{ kind: "open_shift" }]);
  assert.deepEqual(t.timerWrites(on, { kind: "clock_on" }), []);
  // starting a job while clocked off clocks on first
  assert.deepEqual(t.timerWrites(off, { kind: "start", activityType: "job", jobCardId: "j1" }), [
    { kind: "open_shift" },
    { kind: "open_activity", activityType: "job", jobCardId: "j1" },
  ]);
  // switching ends the previous activity
  assert.deepEqual(t.timerWrites(onJob, { kind: "start", activityType: "break" }), [
    { kind: "close_activity", id: "a1" },
    { kind: "open_activity", activityType: "break", jobCardId: null },
  ]);
  assert.deepEqual(t.timerWrites(onJob, { kind: "start", activityType: "job", jobCardId: "j2" }), [
    { kind: "close_activity", id: "a1" },
    { kind: "open_activity", activityType: "job", jobCardId: "j2" },
  ]);
  // tapping the thing already running does nothing
  assert.deepEqual(t.timerWrites(onJob, { kind: "start", activityType: "job", jobCardId: "j1" }), []);
  // a job id is ignored for non-job activities
  assert.deepEqual(t.timerWrites(on, { kind: "start", activityType: "travel", jobCardId: "j1" }), [{ kind: "open_activity", activityType: "travel", jobCardId: null }]);
  assert.deepEqual(t.timerWrites(onJob, { kind: "stop_activity" }), [{ kind: "close_activity", id: "a1" }]);
  assert.deepEqual(t.timerWrites(onJob, { kind: "clock_off" }), [{ kind: "close_activity", id: "a1" }, { kind: "close_shift", id: "s1" }]);
  assert.deepEqual(t.timerWrites(off, { kind: "clock_off" }), []);
  // strays from a second phone are all closed
  const messy = { openShifts: [{ id: "s1", started_at: NOW }, { id: "s2", started_at: NOW }], openActivities: [{ id: "a1", started_at: NOW, activity_type: "job", job_card_id: "j1" }, { id: "a2", started_at: NOW, activity_type: "travel", job_card_id: null }] };
  assert.deepEqual(t.timerWrites(messy, { kind: "clock_off" }).map((w) => w.id), ["a1", "a2", "s1", "s2"]);
});

test("a shift clocked on from a computer is labelled, not flagged for missing location", async () => {
  const t = await import("../src/timesheets.ts");
  const shift = { id: "d1", tenant_id: "t", profile_id: "p", started_at: "2026-11-17T08:00:00+11:00", ended_at: "2026-11-17T12:00:00+11:00", source: "desktop", start_latitude: null, start_longitude: null, end_latitude: null, end_longitude: null, edited_at: null, note: null };
  const flags = t.summariseShift(shift, [], [shift], "2026-11-17T13:00:00+11:00").flags;
  assert.ok(flags.includes("desktop"));
  assert.ok(!flags.includes("no_location"));
});
