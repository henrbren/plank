import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { assertCanEdit, assertCanEditEntity, sees } from "../lib/access";
import { logActivity } from "../lib/activity";
import { all, first, insert } from "../lib/db";
import { guessMime, processDocument } from "../lib/documents";
import { buildBimModel, storeBimModel, type BimFloorInput } from "../lib/bim";
import { interpretFloorplan } from "../lib/floorplan";
import { ApiError, badRequest, body, notFound } from "../lib/http";
import { newId, now } from "../lib/util";
import {
  buildingSchema,
  createBuilding,
  createFloor,
  createProperty,
  createRoom,
  deleteSql,
  floorSchema,
  getBuilding,
  getFloor,
  getPlaceImageKey,
  getProperty,
  getRoom,
  getTree,
  imageKeysToRemove,
  listProperties,
  propertySchema,
  roomSchema,
  setPlaceImage,
  updateBuilding,
  updateFloor,
  updateProperty,
  updateRoom,
} from "../services/portfolio";

export const portfolio = new Hono<AppEnv>();

const actor = (c: { get: (k: "user") => { id: string; name: string | null; email: string } }) => {
  const u = c.get("user");
  return { type: "user" as const, id: u.id, name: u.name ?? u.email };
};

portfolio.get("/tree", async (c) => c.json(await getTree(c.env, c.get("orgId"))));

// Eiendommer
portfolio.get("/properties", async (c) => c.json(await listProperties(c.env, c.get("orgId"))));
portfolio.get("/properties/:id", async (c) => c.json(await getProperty(c.env, c.get("orgId"), c.req.param("id"))));
portfolio.post("/properties", async (c) => {
  const p = await createProperty(c.env, c.get("orgId"), await body(c, propertySchema));
  await logActivity(c.env, { orgId: c.get("orgId"), actor: actor(c), action: "property.created", entityType: "property", entityId: p.id, summary: `Opprettet eiendom ${p.name}` });
  return c.json(p, 201);
});
portfolio.patch("/properties/:id", async (c) => c.json(await updateProperty(c.env, c.get("orgId"), c.req.param("id"), await body(c, propertySchema.partial()))));

// Bygg
portfolio.get("/buildings/:id", async (c) => c.json(await getBuilding(c.env, c.get("orgId"), c.req.param("id"))));
portfolio.post("/buildings", async (c) => {
  const b = await createBuilding(c.env, c.get("orgId"), await body(c, buildingSchema));
  await logActivity(c.env, { orgId: c.get("orgId"), actor: actor(c), action: "building.created", entityType: "building", entityId: b.id, summary: `Opprettet bygg ${b.name}` });
  return c.json(b, 201);
});
portfolio.patch("/buildings/:id", async (c) =>
  c.json(await updateBuilding(c.env, c.get("orgId"), c.req.param("id"), await body(c, buildingSchema.omit({ property_id: true }).partial()))),
);

const IMAGE_MAX = 8 * 1024 * 1024;
const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

function registerPlaceImages(kind: "property" | "building") {
  const path = kind === "property" ? "properties" : "buildings";
  const label = kind === "property" ? "eiendommen" : "bygget";

  portfolio.get(`/${path}/:id/image`, async (c) => {
    const key = await getPlaceImageKey(c.env, c.get("orgId"), kind, c.req.param("id"));
    if (!key) throw notFound("Bildet");
    const obj = await c.env.FILES.get(key);
    if (!obj) throw new ApiError(404, "Bildet finnes ikke i lagringen");
    const mime = obj.httpMetadata?.contentType ?? "image/jpeg";
    if (!IMAGE_MIME.has(mime)) throw new ApiError(404, "Bildet finnes ikke");
    return new Response(obj.body, {
      headers: {
        "Content-Type": mime,
        "Content-Length": String(obj.size),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=86400",
      },
    });
  });

  portfolio.post(`/${path}/:id/image`, async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string") throw badRequest("Velg et bilde.");
    if (file.size === 0) throw badRequest("Filen er tom.");
    if (file.size > IMAGE_MAX) throw new ApiError(413, "Bildet er for stort. Bruk et bilde under 8 MB.");
    const guessed = guessMime(file.name);
    const mime = IMAGE_MIME.has(guessed) ? guessed : file.type;
    if (!IMAGE_MIME.has(mime)) throw badRequest("Bildet må være JPG, PNG eller WebP.");
    const id = c.req.param("id");
    const orgId = c.get("orgId");
    assertCanEdit(kind === "property" ? { property_id: id } : { building_id: id });
    const previous = await getPlaceImageKey(c.env, orgId, kind, id);
    const key = `orgs/${orgId}/places/${id}`;
    await c.env.FILES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: mime } });
    await setPlaceImage(c.env, orgId, kind, id, key);
    if (previous && previous !== key) c.executionCtx.waitUntil(c.env.FILES.delete(previous));
    await logActivity(c.env, { orgId, actor: actor(c), action: `${kind}.image`, entityType: kind, entityId: id, summary: `La inn bilde av ${label}` });
    return c.json({ ok: true });
  });

  portfolio.delete(`/${path}/:id/image`, async (c) => {
    const id = c.req.param("id");
    const orgId = c.get("orgId");
    assertCanEdit(kind === "property" ? { property_id: id } : { building_id: id });
    const previous = await getPlaceImageKey(c.env, orgId, kind, id);
    await setPlaceImage(c.env, orgId, kind, id, null);
    if (previous) c.executionCtx.waitUntil(c.env.FILES.delete(previous));
    await logActivity(c.env, { orgId, actor: actor(c), action: `${kind}.image_removed`, entityType: kind, entityId: id, summary: `Fjernet bilde av ${label}` });
    return c.json({ ok: true });
  });
}

registerPlaceImages("property");
registerPlaceImages("building");

const PLAN_MAX = 15 * 1024 * 1024;
const PLAN_MIME = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);

const planRoom = z.object({
  number: z.string().trim().max(30).nullable(),
  name: z.string().trim().min(1).max(80),
  usage: z.string().trim().max(80).nullable(),
  area: z.number().finite().min(0).max(100_000).nullable(),
  x: z.number().finite().min(-500).max(500).nullable().optional(),
  y: z.number().finite().min(-500).max(500).nullable().optional(),
  w: z.number().finite().min(0).max(500).nullable().optional(),
  d: z.number().finite().min(0).max(500).nullable().optional(),
});

const applySchema = z.object({
  bim: z.boolean().optional(),
  floors: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        level: z.number().int().min(-5).max(80),
        rooms: z.array(planRoom).max(200),
      }),
    )
    .max(40),
});

portfolio.post("/buildings/:id/floorplan", async (c) => {
  const orgId = c.get("orgId");
  const user = c.get("user");
  const building = await first<{ id: string; property_id: string; name: string }>(
    c.env.DB,
    `SELECT id, property_id, name FROM buildings WHERE id = ? AND org_id = ?`,
    c.req.param("id"),
    orgId,
  );
  if (!building || !sees({ building_id: building.id })) throw notFound("Bygget");
  assertCanEdit({ building_id: building.id });
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") throw badRequest("Velg en plantegning.");
  if (file.size === 0) throw badRequest("Filen er tom.");
  if (file.size > PLAN_MAX) throw new ApiError(413, "Filen er for stor. Eksporter én etasje, helst under 15 MB.");
  const filename = file.name.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 180) || "plantegning";
  const guessed = guessMime(filename);
  const mime = PLAN_MIME.has(guessed) ? guessed : file.type;
  if (!PLAN_MIME.has(mime)) throw badRequest("Plantegningen må være PDF eller bilde (PNG, JPG eller WebP).");

  const bytes = await file.arrayBuffer();
  const id = newId("doc");
  const key = `orgs/${orgId}/documents/${id}/${filename}`;
  await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: mime } });
  const t = now();
  await insert(c.env.DB, "documents", {
    id,
    org_id: orgId,
    property_id: building.property_id,
    building_id: building.id,
    floor_id: null,
    room_id: null,
    component_id: null,
    title: `Plantegning – ${building.name}`.slice(0, 200),
    filename,
    mime,
    size: file.size,
    r2_key: key,
    kind: "tegning",
    ns3451: null,
    status: "processing",
    uploaded_by: user.id,
    created_at: t,
    updated_at: t,
  }).run();
  c.executionCtx.waitUntil(processDocument(c.env, id));
  await logActivity(c.env, {
    orgId,
    actor: actor(c),
    action: "document.uploaded",
    entityType: "document",
    entityId: id,
    summary: `Lastet opp plantegning ${filename}`,
  });

  const plan = await interpretFloorplan(c.env, orgId, mime, bytes);
  return c.json({ documentId: id, ...plan });
});

portfolio.post("/buildings/:id/floorplan/apply", async (c) => {
  const orgId = c.get("orgId");
  const building = await first<{ id: string; name: string; property_id: string; property_name: string }>(
    c.env.DB,
    `SELECT b.id, b.name, b.property_id, p.name AS property_name FROM buildings b JOIN properties p ON p.id = b.property_id WHERE b.id = ? AND b.org_id = ?`,
    c.req.param("id"),
    orgId,
  );
  if (!building || !sees({ building_id: building.id })) throw notFound("Bygget");
  assertCanEdit({ building_id: building.id });
  const input = await body(c, applySchema);
  if (input.floors.length === 0) throw badRequest("Velg minst én etasje.");
  const result = await applyFloorplan(c.env, orgId, building, c.get("user").id, input);
  await logActivity(c.env, {
    orgId,
    actor: actor(c),
    action: "floorplan.imported",
    entityType: "building",
    entityId: building.id,
    summary: result.modelId
      ? `La inn ${result.floorsCreated} etasjer og ${result.roomsCreated} rom fra plantegning, og en BIM-modell, i ${building.name}`
      : `La inn ${result.floorsCreated} etasjer og ${result.roomsCreated} rom fra plantegning i ${building.name}`,
  });
  return c.json(result);
});

async function applyFloorplan(
  env: Env,
  orgId: string,
  building: { id: string; name: string; property_id: string; property_name: string },
  userId: string,
  plan: z.infer<typeof applySchema>,
) {
  const buildingId = building.id;
  const makeBim = plan.bim !== false && plan.floors.some((floor) => floor.rooms.length > 0);
  const existingFloors = await all<{ id: string; name: string; ifc_guid: string | null }>(env.DB, `SELECT id, name, ifc_guid FROM floors WHERE building_id = ? AND org_id = ?`, buildingId, orgId);
  const existingRooms = await all<{ id: string; floor_id: string; number: string | null; name: string; ifc_guid: string | null }>(
    env.DB,
    `SELECT id, floor_id, number, name, ifc_guid FROM rooms WHERE building_id = ? AND org_id = ?`,
    buildingId,
    orgId,
  );
  const bimInput: BimFloorInput[] = [];
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  let floorsCreated = 0;
  let roomsCreated = 0;
  for (const floor of plan.floors) {
    let row = existingFloors.find((f) => f.name.toLowerCase() === floor.name.toLowerCase());
    const floorGuid = makeBim ? row?.ifc_guid ?? null : null;
    if (!row) {
      const floorId = newId("flr");
      const area = floor.rooms.reduce((sum, r) => sum + (r.area ?? 0), 0);
      row = { id: floorId, name: floor.name, ifc_guid: floorGuid };
      stmts.push(
        insert(env.DB, "floors", {
          id: floorId,
          org_id: orgId,
          building_id: buildingId,
          name: floor.name,
          level: floor.level,
          elevation: null,
          gross_area: area > 0 ? area : null,
          ifc_guid: null,
          created_at: t,
          updated_at: t,
        }),
      );
      existingFloors.push(row);
      floorsCreated++;
    }
    const floorId = row.id;
    const bimRooms: BimFloorInput["rooms"] = [];
    for (const room of floor.rooms) {
      const match = existingRooms.find((r) => {
        if (r.floor_id !== floorId) return false;
        if (room.number) return r.number === room.number;
        return r.name.toLowerCase() === room.name.toLowerCase();
      });
      const roomGuid = makeBim ? match?.ifc_guid ?? null : null;
      if (!match) {
        const id = newId("rom");
        stmts.push(
          insert(env.DB, "rooms", {
            id,
            org_id: orgId,
            building_id: buildingId,
            floor_id: floorId,
            name: room.name,
            number: room.number,
            usage: room.usage,
            area: room.area,
            ifc_guid: null,
            created_at: t,
            updated_at: t,
          }),
        );
        existingRooms.push({ id, floor_id: floorId, number: room.number, name: room.name, ifc_guid: roomGuid });
        roomsCreated++;
      }
      if (makeBim) bimRooms.push({ number: room.number, name: room.name, area: room.area, x: room.x ?? null, y: room.y ?? null, w: room.w ?? null, d: room.d ?? null, guid: roomGuid });
    }
    if (makeBim) bimInput.push({ name: floor.name, level: floor.level, guid: floorGuid, rooms: bimRooms });
  }

  let modelId: string | null = null;
  if (makeBim) {
    const model = buildBimModel({ buildingName: building.name, siteName: building.property_name, floors: bimInput });
    for (const floor of model.floors) {
      const row = existingFloors.find((f) => f.name.toLowerCase() === floor.name.toLowerCase());
      if (!row) continue;
      if (!row.ifc_guid) {
        stmts.push(env.DB.prepare(`UPDATE floors SET ifc_guid = ?, elevation = ?, updated_at = ? WHERE id = ? AND ifc_guid IS NULL`).bind(floor.guid, floor.elevation, t, row.id));
        row.ifc_guid = floor.guid;
      }
      for (const room of floor.rooms) {
        const match = existingRooms.find((r) => {
          if (r.floor_id !== row.id) return false;
          if (room.number) return r.number === room.number;
          return r.name.toLowerCase() === room.name.toLowerCase();
        });
        if (match && !match.ifc_guid) {
          stmts.push(env.DB.prepare(`UPDATE rooms SET ifc_guid = ?, updated_at = ? WHERE id = ? AND ifc_guid IS NULL`).bind(room.guid, t, match.id));
          match.ifc_guid = room.guid;
        }
      }
    }
    for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
    try {
      modelId = await storeBimModel(env, {
        orgId,
        propertyId: building.property_id,
        buildingId,
        buildingName: building.name,
        userId,
        text: model.text,
        elements: model.elements,
      });
    } catch (err) {
      console.warn("Kunne ikke lagre BIM-modell fra plantegning", err);
    }
    return { floorsCreated, roomsCreated, modelId, layout: model.fromDrawing ? "plan" : "rekke" };
  }

  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
  return { floorsCreated, roomsCreated, modelId, layout: null as "plan" | "rekke" | null };
}

// Etasjer
portfolio.get("/floors/:id", async (c) => c.json(await getFloor(c.env, c.get("orgId"), c.req.param("id"))));
portfolio.post("/floors", async (c) => c.json(await createFloor(c.env, c.get("orgId"), await body(c, floorSchema)), 201));
portfolio.patch("/floors/:id", async (c) =>
  c.json(await updateFloor(c.env, c.get("orgId"), c.req.param("id"), await body(c, floorSchema.omit({ building_id: true }).partial()))),
);

// Rom
portfolio.get("/rooms/:id", async (c) => c.json(await getRoom(c.env, c.get("orgId"), c.req.param("id"))));
portfolio.post("/rooms", async (c) => c.json(await createRoom(c.env, c.get("orgId"), await body(c, roomSchema)), 201));
portfolio.patch("/rooms/:id", async (c) => c.json(await updateRoom(c.env, c.get("orgId"), c.req.param("id"), await body(c, roomSchema.partial()))));

// Sletting
for (const kind of ["property", "building", "floor", "room"] as const) {
  const path = { property: "properties", building: "buildings", floor: "floors", room: "rooms" }[kind];
  portfolio.delete(`/${path}/:id`, async (c) => {
    const id = c.req.param("id");
    const orgId = c.get("orgId");
    await assertCanEditEntity(c.env, orgId, kind, id, "Ressursen");
    const keys = await imageKeysToRemove(c.env, orgId, kind, id);
    const res = await c.env.DB.prepare(deleteSql[kind]!).bind(id, orgId).run();
    if (!res.meta.changes) throw notFound();
    if (keys.length) c.executionCtx.waitUntil(Promise.all(keys.map((key) => c.env.FILES.delete(key))));
    await logActivity(c.env, { orgId, actor: actor(c), action: `${kind}.deleted`, entityType: kind, entityId: id });
    return c.json({ ok: true });
  });
}
