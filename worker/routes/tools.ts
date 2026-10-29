import { Hono, type Context } from "hono";
import type { AppEnv } from "../env";
import { notFound } from "../lib/http";
import { externalTools, runExternalTool, type ExternalContext } from "../mcp/tools";
import { origin } from "../mcp/server";

/**
 * REST-varianten av MCP-verktøyene, for integrasjoner som ikke snakker MCP (n8n, Zapier, skript, andre LLM-rammeverk).
 * GET /api/orgs/:orgId/tools gir verktøyene med JSON Schema, POST /api/orgs/:orgId/tools/:name kjører ett.
 */
export const tools = new Hono<AppEnv>();

function context(c: Context<AppEnv>): ExternalContext {
  const user = c.get("user");
  const key = c.get("apiKey") ?? { id: `session_${user.id}`, orgId: c.get("orgId"), name: "API", kind: "key" as const, canWrite: c.get("access").canEdit };
  return { env: c.env, orgId: c.get("orgId"), user, key, role: c.get("role"), origin: origin(c), waitUntil: (p) => c.executionCtx.waitUntil(p) };
}

tools.get("/", async (c) => {
  const list = await externalTools(context(c));
  return c.json(list.map(({ def, write }) => ({ name: def.tool.name, description: def.tool.description, input_schema: def.tool.input_schema, write })));
});

tools.post("/:name", async (c) => {
  const input = await c.req.json().catch(() => ({}));
  const outcome = await runExternalTool(context(c), c.req.param("name"), input);
  if (!outcome) throw notFound("Verktøyet");
  let result: unknown = outcome.data;
  if (result === undefined) {
    try {
      result = JSON.parse(outcome.content);
    } catch {
      result = outcome.content;
    }
  }
  return c.json({ ok: !outcome.isError, summary: outcome.summary, result, url: outcome.url ?? null }, outcome.isError ? 422 : 200);
});
