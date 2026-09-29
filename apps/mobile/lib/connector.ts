import type {
  AbstractPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from "@powersync/common";
import { UpdateType } from "@powersync/common";
import { supabase } from "./supabase";

const powersyncUrl = process.env.EXPO_PUBLIC_POWERSYNC_URL;

// SQLite has no boolean type, so packages/shared/src/powersync/schema.ts
// stores every boolean-shaped flag as column.integer (0/1) - fine for
// local reads/writes, but these columns are real Postgres `boolean`s, and
// PostgREST rejects a JSON *number* for a boolean column (it can cast JSON
// text/boolean to boolean, but not JSON numeric - confirmed empirically:
// `('{"v":1}'::jsonb -> 'v')::boolean` raises "cannot cast jsonb numeric
// to type boolean", the exact shape of request PostgREST builds from a
// JS `{is_closed: 1}` body). Left unconverted, every one of these writes
// silently failed to upload - the CRUD transaction never completed, and
// the optimistic local toggle got reverted back to the last-synced value
// once PowerSync's own consistency check caught up. This is the "Job is
// done in this stage toggle undoes itself after save" bug (and the same
// bug for every other boolean flag below, which shared the identical
// write pattern even though only job_lifecycle_stages.is_closed was
// reported) - converted back to real booleans here, once, for every
// caller, rather than patching each `? 1 : 0` call site individually.
const BOOLEAN_COLUMNS_BY_TABLE: Record<string, string[]> = {
  client_sites: ["is_primary"],
  client_contacts: ["is_primary"],
  job_cards: ["is_real_estate_job", "nte_exceeded_approved", "referral_fee_paid"],
  job_lifecycle_stages: ["is_system_default", "is_closed"],
  communication_rules: ["is_enabled"],
  communication_templates: ["is_active"],
  notes: ["is_deleted"],
  note_properties: ["value_checkbox"],
  // is_milestone was already affected by this exact bug (set 0/1 at local
  // insert time in apps/mobile/app/tasks/index.tsx, never coerced back on
  // upload) before is_urgent/is_important existed - added here now that the
  // Eisenhower Matrix work adds mobile writes that hit this same path.
  tasks: ["is_milestone", "is_urgent", "is_important"],
};

function coerceBooleanColumns(table: string, data: Record<string, unknown>): Record<string, unknown> {
  const boolColumns = BOOLEAN_COLUMNS_BY_TABLE[table];
  if (!boolColumns) return data;
  const result = { ...data };
  for (const column of boolColumns) {
    if (typeof result[column] === "number") {
      result[column] = result[column] !== 0;
    }
  }
  return result;
}

// note_properties.value_list is a real Postgres `text[]`, but PowerSync's
// local SQLite schema has no array column type - packages/shared/src/
// powersync/schema.ts stores it as a JSON-stringified array in a text
// column instead (see that file's own comment) and expects the app layer
// to parse it back. Left as a JSON string, this would upload verbatim, and
// PostgREST can't cast an arbitrary JSON-format string to `text[]` (it
// expects Postgres's own `{a,b}` array-literal text, not `["a","b"]`) - so
// an offline-created "list"-type property would silently never sync up.
// Same fix shape as coerceBooleanColumns above, for the one column that
// needs it today.
const LIST_COLUMNS_BY_TABLE: Record<string, string[]> = {
  note_properties: ["value_list"],
};

function coerceListColumns(table: string, data: Record<string, unknown>): Record<string, unknown> {
  const listColumns = LIST_COLUMNS_BY_TABLE[table];
  if (!listColumns) return data;
  const result = { ...data };
  for (const column of listColumns) {
    if (typeof result[column] === "string") {
      try {
        const parsed = JSON.parse(result[column] as string);
        if (Array.isArray(parsed)) result[column] = parsed;
      } catch {
        // Malformed JSON shouldn't block the whole upload transaction -
        // leave it as-is and let Postgres accept/reject it on its own.
      }
    }
  }
  return result;
}

function coerceOutgoingColumns(table: string, data: Record<string, unknown>): Record<string, unknown> {
  return coerceListColumns(table, coerceBooleanColumns(table, data));
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

  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) return;

    try {
      for (const op of transaction.crud) {
        const table = supabase.from(op.table);
        switch (op.op) {
          case UpdateType.PUT:
            await table.upsert({ ...coerceOutgoingColumns(op.table, op.opData ?? {}), id: op.id }).throwOnError();
            break;
          case UpdateType.PATCH:
            await table.update(coerceOutgoingColumns(op.table, op.opData ?? {})).eq("id", op.id).throwOnError();
            break;
          case UpdateType.DELETE:
            await table.delete().eq("id", op.id).throwOnError();
            break;
        }
      }
      await transaction.complete();
    } catch (error) {
      console.error("[PowerSync] upload failed, will retry", error);
      throw error;
    }
  }
}
