import { useCallback } from "react";
import { useSyncConflicts } from "./useSyncConflicts";
import type { SyncConflictForResolution, ConflictRemoteResolver } from "./conflictResolution";

interface UseConflictHelpersOptions {
  table?: string;
  remoteResolver?: ConflictRemoteResolver;
}

export function useConflictHelpers(options: UseConflictHelpersOptions = {}) {
  const {
    conflicts,
    pendingConflicts,
    resolveServerWins,
    resolveClientWins,
    resolveManualMerge,
    markResolved,
  } = useSyncConflicts(options);

  const resolve = useCallback(
    async (
      conflict: SyncConflictForResolution,
      strategy: "server" | "client" | "merge" | "ignore",
      mergedPayload?: Record<string, any>,
    ) => {
      if (strategy === "server") {
        return resolveServerWins(conflict);
      }

      if (strategy === "client") {
        return resolveClientWins(conflict);
      }

      if (strategy === "merge") {
        return resolveManualMerge(conflict, mergedPayload || {});
      }

      if (strategy === "ignore") {
        return markResolved(conflict);
      }
    },
    [
      resolveServerWins,
      resolveClientWins,
      resolveManualMerge,
      markResolved,
    ],
  );

  const resolveServer = useCallback(
    (conflict: SyncConflictForResolution) =>
      resolveServerWins(conflict),
    [resolveServerWins],
  );

  const resolveClient = useCallback(
    (conflict: SyncConflictForResolution) =>
      resolveClientWins(conflict),
    [resolveClientWins],
  );

  const merge = useCallback(
    (
      conflict: SyncConflictForResolution,
      mergedPayload: Record<string, any>,
    ) => resolveManualMerge(conflict, mergedPayload),
    [resolveManualMerge],
  );

  const ignore = useCallback(
    (conflict: SyncConflictForResolution) =>
      markResolved(conflict),
    [markResolved],
  );

  return {
    conflicts,
    pendingConflicts,

    // generic
    resolve,

    // helpers
    resolveServer,
    resolveClient,
    merge,
    ignore,
  };
}