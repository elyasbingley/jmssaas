import type {
  AbstractPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from "@powersync/common";
import { UpdateType } from "@powersync/common";
import { supabase } from "./supabase";

const powersyncUrl = process.env.EXPO_PUBLIC_POWERSYNC_URL;

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
            await table.upsert({ ...op.opData, id: op.id }).throwOnError();
            break;
          case UpdateType.PATCH:
            await table.update(op.opData ?? {}).eq("id", op.id).throwOnError();
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
