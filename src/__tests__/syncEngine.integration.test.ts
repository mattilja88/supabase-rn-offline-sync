import { syncTable } from "../syncEngine";
import { resolveConflict } from "../conflictResolution";
import { getConflicts } from "../offlineQueue";

jest.mock("expo-crypto", () => ({
  randomUUID: jest.fn(() => "operation-1"),
}));

type Row = Record<string, any>;

class FakeDb {
  tables: Record<string, Row[]> = {
    tasks: [
      {
        id: "task-1",
        title: "Local title",
        version: 1,
        is_synced: 0,
        deleted_at: null,
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    sync_queue: [
      {
        id: 1,
        table_name: "tasks",
        operation: "UPDATE",
        row_id: "task-1",
        payload: JSON.stringify({
          id: "task-1",
          title: "Local title",
          version: 1,
          client_operation_id: "operation-1",
        }),
        data: null,
        base_version: 1,
        client_operation_id: "operation-1",
        attempts: 0,
        last_error: null,
        next_retry_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    sync_conflicts: [],
  };

  async getAllAsync<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    if (sql.includes("PRAGMA table_info(tasks)")) {
      return [
        { name: "id" },
        { name: "title" },
        { name: "version" },
        { name: "is_synced" },
        { name: "deleted_at" },
        { name: "updated_at" },
      ] as T[];
    }
    if (sql.includes("FROM sync_queue")) {
      const table = params[0];
      return this.tables.sync_queue.filter(
        (item) => !table || item.table_name === table,
      ) as T[];
    }

    if (sql.includes("FROM sync_conflicts")) {
      const table = params[0];
      return this.tables.sync_conflicts.filter(
        (item) =>
          item.status === "pending" && (!table || item.table_name === table),
      ) as T[];
    }

    if (sql.includes("SELECT * FROM tasks")) {
      return this.tables.tasks as T[];
    }

    return [];
  }

  async getFirstAsync<T = any>(
    sql: string,
    params: any[] = [],
  ): Promise<T | null> {
    if (sql.includes("SELECT attempts FROM sync_queue")) {
      const id = params[0];
      return (this.tables.sync_queue.find((item) => item.id === id) ??
        null) as T | null;
    }

    if (sql.includes("SELECT attempts FROM sync_conflicts")) {
      const id = params[0];
      return (this.tables.sync_conflicts.find((item) => item.id === id) ??
        null) as T | null;
    }

    if (sql.includes("SELECT id FROM sync_conflicts")) {
      const [tableName, rowId] = params;
      return (this.tables.sync_conflicts.find(
        (item) =>
          item.table_name === tableName &&
          item.row_id === rowId &&
          item.status === "pending",
      ) ?? null) as T | null;
    }

    if (sql.includes("SELECT * FROM tasks WHERE id = ?")) {
      const id = params[0];
      return (this.tables.tasks.find((row) => row.id === id) ??
        null) as T | null;
    }

    if (sql.includes("PRAGMA table_info(tasks)")) {
      return null;
    }

    return null;
  }

  async runAsync(sql: string, params: any[] = []): Promise<void> {
    if (sql.startsWith("DELETE FROM sync_queue WHERE id = ?")) {
      const id = params[0];
      this.tables.sync_queue = this.tables.sync_queue.filter(
        (item) => item.id !== id,
      );
      return;
    }

    if (sql.includes("INSERT INTO sync_conflicts")) {
      const [
        tableName,
        rowId,
        operation,
        localPayload,
        remotePayload,
        baseVersion,
        remoteVersion,
        status,
      ] = params;

      this.tables.sync_conflicts.push({
        id: this.tables.sync_conflicts.length + 1,
        table_name: tableName,
        row_id: rowId,
        operation,
        local_payload: localPayload,
        remote_payload: remotePayload,
        base_version: baseVersion,
        remote_version: remoteVersion,
        status,
        attempts: 0,
        last_error: null,
        next_retry_at: null,
        created_at: new Date().toISOString(),
        resolved_at: null,
      });
      return;
    }

    if (
      sql.includes("UPDATE sync_conflicts") &&
      sql.includes("status = 'resolving'")
    ) {
      const [strategy, conflictId] = params;
      const conflict = this.tables.sync_conflicts.find(
        (item) => item.id === conflictId,
      );
      if (conflict) {
        conflict.status = "resolving";
        conflict.resolution_strategy = strategy;
      }
      return;
    }

    if (
      sql.includes("UPDATE sync_conflicts") &&
      sql.includes("status = 'resolved'")
    ) {
      const [resolvedAt, strategy, conflictId] = params;
      const conflict = this.tables.sync_conflicts.find(
        (item) => item.id === conflictId,
      );
      if (conflict) {
        conflict.status = "resolved";
        conflict.resolved_at = resolvedAt;
        conflict.resolution_strategy = strategy;
      }
      return;
    }

    if (
      sql.includes("UPDATE sync_conflicts") &&
      sql.includes("status = 'failed'")
    ) {
      const [attempts, lastError, nextRetryAt, conflictId] = params;
      const conflict = this.tables.sync_conflicts.find(
        (item) => item.id === conflictId,
      );
      if (conflict) {
        conflict.status = "failed";
        conflict.attempts = attempts;
        conflict.last_error = lastError;
        conflict.next_retry_at = nextRetryAt;
      }
      return;
    }

    if (sql.includes("UPDATE tasks") && sql.includes("SET is_synced = 1")) {
      const id = params[0];
      const row = this.tables.tasks.find((item) => item.id === id);
      if (row) {
        row.is_synced = 1;
      }
      return;
    }

    if (sql.includes("UPDATE tasks") && sql.includes("SET is_synced = 0")) {
      const id = params[params.length - 1];
      const row = this.tables.tasks.find((item) => item.id === id);
      if (row) {
        row.is_synced = 0;
      }
      return;
    }

    if (sql.includes("DELETE FROM tasks WHERE id = ?")) {
      const id = params[0];
      this.tables.tasks = this.tables.tasks.filter((row) => row.id !== id);
      return;
    }
  }

  async execAsync(): Promise<void> {
    return;
  }
}

function createSupabaseMock() {
  const remoteRow = {
    id: "task-1",
    title: "Remote title",
    version: 2,
    is_synced: undefined,
    deleted_at: null,
    updated_at: "2026-01-02T00:00:00.000Z",
  };

  return {
    from: jest.fn((table: string) => {
      const builder: any = {
        select: jest.fn(() => builder),
        eq: jest.fn(() => builder),
        maybeSingle: jest.fn(async () => ({
          data: remoteRow,
          error: null,
        })),
        order: jest.fn(() => builder),
        gt: jest.fn(() => builder),
        update: jest.fn(() => builder),
        upsert: jest.fn(() => builder),
        single: jest.fn(async () => ({
          data: {
            ...remoteRow,
            title: "Updated from client",
            version: 3,
          },
          error: null,
        })),
      };

      return builder;
    }),
    rpc: jest.fn(),
  };
}

describe("syncEngine integration", () => {
  it("tallentaa konfliktin, kun paikallinen update perustuu vanhaan versioon", async () => {
    const db = new FakeDb() as any;
    const supabase = createSupabaseMock() as any;

    const result = await syncTable(db, supabase, "tasks", null, {
      useRpc: false,
      conflictStrategy: "manual",
    });

    expect(result.pushed).toBe(0);
    expect(result.failed).toBe(false);

    const conflicts = await getConflicts(db, "tasks");

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual(
      expect.objectContaining({
        table_name: "tasks",
        row_id: "task-1",
        operation: "UPDATE",
        status: "pending",
        base_version: 1,
        remote_version: 2,
      }),
    );

    expect(db.tables.sync_queue).toHaveLength(0);
  });

  it("ratkaisee syntyneen konfliktin server-wins-strategialla", async () => {
    const db = new FakeDb() as any;
    const supabase = createSupabaseMock() as any;

    await syncTable(db, supabase, "tasks", null, {
      useRpc: false,
      conflictStrategy: "manual",
    });

    const [conflict] = await getConflicts(db, "tasks");

    await resolveConflict(db, conflict as any, "server-wins");

    expect(db.tables.sync_conflicts[0].status).toBe("resolved");
    expect(db.tables.sync_conflicts[0].resolution_strategy).toBe("server-wins");
  });
});
