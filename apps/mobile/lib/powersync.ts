import "react-native-get-random-values";
import { PowerSyncDatabase } from "@powersync/react-native";
import { AttachmentQueue, AttachmentState, type Transaction, type AttachmentRecord } from "@powersync/common";
import { AppSchema } from "@jmssaas/shared";
import { v4 as uuidv4 } from "uuid";
import { SupabaseConnector } from "./connector";
import { ExpoLocalStorageAdapter, SupabaseRemoteStorageAdapter, jobFileMetaData, watchJobFileAttachments } from "./attachments";

export const powersync = new PowerSyncDatabase({
  schema: AppSchema,
  database: { dbFilename: "jmssaas.db" },
});

const connector = new SupabaseConnector();

export const attachmentQueue = new AttachmentQueue({
  db: powersync,
  localStorage: new ExpoLocalStorageAdapter(),
  remoteStorage: new SupabaseRemoteStorageAdapter(),
  watchAttachments: watchJobFileAttachments(powersync),
});

let syncStarted = false;

export async function connectPowerSync(): Promise<void> {
  await powersync.connect(connector);
  if (!syncStarted) {
    await attachmentQueue.startSync();
    syncStarted = true;
  }
}

export async function disconnectPowerSync(): Promise<void> {
  if (syncStarted) {
    await attachmentQueue.stopSync();
    syncStarted = false;
  }
  await powersync.disconnect();
}

// Captures a photo for a job card: writes it to local storage and queues it
// for upload immediately (works offline), and inserts the matching job_files
// row in the same local transaction so the two can never drift apart.
export async function addJobPhoto(params: {
  tenantId: string;
  jobCardId: string;
  uploadedBy: string;
  imageArrayBuffer: ArrayBuffer;
  mediaType: string;
  fileExtension: string;
}): Promise<void> {
  const id = uuidv4();
  const fileName = `${id}.${params.fileExtension}`;

  await attachmentQueue.saveFile({
    id,
    data: params.imageArrayBuffer,
    fileExtension: params.fileExtension,
    mediaType: params.mediaType,
    metaData: jobFileMetaData(params.tenantId, params.jobCardId),
    updateHook: async (tx: Transaction, attachment: AttachmentRecord) => {
      await tx.execute(
        `INSERT INTO job_files
           (id, tenant_id, job_card_id, storage_path, file_name, mime_type, size_bytes, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attachment.id,
          params.tenantId,
          params.jobCardId,
          `${params.tenantId}/${params.jobCardId}/${fileName}`,
          fileName,
          params.mediaType,
          attachment.size ?? null,
          params.uploadedBy,
          new Date().toISOString(),
        ]
      );
    },
  });
}

export { AttachmentState };
