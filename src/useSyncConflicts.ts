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

/**
 * Hook synkronointikonfliktien hakemiseen ja ratkaisemiseen.
 *
 * Hook kapseloi konfliktien käsittelyn sovellustasolle:
 * - hakee pending-tilassa olevat konfliktit,
 * - palauttaa konfliktien määrän,
 * - tarjoaa valmiit apufunktiot eri ratkaisustrategioille,
 * - päivittää konfliktit automaattisesti ratkaisun jälkeen.
 *
 * remoteResolver on pakollinen client-wins- ja manual-merge-strategioille,
 * koska ne lähettävät ratkaisun palvelimelle.
 */
export function useSyncConflicts(
  options: UseSyncConflictsOptions = {},
): UseSyncConflictsResult {
  const { db } = useOfflineContext();
  const { table, remoteResolver } = options;

  const [conflicts, setConflicts] = useState<SyncConflictForResolution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Hakee ratkaisemattomat konfliktit paikallisesta sync_conflicts-taulusta.
   * Jos table on annettu, palautetaan vain kyseisen taulun konfliktit.
   */
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

  /**
   * Yleinen sisäinen apufunktio konfliktin ratkaisemiseen.
   * Päivittää konfliktien listan ratkaisun jälkeen.
   */
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

  /**
   * Ratkaisee konfliktin hyväksymällä palvelimen version.
   * Tämä ei vaadi remoteResolveria, koska remote_payload on jo tallennettu konfliktiin.
   */
  const resolveServerWins = useCallback(
    async (conflict: SyncConflictForResolution) => {
      await resolveWithStrategy(conflict, "server-wins");
    },
    [resolveWithStrategy],
  );

  /**
   * Ratkaisee konfliktin hyväksymällä paikallisen version.
   * Tämä vaatii remoteResolverin, jotta paikallinen versio voidaan viedä palvelimelle.
   */
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

  /**
   * Ratkaisee konfliktin käyttämällä sovelluksen muodostamaa yhdistettyä payloadia.
   * Tämä vaatii remoteResolverin, koska yhdistetty versio lähetetään palvelimelle.
   */
  const resolveManualMerge = useCallback(
    async (
      conflict: SyncConflictForResolution,
      mergedPayload: Record<string, any>,
    ) => {
      await resolveWithStrategy(conflict, "manual-merge", mergedPayload);
    },
    [resolveWithStrategy],
  );

  /**
   * Merkitsee konfliktin ratkaistuksi ilman datamuutoksia.
   * Tätä kannattaa käyttää vain poikkeustilanteissa tai debug-käytössä.
   */
  const markResolved = useCallback(
    async (conflict: SyncConflictForResolution) => {
      await resolveWithStrategy(conflict, "mark-resolved");
    },
    [resolveWithStrategy],
  );

  /**
   * Nollaa konfliktin retry-tiedot ja hakee konfliktit uudelleen.
   * Tämän avulla käyttäjä voi yrittää epäonnistuneen konfliktin ratkaisua heti uudestaan.
   */
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

  /**
   * Hakee konfliktit automaattisesti, kun hook otetaan käyttöön
   * tai kun taulu vaihtuu.
   */
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
