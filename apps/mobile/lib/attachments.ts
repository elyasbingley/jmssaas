import * as FileSystem from "expo-file-system/legacy";
import { decode as decodeBase64, encode as encodeBase64 } from "base64-arraybuffer";
import type {
  AbstractPowerSyncDatabase,
  AttachmentData,
  AttachmentRecord,
  LocalStorageAdapter,
  RemoteStorageAdapter,
  WatchedAttachmentItem,
} from "@powersync/common";
import { supabase } from "./supabase";

// PowerSync's attachment queue (@powersync/common, still marked @alpha as of
// v1.57) handles the offline lifecycle for job card photos: save locally +
// queue for upload immediately (so a tech with no reception can keep
// working), then upload/download in the background as connectivity allows.
//
// Local files are always named `<attachmentId>.<ext>` (flat - the queue
// controls this). Remote objects live under `<tenant_id>/<job_card_id>/`
// in the `job-files` Supabase Storage bucket to match the storage RLS
// policies in supabase/migrations/20260720000300_storage.sql. Since
// AttachmentRecord has no notion of "folder", that remote prefix is smuggled
// through the record's free-form `metaData` field and combined with its
// `filename` in the adapter below - both locally-created and
// remotely-discovered attachments set metaData the same way, so uploads and
// downloads agree on the same object key.

const ATTACHMENTS_DIR = `${FileSystem.documentDirectory}attachments/`;
const JOB_FILES_BUCKET = "job-files";

function remoteObjectKey(attachment: Pick<AttachmentRecord, "filename" | "metaData">): string {
  return attachment.metaData ? `${attachment.metaData}/${attachment.filename}` : attachment.filename;
}

export function jobFileMetaData(tenantId: string, jobCardId: string): string {
  return `${tenantId}/${jobCardId}`;
}

// Task file objects live under a `<tenant_id>/task-<task_id>/` prefix in the
// same job-files bucket (see the storage policies added in the ux_overhaul
// migration) - the `task-` marker is what lets those policies tell a task
// file's folder apart from a job file's folder, since both share one bucket.
export function taskFileMetaData(tenantId: string, taskId: string): string {
  return `${tenantId}/task-${taskId}`;
}

export class ExpoLocalStorageAdapter implements LocalStorageAdapter {
  async initialize(): Promise<void> {
    await this.makeDir(ATTACHMENTS_DIR);
  }

  getLocalUri(filename: string): string {
    return `${ATTACHMENTS_DIR}${filename}`;
  }

  async saveFile(filePath: string, data: AttachmentData): Promise<number> {
    // Assumes string data is already base64-encoded - the app only ever
    // passes ArrayBuffers (see addJobPhoto below), so this branch is
    // effectively unused today but kept to satisfy the adapter interface.
    const base64 = typeof data === "string" ? data : encodeBase64(data);
    await FileSystem.writeAsStringAsync(filePath, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const info = await FileSystem.getInfoAsync(filePath);
    return info.exists && !info.isDirectory ? (info.size ?? 0) : 0;
  }

  async readFile(filePath: string): Promise<ArrayBuffer> {
    const base64 = await FileSystem.readAsStringAsync(filePath, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return decodeBase64(base64);
  }

  async deleteFile(filePath: string): Promise<void> {
    if (await this.fileExists(filePath)) {
      await FileSystem.deleteAsync(filePath, { idempotent: true });
    }
  }

  async fileExists(filePath: string): Promise<boolean> {
    const info = await FileSystem.getInfoAsync(filePath);
    return info.exists;
  }

  async makeDir(path: string): Promise<void> {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true });
  }

  async rmDir(path: string): Promise<void> {
    await FileSystem.deleteAsync(path, { idempotent: true });
  }

  async clear(): Promise<void> {
    await this.rmDir(ATTACHMENTS_DIR);
    await this.makeDir(ATTACHMENTS_DIR);
  }
}

export class SupabaseRemoteStorageAdapter implements RemoteStorageAdapter {
  async uploadFile(fileData: ArrayBuffer, attachment: AttachmentRecord): Promise<void> {
    const { error } = await supabase.storage.from(JOB_FILES_BUCKET).upload(remoteObjectKey(attachment), fileData, {
      contentType: attachment.mediaType ?? "application/octet-stream",
      upsert: true,
    });
    if (error) throw error;
  }

  async downloadFile(attachment: AttachmentRecord): Promise<ArrayBuffer> {
    const { data, error } = await supabase.storage.from(JOB_FILES_BUCKET).download(remoteObjectKey(attachment));
    if (error) throw error;
    return data.arrayBuffer();
  }

  async deleteFile(attachment: AttachmentRecord): Promise<void> {
    const { error } = await supabase.storage.from(JOB_FILES_BUCKET).remove([remoteObjectKey(attachment)]);
    if (error) throw error;
  }
}

// Every row in job_files or task_files is a photo/file that should exist as
// an attachment. This drives both directions: a row synced down from
// another device (no local attachment record yet) gets queued for
// download; one created locally already has its attachment record from
// addJobPhoto/addTaskPhoto in lib/powersync.ts. Both tables feed the same
// AttachmentQueue (see the AttachmentTable comment in
// packages/shared/src/powersync/schema.ts), so this watches both with one
// combined query rather than running two separate AttachmentQueues.
export function watchFileAttachments(db: AbstractPowerSyncDatabase) {
  return (onUpdate: (items: WatchedAttachmentItem[]) => Promise<void>, signal: AbortSignal) => {
    db.watch(
      `SELECT id, file_name, mime_type, tenant_id, job_card_id, NULL as task_id FROM job_files
       UNION ALL
       SELECT id, file_name, mime_type, tenant_id, NULL as job_card_id, task_id FROM task_files`,
      [],
      {
        onResult: (result: { rows?: { _array: any[] } }) => {
          const items: WatchedAttachmentItem[] = (result.rows?._array ?? []).map((row: any) => ({
            id: row.id,
            filename: row.file_name,
            mediaType: row.mime_type ?? undefined,
            metaData: row.job_card_id
              ? jobFileMetaData(row.tenant_id, row.job_card_id)
              : taskFileMetaData(row.tenant_id, row.task_id),
          }));
          void onUpdate(items);
        },
      },
      { signal }
    );
  };
}
