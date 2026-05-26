import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConflictRemoteResolver } from "./conflictResolution";

interface SupabaseConflictResolverOptions {
  rpcPrefix?: string;
}

/**
 * Luo Supabase-pohjaisen remoteResolverin konfliktien ratkaisuun.
 *
 * Resolver kutsuu taulukohtaista RPC-funktiota muodossa:
 * force_sync_update_<table>
 *
 * Esimerkiksi:
 * table = "events"
 * → force_sync_update_events
 */
export function createSupabaseConflictResolver(
  supabase: SupabaseClient,
  options: SupabaseConflictResolverOptions = {},
): ConflictRemoteResolver {
  const rpcPrefix = options.rpcPrefix ?? "force_sync_update";

  return {
    async forceUpdate(table, rowId, payload) {
      const rpcName = `${rpcPrefix}_${table}`;

      const { data, error } = await supabase.rpc(rpcName, {
        p_row_id: rowId,
        p_payload: payload,
        p_client_operation_id: payload.client_operation_id ?? null,
      });

      if (error) {
        throw error;
      }

      if (!data?.row) {
        throw new Error(`${rpcName} ei palauttanut päivitettyä riviä.`);
      }

      return data.row;
    },
  };
}