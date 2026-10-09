import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { runTurn, titleFrom } from "../agent/runtime";
import type { AgentRow } from "../agent/tools";
import { claudeConfigured } from "../lib/anthropic";
import { all, first } from "../lib/db";
import { ApiError, body, notFound } from "../lib/http";
import { newId, now, parseJson } from "../lib/util";
import type { ChatEvent, Conversation, FocusContext, StoredMessage } from "../../shared/types";

export const conversations = new Hono<AppEnv>();

const focusSchema = z
  .object({
    type: z.enum(["org", "property", "building", "floor", "room", "document", "component", "task", "artifact"]),
    id: z.string().max(64).optional(),
    label: z.string().max(200).optional(),
  })
  .nullish();

async function loadConversation(c: { env: AppEnv["Bindings"] }, orgId: string, userId: string, id: string) {
  const conv = await first<Conversation & { user_id: string | null }>(
    c.env.DB,
    `SELECT cv.*, a.name AS agent_name, a.icon AS agent_icon, a.color AS agent_color FROM conversations cv JOIN agents a ON a.id = cv.agent_id
     WHERE cv.id = ? AND cv.org_id = ? AND (cv.user_id = ? OR cv.source = 'schedule')`,
    id,
    orgId,
    userId,
  );
  if (!conv) throw notFound("Samtalen");
  return conv;
}

conversations.get("/", async (c) => {
  const agentId = c.req.query("agent_id");
  const rows = await all<Conversation>(
    c.env.DB,
    `SELECT cv.id, cv.agent_id, cv.title, cv.model, cv.source, cv.created_at, cv.updated_at, a.name AS agent_name, a.icon AS agent_icon, a.color AS agent_color
     FROM conversations cv JOIN agents a ON a.id = cv.agent_id
     WHERE cv.org_id = ? AND (cv.user_id = ? OR cv.source = 'schedule') ${agentId ? "AND cv.agent_id = ?" : ""}
     ORDER BY cv.updated_at DESC LIMIT 60`,
    ...(agentId ? [c.get("orgId"), c.get("user").id, agentId] : [c.get("orgId"), c.get("user").id]),
  );
  return c.json(rows);
});

conversations.post("/", async (c) => {
  const input = await body(c, z.object({ agent_id: z.string().min(1) }));
  const agent = await first<{ id: string; model: string }>(c.env.DB, `SELECT id, model FROM agents WHERE id = ? AND org_id = ? AND archived = 0`, input.agent_id, c.get("orgId"));
  if (!agent) throw notFound("Agenten");
  const id = newId("cnv");
  const t = now();
  await c.env.DB.prepare(`INSERT INTO conversations (id, org_id, agent_id, user_id, title, model, source, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, 'chat', ?, ?)`)
    .bind(id, c.get("orgId"), agent.id, c.get("user").id, agent.model, t, t)
    .run();
  return c.json(await loadConversation(c, c.get("orgId"), c.get("user").id, id), 201);
});

conversations.get("/:id", async (c) => {
  const conv = await loadConversation(c, c.get("orgId"), c.get("user").id, c.req.param("id"));
  const rows = await all<{ id: string; role: "user" | "assistant"; content: string; context: string | null; created_at: number }>(
    c.env.DB,
    `SELECT id, role, content, context, created_at FROM messages WHERE conversation_id = ? ORDER BY rowid`,
    conv.id,
  );
  const messages: StoredMessage[] = rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: parseJson(r.content, []),
    context: parseJson<FocusContext | null>(r.context, null),
    created_at: r.created_at,
  }));
  const { user_id: _u, ...rest } = conv;
  return c.json({ ...rest, messages });
});

conversations.patch("/:id", async (c) => {
  const input = await body(c, z.object({ title: z.string().trim().min(1).max(120) }));
  const conv = await loadConversation(c, c.get("orgId"), c.get("user").id, c.req.param("id"));
  await c.env.DB.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).bind(input.title, conv.id).run();
  return c.json({ ok: true });
});

conversations.delete("/:id", async (c) => {
  const res = await c.env.DB.prepare(`DELETE FROM conversations WHERE id = ? AND org_id = ? AND user_id = ?`).bind(c.req.param("id"), c.get("orgId"), c.get("user").id).run();
  if (!res.meta.changes) throw notFound("Samtalen");
  return c.json({ ok: true });
});

/** Send melding – svaret strømmes som Server-Sent Events */
conversations.post("/:id/messages", async (c) => {
  if (!claudeConfigured(c.env)) throw new ApiError(503, "Claude er ikke konfigurert (ANTHROPIC_API_KEY mangler)");
  const input = await body(c, z.object({ text: z.string().trim().min(1, "Skriv en melding").max(30000), context: focusSchema }));
  const orgId = c.get("orgId");
  const user = c.get("user");
  const conv = await loadConversation(c, orgId, user.id, c.req.param("id"));
  if (conv.source === "schedule") throw new ApiError(400, "Planlagte kjøringer kan ikke fortsettes – start en ny samtale");
  const agent = await first<AgentRow>(c.env.DB, `SELECT * FROM agents WHERE id = ? AND org_id = ?`, conv.agent_id, orgId);
  if (!agent) throw notFound("Agenten");

  // Lås samtalen mens agenten svarer (utløper etter 3 min i tilfelle krasj)
  const lock = await c.env.DB.prepare(`UPDATE conversations SET running_since = ? WHERE id = ? AND (running_since IS NULL OR running_since < ?)`)
    .bind(now(), conv.id, now() - 3 * 60 * 1000)
    .run();
  if (!lock.meta.changes) throw new ApiError(409, "Agenten jobber fortsatt med forrige melding");

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let open = true;
  const write = async (chunk: string) => {
    if (!open) return;
    try {
      await writer.write(enc.encode(chunk));
    } catch {
      open = false; // klienten koblet fra – fortsett likevel, slik at svaret lagres
    }
  };
  const emit = (e: ChatEvent) => write(`data: ${JSON.stringify(e)}\n\n`);
  const ping = setInterval(() => void write(`: ping\n\n`), 15000);

  const task = (async () => {
    try {
      if (!conv.title) {
        const title = titleFrom(input.text);
        await c.env.DB.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).bind(title, conv.id).run();
        await emit({ type: "title", title });
      }
      await runTurn({ env: c.env, orgId, agent, conversationId: conv.id, user, text: input.text, context: input.context ?? null, emit });
      await emit({ type: "done" });
    } catch (err) {
      console.error("Agentfeil", err);
      await emit({ type: "error", error: err instanceof Error ? err.message : String(err) });
    } finally {
      clearInterval(ping);
      await c.env.DB.prepare(`UPDATE conversations SET running_since = NULL WHERE id = ?`).bind(conv.id).run().catch(() => undefined);
      try {
        await writer.close();
      } catch {
        /* allerede lukket */
      }
    }
  })();
  c.executionCtx.waitUntil(task);

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
});
