import type { SQLiteDatabase } from "expo-sqlite";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getQueue,
  removeFromQueue,
  addConflict,
  markQueueItemFailed,
  compactQueue,
} from "./offlineQueue";
import { upsertFromRemote } from "./localDatabase";

export type ConflictStrategy = "manual" | "client-wins" | "server-wins";

interface SyncEngineOptions {
  useRpc?: boolean;
  conflictStrategy?: ConflictStrategy;
}

function parseQueuePayload(item: any): Record<string, any> {
  const rawPayload = item.payload ?? item.data;

  if (!rawPayload) {
    throw new Error(`Queue item ${item.id} has no payload/data`);
  }

  return JSON.parse(rawPayload);
}


function getQueueRowId(item: any, payload: Record<string, any>): string {
  const rowId = item.row_id ?? payload.id;

  if (!rowId) {
    throw new Error(`Queue item ${item.id} has no row_id/id`);
  }

  return rowId;
}

export async function pushChanges(
  db: SQLiteDatabase,
  supabase: SupabaseClient,
  table: string,
  options?: SyncEngineOptions,
): Promise<{ pushed: number; failed: boolean }> {
  await compactQueue(db, table);
  const queue = await getQueue(db, table);
  let pushed = 0;

  for (const item of queue) {
    const rowData = parseQueuePayload(item);
    const rowId = getQueueRowId(item, rowData);

    const supabaseData = convertForSupabase(rowData);

    try {
      let acceptedRemoteRow: Record<string, any> | null = null;
      if (item.operation === "UPDATE" || item.operation === "DELETE") {
        const conflictCheck = await hasVersionConflict(
          supabase,
          table,
          rowId,
          item.base_version ?? null,
        );

        if (conflictCheck.hasConflict) {
          await handleConflict(
            db,
            supabase,
            table,
            item,
            rowId,
            rowData,
            conflictCheck.remoteRow,
            conflictCheck.remoteVersion,
            options?.conflictStrategy ?? "manual",
          );

          continue;
        }
      }

      if (item.operation === "INSERT") {
        if (options?.useRpc) {
          const { data, error } = await supabase.rpc("apply_sync_insert", {
            p_table_name: table,
            p_payload: supabaseData,
            p_client_operation_id:
              item.client_operation_id ?? rowData.client_operation_id ?? null,
          });

          if (error) throw error;

          acceptedRemoteRow = data?.row ?? null;
        } else {
          const { data, error } = await supabase
            .from(table)
            .upsert(supabaseData)
            .select("*")
            .single();

          if (error) throw error;

          acceptedRemoteRow = data ?? null;
        }
      } else if (item.operation === "UPDATE") {
        if (options?.useRpc) {
          const rpcResult = await pushUpdateWithRpc(
            supabase,
            table,
            rowId,
            supabaseData,
            item.base_version ?? null,
            item.client_operation_id ?? rowData.client_operation_id ?? null,
          );

          if (rpcResult.status === "conflict") {
            await handleConflict(
              db,
              supabase,
              table,
              item,
              rowId,
              rowData,
              rpcResult.remote_row ?? null,
              rpcResult.remote_version ?? null,
              options?.conflictStrategy ?? "manual",
            );

            continue;
          }

          if (rpcResult.status === "rejected") {
            throw new Error(
              `RPC update rejected: ${rpcResult.reason ?? "unknown_reason"}`,
            );
          }

          acceptedRemoteRow = rpcResult.row ?? rpcResult.remote_row ?? null;
        } else {
          const { id, ...updates } = supabaseData;

          const { data, error } = await supabase
            .from(table)
            .update(updates)
            .eq("id", rowId)
            .select("*")
            .maybeSingle();

          if (error) throw error;

          acceptedRemoteRow = data ?? null;
        }
      } else if (item.operation === "DELETE") {
        const { data, error } = await supabase
          .from(table)
          .update({
            deleted_at: new Date().toISOString(),
          })
          .eq("id", rowId)
          .select("*")
          .maybeSingle();

        if (error) throw error;

        acceptedRemoteRow = data ?? null;
      }

      await removeFromQueue(db, item.id);

      if (acceptedRemoteRow) {
        const sqliteRow: Record<string, any> = {};

        for (const [key, value] of Object.entries(acceptedRemoteRow)) {
          if (Array.isArray(value)) {
            sqliteRow[key] = JSON.stringify(value);
          } else if (typeof value === "boolean") {
            sqliteRow[key] = value ? 1 : 0;
          } else {
            sqliteRow[key] = value;
          }
        }

        if (sqliteRow.deleted_at) {
          await db.runAsync(`DELETE FROM ${table} WHERE id = ?`, [rowId]);
        } else {
          await upsertFromRemote(db, table, sqliteRow);
        }
      } else {
        await db.runAsync(
          `UPDATE ${table}
     SET is_synced = 1
     WHERE id = ?`,
          [rowId],
        );
      }

      pushed++;
    } catch (err) {
      console.error(
        `[offline-sync] Push epäonnistui (${table}/${item.operation}):`,
        err,
      );

      await markQueueItemFailed(db, item.id, err);

      return { pushed, failed: true };
    }
  }

  return { pushed, failed: false };
}

async function getRemoteRow(
  supabase: SupabaseClient,
  table: string,
  rowId: string,
): Promise<Record<string, any> | null> {
  const { data, error } = await supabase
    .from(table)
    .select("*")
    .eq("id", rowId)
    .maybeSingle();

  if (error) throw error;

  return data ?? null;
}

async function hasVersionConflict(
  supabase: SupabaseClient,
  table: string,
  rowId: string,
  baseVersion: number | null,
): Promise<{
  hasConflict: boolean;
  remoteRow: Record<string, any> | null;
  remoteVersion: number | null;
}> {
  if (baseVersion == null) {
    return {
      hasConflict: false,
      remoteRow: null,
      remoteVersion: null,
    };
  }

  const remoteRow = await getRemoteRow(supabase, table, rowId);
  const remoteVersion =
    typeof remoteRow?.version === "number" ? remoteRow.version : null;

  return {
    hasConflict: remoteVersion !== null && remoteVersion !== baseVersion,
    remoteRow,
    remoteVersion,
  };
}

async function pushUpdateWithRpc(
  supabase: SupabaseClient,
  table: string,
  rowId: string,
  payload: Record<string, any>,
  baseVersion: number | null,
  clientOperationId: string | null,
): Promise<{
  status: "applied" | "duplicate" | "conflict" | "rejected";
  row?: Record<string, any>;
  remote_row?: Record<string, any>;
  remote_version?: number | null;
  reason?: string;
}> {
  if (baseVersion == null) {
    return {
      status: "rejected",
      reason: "missing_base_version",
    };
  }

  if (!clientOperationId) {
    return {
      status: "rejected",
      reason: "missing_client_operation_id",
    };
  }

  const { data, error } = await supabase.rpc("apply_sync_update", {
    p_table_name: table,
    p_row_id: rowId,
    p_payload: payload,
    p_base_version: baseVersion,
    p_client_operation_id: clientOperationId,
  });

  if (error) throw error;

  return data as any;
}

function convertForSupabase(data: Record<string, any>): Record<string, any> {
  const converted: Record<string, any> = {};

  for (const [key, value] of Object.entries(data)) {
    if (
      typeof value === "string" &&
      (value.startsWith("[") || value.startsWith("{"))
    ) {
      try {
        converted[key] = JSON.parse(value);
      } catch {
        converted[key] = value;
      }
    } else {
      converted[key] = value;
    }
  }

  return converted;
}

async function getLocalRowForPullConflictCheck(
  db: SQLiteDatabase,
  table: string,
  rowId: string,
): Promise<Record<string, any> | null> {
  const row = await db.getFirstAsync<Record<string, any>>(
    `SELECT * FROM ${table} WHERE id = ?`,
    [rowId],
  );

  return row ?? null;
}

function hasUnsyncedLocalChanges(
  localRow: Record<string, any> | null,
): boolean {
  return localRow?.is_synced === 0;
}

export async function pullChanges(
  db: SQLiteDatabase,
  supabase: SupabaseClient,
  table: string,
  lastSyncedAt: string | null,
): Promise<{ pulled: number; syncTimestamp: string }> {
  const syncTimestamp = new Date().toISOString();
  let pulled = 0;

  try {
    let query = supabase
      .from(table)
      .select("*")
      .order("updated_at", { ascending: false });

    if (lastSyncedAt) {
      query = query.gt("updated_at", lastSyncedAt);
    }

    const { data: remoteRows, error } = await query;
    if (error) throw error;

    for (const row of remoteRows || []) {
      const sqliteRow: Record<string, any> = {};

      for (const [key, value] of Object.entries(row)) {
        if (Array.isArray(value)) {
          sqliteRow[key] = JSON.stringify(value);
        } else if (typeof value === "boolean") {
          sqliteRow[key] = value ? 1 : 0;
        } else {
          sqliteRow[key] = value;
        }
      }

      const rowId = sqliteRow.id;

      if (!rowId) {
        continue;
      }

      const localRow = await getLocalRowForPullConflictCheck(db, table, rowId);

      if (hasUnsyncedLocalChanges(localRow)) {
        await addConflict(db, {
          tableName: table,
          rowId,
          operation: sqliteRow.deleted_at ? "DELETE" : "UPDATE",
          localPayload: localRow!,
          remotePayload: row,
          baseVersion:
            typeof localRow?.version === "number" ? localRow.version : null,
          remoteVersion: typeof row.version === "number" ? row.version : null,
        });

        continue;
      }

      if (sqliteRow.deleted_at) {
        await db.runAsync(`DELETE FROM ${table} WHERE id = ?`, [rowId]);
      } else {
        await upsertFromRemote(db, table, sqliteRow);
      }

      pulled++;
    }
  } catch (err) {
    console.error(`[offline-sync] Pull epäonnistui (${table}):`, err);
    return { pulled: 0, syncTimestamp: lastSyncedAt || syncTimestamp };
  }

  return { pulled, syncTimestamp };
}

export async function syncTable(
  db: SQLiteDatabase,
  supabase: SupabaseClient,
  table: string,
  lastSyncedAt: string | null,
  options?: SyncEngineOptions,
): Promise<{
  pushed: number;
  pulled: number;
  failed: boolean;
  syncTimestamp: string;
}> {
  const pushResult = await pushChanges(db, supabase, table, options);
  const pullResult = await pullChanges(db, supabase, table, lastSyncedAt);

  return {
    pushed: pushResult.pushed,
    pulled: pullResult.pulled,
    failed: pushResult.failed,
    syncTimestamp: pullResult.syncTimestamp,
  };
}

async function handleConflict(
  db: SQLiteDatabase,
  supabase: SupabaseClient,
  table: string,
  item: any,
  rowId: string,
  localPayload: Record<string, any>,
  remotePayload: Record<string, any> | null,
  remoteVersion: number | null,
  strategy: ConflictStrategy = "manual",
): Promise<"resolved" | "manual"> {
  if (strategy === "server-wins") {
    await removeFromQueue(db, item.id);

    if (remotePayload) {
      const sqliteRow: Record<string, any> = {};

      for (const [key, value] of Object.entries(remotePayload)) {
        if (Array.isArray(value)) {
          sqliteRow[key] = JSON.stringify(value);
        } else if (typeof value === "boolean") {
          sqliteRow[key] = value ? 1 : 0;
        } else {
          sqliteRow[key] = value;
        }
      }

      await upsertFromRemote(db, table, sqliteRow);
    }

    return "resolved";
  }

  if (strategy === "client-wins") {
    await addConflict(db, {
      tableName: table,
      rowId,
      operation: item.operation,
      localPayload,
      remotePayload,
      baseVersion: item.base_version ?? null,
      remoteVersion,
    });

    await removeFromQueue(db, item.id);
    return "manual";
  }

  await addConflict(db, {
    tableName: table,
    rowId,
    operation: item.operation,
    localPayload,
    remotePayload,
    baseVersion: item.base_version ?? null,
    remoteVersion,
  });

  await removeFromQueue(db, item.id);
  return "manual";
}
