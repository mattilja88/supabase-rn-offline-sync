# offline-sync — Developer Guide

This guide explains how to use `offline-sync` in your React Native / Expo application. The library provides an offline-first architecture where:

- SQLite acts as the primary data source
- Supabase serves as the synchronization layer

## How it works

1. Data is always read from the local SQLite database
2. User changes are saved locally first
3. Changes are added to a `sync_queue`
4. When online, changes are pushed to Supabase
5. New changes from Supabase are pulled back to SQLite
6. Any conflicts are stored separately for resolution

This means your application works fully offline with no perceived latency.

## Main components

### `OfflineSyncProvider`
Initializes the SQLite database, creates tables and migrations, and exposes the database and Supabase client through React Context.

### `useOfflineFirst`
The primary hook for application code. Provides CRUD operations, sync controls, and synchronization state.

### `useSyncConflicts`
Hook for managing conflicts. Provides resolution strategies and conflict state.

### `useConflictHelpers`
UI-friendly API for common conflict resolution patterns.

## Setting up the Provider

```tsx
import { OfflineSyncProvider } from "offline-sync";
import { supabase } from "./lib/supabase";

const tables = [
  {
    name: "tasks",
    columns: `
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL
    `
  }
];

export default function App() {
  return (
    <OfflineSyncProvider supabaseClient={supabase} tables={tables}>
      <YourApp />
    </OfflineSyncProvider>
  );
}
```

The Provider automatically adds these system columns to every table:

- `created_at`
- `updated_at`
- `deleted_at`
- `version`
- `is_synced`

## Defining tables

Tables are defined in JavaScript and must match the structure of your Supabase tables.

```ts
{
  name: "tasks",
  columns: `
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    completed INTEGER DEFAULT 0
  `
}
```

**Requirements:**
- Every table must have an `id` column as the primary key
- The same columns must exist in your Supabase database
- Use SQLite-compatible types (TEXT, INTEGER, REAL, BLOB)

## Using `useOfflineFirst`

```ts
const {
  data,
  loading,
  isOnline,
  isSyncing,
  pendingChanges,
  pendingConflicts,
  create,
  update,
  remove,
  sync,
  refetch,
} = useOfflineFirst<Task>({ 
  table: "tasks",
  orderBy: "created_at",
  ascending: false,
});
```

### Creating records

```ts
await create({ title: "New task" });
```

The record is saved to SQLite immediately, added to the sync queue, and pushed to Supabase if online.

### Updating records

```ts
await update(id, { title: "Updated title" });
```

The current `version` is stored as `base_version` in the queue. If the version on the server has changed since, a conflict is created.

### Deleting records

```ts
await remove(id);
```

This is a soft delete — the row is marked with `deleted_at` and synchronized as a deletion. The row is not physically removed from SQLite until the server confirms.

### Manual synchronization

```ts
await sync();
```

This runs the full sync cycle:
1. Queue compaction (merges redundant operations)
2. Push changes to Supabase
3. Pull new changes from Supabase

## RPC-based synchronization

For tables where conflict detection is critical, enable RPC sync:

```ts
useOfflineFirst({ 
  table: "tasks",
  useRpcSync: true,
});
```

This requires Supabase RPC functions:
- `apply_sync_insert(table, payload)`
- `apply_sync_update(table, payload, base_version)`

These functions validate version numbers on the server side and reject updates that are based on outdated versions.

## Supabase requirements

Every synchronized table must include:

```sql
id uuid primary key
created_at timestamptz not null default now()
updated_at timestamptz not null default now()
deleted_at timestamptz
version integer not null default 1
last_client_operation_id text
client_operation_id uuid
```

## Conflict handling

A conflict occurs when local changes are based on a version that no longer matches the server version. Conflicts go through the following states:

```
pending → resolving → resolved
                   ↘ failed
```

### Resolution strategies

| Strategy | Description |
|----------|-------------|
| `server-wins` | Accept the server version as truth |
| `client-wins` | Send the local version to the server via force-update RPC |
| `manual-merge` | Apply a custom merged payload |
| `mark-resolved` | Skip the conflict without making changes |

### Resolving conflicts

```ts
import { resolveConflict } from "offline-sync";

await resolveConflict(db, conflict, "server-wins");
```

Or use the React hook:

```ts
const {
  conflicts,
  resolveServerWins,
  resolveClientWins,
  resolveManualMerge,
} = useSyncConflicts({ table: "tasks", remoteResolver });

await resolveServerWins(conflict);
```

### Important: manual-merge does not use INSERT OR REPLACE

The `manual-merge` strategy updates only the fields you provide, preserving fields that weren't included in the merge. This prevents accidental data loss when the merge payload is partial.

## Pull protection

Records with `is_synced = 0` (unsynchronized local changes) are never overwritten by pull operations. This ensures that user changes are never lost when new data arrives from the server.

## Version management

The server owns the canonical version of every record. The library tracks versions to detect conflicts but does not generate or modify version numbers — that responsibility belongs to the server.

## Queue compaction

Before pushing to the server, the library compacts redundant operations:

```
INSERT + UPDATE → INSERT (with merged data)
UPDATE + UPDATE → UPDATE (latest values)
INSERT + DELETE → removed entirely
```

This reduces network traffic and avoids race conditions on the server.

## Sync states

The hook returns a sync state which can be one of:

- `idle` — no operations in progress
- `syncing` — sync currently running
- `offline` — no network connection
- `error` — sync failed
- `conflict` — unresolved conflicts exist

## Network handling

The library automatically detects network state changes. When connectivity is restored, pending changes are pushed to the server automatically.

## Retry logic

Failed sync operations are retried with exponential backoff. You can manually reset the retry counter for a specific conflict:

```ts
await resetRetry(conflict);
```

## Developer checklist

- ✅ Wrap your app with `OfflineSyncProvider`
- ✅ Use `useOfflineFirst` for all data access
- ✅ Avoid calling Supabase directly when working with synchronized tables
- ✅ Include all required system columns in your Supabase tables
- ✅ Use RPC sync for tables with strict conflict detection requirements
- ✅ Handle conflicts in your UI when using `manual-merge`

## Current limitations

- The force-update RPC must be implemented manually for client-wins resolution
- No built-in automatic merge — `manual-merge` requires a payload from your application
- No UI components included — you build your own using the provided hooks

## Summary

`offline-sync` provides:

- An offline-first data layer with SQLite
- Reliable synchronization via a queue with retry logic
- Conflict detection based on version numbers
- Safe pull operations that never overwrite local changes

Your application works offline and maintains data integrity across devices.