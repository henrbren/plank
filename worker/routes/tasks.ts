import { Hono } from "hono";
import type { AppEnv } from "../env";
import { logActivity } from "../lib/activity";
import { body, notFound } from "../lib/http";
import { createTask, getTask, listTasks, taskPatchSchema, taskSchema, updateTask } from "../services/tasks";
import { TASK_STATUSES } from "../../shared/types";

export const tasks = new Hono<AppEnv>();

tasks.get("/", async (c) => {
  const q = c.req.query();
  return c.json(
    await listTasks(c.env, c.get("orgId"), {
      status: q.status,
      type: q.type,
      property_id: q.property_id,
      building_id: q.building_id,
      component_id: q.component_id,
      due_before: q.due_before,
      q: q.q,
    }),
  );
});

tasks.get("/:id", async (c) => c.json(await getTask(c.env, c.get("orgId"), c.req.param("id"))));

tasks.post("/", async (c) => {
  const u = c.get("user");
  const t = await createTask(c.env, c.get("orgId"), await body(c, taskSchema), { userId: u.id });
  await logActivity(c.env, {
    orgId: c.get("orgId"),
    actor: { type: "user", id: u.id, name: u.name ?? u.email },
    action: "task.created",
    entityType: "task",
    entityId: t.id,
    summary: t.title,
  });
  return c.json(t, 201);
});

tasks.patch("/:id", async (c) => {
  const u = c.get("user");
  const patch = await body(c, taskPatchSchema);
  const before = await getTask(c.env, c.get("orgId"), c.req.param("id"));
  const t = await updateTask(c.env, c.get("orgId"), c.req.param("id"), patch);
  if (patch.status && patch.status !== before.status) {
    await logActivity(c.env, {
      orgId: c.get("orgId"),
      actor: { type: "user", id: u.id, name: u.name ?? u.email },
      action: "task.status",
      entityType: "task",
      entityId: t.id,
      summary: `${t.title} → ${TASK_STATUSES[t.status]}`,
    });
  }
  return c.json(t);
});

tasks.delete("/:id", async (c) => {
  const res = await c.env.DB.prepare(`DELETE FROM tasks WHERE id = ? AND org_id = ?`).bind(c.req.param("id"), c.get("orgId")).run();
  if (!res.meta.changes) throw notFound("Oppgaven");
  return c.json({ ok: true });
});
