import { useEffect, useRef } from "react";
import { Alert } from "react-native";
import { usePowerSync, useQuery } from "@powersync/react";
import { useAuth } from "../lib/auth-context";

interface RejectedUploadRow {
  id: string;
  table_name: string;
  op: string;
  data: string | null;
  error_code: string | null;
  error_message: string | null;
}

const MAX_LINES = 5;
const PREVIEW_LENGTH = 80;

// Singular, technician-facing names for the tables a phone actually writes
// to. Anything not listed falls back to the raw table name, which is ugly
// but still tells an office admin what to look for.
const TABLE_LABELS: Record<string, string> = {
  clients: "Client",
  client_sites: "Client site",
  job_cards: "Job card",
  job_notes: "Job note",
  job_files: "Job photo",
  job_measurements: "Job measurement",
  tasks: "Task",
  task_notes: "Task note",
  task_files: "Task photo",
};

const OP_LABELS: Record<string, string> = { PUT: "added", PATCH: "edited", DELETE: "deleted" };

// The first recognisable bit of text in the discarded write, so the user can
// tell which note/task this was and re-enter it.
const PREVIEW_COLUMNS = ["body", "title", "name", "label", "description", "file_name"];

function preview(data: string | null): string {
  if (!data) return "";
  try {
    const values = JSON.parse(data) as Record<string, unknown>;
    for (const column of PREVIEW_COLUMNS) {
      const value = values[column];
      if (typeof value === "string" && value.trim().length > 0) {
        const text = value.trim();
        return `: "${text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}...` : text}"`;
      }
    }
  } catch {
    // Not valid JSON - show the line without a preview.
  }
  return "";
}

function reason(row: RejectedUploadRow): string {
  switch (row.error_code) {
    case "23503":
      return "the record it belongs to no longer exists (it may have been deleted)";
    case "23505":
      return "it clashes with a record that already exists";
    case "42501":
      return "your account is no longer allowed to make this change";
    case null:
      return "it was saved together with a change the server refused";
    default:
      return `the server refused it (${row.error_message ?? row.error_code})`;
  }
}

function describe(row: RejectedUploadRow): string {
  const table = TABLE_LABELS[row.table_name] ?? row.table_name;
  const op = OP_LABELS[row.op] ?? row.op;
  return `- ${table} ${op}${preview(row.data)} - ${reason(row)}.`;
}

// Tells the user when the upload connector had to discard a change the
// server will never accept (see uploadData in lib/connector.ts). Without
// this the change just vanishes from the device at the next sync with no
// explanation. Renders nothing itself - it raises a native alert, which
// shows over whatever screen or modal is open, and the rows stay
// unacknowledged in the local `rejected_uploads` table until OK is tapped,
// so a notice raised while the app was closed or backgrounded appears the
// next time it is opened.
export function RejectedUploadsNotice() {
  const { session } = useAuth();
  const powersync = usePowerSync();
  // The local database outlives a sign-out, so only show a user their own.
  const { data: rows } = useQuery<RejectedUploadRow>(
    `SELECT id, table_name, op, data, error_code, error_message
       FROM rejected_uploads
      WHERE user_id = ? AND acknowledged_at IS NULL
      ORDER BY created_at, id`,
    [session?.user.id ?? ""]
  );
  const alertOpen = useRef(false);

  useEffect(() => {
    if (rows.length === 0 || alertOpen.current) return;
    alertOpen.current = true;

    const lines = rows.slice(0, MAX_LINES).map(describe);
    if (rows.length > MAX_LINES) lines.push(`...and ${rows.length - MAX_LINES} more.`);
    const ids = rows.map((row) => row.id);

    Alert.alert(
      rows.length === 1 ? "A change could not be saved" : `${rows.length} changes could not be saved`,
      `The server refused ${rows.length === 1 ? "this change" : "these changes"} made on this device, so ${
        rows.length === 1 ? "it has" : "they have"
      } been removed and will not sync. Re-enter anything that is still needed.\n\n${lines.join("\n")}`,
      [
        {
          text: "OK",
          onPress: () => {
            // Rows arriving while the alert was up are picked up when this
            // update re-runs the query above.
            alertOpen.current = false;
            powersync
              .execute(
                `UPDATE rejected_uploads SET acknowledged_at = ? WHERE id IN (${ids.map(() => "?").join(", ")})`,
                [new Date().toISOString(), ...ids]
              )
              .catch((error) => console.error("[PowerSync] could not acknowledge rejected uploads", error));
          },
        },
      ],
      { cancelable: false }
    );
  }, [rows, powersync]);

  return null;
}
