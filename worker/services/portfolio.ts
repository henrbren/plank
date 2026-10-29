import { z } from "zod";
import type { Env } from "../env";
import { all, first, insert, update } from "../lib/db";
import { assertCanEdit, assertCanEditEntity, assertFullScope, currentAccess, scopeSql, sees, seesProperty } from "../lib/access";
import { assertCanAddBuilding } from "../lib/billing";
import { badRequest, notFound } from "../lib/http";
import { optInt, optNum, optStr, reqStr } from "../lib/schemas";
import { newId, now } from "../lib/util";
import type { Building, Floor, Property, Room, TreeProperty } from "../../shared/types";

// ─── Skjemaer ────────────────────────────────────────────────────────────────

export const propertySchema = z.object({
  name: reqStr(),
  address: optStr(200),
  postal_code: optStr(10),
  city: optStr(100),
  municipality: optStr(100),
  gnr: optStr(20),
  bnr: optStr(20),
  description: optStr(4000),
});
export const PROPERTY_FIELDS = ["name", "address", "postal_code", "city", "municipality", "gnr", "bnr", "description"] as const;

export const buildingSchema = z.object({
  property_id: z.string().min(1),
  name: reqStr(),
  building_number: optStr(30),
  building_type: optStr(100),
  year_built: optInt(),
  gross_area: optNum(),
  description: optStr(4000),
  ifc_guid: optStr(64),
});
export const BUILDING_FIELDS = ["name", "building_number", "building_type", "year_built", "gross_area", "description", "ifc_guid"] as const;

export const floorSchema = z.object({
  building_id: z.string().min(1),
  name: reqStr(),
  level: optInt().transform((v) => v ?? 0),
  elevation: optNum(),
  gross_area: optNum(),
  ifc_guid: optStr(64),
});
export const FLOOR_FIELDS = ["name", "level", "elevation", "gross_area", "ifc_guid"] as const;

export const roomSchema = z.object({
  floor_id: z.string().min(1),
  name: reqStr(),
  number: optStr(30),
  usage: optStr(100),
  area: optNum(),
  ifc_guid: optStr(64),
});
export const ROOM_FIELDS = ["name", "number", "usage", "area", "ifc_guid"] as const;

/** Skjuler lagringsnøkkelen og sier bare om det finnes et bilde. */
export function withImage<T extends { image_key?: string | null }>(row: T): Omit<T, "image_key"> & { has_image: boolean } {
  const { image_key: _key, ...rest } = row;
  return { ...rest, has_image: Boolean(row.image_key) };
}

// ─── Tre ─────────────────────────────────────────────────────────────────────

export async function getTree(env: Env, orgId: string): Promise<TreeProperty[]> {
  const [props, blds, flrs, rms] = await env.DB.batch<any>([
    env.DB.prepare(`SELECT id, name, city, updated_at, image_key IS NOT NULL AS has_image FROM properties WHERE org_id = ? ORDER BY name`).bind(orgId),
    env.DB.prepare(`SELECT id, property_id, name, updated_at, image_key IS NOT NULL AS has_image FROM buildings WHERE org_id = ? ORDER BY name`).bind(orgId),
    env.DB.prepare(`SELECT id, building_id, name, level FROM floors WHERE org_id = ? ORDER BY level, name`).bind(orgId),
    env.DB.prepare(`SELECT id, floor_id, name, number FROM rooms WHERE org_id = ? ORDER BY number, name`).bind(orgId),
  ]);
  const access = currentAccess();
  const roomsByFloor = new Map<string, any[]>();
  for (const r of rms!.results) {
    const list = roomsByFloor.get(r.floor_id) ?? [];
    list.push({ id: r.id, name: r.name, number: r.number });
    roomsByFloor.set(r.floor_id, list);
  }
  const floorsByBuilding = new Map<string, any[]>();
  for (const f of flrs!.results) {
    const list = floorsByBuilding.get(f.building_id) ?? [];
    list.push({ id: f.id, name: f.name, level: f.level, rooms: roomsByFloor.get(f.id) ?? [] });
    floorsByBuilding.set(f.building_id, list);
  }
  const buildingsByProperty = new Map<string, any[]>();
  for (const b of blds!.results) {
    if (!sees({ building_id: b.id }, access)) continue;
    const list = buildingsByProperty.get(b.property_id) ?? [];
    list.push({ id: b.id, name: b.name, has_image: Boolean(b.has_image), updated_at: b.updated_at, floors: floorsByBuilding.get(b.id) ?? [] });
    buildingsByProperty.set(b.property_id, list);
  }
  return props!.results.filter((p: any) => seesProperty(p.id, access)).map((p: any) => ({
    id: p.id,
    name: p.name,
    city: p.city,
    has_image: Boolean(p.has_image),
    updated_at: p.updated_at,
    buildings: buildingsByProperty.get(p.id) ?? [],
  }));
}

// ─── Plassering ──────────────────────────────────────────────────────────────

export interface Location {
  property_id: string | null;
  building_id: string | null;
  floor_id: string | null;
  room_id: string | null;
}

/**
 * Validerer at plasseringen tilhører organisasjonen og fyller inn foreldre.
 * Det mest spesifikke nivået vinner (rom → etasje → bygg → eiendom).
 */
export async function resolveLocation(env: Env, orgId: string, loc: Partial<Location>): Promise<Location> {
  if (loc.room_id) {
    const r = await first<{ floor_id: string; building_id: string; property_id: string }>(
      env.DB,
      `SELECT r.floor_id, r.building_id, b.property_id FROM rooms r JOIN buildings b ON b.id = r.building_id WHERE r.id = ? AND r.org_id = ?`,
      loc.room_id,
      orgId,
    );
    if (!r) throw notFound("Rommet");
    return { property_id: r.property_id, building_id: r.building_id, floor_id: r.floor_id, room_id: loc.room_id };
  }
  if (loc.floor_id) {
    const f = await first<{ building_id: string; property_id: string }>(
      env.DB,
      `SELECT f.building_id, b.property_id FROM floors f JOIN buildings b ON b.id = f.building_id WHERE f.id = ? AND f.org_id = ?`,
      loc.floor_id,
      orgId,
    );
    if (!f) throw notFound("Etasjen");
    return { property_id: f.property_id, building_id: f.building_id, floor_id: loc.floor_id, room_id: null };
  }
  if (loc.building_id) {
    const b = await first<{ property_id: string }>(env.DB, `SELECT property_id FROM buildings WHERE id = ? AND org_id = ?`, loc.building_id, orgId);
    if (!b) throw notFound("Bygget");
    return { property_id: b.property_id, building_id: loc.building_id, floor_id: null, room_id: null };
  }
  if (loc.property_id) {
    const p = await first(env.DB, `SELECT id FROM properties WHERE id = ? AND org_id = ?`, loc.property_id, orgId);
    if (!p) throw notFound("Eiendommen");
    return { property_id: loc.property_id, building_id: null, floor_id: null, room_id: null };
  }
  return { property_id: null, building_id: null, floor_id: null, room_id: null };
}

/** Som resolveLocation, men krever at brukeren kan legge ting på stedet */
export async function resolveWritableLocation(env: Env, orgId: string, loc: Partial<Location>): Promise<Location> {
  const resolved = await resolveLocation(env, orgId, loc);
  assertCanEdit(resolved);
  return resolved;
}

/** Lesbar beskrivelse av en plassering, f.eks. «Sagbruket › Hovedbygg › 2. etasje › Pantry» */
export async function describeLocation(env: Env, loc: Partial<Location>): Promise<string> {
  const parts: string[] = [];
  if (loc.property_id) {
    const p = await first<{ name: string }>(env.DB, `SELECT name FROM properties WHERE id = ?`, loc.property_id);
    if (p) parts.push(p.name);
  }
  if (loc.building_id) {
    const b = await first<{ name: string }>(env.DB, `SELECT name FROM buildings WHERE id = ?`, loc.building_id);
    if (b) parts.push(b.name);
  }
  if (loc.floor_id) {
    const f = await first<{ name: string }>(env.DB, `SELECT name FROM floors WHERE id = ?`, loc.floor_id);
    if (f) parts.push(f.name);
  }
  if (loc.room_id) {
    const r = await first<{ name: string; number: string | null }>(env.DB, `SELECT name, number FROM rooms WHERE id = ?`, loc.room_id);
    if (r) parts.push(r.number ? `${r.number} ${r.name}` : r.name);
  }
  return parts.join(" › ");
}

// ─── Eiendommer ──────────────────────────────────────────────────────────────

export async function listProperties(env: Env, orgId: string) {
  const props = scopeSql({ property: "p.id" });
  const blds = scopeSql({ building: "b.id" });
  const rows = await all<Property & { building_count: number; image_key?: string | null }>(
    env.DB,
    `SELECT p.*, (SELECT COUNT(*) FROM buildings b WHERE b.property_id = p.id AND ${blds.sql}) AS building_count
     FROM properties p WHERE p.org_id = ? AND ${props.sql} ORDER BY p.name`,
    ...blds.params,
    orgId,
    ...props.params,
  );
  return rows.map((row) => withImage(row));
}

export async function getProperty(env: Env, orgId: string, id: string) {
  const property = await first<Property>(env.DB, `SELECT * FROM properties WHERE id = ? AND org_id = ?`, id, orgId);
  if (!property || !seesProperty(id)) throw notFound("Eiendommen");
  const blds = scopeSql({ building: "b.id" });
  const buildings = await all<Building & { floor_count: number; open_tasks: number; document_count: number; image_key?: string | null }>(
    env.DB,
    `SELECT b.*,
       (SELECT COUNT(*) FROM floors f WHERE f.building_id = b.id) AS floor_count,
       (SELECT COUNT(*) FROM tasks t WHERE t.building_id = b.id AND t.status IN ('open','in_progress')) AS open_tasks,
       (SELECT COUNT(*) FROM documents d WHERE d.building_id = b.id) AS document_count
     FROM buildings b WHERE b.property_id = ? AND b.org_id = ? AND ${blds.sql} ORDER BY b.name`,
    id,
    orgId,
    ...blds.params,
  );
  const docScope = scopeSql({ building: "building_id", property: "property_id" });
  const docs = await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM documents WHERE property_id = ? AND org_id = ? AND ${docScope.sql}`, id, orgId, ...docScope.params);
  return { ...withImage(property as Property & { image_key?: string | null }), buildings: buildings.map((b) => withImage(b)), document_count: docs?.n ?? 0 };
}

export async function createProperty(env: Env, orgId: string, input: z.infer<typeof propertySchema>) {
  assertCanEdit();
  assertFullScope("Å opprette eiendommer");
  const id = newId("prp");
  const t = now();
  await insert(env.DB, "properties", { id, org_id: orgId, ...input, created_at: t, updated_at: t }).run();
  return withImage((await first<Property & { image_key?: string | null }>(env.DB, `SELECT * FROM properties WHERE id = ?`, id))!);
}

export async function updateProperty(env: Env, orgId: string, id: string, patch: Record<string, unknown>) {
  assertCanEdit({ property_id: id });
  const stmt = update(env.DB, "properties", { ...patch, updated_at: now() }, [...PROPERTY_FIELDS, "updated_at"], { sql: "id = ? AND org_id = ?", params: [id, orgId] });
  if (stmt) {
    const res = await stmt.run();
    if (!res.meta.changes) throw notFound("Eiendommen");
  }
  return withImage((await first<Property & { image_key?: string | null }>(env.DB, `SELECT * FROM properties WHERE id = ?`, id))!);
}

// ─── Bygg ────────────────────────────────────────────────────────────────────

export async function getBuilding(env: Env, orgId: string, id: string) {
  const building = await first<Building & { property_name: string }>(
    env.DB,
    `SELECT b.*, p.name AS property_name FROM buildings b JOIN properties p ON p.id = b.property_id WHERE b.id = ? AND b.org_id = ?`,
    id,
    orgId,
  );
  if (!building || !sees({ building_id: id })) throw notFound("Bygget");
  const floors = await all<Floor & { room_count: number; room_area: number | null }>(
    env.DB,
    `SELECT f.*, (SELECT COUNT(*) FROM rooms r WHERE r.floor_id = f.id) AS room_count, (SELECT SUM(area) FROM rooms r WHERE r.floor_id = f.id) AS room_area
     FROM floors f WHERE f.building_id = ? ORDER BY f.level, f.name`,
    id,
  );
  const [stats] = await env.DB.batch<{ documents: number; components: number; open_tasks: number; artifacts: number; ifc_models: number }>([
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM documents WHERE building_id = ?1) AS documents,
         (SELECT COUNT(*) FROM components WHERE building_id = ?1) AS components,
         (SELECT COUNT(*) FROM tasks WHERE building_id = ?1 AND status IN ('open','in_progress')) AS open_tasks,
         (SELECT COUNT(*) FROM artifacts WHERE building_id = ?1) AS artifacts,
         (SELECT COUNT(*) FROM documents WHERE building_id = ?1 AND kind = 'ifc') AS ifc_models`,
    ).bind(id),
  ]);
  return { ...withImage(building as Building & { property_name: string; image_key?: string | null }), floors, stats: stats?.results?.[0] ?? null };
}

export async function createBuilding(env: Env, orgId: string, input: z.infer<typeof buildingSchema>) {
  const prop = await first(env.DB, `SELECT id FROM properties WHERE id = ? AND org_id = ?`, input.property_id, orgId);
  if (!prop) throw notFound("Eiendommen");
  assertCanEdit({ property_id: input.property_id });
  await assertCanAddBuilding(env, orgId);
  const id = newId("bld");
  const t = now();
  await insert(env.DB, "buildings", { id, org_id: orgId, ...input, created_at: t, updated_at: t }).run();
  return withImage((await first<Building & { image_key?: string | null }>(env.DB, `SELECT * FROM buildings WHERE id = ?`, id))!);
}

export async function updateBuilding(env: Env, orgId: string, id: string, patch: Record<string, unknown>) {
  assertCanEdit({ building_id: id });
  const stmt = update(env.DB, "buildings", { ...patch, updated_at: now() }, [...BUILDING_FIELDS, "updated_at"], { sql: "id = ? AND org_id = ?", params: [id, orgId] });
  if (stmt) {
    const res = await stmt.run();
    if (!res.meta.changes) throw notFound("Bygget");
  }
  return withImage((await first<Building & { image_key?: string | null }>(env.DB, `SELECT * FROM buildings WHERE id = ?`, id))!);
}

// ─── Etasjer ─────────────────────────────────────────────────────────────────

export async function getFloor(env: Env, orgId: string, id: string) {
  const floor = await first<Floor & { building_name: string; property_id: string; property_name: string }>(
    env.DB,
    `SELECT f.*, b.name AS building_name, b.property_id, p.name AS property_name
     FROM floors f JOIN buildings b ON b.id = f.building_id JOIN properties p ON p.id = b.property_id WHERE f.id = ? AND f.org_id = ?`,
    id,
    orgId,
  );
  if (!floor || !sees({ building_id: floor.building_id })) throw notFound("Etasjen");
  const rooms = await all<Room & { component_count: number }>(
    env.DB,
    `SELECT r.*, (SELECT COUNT(*) FROM components c WHERE c.room_id = r.id) AS component_count FROM rooms r WHERE r.floor_id = ? ORDER BY r.number, r.name`,
    id,
  );
  return { ...floor, rooms };
}

export async function createFloor(env: Env, orgId: string, input: z.infer<typeof floorSchema>) {
  const b = await first(env.DB, `SELECT id FROM buildings WHERE id = ? AND org_id = ?`, input.building_id, orgId);
  if (!b) throw notFound("Bygget");
  assertCanEdit({ building_id: input.building_id });
  const id = newId("flr");
  const t = now();
  await insert(env.DB, "floors", { id, org_id: orgId, ...input, created_at: t, updated_at: t }).run();
  return (await first<Floor>(env.DB, `SELECT * FROM floors WHERE id = ?`, id))!;
}

export async function updateFloor(env: Env, orgId: string, id: string, patch: Record<string, unknown>) {
  await assertCanEditEntity(env, orgId, "floor", id, "Etasjen");
  const stmt = update(env.DB, "floors", { ...patch, updated_at: now() }, [...FLOOR_FIELDS, "updated_at"], { sql: "id = ? AND org_id = ?", params: [id, orgId] });
  if (stmt) {
    const res = await stmt.run();
    if (!res.meta.changes) throw notFound("Etasjen");
  }
  return (await first<Floor>(env.DB, `SELECT * FROM floors WHERE id = ?`, id))!;
}

// ─── Rom ─────────────────────────────────────────────────────────────────────

export async function getRoom(env: Env, orgId: string, id: string) {
  const room = await first<Room & { floor_name: string; building_name: string; property_id: string }>(
    env.DB,
    `SELECT r.*, f.name AS floor_name, b.name AS building_name, b.property_id FROM rooms r
     JOIN floors f ON f.id = r.floor_id JOIN buildings b ON b.id = r.building_id WHERE r.id = ? AND r.org_id = ?`,
    id,
    orgId,
  );
  if (!room || !sees({ building_id: room.building_id })) throw notFound("Rommet");
  return room;
}

export async function createRoom(env: Env, orgId: string, input: z.infer<typeof roomSchema>) {
  const f = await first<{ building_id: string }>(env.DB, `SELECT building_id FROM floors WHERE id = ? AND org_id = ?`, input.floor_id, orgId);
  if (!f) throw notFound("Etasjen");
  assertCanEdit({ building_id: f.building_id });
  const id = newId("rom");
  const t = now();
  await insert(env.DB, "rooms", { id, org_id: orgId, building_id: f.building_id, ...input, created_at: t, updated_at: t }).run();
  return (await first<Room>(env.DB, `SELECT * FROM rooms WHERE id = ?`, id))!;
}

export async function updateRoom(env: Env, orgId: string, id: string, patch: Record<string, unknown>) {
  await assertCanEditEntity(env, orgId, "room", id, "Rommet");
  if ("floor_id" in patch && patch.floor_id) {
    const f = await first<{ building_id: string }>(env.DB, `SELECT building_id FROM floors WHERE id = ? AND org_id = ?`, patch.floor_id, orgId);
    if (!f) throw badRequest("Ukjent etasje");
    assertCanEdit({ building_id: f.building_id });
    patch.building_id = f.building_id;
  }
  const stmt = update(env.DB, "rooms", { ...patch, updated_at: now() }, [...ROOM_FIELDS, "floor_id", "building_id", "updated_at"], {
    sql: "id = ? AND org_id = ?",
    params: [id, orgId],
  });
  if (stmt) {
    const res = await stmt.run();
    if (!res.meta.changes) throw notFound("Rommet");
  }
  return (await first<Room>(env.DB, `SELECT * FROM rooms WHERE id = ?`, id))!;
}

export async function getPlaceImageKey(env: Env, orgId: string, kind: "property" | "building", id: string): Promise<string | null> {
  const table = kind === "property" ? "properties" : "buildings";
  const row = await first<{ image_key: string | null }>(env.DB, `SELECT image_key FROM ${table} WHERE id = ? AND org_id = ?`, id, orgId);
  const visible = kind === "property" ? seesProperty(id) : sees({ building_id: id });
  if (!row || !visible) throw notFound(kind === "property" ? "Eiendommen" : "Bygget");
  return row.image_key;
}

export async function setPlaceImage(env: Env, orgId: string, kind: "property" | "building", id: string, imageKey: string | null) {
  assertCanEdit(kind === "property" ? { property_id: id } : { building_id: id });
  const table = kind === "property" ? "properties" : "buildings";
  const res = await env.DB.prepare(`UPDATE ${table} SET image_key = ?, updated_at = ? WHERE id = ? AND org_id = ?`).bind(imageKey, now(), id, orgId).run();
  if (!res.meta.changes) throw notFound(kind === "property" ? "Eiendommen" : "Bygget");
}

/** Bildenøkler som skal slettes fra R2 når eiendommen eller bygget slettes. */
export async function imageKeysToRemove(env: Env, orgId: string, kind: string, id: string): Promise<string[]> {
  if (kind === "building") {
    const row = await first<{ image_key: string | null }>(env.DB, `SELECT image_key FROM buildings WHERE id = ? AND org_id = ?`, id, orgId);
    return row?.image_key ? [row.image_key] : [];
  }
  if (kind === "property") {
    const rows = await all<{ image_key: string | null }>(
      env.DB,
      `SELECT image_key FROM properties WHERE id = ?1 AND org_id = ?2 AND image_key IS NOT NULL
       UNION ALL
       SELECT image_key FROM buildings WHERE property_id = ?1 AND org_id = ?2 AND image_key IS NOT NULL`,
      id,
      orgId,
    );
    return rows.flatMap((r) => (r.image_key ? [r.image_key] : []));
  }
  return [];
}

export const deleteSql: Record<string, string> = {
  property: `DELETE FROM properties WHERE id = ? AND org_id = ?`,
  building: `DELETE FROM buildings WHERE id = ? AND org_id = ?`,
  floor: `DELETE FROM floors WHERE id = ? AND org_id = ?`,
  room: `DELETE FROM rooms WHERE id = ? AND org_id = ?`,
};

