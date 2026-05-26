import type { SQLiteDatabase } from "expo-sqlite";

/**
 * Lisää uuden rivin paikalliseen SQLite-tietokantaan.
 * Funktio suodattaa datasta pois tuntemattomat sarakkeet ja merkitsee rivin synkronoimattomaksi.
 */
export async function insertLocal(
  db: SQLiteDatabase,
  table: string,
  data: Record<string, any>,
): Promise<void> {
  const allowedColumns = await getTableColumns(db, table);

  const filteredData: Record<string, any> = {};
  for (const key of allowedColumns) {
    if (key in data && key !== "is_synced") {
      filteredData[key] = data[key];
    }
  }

  const dataColumns = Object.keys(filteredData);

  if (dataColumns.length === 0) {
    throw new Error(
      `insertLocal: Ei tallennettavia sarakkeita taululle "${table}".`,
    );
  }

  const columns = [...dataColumns, "is_synced"];
  const placeholders = columns.map(() => "?").join(", ");
  const values = [...dataColumns.map((col) => filteredData[col]), 0];

  await db.runAsync(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
    values,
  );
}

/**
 * Hakee rivejä paikallisesta tietokannasta annetusta taulusta.
 * Oletuksena soft delete -rivit piilotetaan, mutta ne voidaan hakea mukaan includeDeleted-asetuksella.
 */
export async function queryLocal<T>(
  db: SQLiteDatabase,
  table: string,
  options?: {
    where?: { column: string; value: any };
    orderBy?: string;
    ascending?: boolean;
    includeDeleted?: boolean;
  },
): Promise<T[]> {
  let sql = `SELECT * FROM ${table}`;
  const params: any[] = [];
  const whereClauses: string[] = [];

  if (!options?.includeDeleted) {
    whereClauses.push(`deleted_at IS NULL`);
  }

  if (options?.where) {
    whereClauses.push(`${options.where.column} = ?`);
    params.push(options.where.value);
  }

  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(" AND ")}`;
  }

  const defaultOrderColumns: Record<string, string> = {
    group_members: "joined_at",
  };

  const orderCol =
    options?.orderBy ?? defaultOrderColumns[table] ?? "created_at";

  const direction = options?.ascending ? "ASC" : "DESC";
  sql += ` ORDER BY ${orderCol} ${direction}`;

  if (params.length > 0) {
    return await db.getAllAsync<T>(sql, params);
  }

  return await db.getAllAsync<T>(sql);
}

/**
 * Päivittää paikallisen rivin ja merkitsee sen synkronoimattomaksi.
 * Päivitykseen lisätään automaattisesti uusi updated_at-aikaleima.
 */
export async function updateLocal(
  db: SQLiteDatabase,
  table: string,
  id: string,
  changes: Record<string, any>,
): Promise<void> {
  const allowedColumns = await getTableColumns(db, table);

  const updates: Record<string, any> = { updated_at: new Date().toISOString() };

  for (const key of Object.keys(changes)) {
    if (allowedColumns.includes(key) && key !== "is_synced") {
      updates[key] = changes[key];
    }
  }

  const setColumns = Object.keys(updates);

  if (setColumns.length === 0) {
    throw new Error(
      `updateLocal: Ei päivitettäviä sarakkeita taululle "${table}".`,
    );
  }

  const setClauses = [
    ...setColumns.map((col) => `${col} = ?`),
    "is_synced = ?",
  ].join(", ");

  const values = [...setColumns.map((col) => updates[col]), 0, id];

  await db.runAsync(`UPDATE ${table} SET ${setClauses} WHERE id = ?`, values);
}

/**
 * Toteuttaa paikallisen soft deleten eli merkitsee rivin poistetuksi deleted_at-kentällä.
 * Rivi jätetään tietokantaan, jotta poistomuutos voidaan synkronoida myöhemmin palvelimelle.
 */
export async function deleteLocal(
  db: SQLiteDatabase,
  table: string,
  id: string,
): Promise<void> {
  const now = new Date().toISOString();

  await db.runAsync(
    `UPDATE ${table}
     SET deleted_at = ?,
         updated_at = ?,
         is_synced = 0
     WHERE id = ?`,
    [now, now, id],
  );
}

/**
 * Välimuisti taulujen sarakkeille, jotta PRAGMA table_info -kyselyä ei tarvitse tehdä jokaisessa operaatiossa.
 * Tämä nopeuttaa paikallisia insert-, update- ja upsert-operaatioita.
 */
const tableColumnsCache: Record<string, string[]> = {};

/**
 * Hakee SQLite-taulun sarakenimet ja tallentaa ne välimuistiin.
 * Saraketietoja käytetään tuntemattomien kenttien suodattamiseen ennen SQL-kyselyitä.
 */
async function getTableColumns(
  db: SQLiteDatabase,
  table: string,
): Promise<string[]> {
  if (!tableColumnsCache[table]) {
    const result = await db.getAllAsync(`PRAGMA table_info(${table})`);
    tableColumnsCache[table] = result.map((col: any) => col.name);
  }

  return tableColumnsCache[table];
}

/**
 * Lisää tai korvaa palvelimelta saadun rivin paikalliseen SQLite-tietokantaan.
 * Rivi merkitään synkronoiduksi, koska sen oletetaan vastaavan palvelimen tilaa.
 */
export async function upsertFromRemote(
  db: SQLiteDatabase,
  table: string,
  data: Record<string, any>,
): Promise<void> {
  const allowedColumns = await getTableColumns(db, table);

  const filteredData: Record<string, any> = {};

  for (const key of allowedColumns) {
    if (key in data && key !== "is_synced") {
      filteredData[key] = data[key];
    }
  }

  const dataColumns = Object.keys(filteredData);

  if (dataColumns.length === 0) {
    throw new Error(
      `upsertFromRemote: Ei tallennettavia sarakkeita taululle "${table}".`,
    );
  }

  const columns = [...dataColumns, "is_synced"];
  const placeholders = columns.map(() => "?").join(", ");
  const values = [...dataColumns.map((col) => filteredData[col]), 1];

  await db.runAsync(
    `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
    values,
  );
}
