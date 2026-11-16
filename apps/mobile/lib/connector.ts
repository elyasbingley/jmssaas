import type {
  AbstractPowerSyncDatabase,
  CrudEntry,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from "@powersync/common";
import { UpdateType } from "@powersync/common";
import { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "./supabase";

const powersyncUrl = process.env.EXPO_PUBLIC_POWERSYNC_URL;

// Postgres SQLSTATEs for a write the server will never accept however many
// times it is replayed - the same set PowerSync's own Supabase demo
// connector treats as fatal. Anything else (no network, 5xx, an expired
// token, a PGRST* error from PostgREST itself) is assumed to be transient.
const PERMANENT_REJECTION_CODES = [
  /^22...$/, // class 22 - data exception (bad uuid/date, value too long, ...)
  /^23...$/, // class 23 - integrity constraint (foreign key, not-null, unique, check)
  /^42501$/, // insufficient privilege - in practice a row-level-security denial
];

// The outcome of replaying one queued op: `status` is the HTTP status
// PostgREST answered with, or 0 when the request never got a response.
interface OpFailure {
  error: PostgrestError;
  status: number;
}

/**
 * True when retrying can never succeed, so the op should be discarded
 * rather than left to block everything queued behind it.
 *
 * A 401 is never treated as permanent, whatever the code: PostgREST answers
 * 42501 with 401 (rather than 403) when the request carried no user token,
 * i.e. it was evaluated as the anonymous role. That happens when an upload
 * races a sign-out or a lost session, and the same write would be accepted
 * once the user is signed in again - discarding it would throw away good
 * data.
 */
export function isPermanentRejection(code: unknown, status: number): boolean {
  if (status === 401) return false;
  return typeof code === "string" && PERMANENT_REJECTION_CODES.some((pattern) => pattern.test(code));
}

// Replays one queued op against Supabase. Returns null on success. Not
// using .throwOnError() here because the thrown PostgrestError drops the
// HTTP status, which isPermanentRejection needs.
async function applyOp(op: CrudEntry): Promise<OpFailure | null> {
  const table = supabase.from(op.table);
  let result: { error: PostgrestError | null; status: number };
  switch (op.op) {
    case UpdateType.PUT:
      result = await table.upsert({ ...op.opData, id: op.id });
      break;
    case UpdateType.PATCH:
      result = await table.update(op.opData ?? {}).eq("id", op.id);
      break;
    case UpdateType.DELETE:
      result = await table.delete().eq("id", op.id);
      break;
  }
  if (!result.error) return null;
  // Without throwOnError the error is the parsed response body (or a
  // synthesised one for a network failure), not an Error instance - wrap it
  // so whatever gets rethrown to PowerSync is a real Error with a stack.
  // The fields are typed as strings but are missing/null in practice for a
  // non-JSON error body (e.g. a gateway's HTML 502 page).
  const { message, details, hint, code } = result.error;
  return {
    error: new PostgrestError({
      message: message ?? "Upload failed",
      details: details ?? "",
      hint: hint ?? "",
      code: code ?? "",
    }),
    status: result.status,
  };
}

// Bridges PowerSync to Supabase: fetchCredentials hands PowerSync the
// caller's Supabase access token (PowerSync validates it against the
// project's JWT secret), and uploadData replays queued local writes as
// ordinary Supabase requests - so the same Postgres RLS policies that
// protect the rest of the app apply to synced writes too.
export class SupabaseConnector implements PowerSyncBackendConnector {
  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    const {
      data: { session },
      error,
    } = await supabase.auth.getSession();
    if (error) throw error;
    if (!session) return null;

    if (!powersyncUrl) {
      throw new Error(
        "Missing EXPO_PUBLIC_POWERSYNC_URL. Copy .env.example to apps/mobile/.env and fill in your PowerSync instance URL - see docs/SETUP.md."
      );
    }

    return {
      endpoint: powersyncUrl,
      token: session.access_token,
    };
  }

  // PowerSync calls this whenever the local upload queue is non-empty, one
  // local transaction at a time, strictly in order - it will not look at the
  // next transaction until this one is completed. Throwing means "try this
  // same transaction again later", which is right for a transient failure
  // but would wedge the whole queue forever on a write Postgres will never
  // accept (e.g. a note added offline to a job that was deleted before the
  // phone synced). So failures are split in two:
  //
  // - Transient (anything isPermanentRejection says no to): rethrow, PowerSync
  //   retries. Ops already applied are replayed on the retry, which is safe -
  //   PUT is an upsert and PATCH/DELETE are idempotent.
  // - Permanent: discard and complete the transaction so the queue moves on.
  //
  // What gets discarded is the rejected op AND every op after it in the same
  // local transaction; ops before it stay applied. The ops go to Postgres as
  // separate requests, so real all-or-nothing is not on offer from here (it
  // would take a server-side RPC that applies the whole batch in one
  // database transaction) - the choice is only what to do with the tail.
  // Carrying on with it would apply writes whose prerequisite was just
  // rejected, leaving the server in a state the device never produced and
  // nobody would notice; stopping leaves a clean prefix and loses only
  // writes that are then reported. This is also what PowerSync's Supabase
  // demo connector does. Today it makes no practical difference: every
  // write in the app is a single-statement execute(), so each transaction
  // holds exactly one op (the photo helpers in powersync.ts pair it with an
  // `attachments` row, but that table is local-only and never queued).
  //
  // Once the queue is empty the next sync checkpoint overwrites local rows
  // with the server's, so a discarded insert/edit disappears from the device.
  // That is data the user believes was saved, hence recordRejectedUploads.
  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) return;

    try {
      for (let index = 0; index < transaction.crud.length; index++) {
        const failure = await applyOp(transaction.crud[index]);
        if (!failure) continue;

        if (!isPermanentRejection(failure.error.code, failure.status)) throw failure.error;

        // Second guard on the same sign-out race as the 401 check: only
        // discard a write that was judged against a real signed-in user.
        const { data, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        if (!data.session) throw failure.error;

        await recordRejectedUploads(database, data.session.user.id, transaction.crud.slice(index), failure);
        break;
      }
      await transaction.complete();
    } catch (error) {
      console.error("[PowerSync] upload failed, will retry", error);
      throw error;
    }
  }
}

// Logs discarded ops and saves them to the local-only `rejected_uploads`
// table, which the in-app notice (components/RejectedUploadsNotice.tsx)
// reads. `ops[0]` is the op the server rejected; any others are the rest of
// its transaction, discarded unsent. Never throws: the console line is the
// record of last resort, and failing to save the notice row must not put
// the queue back into the stuck state this exists to prevent.
async function recordRejectedUploads(
  database: AbstractPowerSyncDatabase,
  userId: string,
  ops: CrudEntry[],
  failure: OpFailure
): Promise<void> {
  const [rejected, ...unsent] = ops;
  const { code, message, details, hint } = failure.error;

  // Deliberately not logging op.opData - it can hold customer details, and
  // device logs are readable by more than this app. It is kept in
  // rejected_uploads.data instead.
  console.error("[PowerSync] upload permanently rejected by the server - discarding, will not retry", {
    table: rejected.table,
    op: rejected.op,
    id: rejected.id,
    status: failure.status,
    error: { code, message, details, hint },
  });
  for (const op of unsent) {
    console.error("[PowerSync] upload discarded unsent - an earlier write in the same local transaction was rejected", {
      table: op.table,
      op: op.op,
      id: op.id,
      rejected: { table: rejected.table, op: rejected.op, id: rejected.id },
    });
  }

  try {
    const now = new Date().toISOString();
    await database.writeTransaction(async (tx) => {
      for (const op of ops) {
        // Keyed on the op's upload-queue id so a crash between this write
        // and transaction.complete() re-records the same rows on the retry
        // rather than duplicating them.
        const id = `crud-${op.clientId}`;
        const isRejected = op === rejected;
        await tx.execute("DELETE FROM rejected_uploads WHERE id = ?", [id]);
        await tx.execute(
          `INSERT INTO rejected_uploads
             (id, user_id, table_name, op, row_id, data, error_code, error_message, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            userId,
            op.table,
            op.op,
            op.id,
            op.opData ? JSON.stringify(op.opData) : null,
            isRejected ? code : null,
            isRejected
              ? [message, details, hint].filter(Boolean).join(" - ")
              : `Not sent: an earlier change in the same save (${rejected.table} ${rejected.id}) was rejected.`,
            now,
          ]
        );
      }
    });
  } catch (error) {
    console.error("[PowerSync] could not save the rejected upload(s) above for the in-app notice", error);
  }
}
