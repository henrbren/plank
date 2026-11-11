import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all } from "../lib/db";
import { seedDesk } from "../lib/deskSeed";
import { body } from "../lib/http";
import { logActivity } from "../lib/activity";
import { actOnCase, createDeskItem, deskBuilding, deskCase, deskEditor, deskHome, deskCreateSchema, deskPatchSchema, removeDesk, saveDesk } from "../services/desk";

export const desk = new Hono<AppEnv>();

desk.get("/", async (c) => c.json(await deskHome(c.env, c.get("orgId"))));

desk.post("/seed", async (c) => {
  const orgId = c.get("orgId");
  const buildings = await all<{ id: string; name: string; building_type: string | null }>(
    c.env.DB,
    `SELECT id, name, building_type FROM buildings WHERE org_id = ?`,
    orgId,
  );
  const pick = (pred: (b: { name: string; building_type: string | null }) => boolean) => buildings.find(pred)?.id ?? null;
  const result = await seedDesk(c.env, orgId, {
    kontorId: pick((b) => /hovedbygg|kontor/i.test(`${b.name} ${b.building_type ?? ""}`)),
    lagerId: pick((b) => /lager/i.test(`${b.name} ${b.building_type ?? ""}`)),
    boligId: pick((b) => /blokk|bolig/i.test(`${b.name} ${b.building_type ?? ""}`)),
  });
  if (result.created) {
    const u = c.get("user");
    await logActivity(c.env, {
      orgId,
      actor: { type: "user", id: u.id, name: u.name ?? u.email },
      action: "desk.seed",
      summary: "La inn utleieeksempelet",
    });
  }
  const home = await deskHome(c.env, orgId);
  return c.json({ created: result.created, ...home }, result.created ? 201 : 200);
});

desk.get("/buildings/:id", async (c) => c.json(await deskBuilding(c.env, c.get("orgId"), c.req.param("id"))));

desk.post("/items", async (c) => {
  const input = await body(c, deskCreateSchema);
  const u = c.get("user");
  const res = await createDeskItem(c.env, c.get("orgId"), input, { userId: u.id, name: u.name ?? u.email });
  return c.json(res, 201);
});

desk.get("/cases/:id", async (c) => c.json(await deskCase(c.env, c.get("orgId"), c.req.param("id"))));

desk.get("/leases/:id", async (c) => c.json(await deskEditor(c.env, c.get("orgId"), { leaseId: c.req.param("id") })));

desk.get("/units/:id", async (c) => c.json(await deskEditor(c.env, c.get("orgId"), { unitId: c.req.param("id") })));

desk.post("/cases/:id", async (c) => {
  const input = await body(c, z.object({ unit_id: z.string().optional(), lease_id: z.string().optional() }));
  const u = c.get("user");
  const res = await actOnCase(c.env, c.get("orgId"), c.req.param("id"), input, { userId: u.id, name: u.name ?? u.email });
  return c.json(res);
});

function editorActor(c: { get: (k: "user") => { id: string; name: string | null; email: string } }) {
  const u = c.get("user");
  return { userId: u.id, name: u.name ?? u.email };
}

desk.patch("/cases/:id", async (c) => {
  const res = await saveDesk(c.env, c.get("orgId"), { caseId: c.req.param("id") }, await body(c, deskPatchSchema), editorActor(c));
  return c.json(res);
});

desk.patch("/leases/:id", async (c) => {
  const res = await saveDesk(c.env, c.get("orgId"), { leaseId: c.req.param("id") }, await body(c, deskPatchSchema), editorActor(c));
  return c.json(res);
});

desk.patch("/units/:id", async (c) => {
  const res = await saveDesk(c.env, c.get("orgId"), { unitId: c.req.param("id") }, await body(c, deskPatchSchema), editorActor(c));
  return c.json(res);
});

desk.delete("/cases/:id", async (c) => c.json(await removeDesk(c.env, c.get("orgId"), { caseId: c.req.param("id") }, editorActor(c))));

desk.delete("/leases/:id", async (c) => c.json(await removeDesk(c.env, c.get("orgId"), { leaseId: c.req.param("id") }, editorActor(c))));

desk.delete("/units/:id", async (c) => c.json(await removeDesk(c.env, c.get("orgId"), { unitId: c.req.param("id") }, editorActor(c))));
