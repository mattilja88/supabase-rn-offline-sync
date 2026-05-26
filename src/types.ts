export type ConflictStrategy = 'last-write-wins' | 'server-wins' | 'client-wins';

export interface OfflineConfig {
  table: string;
}

export interface SyncStatus {
  isOnline: boolean;
  isSyncing: boolean;
  pendingChanges: number;
  lastSyncedAt: string | null;
}

export interface TableDefinition {
  name: string;
  columns: string;
}