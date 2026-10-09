import { z } from "zod";
import type { Env } from "../env";
import { all, first, insert, update } from "../lib/db";
import { notFound } from "../lib/http";
import { optDate, optId, optStr, reqStr } from "../lib/schemas";
import { newId, now } from "../lib/util";
import type { Task } from "../../shared/types";
import { resolveLocation } from "./portfolio";

const taskFields = {
  property_id: optId(),
  building_id: optId(),
  floor_id: optId(),
  room_id: optId(),
  component_id: optId(),
  title: reqStr(200),
  description: optStr(8000),
  type: z.enum(["vedlikehold", "avvik", "kontroll", "dokumentasjon", "annet"]),
  status: z.enum(["open", "in_progress", "done", "cancelled"]),
  priority: z.enum(["low", "normal", "high", "critical"]),
  due_date: optDate(),
  assignee: optStr(200),
};
export const taskSchema = z.object({
  ...taskFields,
  type: taskFields.type.default("vedlikehold"),
  status: taskFields.status.default("open"),
  priority: taskFields.priority.default("normal"),
});
/** NB: uten standardverdier – zod 4 bruker ellers default også i .partial() */
export const taskPatchSchema = z.object(taskFields).partial();

const TASK_FIELDS = [
  "property_id",
  "building_id",
  "floor_id",
  "room_id",
  "component_id",
  "title",
  "description",
  "type",
  "status",
  "priority",
  "due_date",
  "assignee",
  "completed_at",
  "updated_at",
] as const;

export interface TaskFilter {
  status?: string | null; // 'open' = open + in_progress, 'all', eller konkret status
  type?: string | null;
  property_id?: string | null;
  building_id?: string | null;
  component_id?: string | null;
  due_before?: string | null;
  q?: string | null;
  limit?: number;
}

const SELECT = `SELECT t.*, b.name AS building_name, c.name AS component_name, a.name AS agent_name
  FROM tasks t
  LEFT JOIN buildings b ON b.id = t.building_id
  LEFT JOIN components c ON c.id = t.component_id
  LEFT JOIN agents a ON a.id = t.created_by_agent`;

export async function listTasks(env: Env, orgId: string, f: TaskFilter = {}): Promise<Task[]> {
  const where = ["t.org_id = ?"];
  const params: unknown[] = [orgId];
  const status = f.status ?? "open";
  if (status === "open") where.push("t.status IN ('open','in_progress')");
  else if (status !== "all") where.push("t.status = ?"), params.push(status);
  if (f.type) where.push("t.type = ?"), params.push(f.type);
  if (f.property_id) where.push("t.property_id = ?"), params.push(f.property_id);
  if (f.building_id) where.push("t.building_id = ?"), params.push(f.building_id);
  if (f.component_id) where.push("t.component_id = ?"), params.push(f.component_id);
  if (f.due_before) where.push("t.due_date IS NOT NULL AND t.due_date <= ?"), params.push(f.due_before);
  if (f.q) where.push("(t.title LIKE ? OR t.description LIKE ?)"), params.push(`%${f.q}%`, `%${f.q}%`);
  const limit = Math.min(Math.max(f.limit ?? 300, 1), 1000);
  return all<Task>(
    env.DB,
    `${SELECT} WHERE ${where.join(" AND ")}
     ORDER BY CASE t.status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END,
       CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date,
       CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.created_at DESC
     LIMIT ${limit}`,
    ...params,
  );
}

export async function getTask(env: Env, orgId: string, id: string): Promise<Task> {
  const t = await first<Task>(env.DB, `${SELECT} WHERE t.id = ? AND t.org_id = ?`, id, orgId);
  if (!t) throw notFound("Oppgaven");
  return t;
}

async function locationFor(env: Env, orgId: string, input: Partial<z.infer<typeof taskSchema>>) {
  // Komponenten gir plassering hvis ingen annen er oppgitt
  let loc: Partial<z.infer<typeof taskSchema>> = input;
  if (input.component_id) {
    const c = await first<{ building_id: string | null; floor_id: string | null; room_id: string | null }>(
      env.DB,
      `SELECT building_id, floor_id, room_id FROM components WHERE id = ? AND org_id = ?`,
      input.component_id,
      orgId,
    );
    if (!c) throw notFound("Komponenten");
    if (!input.room_id && !input.floor_id && !input.building_id) loc = { ...input, ...c };
  }
  return resolveLocation(env, orgId, loc);
}

export async function createTask(
  env: Env,
  orgId: string,
  input: z.infer<typeof taskSchema>,
  actor: { userId?: string | null; agentId?: string | null },
): Promise<Task> {
  const loc = await locationFor(env, orgId, input);
  const id = newId("tsk");
  const t = now();
  await insert(env.DB, "tasks", {
    id,
    org_id: orgId,
    ...input,
    ...loc,
    completed_at: input.status === "done" ? t : null,
    created_by_user: actor.userId ?? null,
    created_by_agent: actor.agentId ?? null,
    created_at: t,
    updated_at: t,
  }).run();
  return getTask(env, orgId, id);
}

export async function updateTask(env: Env, orgId: string, id: string, patch: z.infer<typeof taskPatchSchema>): Promise<Task> {
  const existing = await getTask(env, orgId, id);
  const next: Record<string, unknown> = { ...patch, updated_at: now() };
  const locKeys = ["property_id", "building_id", "floor_id", "room_id", "component_id"] as const;
  if (locKeys.some((k) => k in patch)) {
    const merged = { ...existing, ...patch } as Partial<z.infer<typeof taskSchema>>;
    Object.assign(next, await locationFor(env, orgId, merged));
  }
  if (patch.status && patch.status !== existing.status) {
    next.completed_at = patch.status === "done" ? now() : null;
  }
  const stmt = update(env.DB, "tasks", next, TASK_FIELDS, { sql: "id = ? AND org_id = ?", params: [id, orgId] });
  if (stmt) await stmt.run();
  return getTask(env, orgId, id);
}
