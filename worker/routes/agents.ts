import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { AGENT_TEMPLATES } from "../agent/templates";
import { describeSchedule, nextRunAt, parseSchedule } from "../agent/schedule";
import { logActivity } from "../lib/activity";
import { all, first, insert, update } from "../lib/db";
import { badRequest, body, notFound } from "../lib/http";
import { optId, optStr } from "../lib/schemas";
import { newId, now, parseJson } from "../lib/util";
import { MODELS, TOOL_GROUPS, type Agent, type AgentRun, type ToolGroup } from "../../shared/types";

export const agents = new Hono<AppEnv>();

interface AgentDbRow extends Omit<Agent, "tools" | "notify_emails"> {
  tools: string;
  notify_emails: string;
}

export function toAgent(row: AgentDbRow): Agent & { schedule_label: string } {
  return {
    ...row,
    tools: parseJson<ToolGroup[]>(row.tools, []),
    notify_emails: parseJson<string[]>(row.notify_emails, []),
    schedule_label: describeSchedule(row.schedule),
  };
}

const modelIds = MODELS.map((m) => m.id) as [string, ...string[]];
const toolKeys = Object.keys(TOOL_GROUPS) as [ToolGroup, ...ToolGroup[]];

const agentFields = {
  name: z.string().trim().min(1).max(80),
  icon: z.string().max(40),
  color: z.string().max(20),
  description: optStr(500),
  instructions: z.string().max(20000),
  model: z.enum(modelIds),
  effort: z.enum(["low", "medium", "high"]),
  tools: z.array(z.enum(toolKeys)).max(20),
  scope_type: z.enum(["org", "property", "building"]),
  scope_id: optId(),
  schedule: optStr(40).refine((v) => v == null || parseSchedule(v) != null, "Ugyldig tidsplan"),
  schedule_prompt: optStr(8000),
  notify_emails: z.array(z.string().trim().email()).max(20),
  template: optStr(40),
};
const agentSchema = z.object({
  ...agentFields,
  icon: agentFields.icon.default("bot"),
  color: agentFields.color.default("wood"),
  instructions: agentFields.instructions.default(""),
  effort: agentFields.effort.default("medium"),
  tools: agentFields.tools.default([]),
  scope_type: agentFields.scope_type.default("org"),
  notify_emails: agentFields.notify_emails.default([]),
});
/** Uten standardverdier, slik at PATCH bare endrer feltene som sendes */
const agentPatchSchema = z.object(agentFields).partial();

const FIELDS = ["name", "icon", "color", "description", "instructions", "model", "effort", "tools", "scope_type", "scope_id", "schedule", "schedule_prompt", "notify_emails", "next_run_at", "updated_at"] as const;

async function validateScope(c: { env: AppEnv["Bindings"]; orgId: string }, scopeType: string, scopeId: string | null | undefined) {
  if (scopeType === "org") return null;
  if (!scopeId) throw badRequest("Velg eiendom eller bygg for avgrensningen");
  const table = scopeType === "property" ? "properties" : "buildings";
  const row = await first(c.env.DB, `SELECT id FROM ${table} WHERE id = ? AND org_id = ?`, scopeId, c.orgId);
  if (!row) throw badRequest("Ukjent eiendom/bygg for avgrensningen");
  return scopeId;
}

agents.get("/", async (c) => {
  const rows = await all<AgentDbRow>(c.env.DB, `SELECT * FROM agents WHERE org_id = ? AND archived = 0 ORDER BY created_at`, c.get("orgId"));
  return c.json(rows.map(toAgent));
});

agents.get("/templates", (c) => c.json(AGENT_TEMPLATES));

agents.get("/:id", async (c) => {
  const row = await first<AgentDbRow>(c.env.DB, `SELECT * FROM agents WHERE id = ? AND org_id = ? AND archived = 0`, c.req.param("id"), c.get("orgId"));
  if (!row) throw notFound("Agenten");
  const runs = await all<AgentRun>(
    c.env.DB,
    `SELECT id, agent_id, conversation_id, trigger, status, summary, error, started_at, finished_at FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT 20`,
    row.id,
  );
  return c.json({ ...toAgent(row), runs });
});

agents.post("/", async (c) => {
  const input = await body(c, agentSchema);
  const orgId = c.get("orgId");
  const scopeId = await validateScope({ env: c.env, orgId }, input.scope_type, input.scope_id);
  const id = newId("agt");
  const t = now();
  await insert(c.env.DB, "agents", {
    id,
    org_id: orgId,
    ...input,
    scope_id: scopeId,
    next_run_at: input.schedule ? nextRunAt(input.schedule) : null,
    created_by: c.get("user").id,
    created_at: t,
    updated_at: t,
  }).run();
  const u = c.get("user");
  await logActivity(c.env, { orgId, actor: { type: "user", id: u.id, name: u.name ?? u.email }, action: "agent.created", entityType: "agent", entityId: id, summary: `Opprettet agenten ${input.name}` });
  const row = await first<AgentDbRow>(c.env.DB, `SELECT * FROM agents WHERE id = ?`, id);
  return c.json(toAgent(row!), 201);
});

agents.patch("/:id", async (c) => {
  const orgId = c.get("orgId");
  const existing = await first<AgentDbRow>(c.env.DB, `SELECT * FROM agents WHERE id = ? AND org_id = ? AND archived = 0`, c.req.param("id"), orgId);
  if (!existing) throw notFound("Agenten");
  const patch: Record<string, unknown> = await body(c, agentPatchSchema);
  if ("scope_type" in patch || "scope_id" in patch) {
    const type = (patch.scope_type as string | undefined) ?? existing.scope_type;
    patch.scope_id = await validateScope({ env: c.env, orgId }, type, (patch.scope_id as string | null | undefined) ?? existing.scope_id);
  }
  if ("schedule" in patch) patch.next_run_at = patch.schedule ? nextRunAt(patch.schedule as string) : null;
  patch.updated_at = now();
  const stmt = update(c.env.DB, "agents", patch, FIELDS, { sql: "id = ? AND org_id = ?", params: [existing.id, orgId] });
  if (stmt) await stmt.run();
  const row = await first<AgentDbRow>(c.env.DB, `SELECT * FROM agents WHERE id = ?`, existing.id);
  return c.json(toAgent(row!));
});

agents.delete("/:id", async (c) => {
  const res = await c.env.DB.prepare(`UPDATE agents SET archived = 1, schedule = NULL, next_run_at = NULL, updated_at = ? WHERE id = ? AND org_id = ?`)
    .bind(now(), c.req.param("id"), c.get("orgId"))
    .run();
  if (!res.meta.changes) throw notFound("Agenten");
  return c.json({ ok: true });
});
