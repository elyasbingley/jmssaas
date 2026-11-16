import { useCallback, useEffect, useState } from "react";
import * as Location from "expo-location";
import { v4 as uuidv4 } from "uuid";
import { usePowerSync, useQuery } from "@powersync/react";
import { timerWrites, type TimerAction, type TimesheetActivity, type TimesheetShift } from "@jmssaas/shared";
import { useAuth } from "./auth-context";

// The timer buttons (Home card, Job Card): clock on/off, start/stop an
// activity. Everything is written to local SQLite through PowerSync, so a
// tap works with no signal and uploads whenever the phone next has one.
// What each button has to write comes from @jmssaas/shared's timerWrites
// (unit tested there) - this file only turns those into SQL.
//
// Location is one reading per tap, never tracked in between. The tap is
// written first with the time it was made; the reading is added to the
// same rows afterwards when the phone gets a fix, because a GPS fix can
// take several seconds (or never arrive indoors, or be refused) and the
// recorded time must not wait for it.

type Fix = { latitude: number; longitude: number; accuracy: number | null };

async function readLocation(): Promise<Fix | null> {
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return null;
    const position = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20000)),
    ]);
    if (!position) return null;
    return { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy };
  } catch {
    return null;
  }
}

// Re-renders on an interval so running durations tick over.
export function useNow(intervalMs = 30000): string {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date().toISOString()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useTimesheet() {
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const profileId = profile?.id ?? "";
  const { data: openShifts } = useQuery<TimesheetShift>(
    "SELECT * FROM timesheet_shifts WHERE profile_id = ? AND ended_at IS NULL ORDER BY started_at",
    [profileId]
  );
  const { data: openActivities } = useQuery<TimesheetActivity>(
    "SELECT * FROM timesheet_activities WHERE profile_id = ? AND ended_at IS NULL ORDER BY started_at",
    [profileId]
  );
  const [busy, setBusy] = useState(false);

  const perform = useCallback(
    async (action: TimerAction) => {
      if (!profile) return;
      const writes = timerWrites({ openShifts, openActivities }, action);
      if (writes.length === 0) return;
      setBusy(true);
      const at = new Date().toISOString();
      const started: { table: string; id: string }[] = [];
      const ended: { table: string; id: string }[] = [];
      try {
        await powersync.writeTransaction(async (tx) => {
          for (const write of writes) {
            switch (write.kind) {
              case "open_shift": {
                const id = uuidv4();
                await tx.execute(
                  "INSERT INTO timesheet_shifts (id, tenant_id, profile_id, started_at, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'timer', ?, ?)",
                  [id, profile.tenant_id, profile.id, at, at, at]
                );
                started.push({ table: "timesheet_shifts", id });
                break;
              }
              case "open_activity": {
                const id = uuidv4();
                await tx.execute(
                  "INSERT INTO timesheet_activities (id, tenant_id, profile_id, activity_type, job_card_id, started_at, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'timer', ?, ?)",
                  [id, profile.tenant_id, profile.id, write.activityType, write.jobCardId, at, at, at]
                );
                started.push({ table: "timesheet_activities", id });
                break;
              }
              case "close_shift":
                await tx.execute("UPDATE timesheet_shifts SET ended_at = ?, updated_at = ? WHERE id = ?", [at, at, write.id]);
                ended.push({ table: "timesheet_shifts", id: write.id });
                break;
              case "close_activity":
                await tx.execute("UPDATE timesheet_activities SET ended_at = ?, updated_at = ? WHERE id = ?", [at, at, write.id]);
                ended.push({ table: "timesheet_activities", id: write.id });
                break;
            }
          }
        });
      } finally {
        setBusy(false);
      }

      // Not awaited by the caller's UI - see the note at the top.
      void readLocation().then(async (fix) => {
        if (!fix) return;
        for (const row of started) {
          await powersync.execute(`UPDATE ${row.table} SET start_latitude = ?, start_longitude = ?, start_accuracy_m = ? WHERE id = ?`, [
            fix.latitude,
            fix.longitude,
            fix.accuracy,
            row.id,
          ]);
        }
        for (const row of ended) {
          await powersync.execute(`UPDATE ${row.table} SET end_latitude = ?, end_longitude = ?, end_accuracy_m = ? WHERE id = ?`, [
            fix.latitude,
            fix.longitude,
            fix.accuracy,
            row.id,
          ]);
        }
      });
    },
    [powersync, profile, openShifts, openActivities]
  );

  return {
    // The earliest still-open entry of each kind (there is normally only one).
    shift: openShifts[0] ?? null,
    activity: openActivities[0] ?? null,
    busy,
    perform,
  };
}
