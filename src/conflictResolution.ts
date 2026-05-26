import type { SQLiteDatabase } from "expo-sqlite";

import {
  markConflictResolved,
  markConflictResolving,
  markConflictFailed,
} from "./offlineQueue";
import { upsertFromRemote } from "./localDatabase";

export type ResolveStrategy =
  | "server-wins"
  | "client-wins"
  | "manual-merge"
  | "mark-resolved";

export interface ConflictRemoteResolver {
  forceUpdate: (
    table: string,
    rowId: string,
    payload: Record<string, any>,
  ) => Promise<Record<string, any>>;
}

export interface SyncConflictForResolution {
  id: number;
  table_name: string;
  row_id: string;
  operation: "INSERT" | "UPDATE" | "DELETE";
  local_payload: string;
  remote_payload: string | null;
  resolution_strategy?: string | null;
  base_version: number | null;
  remote_version: number | null;
  status?: "pending" | "resolving" | "resolved" | "failed" | "ignored";
  attempts?: number;
  last_error?: string | null;
  next_retry_at?: string | null;
  created_at?: string;
  resolved_at?: string | null;
}

function parseJsonPayload<T = Record<string, any>>(
  value: string | null,
): T | null {
  if (!value) return null;
  return JSON.parse(value) as T;
}

function convertForSQLite(row: Record<string, any>): Record<string, any> {
  const sqliteRow: Record<string, any> = {};

  for (const [key, value] of Object.entries(row)) {
    if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
      sqliteRow[key] = JSON.stringify(value);
    } else if (typeof value === "boolean") {
      sqliteRow[key] = value ? 1 : 0;
    } else {
      sqliteRow[key] = value;
    }
  }

  return sqliteRow;
}

function convertForSupabase(row: Record<string, any>): Record<string, any> {
  const converted: Record<string, any> = {};

  for (const [key, value] of Object.entries(row)) {
    if (
      typeof value === "string" &&
      (value.startsWith("{") || value.startsWith("["))
    ) {
      try {
        converted[key] = JSON.parse(value);
      } catch {
        converted[key] = value;
      }
    } else if (key !== "is_synced") {
      converted[key] = value;
    }
  }

  return converted;
}

async function getLocalRow(
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

async function updateLocalMergeRow(
  db: SQLiteDatabase,
  table: string,
  rowId: string,
  mergedPayload: Record<string, any>,
): Promise<void> {
  const updates: Record<string, any> = {
    ...mergedPayload,
    updated_at: new Date().toISOString(),
    is_synced: 0,
  };

  delete updates.id;

  const columns = Object.keys(updates);

  if (columns.length === 0) {
    throw new Error("manual-merge ei sisältänyt päivitettäviä kenttiä.");
  }

  const setClause = columns.map((column) => `${column} = ?`).join(", ");
  const values = columns.map((column) => updates[column]);

  await db.runAsync(
    `UPDATE ${table}
     SET ${setClause}
     WHERE id = ?`,
    [...values, rowId],
  );
}

async function applyRemoteResolution(
  resolver: ConflictRemoteResolver | undefined,
  table: string,
  rowId: string,
  payload: Record<string, any>,
): Promise<Record<string, any>> {
  if (!resolver) {
    throw new Error(
      "Tämä konfliktinratkaisustrategia vaatii remoteResolverin.",
    );
  }

  return await resolver.forceUpdate(table, rowId, payload);
}

export async function resolveConflict(
  db: SQLiteDatabase,
  conflict: SyncConflictForResolution,
  strategy: ResolveStrategy,
  options?: {
    remoteResolver?: ConflictRemoteResolver;
    mergedPayload?: Record<string, any>;
  },
): Promise<void> {
  const table = conflict.table_name;
  const rowId = conflict.row_id;

  await markConflictResolving(db, conflict.id, strategy);

  try {
    if (strategy === "mark-resolved") {
      await markConflictResolved(db, conflict.id, strategy);
      return;
    }

    if (strategy === "server-wins") {
      const remote = parseJsonPayload(conflict.remote_payload);
      if (!remote) {
        throw new Error(
          "server-wins ei onnistu, koska konfliktilla ei ole remote_payload-arvoa.",
        );
      }
      if (remote.deleted_at) {
        await db.runAsync(`DELETE FROM ${table} WHERE id = ?`, [rowId]);
      } else {
        await upsertFromRemote(db, table, convertForSQLite(remote));
      }
      await markConflictResolved(db, conflict.id, strategy);
      return;
    }

    if (strategy === "client-wins") {
      const localRow = await getLocalRow(db, table, rowId);

      if (!localRow) {
        throw new Error(
          `client-wins ei onnistu, koska paikallista riviä ${rowId} ei löytynyt.`,
        );
      }

      const payload = convertForSupabase({
        ...localRow,
        updated_at: new Date().toISOString(),
      });

      const remoteRow = await applyRemoteResolution(
        options?.remoteResolver,
        table,
        rowId,
        payload,
      );

      await upsertFromRemote(db, table, convertForSQLite(remoteRow));
      await markConflictResolved(db, conflict.id, strategy);
      return;
    }

    if (strategy === "manual-merge") {
      if (!options?.mergedPayload) {
        throw new Error("manual-merge vaatii mergedPayload-parametrin.");
      }

      const mergedLocalRow = convertForSQLite({
        ...options.mergedPayload,
        id: rowId,
        updated_at: new Date().toISOString(),
      });

      if (options.remoteResolver) {
        const payload = convertForSupabase(mergedLocalRow);

        const remoteRow = await applyRemoteResolution(
          options.remoteResolver,
          table,
          rowId,
          payload,
        );

        await upsertFromRemote(db, table, convertForSQLite(remoteRow));
        await markConflictResolved(db, conflict.id, strategy);
        return;
      }

      await updateLocalMergeRow(db, table, rowId, mergedLocalRow);

      await markConflictResolved(db, conflict.id, strategy);
      return;
    }
  } catch (err) {
    await markConflictFailed(db, conflict.id, err);
    throw err;
  }
}
