import { useEffect, useRef } from "react";
import { Alert } from "react-native";
import { usePowerSync, useQuery } from "@powersync/react";
import { useAuth } from "../lib/auth-context";
import { REJECTED_FILE_UPLOAD_OP } from "../lib/attachment-errors";

interface RejectedUploadRow {
  id: string;
  table_name: string;
  op: string;
  row_id: string;
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

const OP_LABELS: Record<string, string> = {
  PUT: "added",
  PATCH: "edited",
  DELETE: "deleted",
  // The row may have synced fine - this is the photo file itself, refused by
  // Supabase Storage (see lib/attachment-errors.ts).
  [REJECTED_FILE_UPLOAD_OP]: "not uploaded",
};

// The first recognisable bit of text in the discarded write, so the user can
// tell which note/task this was and re-enter it.
const PREVIEW_COLUMNS = ["body", "title", "name", "label", "description", "file_name"];

// A photo's file name is a UUID, which tells the user nothing - say when it
// was taken and what it was attached to instead.
function photoPreview(values: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof values.taken_at === "string") {
    const takenAt = new Date(values.taken_at);
    if (!Number.isNaN(takenAt.getTime())) {
      parts.push(
        `taken ${takenAt.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`
      );
    }
  }
  if (typeof values.parent === "string" && values.parent.length > 0) parts.push(`for "${values.parent}"`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function preview(row: RejectedUploadRow): string {
  if (!row.data) return "";
  try {
    const values = JSON.parse(row.data) as Record<string, unknown>;
    if (row.op === REJECTED_FILE_UPLOAD_OP) return photoPreview(values);
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

// error_code here is Supabase Storage's status code, not a Postgres SQLSTATE.
function photoReason(row: RejectedUploadRow): string {
  switch (row.error_code) {
    case "403":
      return "the job or task it belongs to no longer exists, or your account is no longer allowed to add photos to it";
    case "413":
      return "the file is too large";
    case "415":
      return "this type of file is not allowed";
    default:
      return `the server refused it (${row.error_message ?? row.error_code})`;
  }
}

function reason(row: RejectedUploadRow): string {
  if (row.op === REJECTED_FILE_UPLOAD_OP) return `${photoReason(row)}. Nobody else can see this photo`;
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
  return `- ${table} ${op}${preview(row)} - ${reason(row)}.`;
}

// Tells the user when the upload connector had to discard a change the
// server will never accept (see uploadData in lib/connector.ts), or when
// Supabase Storage permanently refused a photo's file (see
// lib/attachment-errors.ts). Without this the change just vanishes from the
// device at the next sync with no explanation, and a refused photo keeps
// showing on this device while nobody else ever receives it. Renders nothing itself - it raises a native alert, which
// shows over whatever screen or modal is open, and the rows stay
// unacknowledged in the local `rejected_uploads` table until OK is tapped,
// so a notice raised while the app was closed or backgrounded appears the
// next time it is opened.
export function RejectedUploadsNotice() {
  const { session } = useAuth();
  const powersync = usePowerSync();
  // The local database outlives a sign-out, so only show a user their own.
  const { data: rows } = useQuery<RejectedUploadRow>(
    `SELECT id, table_name, op, row_id, data, error_code, error_message
       FROM rejected_uploads
      WHERE user_id = ? AND acknowledged_at IS NULL
      ORDER BY created_at, id`,
    [session?.user.id ?? ""]
  );
  const alertOpen = useRef(false);

  useEffect(() => {
    if (rows.length === 0 || alertOpen.current) return;
    alertOpen.current = true;

    // A photo is two uploads - its job_files/task_files row and its file -
    // and when the job it was for has been deleted both are refused. One
    // line per lost photo: the row's, which says why. (The row usually fails
    // first, and the file's refusal is then saved already acknowledged, so
    // this only matters when both are waiting at once.)
    const rejectedRowIds = new Set(rows.filter((row) => row.op !== REJECTED_FILE_UPLOAD_OP).map((row) => row.row_id));
    const shown = rows.filter((row) => row.op !== REJECTED_FILE_UPLOAD_OP || !rejectedRowIds.has(row.row_id));

    const lines = shown.slice(0, MAX_LINES).map(describe);
    if (shown.length > MAX_LINES) lines.push(`...and ${shown.length - MAX_LINES} more.`);
    const ids = rows.map((row) => row.id);

    // A refused photo file is not removed the way a discarded write is: its
    // row may have synced and it can still show on this device for a while.
    const onlyPhotoFiles = shown.every((row) => row.op === REJECTED_FILE_UPLOAD_OP);
    const one = shown.length === 1;
    const intro = onlyPhotoFiles
      ? `The server refused ${one ? "this photo" : "these photos"} taken on this device, so ${
          one ? "it" : "they"
        } will not sync. Take ${one ? "it" : "them"} again if still needed.`
      : `The server refused ${one ? "this change" : "these changes"} made on this device, so ${
          one ? "it has" : "they have"
        } been removed and will not sync. Re-enter anything that is still needed.`;

    Alert.alert(
      onlyPhotoFiles
        ? one
          ? "A photo could not be uploaded"
          : `${shown.length} photos could not be uploaded`
        : one
          ? "A change could not be saved"
          : `${shown.length} changes could not be saved`,
      `${intro}\n\n${lines.join("\n")}`,
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
