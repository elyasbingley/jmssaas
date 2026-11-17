import type {
  AbstractPowerSyncDatabase,
  AttachmentErrorHandler,
  AttachmentQueueOptions,
  AttachmentRecord,
} from "@powersync/common";

// Decides what PowerSync's attachment queue does when a photo upload or
// download fails. Without an error handler the queue treats every failure
// as retryable (see uploadAttachment in @powersync/common's
// lib/attachments/SyncingService.js), so an upload Supabase Storage will
// never accept was re-sent every sync interval (30 s) for as long as the
// app was installed, and the technician was never told the photo had not
// reached the office. This is the file-upload counterpart of the
// permanent-rejection handling in uploadData (lib/connector.ts).
//
// Deliberately free of React Native / Expo imports so it can be run in Node.

// How Supabase Storage reports a failure, as read from the storage server
// source (supabase/storage: internal/errors/storage-error.ts,
// http/error-handler.ts, storage/database/errors.ts) and from
// @supabase/storage-js 2.110.7 (src/lib/common/fetch.ts):
//
// - The server answers every error that is not a 500 with HTTP **400**, and
//   puts the real status in the JSON body's `statusCode` ("403", "404",
//   "413", "503", ...). storage-js surfaces that as `error.statusCode` (a
//   string) and the HTTP status as `error.status` (a number). So `status`
//   says almost nothing - a database-in-read-only-mode 503 and a
//   row-level-security denial both arrive as status 400 - and the body's
//   `statusCode` is what has to be read.
// - An upload refused by the bucket's RLS policies is statusCode "403",
//   message "new row violates row-level security policy".
// - An expired or otherwise unverifiable token is ALSO statusCode "403"
//   (the server raises the same AccessDenied error, with the JWT library's
//   message), so "403" alone must not be treated as permanent - only the
//   row-level-security message is.
// - A request that never got a response (no network, DNS, TLS) is a
//   StorageUnknownError with no `status` at all.
export type StorageFailureKind =
  // The server examined the request and will give the same answer however
  // many times it is repeated.
  | "refused"
  // The object is not there, or not visible to this user (the server
  // answers both the same way).
  | "missing"
  // Anything else: no network, 5xx, 429, an expired token, an error from
  // outside Supabase Storage. Assumed to be worth retrying.
  | "transient";

export interface StorageFailure {
  kind: StorageFailureKind;
  // The body's statusCode ("403", "413", ...), or "" when there was no response.
  code: string;
  message: string;
}

const ROW_LEVEL_SECURITY = /row-level security/i;
const OBJECT_NOT_FOUND = /object not found/i;

export function classifyStorageError(error: unknown): StorageFailure {
  const message = error instanceof Error ? error.message : String(error);
  // Same structural test as storage-js's own isStorageError(), which is not
  // re-exported by @supabase/supabase-js.
  if (typeof error !== "object" || error === null || !("__isStorageError" in error)) {
    return { kind: "transient", code: "", message };
  }
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  if (typeof status !== "number") return { kind: "transient", code: "", message };

  // storage-js falls back to the body's `code` (e.g. "AccessDenied") and then
  // to the HTTP status when the body has no statusCode, e.g. for a gateway's
  // non-JSON error page.
  const code = typeof statusCode === "string" && /^\d+$/.test(statusCode) ? statusCode : String(status);

  if (code === "403" && ROW_LEVEL_SECURITY.test(message)) return { kind: "refused", code, message };
  // Larger than the bucket's/project's file size limit, or a MIME type the
  // bucket does not allow. Neither changes on a retry of the same file.
  if (code === "413" || code === "415") return { kind: "refused", code, message };
  // "Bucket not found" is also a 404, but that is a deployment problem that
  // gets fixed server-side - not a reason to throw a technician's photo away.
  if (code === "404" && OBJECT_NOT_FOUND.test(message)) return { kind: "missing", code, message };
  return { kind: "transient", code, message };
}

// True for the one refusal that can be a false alarm - see uploadFile in
// lib/attachments.ts.
export function isRowLevelSecurityRefusal(failure: StorageFailure): boolean {
  return failure.kind === "refused" && failure.code === "403";
}

// `rejected_uploads.op` for a photo whose file upload was refused. The other
// values in that column are the CRUD op types written by lib/connector.ts.
export const REJECTED_FILE_UPLOAD_OP = "UPLOAD";

// A job_files/task_files row syncs through the normal upload queue,
// independently of its file, so another device routinely learns about a
// photo before the file has finished uploading and gets a 404 for it. Keep
// polling for this long after first hearing of the photo before concluding
// the file is never coming. Generous because the uploading phone can be on
// a connection good enough for the row but not for a multi-megabyte photo
// until it is back on wifi.
export const MISSING_DOWNLOAD_GRACE_MS = 24 * 60 * 60 * 1000;

export interface AttachmentErrorHandlerOptions {
  db: AbstractPowerSyncDatabase;
  // The signed-in user's id, or null when there is no session right now.
  getSignedInUserId: () => Promise<string | null>;
  now?: () => number;
}

export function createAttachmentErrorHandler({
  db,
  getSignedInUserId,
  now = Date.now,
}: AttachmentErrorHandlerOptions): AttachmentErrorHandler {
  return {
    // Each of these answers "retry?". Returning false makes the queue mark
    // the attachment ARCHIVED, which takes it out of the periodic sync.
    async onUploadError(attachment, error) {
      try {
        const failure = classifyStorageError(error);
        if (failure.kind !== "refused") return true;

        // Same sign-out race the connector guards against: a request that
        // went out with no user token is judged as the anonymous role and
        // refused by RLS exactly like a real denial, but would be accepted
        // once signed in again.
        const userId = await getSignedInUserId();
        if (!userId) return true;

        console.error("[PowerSync] photo upload permanently refused by storage - will not retry", {
          id: attachment.id,
          path: remoteObjectKey(attachment),
          code: failure.code,
          message: failure.message,
        });
        await recordRefusedUpload(db, userId, attachment, failure, now());
        return false;
      } catch (handlerError) {
        // Retrying is the outcome that cannot lose a photo.
        console.error("[PowerSync] attachment error handler failed, will retry the upload", handlerError);
        return true;
      }
    },

    async onDownloadError(attachment, error) {
      const failure = classifyStorageError(error);
      if (failure.kind !== "missing") return true;
      // `timestamp` is when this device first queued the download, and is
      // kept when the queue re-queues an archived attachment.
      if (now() - (attachment.timestamp ?? now()) < MISSING_DOWNLOAD_GRACE_MS) return true;
      // Nothing to tell the user: this is someone else's photo that never
      // arrived (or was removed), not something this device lost.
      console.warn("[PowerSync] photo is still not in storage a day after its row synced - no longer polling for it", {
        id: attachment.id,
        path: remoteObjectKey(attachment),
      });
      return false;
    },

    // Nothing in the app queues attachment deletes today, and Storage's
    // remove() reports "not there / not allowed" as an empty success rather
    // than an error, so this exists to satisfy the interface.
    async onDeleteError(_attachment, error) {
      return classifyStorageError(error).kind !== "refused";
    },
  };
}

// ARCHIVED is not final on its own: whenever the watched job_files/
// task_files query emits, AttachmentQueue.startSync() puts an archived
// attachment that is still referenced and has never synced straight back
// into QUEUED_UPLOAD. So a refused upload whose row survives (the row was
// accepted but the file was not, e.g. it is too large) would be re-sent on
// every change to either table. Dropping refused uploads from the watched
// set is what makes the refusal stick: an archived attachment that is not
// watched is left archived, and is eventually removed along with its local
// file by the queue's archive cache limit.
export function skipRefusedUploads(
  db: AbstractPowerSyncDatabase,
  watchAttachments: AttachmentQueueOptions["watchAttachments"]
): AttachmentQueueOptions["watchAttachments"] {
  return (onUpdate, signal) =>
    watchAttachments(async (items) => {
      let refusedIds: Set<string>;
      try {
        const rows = await db.getAll<{ row_id: string }>("SELECT row_id FROM rejected_uploads WHERE op = ?", [
          REJECTED_FILE_UPLOAD_OP,
        ]);
        refusedIds = new Set(rows.map((row) => row.row_id));
      } catch (error) {
        console.error("[PowerSync] could not read refused photo uploads - they may be retried", error);
        refusedIds = new Set();
      }
      await onUpdate(refusedIds.size > 0 ? items.filter((item) => !refusedIds.has(item.id)) : items);
    }, signal);
}

// Same key SupabaseRemoteStorageAdapter builds - see the comment at the top
// of lib/attachments.ts for why the folder travels in metaData.
export function remoteObjectKey(attachment: Pick<AttachmentRecord, "filename" | "metaData">): string {
  return attachment.metaData ? `${attachment.metaData}/${attachment.filename}` : attachment.filename;
}

// Which photo this was, from the `<tenant_id>/<job_card_id>` or
// `<tenant_id>/task-<task_id>` folder in metaData. The parent row is still
// in the local database when this runs in the usual case (PowerSync does not
// apply a downloaded checkpoint while local writes are waiting to upload),
// so its title can be captured for the notice before it disappears.
async function describeParent(
  db: AbstractPowerSyncDatabase,
  attachment: AttachmentRecord
): Promise<{ table: string; parent: string | null }> {
  const folder = attachment.metaData?.split("/")[1] ?? "";
  const isTask = folder.startsWith("task-");
  const table = isTask ? "task_files" : "job_files";
  try {
    const row = await db.getOptional<{ number: string | null; title: string | null }>(
      `SELECT number, title FROM ${isTask ? "tasks" : "job_cards"} WHERE id = ?`,
      [isTask ? folder.slice("task-".length) : folder]
    );
    const parent = [row?.number, row?.title].filter(Boolean).join(" ");
    return { table, parent: parent || null };
  } catch {
    return { table, parent: null };
  }
}

// Saves the refusal to the local-only `rejected_uploads` table, which both
// the in-app notice (components/RejectedUploadsNotice.tsx) and
// skipRefusedUploads above read. Throws if it cannot be saved, so the
// caller retries rather than dropping a photo the user was never told about.
async function recordRefusedUpload(
  db: AbstractPowerSyncDatabase,
  userId: string,
  attachment: AttachmentRecord,
  failure: StorageFailure,
  nowMs: number
): Promise<void> {
  const id = `attachment-${attachment.id}`;
  const { table, parent } = await describeParent(db, attachment);
  const timestamp = new Date(nowMs).toISOString();

  await db.writeTransaction(async (tx) => {
    // Once per photo, and never un-acknowledging one the user has already
    // dismissed: this can run again for the same attachment if the app is
    // killed between this write and the queue archiving it.
    if (await tx.getOptional("SELECT 1 FROM rejected_uploads WHERE id = ?", [id])) return;

    // The attachment id is also the id of its job_files/task_files row. If
    // the connector has already reported that row as rejected (the usual
    // order when the job was deleted - the row is a far smaller request than
    // the file), the user has been told this photo is gone; record this for
    // skipRefusedUploads but do not raise a second notice about it.
    const rowAlreadyReported = await tx.getOptional(
      "SELECT 1 FROM rejected_uploads WHERE row_id = ? AND op != ?",
      [attachment.id, REJECTED_FILE_UPLOAD_OP]
    );

    await tx.execute(
      `INSERT INTO rejected_uploads
         (id, user_id, table_name, op, row_id, data, error_code, error_message, created_at, acknowledged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        userId,
        table,
        REJECTED_FILE_UPLOAD_OP,
        attachment.id,
        JSON.stringify({
          file_name: attachment.filename,
          storage_path: remoteObjectKey(attachment),
          mime_type: attachment.mediaType ?? null,
          size_bytes: attachment.size ?? null,
          // Still on the device until the queue's archive cache evicts it.
          local_uri: attachment.localUri ?? null,
          taken_at: attachment.timestamp ? new Date(attachment.timestamp).toISOString() : null,
          parent,
        }),
        failure.code,
        failure.message,
        timestamp,
        rowAlreadyReported ? timestamp : null,
      ]
    );
  });
}
