import React, { createContext, useContext, useEffect, useState } from "react";
import * as SQLite from "expo-sqlite";
import { initQueue, initConflicts } from "./offlineQueue";

export interface TableDefinition {
  name: string;
  columns: string;
}

interface OfflineSyncContextType {
  db: SQLite.SQLiteDatabase | null;
  supabaseClient: any;
  isReady: boolean;
}

interface OfflineSyncProviderProps {
  supabaseClient: any;
  tables: TableDefinition[];
  databaseName?: string;
  children: React.ReactNode;
}

const OfflineSyncContext = createContext<OfflineSyncContextType>({
  db: null,
  supabaseClient: null,
  isReady: false,
});

/**
 * Palauttaa offline-sync-kontekstin, jonka kautta paketin hookit ja funktiot pääsevät käsiksi SQLiteen ja Supabaseen.
 * Jos provider ei ole vielä valmis, funktio varoittaa kehittäjää puuttuvasta tai keskeneräisestä alustuksesta.
 */
export function useOfflineContext() {
  const context = useContext(OfflineSyncContext);
  if (!context.db) {
    console.warn("[offline-sync] Provider ei ole valmis tai puuttuu");
  }
  return context;
}

/**
 * Lisää tauluun sarakkeen vain, jos sitä ei ole vielä olemassa.
 * Tätä käytetään turvallisiin paikallisiin migraatioihin, jotta vanhat tietokannat voidaan päivittää rikkomatta olemassa olevaa dataa.
 */
async function addColumnIfMissing(
  database: SQLite.SQLiteDatabase,
  tableName: string,
  columnName: string,
  columnDefinition: string,
): Promise<void> {
  const columns = await database.getAllAsync<{ name: string }>(
    `PRAGMA table_info(${tableName})`,
  );

  const exists = columns.some((column) => column.name === columnName);

  if (!exists) {
    await database.execAsync(
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`,
    );
  }
}

/**
 * Lisää synkronoinnin tarvitsemat metadata-sarakkeet paikalliseen tauluun.
 * Metadataa käytetään muun muassa soft deleteen, konfliktien tunnistukseen ja paikallisten muutosten synkronointitilaan.
 */
async function migrateOfflineTable(
  database: SQLite.SQLiteDatabase,
  tableName: string,
): Promise<void> {
  await addColumnIfMissing(database, tableName, "created_at", "TEXT");
  await addColumnIfMissing(database, tableName, "updated_at", "TEXT");
  await addColumnIfMissing(database, tableName, "deleted_at", "TEXT");
  await addColumnIfMissing(database, tableName, "version", "INTEGER DEFAULT 1");
  await addColumnIfMissing(
    database,
    tableName,
    "is_synced",
    "INTEGER DEFAULT 0",
  );

  await database.runAsync(
    `UPDATE ${tableName}
     SET version = 1
     WHERE version IS NULL`,
  );
}

/**
 * Alustaa paikallisen SQLite-tietokannan, sovelluksen määrittelemät taulut sekä synkronointiin liittyvät apurakenteet.
 * Provider jakaa tietokannan ja Supabase-clientin React Contextin kautta kaikille paketin käyttäville komponenteille.
 */
export function OfflineSyncProvider({
  supabaseClient,
  tables,
  databaseName = "offline-sync.db",
  children,
}: OfflineSyncProviderProps) {
  const [db, setDb] = useState<SQLite.SQLiteDatabase | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const init = async () => {
      try {
        const database = await SQLite.openDatabaseAsync(databaseName);
        await database.execAsync("PRAGMA journal_mode = WAL");

        for (const table of tables) {
          await database.execAsync(`
            CREATE TABLE IF NOT EXISTS ${table.name} (
              ${table.columns},
              is_synced INTEGER DEFAULT 0
            )
          `);

          await migrateOfflineTable(database, table.name);
        }

        await initQueue(database);
        await initConflicts(database);

        setDb(database);
        setIsReady(true);
      } catch (err) {
        console.error("[offline-sync] Alustus epäonnistui:", err);
      }
    };

    init();
  }, [databaseName]);

  if (!isReady) return null;

  return (
    <OfflineSyncContext.Provider value={{ db, supabaseClient, isReady }}>
      {children}
    </OfflineSyncContext.Provider>
  );
}