import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { logActivity } from "../lib/activity";
import { all, first, insert } from "../lib/db";
import { badRequest, body } from "../lib/http";
import { newId, now, parseJson } from "../lib/util";
import type { IfcSummary } from "../../shared/types";

export const ifc = new Hono<AppEnv>();

const MAX_ELEMENTS = 30_000;

const importSchema = z.object({
  document_id: z.string().min(1),
  schema: z.string().max(40).default("IFC"),
  storeys: z
    .array(
      z.object({
        guid: z.string().max(64),
        name: z.string().max(200),
        elevation: z.number().nullable(),
        spaces: z.array(z.object({ guid: z.string().max(64), name: z.string().max(200), long_name: z.string().max(200).nullable(), area: z.number().nullable() })).max(5000),
      }),
    )
    .max(500),
  elements: z
    .array(
      z.object({
        express_id: z.number().int(),
        guid: z.string().max(64).nullable(),
        ifc_type: z.string().max(80),
        name: z.string().max(300).nullable(),
        storey: z.string().max(200).nullable(),
        props: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(MAX_ELEMENTS),
  create_locations: z.boolean().default(true),
});

/** Setter inn mange rader via json_each – én bundet parameter per stor bit (D1 tillater maks 100 parametere per spørring) */
async function bulkInsertElements(env: Env, docId: string, orgId: string, buildingId: string | null, elements: z.infer<typeof importSchema>["elements"]) {
  const rows = elements.map((e) => ({ e: e.express_id, g: e.guid, t: e.ifc_type, n: e.name, s: e.storey, p: e.props ? JSON.stringify(e.props).slice(0, 4000) : null }));
  let batch: typeof rows = [];
  let size = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO ifc_elements (document_id, org_id, building_id, express_id, guid, ifc_type, name, storey, props)
       SELECT ?1, ?2, ?3, json_extract(value, '$.e'), json_extract(value, '$.g'), json_extract(value, '$.t'), json_extract(value, '$.n'), json_extract(value, '$.s'), json_extract(value, '$.p')
       FROM json_each(?4)`,
    )
      .bind(docId, orgId, buildingId, JSON.stringify(batch))
      .run();
    batch = [];
    size = 0;
  };
  for (const r of rows) {
    const len = JSON.stringify(r).length;
    if (size + len > 700_000) await flush();
    batch.push(r);
    size += len;
  }
  await flush();
}

ifc.post("/import", async (c) => {
  const orgId = c.get("orgId");
  const input = await body(c, importSchema);
  const doc = await first<{ id: string; building_id: string | null; title: string }>(
    c.env.DB,
    `SELECT id, building_id, title FROM documents WHERE id = ? AND org_id = ?`,
    input.document_id,
    orgId,
  );
  if (!doc) throw badRequest("Ukjent dokument");
  const t = now();

  // Elementindeks
  await c.env.DB.prepare(`DELETE FROM ifc_elements WHERE document_id = ?`).bind(doc.id).run();
  await bulkInsertElements(c.env, doc.id, orgId, doc.building_id, input.elements);

  const byType: Record<string, number> = {};
  const byStorey: Record<string, number> = {};
  for (const e of input.elements) {
    byType[e.ifc_type] = (byType[e.ifc_type] ?? 0) + 1;
    if (e.storey) byStorey[e.storey] = (byStorey[e.storey] ?? 0) + 1;
  }
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO ifc_models (document_id, org_id, building_id, schema, stats, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(doc.id, orgId, doc.building_id, input.schema, JSON.stringify({ by_type: byType, by_storey: byStorey }), t)
    .run();

  // Etasjer og rom
  let floorsCreated = 0;
  let roomsCreated = 0;
  let roomsUpdated = 0;
  if (input.create_locations && doc.building_id) {
    const floors = await all<{ id: string; name: string; ifc_guid: string | null }>(c.env.DB, `SELECT id, name, ifc_guid FROM floors WHERE building_id = ?`, doc.building_id);
    const rooms = await all<{ id: string; ifc_guid: string | null; floor_id: string; number: string | null; name: string }>(
      c.env.DB,
      `SELECT id, ifc_guid, floor_id, number, name FROM rooms WHERE building_id = ?`,
      doc.building_id,
    );
    const roomByGuid = new Map(rooms.filter((r) => r.ifc_guid).map((r) => [r.ifc_guid!, r.id]));
    // Eksisterende rom uten GUID matches på romnummer (eller navn) i samme etasje
    const findExisting = (floorId: string, number: string | null, name: string) =>
      rooms.find((r) => !r.ifc_guid && r.floor_id === floorId && ((number && r.number === number) || r.name.toLowerCase() === name.toLowerCase()))?.id;
    const sorted = [...input.storeys].sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
    const groundIdx = Math.max(0, sorted.findIndex((s) => (s.elevation ?? 0) >= -0.5));
    const stmts: D1PreparedStatement[] = [];
    for (const [i, s] of sorted.entries()) {
      let floor = floors.find((f) => f.ifc_guid === s.guid) ?? floors.find((f) => f.name.toLowerCase() === s.name.toLowerCase());
      if (!floor) {
        floor = { id: newId("flr"), name: s.name, ifc_guid: s.guid };
        stmts.push(
          insert(c.env.DB, "floors", {
            id: floor.id,
            org_id: orgId,
            building_id: doc.building_id,
            name: s.name || `Etasje ${i - groundIdx + 1}`,
            level: i - groundIdx,
            elevation: s.elevation,
            ifc_guid: s.guid,
            created_at: t,
            updated_at: t,
          }),
        );
        floorsCreated++;
      } else if (!floor.ifc_guid) {
        stmts.push(c.env.DB.prepare(`UPDATE floors SET ifc_guid = ?, elevation = COALESCE(elevation, ?), updated_at = ? WHERE id = ?`).bind(s.guid, s.elevation, t, floor.id));
      }
      for (const sp of s.spaces) {
        const name = sp.long_name || sp.name || "Rom";
        const number = sp.long_name && sp.name !== sp.long_name ? sp.name : null;
        const existing = roomByGuid.get(sp.guid) ?? findExisting(floor.id, number, name);
        if (existing) {
          stmts.push(
            c.env.DB.prepare(`UPDATE rooms SET name = ?, number = ?, area = COALESCE(?, area), floor_id = ?, ifc_guid = ?, updated_at = ? WHERE id = ?`).bind(
              name,
              number,
              sp.area,
              floor.id,
              sp.guid,
              t,
              existing,
            ),
          );
          roomsUpdated++;
        } else {
          stmts.push(
            insert(c.env.DB, "rooms", {
              id: newId("rom"),
              org_id: orgId,
              building_id: doc.building_id,
              floor_id: floor.id,
              name,
              number,
              area: sp.area,
              ifc_guid: sp.guid,
              created_at: t,
              updated_at: t,
            }),
          );
          roomsCreated++;
        }
      }
    }
    for (let i = 0; i < stmts.length; i += 80) await c.env.DB.batch(stmts.slice(i, i + 80));
  }

  const u = c.get("user");
  await logActivity(c.env, {
    orgId,
    actor: { type: "user", id: u.id, name: u.name ?? u.email },
    action: "ifc.imported",
    entityType: "document",
    entityId: doc.id,
    summary: `Indekserte ${input.elements.length} IFC-elementer fra ${doc.title}${floorsCreated || roomsCreated ? ` (${floorsCreated} etasjer, ${roomsCreated} rom opprettet)` : ""}`,
  });
  return c.json({ ok: true, elements: input.elements.length, floors_created: floorsCreated, rooms_created: roomsCreated, rooms_updated: roomsUpdated });
});

ifc.get("/models", async (c) => {
  const buildingId = c.req.query("building_id");
  const rows = await all<{ id: string; title: string; filename: string; size: number; building_id: string | null; created_at: number; schema: string | null; stats: string | null; indexed_at: number | null }>(
    c.env.DB,
    `SELECT d.id, d.title, d.filename, d.size, d.building_id, d.created_at, m.schema, m.stats, m.indexed_at
     FROM documents d LEFT JOIN ifc_models m ON m.document_id = d.id
     WHERE d.org_id = ? AND d.kind = 'ifc' ${buildingId ? "AND d.building_id = ?" : ""} ORDER BY d.created_at DESC`,
    ...(buildingId ? [c.get("orgId"), buildingId] : [c.get("orgId")]),
  );
  return c.json(rows.map((r) => ({ ...r, stats: parseJson(r.stats, null) })));
});

ifc.get("/summary/:documentId", async (c) => {
  const row = await first<{ document_id: string; schema: string | null; stats: string | null; indexed_at: number }>(
    c.env.DB,
    `SELECT document_id, schema, stats, indexed_at FROM ifc_models WHERE document_id = ? AND org_id = ?`,
    c.req.param("documentId"),
    c.get("orgId"),
  );
  const result: IfcSummary | null = row ? { ...row, stats: parseJson(row.stats, null) } : null;
  return c.json(result);
});

ifc.get("/elements", async (c) => {
  const q = c.req.query();
  return c.json(await queryIfcElements(c.env, c.get("orgId"), { building_id: q.building_id, document_id: q.document_id, ifc_type: q.type, storey: q.storey, q: q.q, limit: Number(q.limit) || 200 }));
});

export async function queryIfcElements(
  env: Env,
  orgId: string,
  f: { building_id?: string | null; document_id?: string | null; ifc_type?: string | null; storey?: string | null; q?: string | null; guid?: string | null; limit?: number },
) {
  const where = ["org_id = ?"];
  const params: unknown[] = [orgId];
  if (f.building_id) where.push("building_id = ?"), params.push(f.building_id);
  if (f.document_id) where.push("document_id = ?"), params.push(f.document_id);
  if (f.ifc_type) where.push("ifc_type LIKE ?"), params.push(f.ifc_type.replace(/\*/g, "%"));
  if (f.storey) where.push("storey LIKE ?"), params.push(`%${f.storey}%`);
  if (f.guid) where.push("guid = ?"), params.push(f.guid);
  if (f.q) where.push("(name LIKE ? OR props LIKE ?)"), params.push(`%${f.q}%`, `%${f.q}%`);
  const limit = Math.min(Math.max(Number.isFinite(f.limit) ? Number(f.limit) : 200, 1), 1000);
  const rows = await all<{ document_id: string; express_id: number; guid: string | null; ifc_type: string; name: string | null; storey: string | null; props: string | null }>(
    env.DB,
    `SELECT document_id, express_id, guid, ifc_type, name, storey, props FROM ifc_elements WHERE ${where.join(" AND ")} ORDER BY storey, ifc_type, name LIMIT ${limit}`,
    ...params,
  );
  return rows.map((r) => ({ ...r, props: parseJson<Record<string, unknown> | null>(r.props, null) }));
}
