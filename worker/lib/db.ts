/** Små hjelpere rundt D1 */

export async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...params).all<T>();
  return res.results ?? [];
}

export async function first<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
}

export async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<D1Result> {
  return db.prepare(sql).bind(...params).run();
}

/** Bygger INSERT fra et objekt (kun definerte nøkler) */
export function insert(db: D1Database, table: string, row: Record<string, unknown>): D1PreparedStatement {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
  return db.prepare(sql).bind(...keys.map((k) => normalize(row[k])));
}

/** Bygger UPDATE ... SET for tillatte felter som finnes i patch. Returnerer null hvis ingenting å oppdatere. */
export function update(
  db: D1Database,
  table: string,
  patch: Record<string, unknown>,
  allowed: readonly string[],
  where: { sql: string; params: unknown[] },
): D1PreparedStatement | null {
  const keys = allowed.filter((k) => k in patch && patch[k] !== undefined);
  if (keys.length === 0) return null;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const sql = `UPDATE ${table} SET ${sets} WHERE ${where.sql}`;
  return db.prepare(sql).bind(...keys.map((k) => normalize(patch[k])), ...where.params);
}

function normalize(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return v;
}
