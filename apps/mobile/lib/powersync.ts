import "react-native-get-random-values";
import { PowerSyncDatabase } from "@powersync/react-native";
import {
  AttachmentQueue,
  AttachmentState,
  createBaseLogger,
  LogLevel,
  type Transaction,
  type AttachmentRecord,
} from "@powersync/common";
import { AppSchema } from "@jmssaas/shared";
import { v4 as uuidv4 } from "uuid";
import { SupabaseConnector } from "./connector";
import { ExpoLocalStorageAdapter, SupabaseRemoteStorageAdapter, jobFileMetaData, watchJobFileAttachments } from "./attachments";

// Dev-only debug logging. PowerSyncDatabase (and everything it creates
// internally - ConnectionManager, the sync stream implementation, etc.)
// defaults to a named logger derived from this same base logger, so setting
// the level here before construction is enough to surface what would
// otherwise be silent internals: connection attempts, retries, and the
// underlying cause the next time something like the connect-loop bug in
// auth-context.tsx produces a bare warning with no context.
//
// Deliberately not using logger.useDefaults(): js-logger's built-in handler
// routes DEBUG-level messages through console.debug specifically (see
// js-logger's createDefaultHandler), and console.debug is not reliably
// forwarded to the Metro terminal on a Hermes-based dev build the way
// console.log/warn/error are - React Native's own JS console-forwarding
// shim only runs when console._isPolyfilled is set, which is a legacy
// JSC-only flag that Hermes doesn't set. That mismatch is a plausible
// explanation for debug output going missing entirely, so this handler
// avoids console.debug altogether and always logs through console.log
// (or console.warn/console.error, which are already confirmed to reach
// the terminal) instead.
if (__DEV__) {
  const logger = createBaseLogger();
  logger.setLevel(LogLevel.DEBUG);
  logger.setHandler((messages, context) => {
    const args = Array.prototype.slice.call(messages);
    if (context.name) args.unshift(`[${context.name}]`);
    if (context.level === LogLevel.WARN) {
      console.warn(...args);
    } else if (context.level === LogLevel.ERROR) {
      console.error(...args);
    } else {
      console.log(`[${context.level.name}]`, ...args);
    }
  });
}

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
