import { useCallback, useEffect, useState } from "react";
import { useOfflineContext } from "./provider";
import { getConflicts, resetConflictRetry } from "./offlineQueue";
import {
  resolveConflict,
  type ConflictRemoteResolver,
  type ResolveStrategy,
  type SyncConflictForResolution,
} from "./conflictResolution";

interface UseSyncConflictsOptions {
  table?: string;
  remoteResolver?: ConflictRemoteResolver;
}

interface UseSyncConflictsResult {
  conflicts: SyncConflictForResolution[];
  pendingConflicts: number;
  loading: boolean;
  error: string | null;
  refetchConflicts: () => Promise<void>;
  resolveServerWins: (conflict: SyncConflictForResolution) => Promise<void>;
  resolveClientWins: (conflict: SyncConflictForResolution) => Promise<void>;
  resolveManualMerge: (
    conflict: SyncConflictForResolution,
    mergedPayload: Record<string, any>,
  ) => Promise<void>;
  markResolved: (conflict: SyncConflictForResolution) => Promise<void>;
  resetRetry: (conflict: SyncConflictForResolution) => Promise<void>;
}

export function useSyncConflicts(
  options: UseSyncConflictsOptions = {},
): UseSyncConflictsResult {
  const { db } = useOfflineContext();
  const { table, remoteResolver } = options;

  const [conflicts, setConflicts] = useState<SyncConflictForResolution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);


  const refetchConflicts = useCallback(async () => {
    if (!db) return;

    setLoading(true);
    setError(null);

    try {
      const rows = await getConflicts(db, table);

      setConflicts(rows as SyncConflictForResolution[]);
    } catch (err) {
      const message = err instanceof Error ? err.message : JSON.stringify(err);

      console.error("[offline-sync] Konfliktien haku epäonnistui:", err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [db, table]);

  const resolveWithStrategy = useCallback(
    async (
      conflict: SyncConflictForResolution,
      strategy: ResolveStrategy,
      mergedPayload?: Record<string, any>,
    ) => {
      if (!db) return;

      setError(null);

      try {
        await resolveConflict(db, conflict, strategy, {
          remoteResolver,
          mergedPayload,
        });

        await refetchConflicts();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : JSON.stringify(err);

        console.error(
          `[offline-sync] Konfliktin ratkaisu epäonnistui (${strategy}):`,
          err,
        );

        setError(message);
        throw err;
      }
    },
    [db, remoteResolver, refetchConflicts],
  );

  const resolveServerWins = useCallback(
    async (conflict: SyncConflictForResolution) => {
      await resolveWithStrategy(conflict, "server-wins");
    },
    [resolveWithStrategy],
  );

  const resolveClientWins = useCallback(
    async (conflict: SyncConflictForResolution) => {
      if (!remoteResolver) {
        throw new Error(
          "client-wins vaatii remoteResolverin, jotta ratkaisu voidaan lähettää palvelimelle.",
        );
      }

      await resolveWithStrategy(conflict, "client-wins");
    },
    [remoteResolver, resolveWithStrategy],
  );

  const resolveManualMerge = useCallback(
    async (
      conflict: SyncConflictForResolution,
      mergedPayload: Record<string, any>,
    ) => {
      await resolveWithStrategy(conflict, "manual-merge", mergedPayload);
    },
    [resolveWithStrategy],
  );

  const markResolved = useCallback(
    async (conflict: SyncConflictForResolution) => {
      await resolveWithStrategy(conflict, "mark-resolved");
    },
    [resolveWithStrategy],
  );

  const resetRetry = useCallback(
    async (conflict: SyncConflictForResolution) => {
      if (!db) return;

      setError(null);

      try {
        await resetConflictRetry(db, conflict.id);
        await refetchConflicts();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : JSON.stringify(err);

        console.error(
          "[offline-sync] Konfliktin retry-reset epäonnistui:",
          err,
        );
        setError(message);
        throw err;
      }
    },
    [db, refetchConflicts],
  );

  useEffect(() => {
    refetchConflicts();
  }, [refetchConflicts]);

  return {
    conflicts,
    pendingConflicts: conflicts.length,
    loading,
    error,
    refetchConflicts,
    resolveServerWins,
    resolveClientWins,
    resolveManualMerge,
    markResolved,
    resetRetry,
  };
}
