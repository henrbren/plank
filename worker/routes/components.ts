import { Hono } from "hono";
import type { AppEnv } from "../env";
import { assertCanEditEntity } from "../lib/access";
import { logActivity } from "../lib/activity";
import { body, notFound } from "../lib/http";
import { componentSchema, createComponent, getComponent, listComponents, updateComponent } from "../services/components";
import { listDocuments } from "../services/documents";
import { listTasks } from "../services/tasks";

export const components = new Hono<AppEnv>();

components.get("/", async (c) => {
  const q = c.req.query();
  return c.json(
    await listComponents(c.env, c.get("orgId"), {
      property_id: q.property_id,
      building_id: q.building_id,
      floor_id: q.floor_id,
      room_id: q.room_id,
      ns3451: q.ns3451,
      q: q.q,
      service_due_before: q.service_due_before,
    }),
  );
});

components.get("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const component = await getComponent(c.env, orgId, id);
  const [documents, tasks] = await Promise.all([listDocuments(c.env, orgId, { component_id: id }), listTasks(c.env, orgId, { component_id: id, status: "all" })]);
  return c.json({ ...component, documents, tasks });
});

components.post("/", async (c) => {
  const comp = await createComponent(c.env, c.get("orgId"), await body(c, componentSchema));
  const u = c.get("user");
  await logActivity(c.env, {
    orgId: c.get("orgId"),
    actor: { type: "user", id: u.id, name: u.name ?? u.email },
    action: "component.created",
    entityType: "component",
    entityId: comp.id,
    summary: `Registrerte ${comp.name}`,
  });
  return c.json(comp, 201);
});

components.patch("/:id", async (c) => c.json(await updateComponent(c.env, c.get("orgId"), c.req.param("id"), await body(c, componentSchema.partial()))));

components.delete("/:id", async (c) => {
  await assertCanEditEntity(c.env, c.get("orgId"), "component", c.req.param("id"), "Komponenten");
  const res = await c.env.DB.prepare(`DELETE FROM components WHERE id = ? AND org_id = ?`).bind(c.req.param("id"), c.get("orgId")).run();
  if (!res.meta.changes) throw notFound("Komponenten");
  return c.json({ ok: true });
});
