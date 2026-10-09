import type { Env, SessionUser } from "../env";
import { addUsage, streamClaude, textOf, type Block, type ClaudeMessage, type ClaudeResponse, type ClaudeUsage } from "../lib/anthropic";
import { all, first } from "../lib/db";
import { newId, now, parseJson, truncate } from "../lib/util";
import type { ChatEvent, FocusContext, ToolGroup } from "../../shared/types";
import { buildSystemPrompt, contextBlock } from "./prompts";
import { executeTool, resolveScope, toolLabel, toolsFor, type AgentRow, type ToolContext } from "./tools";

const MAX_STEPS = 24;
const MAX_TOKENS = 32000;

export interface RunTurnOptions {
  env: Env;
  orgId: string;
  agent: AgentRow;
  conversationId: string;
  user: SessionUser | null;
  text: string;
  context?: FocusContext | null;
  scheduled?: boolean;
  emit: (e: ChatEvent) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface RunTurnResult {
  finalText: string;
  usage: ClaudeUsage;
  toolCalls: number;
}

interface StoredRow {
  id: string;
  role: "user" | "assistant";
  content: string;
}

/**
 * Bygger meldingslisten for API-et fra lagrede meldinger, og reparerer historikk som kan ha
 * blitt ugyldig (avbrutte kjøringer, frakobling):
 * - slår sammen påfølgende meldinger med samme rolle
 * - tool_result-blokker legges først i brukermeldingen og må svare til tool_use i forrige assistentmelding
 * - foreldreløse tool_result-blokker fjernes, manglende resultater legges inn som «avbrutt»
 */
export function buildHistory(rows: StoredRow[]): ClaudeMessage[] {
  const merged: { role: "user" | "assistant"; content: Block[] }[] = [];
  for (const r of rows) {
    const content = parseJson<Block[]>(r.content, []);
    if (content.length === 0) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.role === r.role) prev.content.push(...content);
    else merged.push({ role: r.role, content: [...content] });
  }

  const out: { role: "user" | "assistant"; content: Block[] }[] = [];
  const push = (m: { role: "user" | "assistant"; content: Block[] }) => {
    if (m.content.length === 0) return;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content.push(...m.content);
    else out.push(m);
  };

  for (let i = 0; i < merged.length; i++) {
    const m = merged[i]!;
    if (m.role === "assistant") {
      push(m);
      const toolIds = m.content.filter((b) => b.type === "tool_use").map((b) => String(b.id));
      const next = merged[i + 1];
      if (toolIds.length > 0 && (!next || next.role !== "user")) {
        // Verktøykall uten noe svar i det hele tatt
        push({ role: "user", content: toolIds.map((id) => ({ type: "tool_result", tool_use_id: id, content: "Avbrutt – verktøyet ble ikke kjørt ferdig.", is_error: true })) });
      }
      continue;
    }
    const prev = out[out.length - 1];
    const expected = prev?.role === "assistant" ? prev.content.filter((b) => b.type === "tool_use").map((b) => String(b.id)) : [];
    const seen = new Set<string>();
    const results: Block[] = [];
    for (const b of m.content) {
      if (b.type !== "tool_result") continue;
      const id = String(b.tool_use_id);
      if (expected.includes(id) && !seen.has(id)) {
        seen.add(id);
        results.push(b);
      }
    }
    for (const id of expected) {
      if (!seen.has(id)) results.push({ type: "tool_result", tool_use_id: id, content: "Avbrutt – verktøyet ble ikke kjørt ferdig.", is_error: true });
    }
    const others = m.content.filter((b) => b.type !== "tool_result");
    push({ role: "user", content: [...results, ...others] });
  }
  // Historikken må starte med en brukermelding
  while (out.length && out[0]!.role !== "user") out.shift();
  return out;
}

async function saveMessage(env: Env, orgId: string, conversationId: string, role: "user" | "assistant", content: Block[], extra: { context?: FocusContext | null; usage?: ClaudeUsage } = {}) {
  const id = newId("msg");
  await env.DB.prepare(`INSERT INTO messages (id, conversation_id, org_id, role, content, context, usage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, conversationId, orgId, role, JSON.stringify(content), extra.context ? JSON.stringify(extra.context) : null, extra.usage ? JSON.stringify(extra.usage) : null, now())
    .run();
  return id;
}

/** Litt ekstra kontekst om det brukeren ser på (hjelper modellen å bruke riktige ID-er) */
async function focusDetail(env: Env, orgId: string, ctx: FocusContext | null | undefined): Promise<string | null> {
  if (!ctx?.id) return null;
  try {
    if (ctx.type === "floor") {
      const f = await first<{ building_id: string; building: string }>(env.DB, `SELECT f.building_id, b.name AS building FROM floors f JOIN buildings b ON b.id = f.building_id WHERE f.id = ? AND f.org_id = ?`, ctx.id, orgId);
      if (f) return `Etasjen ligger i bygget «${f.building}» (plank://building/${f.building_id}).`;
    }
    if (ctx.type === "room") {
      const r = await first<{ floor_id: string; floor: string; building_id: string; building: string }>(
        env.DB,
        `SELECT r.floor_id, f.name AS floor, r.building_id, b.name AS building FROM rooms r JOIN floors f ON f.id = r.floor_id JOIN buildings b ON b.id = r.building_id WHERE r.id = ? AND r.org_id = ?`,
        ctx.id,
        orgId,
      );
      if (r) return `Rommet ligger i «${r.floor}» (plank://floor/${r.floor_id}) i bygget «${r.building}» (plank://building/${r.building_id}).`;
    }
    if (ctx.type === "component") {
      const c = await first<{ building_id: string | null; room_id: string | null }>(env.DB, `SELECT building_id, room_id FROM components WHERE id = ? AND org_id = ?`, ctx.id, orgId);
      if (c?.building_id) return `Komponenten står i plank://building/${c.building_id}${c.room_id ? `, rom plank://room/${c.room_id}` : ""}.`;
    }
    if (ctx.type === "document") {
      const d = await first<{ building_id: string | null; component_id: string | null; status: string }>(env.DB, `SELECT building_id, component_id, status FROM documents WHERE id = ? AND org_id = ?`, ctx.id, orgId);
      if (d) return `Dokumentet${d.building_id ? ` hører til plank://building/${d.building_id}` : ""}${d.component_id ? ` og komponent plank://component/${d.component_id}` : ""}. Les det med read_document hvis spørsmålet gjelder innholdet.`;
    }
    if (ctx.type === "artifact") {
      return `Hvis brukeren ber om endringer, gjelder det trolig denne siden: les den med get_artifact og lagre ny versjon med update_artifact.`;
    }
  } catch {
    /* ignorer */
  }
  return null;
}

/** Kjører én brukertur: melding inn → (verktøyløkke) → svar ut */
export async function runTurn(opts: RunTurnOptions): Promise<RunTurnResult> {
  const { env, orgId, agent, conversationId, emit } = opts;
  const scope = await resolveScope(env, agent);
  const conv = await first<{ model: string; system_prompt: string | null; tool_groups: string | null }>(
    env.DB,
    `SELECT model, system_prompt, tool_groups FROM conversations WHERE id = ?`,
    conversationId,
  );

  // Systemprompt og verktøy fryses ved første melding: endringer midt i en samtale kan gjøre at
  // API-et avviser tidligere thinking-blokker. Nye agentinnstillinger gjelder fra neste samtale.
  let groups: ToolGroup[];
  let system: string;
  if (conv?.system_prompt && conv.tool_groups) {
    system = conv.system_prompt;
    groups = parseJson<ToolGroup[]>(conv.tool_groups, []);
  } else {
    groups = parseJson<ToolGroup[]>(agent.tools, []);
    const org = await first<{ name: string }>(env.DB, `SELECT name FROM orgs WHERE id = ?`, orgId);
    system = buildSystemPrompt({
      agentName: agent.name,
      instructions: agent.instructions,
      orgName: org?.name ?? "",
      scopeLabel: scope.label,
      tools: groups,
      scheduled: Boolean(opts.scheduled),
    });
    await env.DB.prepare(`UPDATE conversations SET system_prompt = ?, tool_groups = ? WHERE id = ?`).bind(system, JSON.stringify(groups), conversationId).run();
  }
  const { tools, defs } = toolsFor(groups);
  const heartbeat = () =>
    env.DB.prepare(`UPDATE conversations SET running_since = ? WHERE id = ? AND running_since IS NOT NULL`).bind(now(), conversationId).run().catch(() => undefined);

  // Brukermelding
  const ctxText = contextBlock(opts.context, await focusDetail(env, orgId, opts.context));
  const userContent: Block[] = [
    { type: "text", text: ctxText },
    { type: "text", text: opts.text },
  ];
  await saveMessage(env, orgId, conversationId, "user", userContent, { context: opts.context ?? null });

  const rows = await all<StoredRow>(env.DB, `SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY rowid`, conversationId);
  const messages = buildHistory(rows);

  const toolCtx: ToolContext = { env, orgId, agent, conversationId, user: opts.user, scope };
  let usage: ClaudeUsage = {};
  let finalText = "";
  let toolCalls = 0;
  let lastInputTokens: number | null = null;

  if (tools.length > 0) (tools[tools.length - 1] as { cache_control?: unknown }).cache_control = { type: "ephemeral" };

  for (let step = 0; step < MAX_STEPS; step++) {
    if (opts.signal?.aborted) break;
    await heartbeat();

    // Cache-breakpoint på siste blokk i siste melding (gjør verktøyløkker billigere)
    const reqMessages: ClaudeMessage[] = messages.map((m, idx) => {
      if (idx !== messages.length - 1 || m.role !== "user" || typeof m.content === "string") return m;
      const content = [...(m.content as Block[])];
      const lastIdx = content.length - 1;
      const last = content[lastIdx];
      if (last && (last.type === "text" || last.type === "tool_result")) content[lastIdx] = { ...last, cache_control: { type: "ephemeral" } };
      return { ...m, content };
    });

    const messageId = newId("msg");
    await emit({ type: "message_start", message_id: messageId });

    let response: ClaudeResponse | null = null;
    for await (const ev of streamClaude(
      env,
      {
        model: conv?.model ?? agent.model,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: tools.length ? tools : undefined,
        messages: reqMessages,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: (agent.effort as "low" | "medium" | "high") ?? "medium" },
        metadata: opts.user ? { user_id: opts.user.id } : undefined,
      },
      opts.signal,
    )) {
      if (ev.type === "text_delta") await emit({ type: "text", text: ev.text });
      else if (ev.type === "thinking_delta") await emit({ type: "thinking", text: ev.text });
      else if (ev.type === "block_start" && (ev.block.type === "tool_use" || ev.block.type === "server_tool_use")) {
        await emit({ type: "tool_start", id: String(ev.block.id), name: String(ev.block.name), label: toolLabel(defs, String(ev.block.name), {}) });
      } else if (ev.type === "block_stop" && (ev.block.type === "tool_use" || ev.block.type === "server_tool_use")) {
        await emit({ type: "tool_input", id: String(ev.block.id), input: { label: toolLabel(defs, String(ev.block.name), ev.block.input) } });
      } else if (ev.type === "block_stop" && ev.block.type === "web_search_tool_result") {
        const results = Array.isArray(ev.block.content) ? ev.block.content.length : 0;
        await emit({ type: "tool_result", id: String(ev.block.tool_use_id), name: "web_search", ok: true, summary: `${results} resultater` });
      } else if (ev.type === "done") {
        response = ev.message;
      }
    }
    if (!response) throw new Error("Tomt svar fra modellen");

    usage = addUsage(usage, response.usage);
    lastInputTokens = (response.usage.input_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
    // Lagre assistentsvaret uendret (inkl. thinking-blokker med signatur)
    const content = response.content;
    await saveMessage(env, orgId, conversationId, "assistant", content, { usage: response.usage });
    messages.push({ role: "assistant", content });
    const text = textOf(content);
    if (text) finalText = text;
    await emit({ type: "message_done", message_id: messageId });

    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason !== "tool_use") {
      if (response.stop_reason === "max_tokens") await emit({ type: "text", text: "\n\n*(Svaret ble avkortet fordi det ble for langt.)*" });
      if (response.stop_reason === "refusal") await emit({ type: "text", text: "\n\n*(Modellen avslo å svare på denne forespørselen.)*" });
      break;
    }

    // Kjør verktøy
    const results: Block[] = [];
    for (const block of content.filter((b) => b.type === "tool_use")) {
      toolCalls++;
      const name = String(block.name);
      const outcome = await executeTool(toolCtx, defs, name, block.input);
      results.push({ type: "tool_result", tool_use_id: String(block.id), content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
      await emit({ type: "tool_result", id: String(block.id), name, ok: !outcome.isError, summary: outcome.summary, link: outcome.link });
    }
    await saveMessage(env, orgId, conversationId, "user", results);
    messages.push({ role: "user", content: results });
  }

  // Veldig lange samtaler blir dyre og nærmer seg kontekstgrensen
  if ((lastInputTokens ?? 0) > 600_000) {
    await emit({ type: "text", text: "\n\n*(Samtalen er blitt svært lang. Start gjerne en ny samtale for raskere og billigere svar.)*" });
  }

  await env.DB.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).bind(now(), conversationId).run();
  return { finalText, usage, toolCalls };
}

/** Lager en tittel for samtalen fra første melding */
export function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return truncate(clean, 70);
}
