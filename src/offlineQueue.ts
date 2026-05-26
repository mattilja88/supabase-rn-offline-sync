// packages/offlineSync/src/offlineQueue.ts
import type { SQLiteDatabase } from "expo-sqlite";
import * as Crypto from "expo-crypto";

export type QueueOperation = "INSERT" | "UPDATE" | "DELETE";

export interface QueueItem {
  id: number;
  table_name: string;
  operation: QueueOperation;

  data: string | null;

  row_id: string | null;
  payload: string | null;
  base_version: number | null;
  client_operation_id: string | null;

  attempts: number;
  last_error: string | null;
  next_retry_at: string | null;

  created_at: string;
}

export interface SyncConflict {
  id: number;
  table_name: string;
  row_id: string;
  operation: QueueOperation;
  local_payload: string;
  remote_payload: string | null;
  resolution_strategy: string | null;
  base_version: number | null;
  remote_version: number | null;
  status: "pending" | "resolving" | "resolved" | "failed" | "ignored";
  attempts: number;
  last_error: string | null;
  next_retry_at: string | null;
  created_at: string;
  resolved_at: string | null;
}

export async function initConflicts(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      local_payload TEXT NOT NULL,
      remote_payload TEXT,
      resolution_strategy TEXT,
      base_version INTEGER,
      remote_version INTEGER,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      last_error TEXT,
      next_retry_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT
    )
  `);

  await addConflictColumnIfMissing(db, "resolution_strategy", "TEXT");
  await addConflictColumnIfMissing(db, "last_error", "TEXT");
  await addConflictColumnIfMissing(db, "attempts", "INTEGER DEFAULT 0");
  await addConflictColumnIfMissing(db, "next_retry_at", "TEXT");
}

async function addConflictColumnIfMissing(
  db: SQLiteDatabase,
  columnName: string,
  columnDefinition: string,
): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>(
    "PRAGMA table_info(sync_conflicts)",
  );

  const exists = columns.some((column) => column.name === columnName);

  if (!exists) {
    await db.execAsync(
      `ALTER TABLE sync_conflicts ADD COLUMN ${columnName} ${columnDefinition}`,
    );
  }
}

export async function addConflict(
  db: SQLiteDatabase,
  conflict: {
    tableName: string;
    rowId: string;
    operation: QueueOperation;
    localPayload: Record<string, any>;
    remotePayload?: Record<string, any> | null;
    baseVersion?: number | null;
    remoteVersion?: number | null;
  },
): Promise<void> {
  const existing = await db.getFirstAsync<{ id: number }>(
    `SELECT id FROM sync_conflicts
   WHERE table_name = ?
     AND row_id = ?
     AND status = 'pending'
   LIMIT 1`,
    [conflict.tableName, conflict.rowId],
  );

  if (existing) {
    return;
  }
  await db.runAsync(
    `INSERT INTO sync_conflicts (
      table_name,
      row_id,
      operation,
      local_payload,
      remote_payload,
      base_version,
      remote_version,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      conflict.tableName,
      conflict.rowId,
      conflict.operation,
      JSON.stringify(conflict.localPayload),
      conflict.remotePayload ? JSON.stringify(conflict.remotePayload) : null,
      conflict.baseVersion ?? null,
      conflict.remoteVersion ?? null,
      "pending",
    ],
  );
}

export async function getConflicts(
  db: SQLiteDatabase,
  table?: string,
): Promise<SyncConflict[]> {
  const now = new Date().toISOString();

  if (table) {
    return await db.getAllAsync<SyncConflict>(
      `SELECT * FROM sync_conflicts
       WHERE table_name = ?
         AND (
           status = 'pending'
           OR (
             status = 'failed'
             AND (next_retry_at IS NULL OR next_retry_at <= ?)
           )
         )
       ORDER BY created_at ASC`,
      [table, now],
    );
  }

  return await db.getAllAsync<SyncConflict>(
    `SELECT * FROM sync_conflicts
     WHERE status = 'pending'
        OR (
          status = 'failed'
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        )
     ORDER BY created_at ASC`,
    [now],
  );
}

export async function markConflictResolving(
  db: SQLiteDatabase,
  conflictId: number,
  strategy: string,
): Promise<void> {
  await db.runAsync(
    `UPDATE sync_conflicts
     SET status = 'resolving',
         resolution_strategy = ?,
         last_error = NULL,
         next_retry_at = NULL
     WHERE id = ?`,
    [strategy, conflictId],
  );
}

export async function markConflictResolved(
  db: SQLiteDatabase,
  conflictId: number,
  strategy?: string,
): Promise<void> {
  const now = new Date().toISOString();

  await db.runAsync(
    `UPDATE sync_conflicts
     SET status = 'resolved',
         resolved_at = ?,
         resolution_strategy = COALESCE(?, resolution_strategy),
         last_error = NULL,
         next_retry_at = NULL
     WHERE id = ?`,
    [now, strategy ?? null, conflictId],
  );
}

export async function markConflictFailed(
  db: SQLiteDatabase,
  conflictId: number,
  error: unknown,
): Promise<void> {
  const errorMessage =
    error instanceof Error ? error.message : JSON.stringify(error);

  const current = await db.getFirstAsync<{ attempts: number | null }>(
    "SELECT attempts FROM sync_conflicts WHERE id = ?",
    [conflictId],
  );

  const attempts = (current?.attempts ?? 0) + 1;

  const delayMs = Math.min(2 ** attempts * 1000, 60_000);
  const nextRetryAt = new Date(Date.now() + delayMs).toISOString();

  await db.runAsync(
    `UPDATE sync_conflicts
     SET status = 'failed',
         attempts = ?,
         last_error = ?,
         next_retry_at = ?
     WHERE id = ?`,
    [attempts, errorMessage, nextRetryAt, conflictId],
  );
}

export async function resetConflictRetry(
  db: SQLiteDatabase,
  conflictId: number,
): Promise<void> {
  await db.runAsync(
    `UPDATE sync_conflicts
     SET status = 'pending',
         attempts = 0,
         last_error = NULL,
         next_retry_at = NULL
     WHERE id = ?`,
    [conflictId],
  );
}

async function addQueueColumnIfMissing(
  db: SQLiteDatabase,
  columnName: string,
  columnDefinition: string,
): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>(
    "PRAGMA table_info(sync_queue)",
  );

  const exists = columns.some((column) => column.name === columnName);

  if (!exists) {
    await db.execAsync(
      `ALTER TABLE sync_queue ADD COLUMN ${columnName} ${columnDefinition}`,
    );
  }
}

export async function initQueue(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      operation TEXT NOT NULL,

      data TEXT,

      row_id TEXT,
      payload TEXT,
      base_version INTEGER,
      client_operation_id TEXT,

      attempts INTEGER DEFAULT 0,
      last_error TEXT,
      next_retry_at TEXT,

      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await addQueueColumnIfMissing(db, "data", "TEXT");
  await addQueueColumnIfMissing(db, "row_id", "TEXT");
  await addQueueColumnIfMissing(db, "payload", "TEXT");
  await addQueueColumnIfMissing(db, "base_version", "INTEGER");
  await addQueueColumnIfMissing(db, "client_operation_id", "TEXT");
  await addQueueColumnIfMissing(db, "attempts", "INTEGER DEFAULT 0");
  await addQueueColumnIfMissing(db, "last_error", "TEXT");
  await addQueueColumnIfMissing(db, "next_retry_at", "TEXT");
}

export async function addToQueue(
  db: SQLiteDatabase,
  table: string,
  operation: QueueOperation,
  data: Record<string, any>,
  options?: {
    rowId?: string;
    baseVersion?: number | null;
    clientOperationId?: string;
  },
): Promise<void> {
  const rowId = options?.rowId ?? data.id ?? null;
  const baseVersion = options?.baseVersion ?? data.version ?? null;
  const clientOperationId =
    options?.clientOperationId ?? (await Crypto.randomUUID());
  const payloadObject = {
    ...data,
    client_operation_id: clientOperationId,
  };
  const payload = JSON.stringify(payloadObject);

  await db.runAsync(
    `INSERT INTO sync_queue (
      table_name,
      operation,
      data,
      row_id,
      payload,
      base_version,
      client_operation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [table, operation, payload, rowId, payload, baseVersion, clientOperationId],
  );
}

export async function getQueue(
  db: SQLiteDatabase,
  table?: string,
): Promise<QueueItem[]> {
  const now = new Date().toISOString();

  if (table) {
    return await db.getAllAsync<QueueItem>(
      `SELECT * FROM sync_queue
       WHERE table_name = ?
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY created_at ASC`,
      [table, now],
    );
  }

  return await db.getAllAsync<QueueItem>(
    `SELECT * FROM sync_queue
     WHERE next_retry_at IS NULL OR next_retry_at <= ?
     ORDER BY created_at ASC`,
    [now],
  );
}

export async function removeFromQueue(
  db: SQLiteDatabase,
  id: number,
): Promise<void> {
  await db.runAsync("DELETE FROM sync_queue WHERE id = ?", [id]);
}

export async function getQueueCount(db: SQLiteDatabase): Promise<number> {
  const result = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) as count FROM sync_queue",
  );
  return result?.count ?? 0;
}

export async function clearQueue(db: SQLiteDatabase): Promise<void> {
  await db.runAsync("DELETE FROM sync_queue");
}

export async function markQueueItemFailed(
  db: SQLiteDatabase,
  id: number,
  error: unknown,
): Promise<void> {
  const errorMessage =
    error instanceof Error ? error.message : JSON.stringify(error);

  const current = await db.getFirstAsync<{ attempts: number | null }>(
    "SELECT attempts FROM sync_queue WHERE id = ?",
    [id],
  );

  const attempts = (current?.attempts ?? 0) + 1;

  const delayMs = Math.min(2 ** attempts * 1000, 60_000);
  const nextRetryAt = new Date(Date.now() + delayMs).toISOString();

  await db.runAsync(
    `UPDATE sync_queue
     SET attempts = ?,
         last_error = ?,
         next_retry_at = ?
     WHERE id = ?`,
    [attempts, errorMessage, nextRetryAt, id],
  );
}

export async function resetQueueItemRetry(
  db: SQLiteDatabase,
  id: number,
): Promise<void> {
  await db.runAsync(
    `UPDATE sync_queue
     SET attempts = 0,
         last_error = NULL,
         next_retry_at = NULL
     WHERE id = ?`,
    [id],
  );
}

function parseQueueItemPayload(item: QueueItem): Record<string, any> {
  const rawPayload = item.payload ?? item.data;

  if (!rawPayload) {
    return {};
  }

  return JSON.parse(rawPayload);
}

export async function compactQueue(
  db: SQLiteDatabase,
  table?: string,
): Promise<void> {
  const rows = table
    ? await db.getAllAsync<QueueItem>(
        `SELECT * FROM sync_queue
         WHERE table_name = ?
         ORDER BY created_at ASC`,
        [table],
      )
    : await db.getAllAsync<QueueItem>(
        `SELECT * FROM sync_queue
         ORDER BY created_at ASC`,
      );

  const grouped = new Map<string, QueueItem[]>();

  for (const item of rows) {
    const payload = parseQueueItemPayload(item);
    const rowId = item.row_id ?? payload.id;

    if (!rowId) continue;

    const key = `${item.table_name}:${rowId}`;

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

    grouped.get(key)!.push(item);
  }

  for (const items of grouped.values()) {
    if (items.length <= 1) continue;

    const first = items[0];
    const last = items[items.length - 1];

    const firstPayload = parseQueueItemPayload(first);
    const lastPayload = parseQueueItemPayload(last);

    if (first.operation === "INSERT" && last.operation === "DELETE") {
      const ids = items.map((item) => item.id);
      await deleteQueueItems(db, ids);
      continue;
    }


    if (first.operation === "INSERT" && last.operation === "UPDATE") {
      await replaceQueueGroup(db, items, {
        operation: "INSERT",
        payload: {
          ...firstPayload,
          ...lastPayload,
        },
        baseVersion: null,
      });
      continue;
    }

    if (first.operation === "UPDATE" && last.operation === "UPDATE") {
      await replaceQueueGroup(db, items, {
        operation: "UPDATE",
        payload: {
          ...firstPayload,
          ...lastPayload,
        },
        baseVersion: first.base_version,
      });
      continue;
    }

    if (last.operation === "DELETE") {
      await replaceQueueGroup(db, items, {
        operation: "DELETE",
        payload: {
          id: last.row_id ?? lastPayload.id,
          deleted_at: lastPayload.deleted_at ?? new Date().toISOString(),
          updated_at: lastPayload.updated_at ?? new Date().toISOString(),
        },
        baseVersion: first.base_version,
      });
      continue;
    }
  }
}

async function deleteQueueItems(
  db: SQLiteDatabase,
  ids: number[],
): Promise<void> {
  if (ids.length === 0) return;

  const placeholders = ids.map(() => "?").join(", ");

  await db.runAsync(
    `DELETE FROM sync_queue WHERE id IN (${placeholders})`,
    ids,
  );
}

async function replaceQueueGroup(
  db: SQLiteDatabase,
  items: QueueItem[],
  replacement: {
    operation: QueueOperation;
    payload: Record<string, any>;
    baseVersion: number | null;
  },
): Promise<void> {
  const first = items[0];
  const last = items[items.length - 1];

  const parsedLastPayload = parseQueueItemPayload(last);

  const payload: Record<string, any> = {
    ...replacement.payload,
    client_operation_id:
      last.client_operation_id ?? parsedLastPayload.client_operation_id,
  };

  const payloadText = JSON.stringify(payload);
  const idsToDelete = items.map((item) => item.id);

  await deleteQueueItems(db, idsToDelete);

  await db.runAsync(
    `INSERT INTO sync_queue (
      table_name,
      operation,
      data,
      row_id,
      payload,
      base_version,
      client_operation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      first.table_name,
      replacement.operation,
      payloadText,
      first.row_id ?? payload.id,
      payloadText,
      replacement.baseVersion,
      payload.client_operation_id ?? null,
    ],
  );
}
