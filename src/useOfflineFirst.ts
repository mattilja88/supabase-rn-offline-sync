import { useState, useEffect, useCallback, useRef } from "react";
import { useOfflineContext } from "./provider";
import {
  insertLocal,
  queryLocal,
  updateLocal,
  deleteLocal,
} from "./localDatabase";
import { addToQueue, getQueueCount, getConflicts, SyncConflict } from "./offlineQueue";
import { syncTable } from "./syncEngine";
import { onNetworkChange } from "./networkMonitor";
import * as Crypto from "expo-crypto";

type SyncState = "idle" | "syncing" | "offline" | "error" | "conflict";
export type ConflictStrategy = "manual" | "client-wins" | "server-wins";

/**
 * Hakee paikallisen rivin nykyisen versionumeron ennen muutoksen jonottamista.
 * Tätä versiota käytetään myöhemmin konfliktien tunnistamiseen synkronoinnissa.
 */
async function getLocalRowVersion(
  db: any,
  table: string,
  id: string,
): Promise<number | null> {
  const row = await db.getFirstAsync(
    `SELECT version FROM ${table} WHERE id = ?`,
    [id],
  );

  return (row as any)?.version ?? null;
}

interface UseOfflineFirstOptions {
  table: string;
  orderBy?: string;
  ascending?: boolean;
  useRpcSync?: boolean;
  conflictStrategy?: ConflictStrategy;
}

/**
 * Pääasiallinen hook offline-first-datan lukemiseen, muokkaamiseen ja synkronointiin.
 * Hook käyttää SQLiteä ensisijaisena tietolähteenä ja jonottaa muutokset myöhempää Supabase-synkronointia varten.
 */
export function useOfflineFirst<T extends { id: string }>(
  options: UseOfflineFirstOptions,
) {
  const { db, supabaseClient } = useOfflineContext();
  const {
    table,
    orderBy = "created_at",
    ascending = false,
    useRpcSync = false,
    conflictStrategy = "manual",
  } = options;

  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [isOnline, setIsOnline] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingChanges, setPendingChanges] = useState(0);
  const [pendingConflicts, setPendingConflicts] = useState(0);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const lastSyncRef = useRef<string | null>(null);
  const isSyncingRef = useRef(false);

  /**
   * Lukee taulun datan paikallisesta SQLite-tietokannasta ja päivittää hookin tilan.
   * Samalla päivitetään odottavien muutosten ja ratkaisemattomien konfliktien määrät käyttöliittymää varten.
   */
  const fetchLocal = useCallback(async () => {
    if (!db) return;
    try {
      const rows = await queryLocal<T>(db, table, { orderBy, ascending });
      setData(rows);

      const count = await getQueueCount(db);
      setPendingChanges(count);

      const conflicts = await getConflicts(db, table);
      setConflicts(conflicts);
      setPendingConflicts(conflicts.length);

      if (conflicts.length > 0) {
        setSyncState("conflict");
      }
    } catch (err) {
      console.error(`[offline-sync] fetchLocal (${table}):`, err);
    }
  }, [db, table, orderBy, ascending]);

  /**
   * Synkronoi yhden taulun paikalliset muutokset Supabaseen ja hakee palvelimen muutokset takaisin SQLiteen.
   * Funktio estää päällekkäiset synkronoinnit ja päivittää syncState-tilan onnistumisen, virheen tai konfliktin mukaan.
   */
  const sync = useCallback(async () => {
    if (!db || !supabaseClient || isSyncingRef.current) return;

    if (!isOnline) {
      setSyncState("offline");
      return;
    }

    isSyncingRef.current = true;
    setIsSyncing(true);
    setSyncState("syncing");
    setLastSyncError(null);

    try {
      const result = await syncTable(
        db,
        supabaseClient,
        table,
        lastSyncRef.current,
        {
          useRpc: useRpcSync,
          conflictStrategy,
        },
      );

      lastSyncRef.current = result.syncTimestamp;

      await fetchLocal();

      const conflicts = await getConflicts(db, table);
      setPendingConflicts(conflicts.length);

      if (conflicts.length > 0) {
        setSyncState("conflict");
      } else if (result.failed) {
        setSyncState("error");
      } else {
        setSyncState("idle");
      }

      console.log(
        `[offline-sync] Sync (${table}): ${result.pushed} push, ${result.pulled} pull`,
      );
    } catch (err) {
      console.error(`[offline-sync] sync (${table}):`, err);

      const message = err instanceof Error ? err.message : JSON.stringify(err);

      setLastSyncError(message);
      setSyncState("error");
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [
    db,
    supabaseClient,
    table,
    isOnline,
    fetchLocal,
    useRpcSync,
    conflictStrategy,
  ]);

  /**
   * Luo uuden rivin ensin paikalliseen SQLiteen ja lisää INSERT-operaation synkronointijonoon.
   * Käyttöliittymä päivittyy heti paikallisen datan perusteella, ja synkronointi käynnistyy taustalla jos verkko on käytettävissä.
   */
  const create = useCallback(
    async (item: Omit<T, "id" | "created_at" | "updated_at">) => {
      if (!db) return null;

      const id = await Crypto.randomUUID();
      const now = new Date().toISOString();

      const localData: Record<string, any> = {
        ...item,
        id,
        created_at: now,
        updated_at: now,
        version: 1
      };

      const sqliteData = { ...localData };
      for (const key of Object.keys(sqliteData)) {
        if (typeof sqliteData[key] === "boolean") {
          sqliteData[key] = sqliteData[key] ? 1 : 0;
        }
      }

      try {
        await insertLocal(db, table, sqliteData);
        await addToQueue(db, table, "INSERT", localData);

        await fetchLocal();

        if (isOnline) {
          setTimeout(() => sync(), 100);
        }

        return id;
      } catch (err) {
        console.error(`[offline-sync] create (${table}):`, err);
        return null;
      }
    },
    [db, table, fetchLocal, isOnline, sync],
  );

  /**
   * Päivittää rivin paikallisesti ja lisää UPDATE-operaation synkronointijonoon.
   * Ennen muutosta talletetaan rivin base_version, jotta myöhempi synkronointi voi havaita konfliktit.
   */
  const update = useCallback(
    async (id: string, changes: Partial<T>) => {
      if (!db) return;

      const now = new Date().toISOString();
      const updatedChanges: Record<string, any> = {
        ...changes,
        updated_at: now,
      };

      const sqliteChanges = { ...updatedChanges };
      for (const key of Object.keys(sqliteChanges)) {
        if (typeof sqliteChanges[key] === "boolean") {
          sqliteChanges[key] = sqliteChanges[key] ? 1 : 0;
        }
      }

      try {
        const baseVersion = await getLocalRowVersion(db, table, id);

        await updateLocal(db, table, id, sqliteChanges);

        await addToQueue(
          db,
          table,
          "UPDATE",
          { id, ...updatedChanges },
          {
            rowId: id,
            baseVersion,
          },
        );

        await fetchLocal();

        if (isOnline) {
          setTimeout(() => sync(), 100);
        }
      } catch (err) {
        console.error(`[offline-sync] update (${table}):`, err);
      }
    },
    [db, table, fetchLocal, isOnline, sync],
  );

  /**
   * Poistaa rivin paikallisesti soft deletenä ja lisää DELETE-operaation synkronointijonoon.
   * Riviä ei poisteta heti fyysisesti, jotta poistomuutos voidaan välittää hallitusti palvelimelle.
   */
  const remove = useCallback(
    async (id: string) => {
      if (!db) return;

      try {
        const baseVersion = await getLocalRowVersion(db, table, id);

        await deleteLocal(db, table, id);

        await addToQueue(
          db,
          table,
          "DELETE",
          { id },
          {
            rowId: id,
            baseVersion,
          },
        );

        await fetchLocal();

        if (isOnline) {
          setTimeout(() => sync(), 100);
        }
      } catch (err) {
        console.error(`[offline-sync] remove (${table}):`, err);
      }
    },
    [db, table, fetchLocal, isOnline, sync],
  );

  /**
   * Kuuntelee verkkoyhteyden muutoksia ja käynnistää synkronoinnin, kun yhteys palautuu.
   * Tämä mahdollistaa offline-tilassa tehtyjen muutosten lähettämisen automaattisesti myöhemmin.
   */
  useEffect(() => {
    const unsubscribe = onNetworkChange((connected) => {
      setIsOnline(connected);
      if (connected) {
        setTimeout(() => sync(), 500);
      }
    });
    return () => unsubscribe();
  }, [sync, table]);

  /**
   * Alustaa hookin lukemalla paikallisen datan ja yrittämällä ensimmäistä synkronointia.
   * Paikallinen data näytetään ensin, jotta sovellus toimii nopeasti myös ilman verkkoyhteyttä.
   */
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await fetchLocal();
      setLoading(false);
      sync();
    };
    init();
  }, [fetchLocal]);

  return {
    data,
    loading,
    isOnline,
    isSyncing,
    pendingChanges,
    pendingConflicts,
    lastSyncError,
    syncState,
    create,
    update,
    remove,
    sync,
    conflicts,
    refetch: fetchLocal,
  };
}