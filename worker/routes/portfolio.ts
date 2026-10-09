import { Hono } from "hono";
import type { AppEnv } from "../env";
import { logActivity } from "../lib/activity";
import { body, notFound } from "../lib/http";
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
  getProperty,
  getRoom,
  getTree,
  listProperties,
  propertySchema,
  roomSchema,
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
    const res = await c.env.DB.prepare(deleteSql[kind]!).bind(c.req.param("id"), c.get("orgId")).run();
    if (!res.meta.changes) throw notFound();
    await logActivity(c.env, { orgId: c.get("orgId"), actor: actor(c), action: `${kind}.deleted`, entityType: kind, entityId: c.req.param("id") });
    return c.json({ ok: true });
  });
}
