export { OfflineSyncProvider, useOfflineContext } from "./provider";
export { useOfflineFirst } from "./useOfflineFirst";

export {
  deleteLocal, insertLocal,
  queryLocal,
  updateLocal, upsertFromRemote
} from "./localDatabase";

export {
  addConflict, addToQueue, clearQueue, compactQueue, getConflicts, getQueue, getQueueCount, initQueue, markConflictResolved, removeFromQueue
} from "./offlineQueue";

export { pullChanges, pushChanges, syncTable } from "./syncEngine";

export type { QueueItem, QueueOperation } from "./offlineQueue";

export {
  resolveConflict,
} from "./conflictResolution";

export type {
  ResolveStrategy,
  SyncConflictForResolution,
  ConflictRemoteResolver,
} from "./conflictResolution";

export type { TableDefinition } from "./provider";

export { useSyncConflicts } from "./useSyncConflicts";

export { useConflictHelpers } from "./useConflictHelpers";

export { createSupabaseConflictResolver } from "./supabaseConflictResolver";


