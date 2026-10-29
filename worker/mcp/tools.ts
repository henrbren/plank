import type { Env, SessionUser } from "../env";
import { runTurn, titleFrom } from "../agent/runtime";
import { ENTITY_PATHS, executeTool, isWriteTool, logAgent, toolDefsFor, type AgentRow, type ToolContext, type ToolDef, type ToolOutcome } from "../agent/tools";
import { currentAccess, type Access } from "../lib/access";
import { claudeConfigured } from "../lib/anthropic";
import type { ApiKeyInfo } from "../lib/apiKeys";
import { boligmappaConfigured, connectBoligmappa, normalizeOrgNr } from "../lib/boligmappa";
import { all, first } from "../lib/db";
import { ApiError, notFound } from "../lib/http";
import { assertAiAvailable } from "../lib/usage";
import { newId, now, parseJson, truncate } from "../lib/util";
import { storeDocument } from "../services/documents";
import { grantAgents } from "../services/laft";
import { DOCUMENT_KINDS, TOOL_GROUPS, type ChatEvent, type ToolGroup } from "../../shared/types";

/**
 * Verktøyene Plank tilbyr utenfor appen – via MCP (Claude, ChatGPT, Cursor …) og REST-API-et.
 * Gjenbruker agentverktøyene (samme tilgangskontroll og logging), pluss noen som bare gir mening utenfra.
 */

export interface ExternalContext {
  env: Env;
  orgId: string;
  user: SessionUser;
  key: ApiKeyInfo;
  role: "owner" | "admin" | "member";
  /** Offentlig adresse (https://vert) for lenker inn i Plank */
  origin: string;
  waitUntil: (p: Promise<unknown>) => void;
}

const MAX_INLINE_BYTES = 25 * 1024 * 1024;
const MAX_URL_BYTES = 95 * 1024 * 1024;

const str = { type: "string" } as const;
const json = (v: unknown) => JSON.stringify(v, null, 0);

/** Verktøygruppene som gir mening for organisasjonen akkurat nå */
async function availableGroups(ctx: ExternalContext, access: Access): Promise<ToolGroup[]> {
  const [org, bm] = await Promise.all([
    first<{ laft_account_id: string | null }>(ctx.env.DB, `SELECT laft_account_id FROM orgs WHERE id = ?`, ctx.orgId),
    first<{ org_id: string }>(ctx.env.DB, `SELECT org_id FROM bm_sources WHERE org_id = ?`, ctx.orgId),
  ]);
  return (Object.keys(TOOL_GROUPS) as ToolGroup[]).filter((g) => {
    if (g === "web") return false; // nettsøk er et serververktøy hos Claude – klienten har sitt eget
    if (g === "email") return access.canEdit;
    if (g === "laft" || g === "laft_import" || g === "laft_write") return Boolean(org?.laft_account_id);
    if (g === "boligmappa") return Boolean(bm);
    return true;
  });
}

// ─── Verktøy som bare finnes utenfra ────────────────────────────────────────

const plankInfo: ToolDef = {
  group: "portfolio",
  label: () => "Henter info om Plank",
  tool: {
    name: "plank_info",
    description:
      "Start her. Viser organisasjonen, hvem du er logget inn som, tilgangen din (lese/skrive, hele porteføljen eller utvalgte bygg), nøkkeltall (eiendommer, bygg, komponenter, dokumenter, åpne oppgaver) og hvilke datakilder som er koblet til (Boligmappa, LAFT).",
    input_schema: { type: "object", properties: {} },
  },
  run: async (tc) => {
    const access = currentAccess();
    const [org, counts, bm] = await Promise.all([
      first<{ name: string; laft_account_id: string | null }>(tc.env.DB, `SELECT name, laft_account_id FROM orgs WHERE id = ?`, tc.orgId),
      first<Record<string, number>>(
        tc.env.DB,
        `SELECT (SELECT COUNT(*) FROM properties WHERE org_id = ?1) AS properties,
                (SELECT COUNT(*) FROM buildings WHERE org_id = ?1) AS buildings,
                (SELECT COUNT(*) FROM components WHERE org_id = ?1) AS components,
                (SELECT COUNT(*) FROM documents WHERE org_id = ?1) AS documents,
                (SELECT COUNT(*) FROM tasks WHERE org_id = ?1 AND status IN ('open', 'in_progress')) AS open_tasks,
                (SELECT COUNT(*) FROM agents WHERE org_id = ?1 AND archived = 0) AS agents`,
        tc.orgId,
      ),
      first<{ org_nr: string; status: string; building_count: number; document_count: number }>(
        tc.env.DB,
        `SELECT org_nr, status, building_count, document_count FROM bm_sources WHERE org_id = ?`,
        tc.orgId,
      ),
    ]);
    const info = {
      organization: { id: tc.orgId, name: org?.name },
      user: tc.user ? { id: tc.user.id, email: tc.user.email, name: tc.user.name } : null,
      access: {
        can_write: access.canEdit,
        admin: access.admin,
        whole_portfolio: !access.scope,
        buildings: access.scope ? access.scope.buildings.length : null,
      },
      counts: access.scope ? "Tallene vises bare med tilgang til hele porteføljen" : counts,
      sources: {
        boligmappa: bm
          ? { connected: true, org_nr: bm.org_nr, status: bm.status, buildings: bm.building_count, documents: bm.document_count }
          : { connected: false, available: boligmappaConfigured(tc.env) },
        laft: { connected: Boolean(org?.laft_account_id) },
      },
      app_url: `${(tc as ExternalToolContext).origin}/o/${tc.orgId}`,
    };
    return { content: json(info), data: info, summary: org?.name ?? "" };
  },
};

const uploadDocument: ToolDef = {
  group: "documents_write",
  label: (i) => `Laster opp «${truncate(String(i.filename ?? ""), 60)}»`,
  tool: {
    name: "upload_document",
    description:
      "Laster opp et dokument til Plank (PDF, Office, bilder, IFC, tekst). Gi innholdet som content_base64, som ren tekst i text, eller som en offentlig https-url Plank henter selv. Teksten trekkes ut, og dokumentet klassifiseres og blir søkbart i løpet av kort tid. Knytt det til eiendom, bygg, etasje, rom eller komponent når du kan.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Filnavn med filendelse, f.eks. «FDV ventilasjon.pdf»" },
        content_base64: { type: "string", description: "Filinnhold som base64 (maks 25 MB)" },
        text: { type: "string", description: "Ren tekst eller markdown (alternativ til content_base64)" },
        url: { type: "string", description: "https-adresse Plank skal hente filen fra (maks 95 MB)" },
        title: str,
        kind: { type: "string", enum: Object.keys(DOCUMENT_KINDS) },
        ns3451: { type: "string", description: "NS 3451-kode, f.eks. 360" },
        property_id: str,
        building_id: str,
        floor_id: str,
        room_id: str,
        component_id: str,
      },
      required: ["filename"],
    },
  },
  run: async (tc, i) => {
    const bytes = await fileBytes(i);
    const doc = await storeDocument(
      tc.env,
      tc.orgId,
      {
        filename: String(i.filename),
        bytes,
        title: i.title ?? null,
        kind: i.kind ?? null,
        ns3451: i.ns3451 ?? null,
        property_id: i.property_id ?? null,
        building_id: i.building_id ?? null,
        floor_id: i.floor_id ?? null,
        room_id: i.room_id ?? null,
        component_id: i.component_id ?? null,
      },
      { userId: tc.user?.id ?? null, waitUntil: tc.waitUntil },
    );
    await logAgent(tc, "document.uploaded", "document", doc.id, `Lastet opp ${doc.filename}`);
    const out = { ok: true, id: doc.id, title: doc.title, kind: doc.kind, status: doc.status, size: doc.size };
    return {
      content: json({ ...out, note: "Teksten hentes ut i bakgrunnen. Les dokumentet med read_document om et lite øyeblikk." }),
      data: out,
      summary: doc.title,
      link: { type: "document", id: doc.id, label: doc.title },
    };
  },
};

async function fileBytes(i: Record<string, unknown>): Promise<ArrayBuffer> {
  if (typeof i.content_base64 === "string" && i.content_base64) {
    const clean = i.content_base64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    if (clean.length * 0.75 > MAX_INLINE_BYTES) throw new ApiError(413, "Filen er for stor (maks 25 MB som base64). Bruk url i stedet.");
    let bin: string;
    try {
      bin = atob(clean);
    } catch {
      throw new ApiError(400, "content_base64 er ikke gyldig base64");
    }
    const arr = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
    if (arr.byteLength === 0) throw new ApiError(400, "Filen er tom");
    return arr.buffer;
  }
  if (typeof i.text === "string" && i.text) {
    const arr = new TextEncoder().encode(i.text);
    if (arr.byteLength > MAX_INLINE_BYTES) throw new ApiError(413, "Teksten er for lang");
    return arr.buffer as ArrayBuffer;
  }
  if (typeof i.url === "string" && i.url) {
    const url = safeUrl(i.url);
    const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Plank/1.0" } });
    if (!res.ok) throw new ApiError(502, `Klarte ikke å hente filen (${res.status})`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_URL_BYTES) throw new ApiError(413, "Filen er for stor (maks 95 MB)");
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_URL_BYTES) throw new ApiError(413, "Filen er for stor (maks 95 MB)");
    if (buf.byteLength === 0) throw new ApiError(400, "Filen er tom");
    return buf;
  }
  throw new ApiError(400, "Oppgi content_base64, text eller url");
}

/** Bare offentlige https-adresser (ikke IP-adresser eller lokale vertsnavn) */
function safeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ApiError(400, "Ugyldig url");
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:") throw new ApiError(400, "url må bruke https");
  if (u.username || u.password) throw new ApiError(400, "url kan ikke inneholde brukernavn eller passord");
  if (/^[\d.]+$/.test(host) || host.includes(":") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) {
    throw new ApiError(400, "url må peke til et offentlig vertsnavn");
  }
  return u.toString();
}

const listAgents: ToolDef = {
  group: "portfolio",
  label: () => "Lister agenter",
  tool: {
    name: "list_agents",
    description: "Lister Plank-agentene i organisasjonen (navn, beskrivelse, verktøygrupper, tidsplan). Bruk ask_agent for å la en av dem gjøre en jobb.",
    input_schema: { type: "object", properties: {} },
  },
  run: async (tc) => {
    const rows = await all<{ id: string; name: string; description: string | null; model: string; tools: string; schedule: string | null; scope_type: string; scope_id: string | null }>(
      tc.env.DB,
      `SELECT id, name, description, model, tools, schedule, scope_type, scope_id FROM agents WHERE org_id = ? AND archived = 0 ORDER BY created_at`,
      tc.orgId,
    );
    const out = rows.map((r) => ({ ...r, tools: parseJson<string[]>(r.tools, []) }));
    return { content: json(out), data: out, summary: `${out.length} agenter` };
  },
};

const askAgent: ToolDef = {
  group: "portfolio",
  label: () => "Spør en Plank-agent",
  tool: {
    name: "ask_agent",
    description:
      "Gir en oppgave til en Plank-agent, som jobber med sine egne instrukser og verktøy (og kan bygge sider/artifacts i Plank), og returnerer svaret. Bruker organisasjonens AI-kvote. Uten agent_id brukes den første agenten (vanligvis FDV-assistenten). Send conversation_id fra et tidligere svar for å fortsette samme samtale.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Hva agenten skal gjøre eller svare på" },
        agent_id: str,
        conversation_id: str,
      },
      required: ["message"],
    },
  },
  run: async (tc, i) => {
    const env = tc.env;
    if (!claudeConfigured(env)) throw new ApiError(503, "Claude er ikke konfigurert på serveren");
    if (!tc.user) throw new ApiError(401, "Mangler bruker");
    const text = String(i.message ?? "").trim().slice(0, 30000);
    if (!text) throw new ApiError(400, "Skriv en melding");
    await assertAiAvailable(env, tc.orgId);

    let conversationId: string;
    let agent: AgentRow | null;
    if (i.conversation_id) {
      const conv = await first<{ id: string; agent_id: string; source: string }>(
        env.DB,
        `SELECT id, agent_id, source FROM conversations WHERE id = ? AND org_id = ? AND user_id = ?`,
        String(i.conversation_id),
        tc.orgId,
        tc.user.id,
      );
      if (!conv) throw notFound("Samtalen");
      if (conv.source === "schedule") throw new ApiError(400, "Planlagte kjøringer kan ikke fortsettes – start en ny samtale");
      agent = await first<AgentRow>(env.DB, `SELECT * FROM agents WHERE id = ? AND org_id = ?`, conv.agent_id, tc.orgId);
      conversationId = conv.id;
    } else {
      agent = i.agent_id
        ? await first<AgentRow>(env.DB, `SELECT * FROM agents WHERE id = ? AND org_id = ? AND archived = 0`, String(i.agent_id), tc.orgId)
        : await first<AgentRow>(env.DB, `SELECT * FROM agents WHERE org_id = ? AND archived = 0 ORDER BY created_at LIMIT 1`, tc.orgId);
      conversationId = newId("cnv");
      if (agent) {
        const t = now();
        await env.DB.prepare(`INSERT INTO conversations (id, org_id, agent_id, user_id, title, model, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'chat', ?, ?)`)
          .bind(conversationId, tc.orgId, agent.id, tc.user.id, titleFrom(text), agent.model, t, t)
          .run();
      }
    }
    if (!agent) throw notFound("Agenten");

    const lock = await env.DB.prepare(`UPDATE conversations SET running_since = ? WHERE id = ? AND (running_since IS NULL OR running_since < ?)`)
      .bind(now(), conversationId, now() - 3 * 60 * 1000)
      .run();
    if (!lock.meta.changes) throw new ApiError(409, "Agenten jobber fortsatt med forrige melding i denne samtalen");

    const steps: { tool: string; ok: boolean; summary: string }[] = [];
    const links: NonNullable<ToolOutcome["link"]>[] = [];
    const emit = (e: ChatEvent) => {
      if (e.type === "tool_result") {
        steps.push({ tool: e.name, ok: e.ok, summary: e.summary });
        if (e.link) links.push(e.link);
      }
    };
    let result: Awaited<ReturnType<typeof runTurn>>;
    try {
      result = await runTurn({ env, orgId: tc.orgId, agent, conversationId, user: tc.user, text, emit });
    } finally {
      await env.DB.prepare(`UPDATE conversations SET running_since = NULL WHERE id = ?`).bind(conversationId).run().catch(() => undefined);
    }
    const origin = (tc as ExternalToolContext).origin;
    const out = {
      agent: { id: agent.id, name: agent.name },
      conversation_id: conversationId,
      conversation_url: `${origin}/o/${tc.orgId}/conversations/${conversationId}`,
      // plank://-lenker fungerer bare i appen – gjør dem om til vanlige adresser
      answer: result.finalText.replace(/plank:\/\/(\w+)\/([\w-]+)/g, (_m, type: string, id: string) => entityUrl(origin, tc.orgId, type, id)),
      steps,
      links: links.map((l) => ({ ...l, url: entityUrl(origin, tc.orgId, l.type, l.id) })),
    };
    return { content: json(out), data: out, summary: `${agent.name}: ${truncate(result.finalText, 80)}` };
  },
};

const boligmappaConnect: ToolDef = {
  group: "boligmappa",
  label: () => "Kobler til Boligmappa",
  tool: {
    name: "boligmappa_koble_til",
    description:
      "Kobler organisasjonen til Boligmappa med organisasjonsnummeret (9 siffer) til eieren av byggene, og gir agentene tilgang til Boligmappa. Krever administrator. Kjør deretter boligmappa_synk til status er ready, se boligmappa_oversikt og hent bygg med boligmappa_import.",
    input_schema: { type: "object", properties: { org_nr: { type: "string", description: "Organisasjonsnummer, 9 siffer" } }, required: ["org_nr"] },
  },
  run: async (tc, i) => {
    const access = currentAccess();
    if (!access.admin || !access.canEdit || access.scope) throw new ApiError(403, "Krever administrator med skrivetilgang");
    const orgNr = normalizeOrgNr(String(i.org_nr ?? ""));
    await connectBoligmappa(tc.env, tc.orgId, orgNr);
    const agentsGranted = await grantAgents(tc.env, tc.orgId, ["boligmappa"]);
    await logAgent(tc, "boligmappa.connected", "org", tc.orgId, `Koblet til Boligmappa (${orgNr})`);
    const out = { ok: true, org_nr: orgNr, agents_granted: agentsGranted, next: "Kall boligmappa_synk til status er ready." };
    return { content: json(out), data: out, summary: `Koblet til ${orgNr}` };
  },
};

// ─── Oppslag og kjøring ─────────────────────────────────────────────────────

export interface ExternalTool {
  def: ToolDef;
  write: boolean;
}

/** Verktøyene denne nøkkelen kan bruke i organisasjonen */
export async function externalTools(ctx: ExternalContext, access: Access = currentAccess()): Promise<ExternalTool[]> {
  const groups = await availableGroups(ctx, access);
  const defs: ToolDef[] = [plankInfo, ...toolDefsFor(groups, access), listAgents, askAgent];
  if (access.canEdit) defs.splice(1, 0, uploadDocument);
  if (access.admin && access.canEdit && !access.scope && boligmappaConfigured(ctx.env)) defs.push(boligmappaConnect);
  // ask_agent kan endre data gjennom agentens verktøy (innenfor tilgangen), og merkes derfor som skrivende
  const write = (d: ToolDef) => isWriteTool(d.tool.name) || d === uploadDocument || d === boligmappaConnect || d === askAgent;
  return defs.map((def) => ({ def, write: write(def) }));
}

type ExternalToolContext = ToolContext & { origin: string };

function toolContext(ctx: ExternalContext): ExternalToolContext {
  const agent: AgentRow = {
    id: `api_${ctx.key.id}`,
    org_id: ctx.orgId,
    name: ctx.key.name,
    instructions: "",
    model: ctx.env.DEFAULT_MODEL,
    effort: "medium",
    tools: "[]",
    scope_type: "org",
    scope_id: null,
    notify_emails: "[]",
    schedule_prompt: null,
  };
  return {
    env: ctx.env,
    orgId: ctx.orgId,
    agent,
    conversationId: null,
    user: ctx.user,
    scope: { property_id: null, building_id: null },
    via: { keyId: ctx.key.id, keyName: ctx.key.name },
    waitUntil: ctx.waitUntil,
    origin: ctx.origin,
  };
}

export function entityUrl(origin: string, orgId: string, type: string, id: string): string {
  return `${origin}/o/${orgId}/${ENTITY_PATHS[type] ?? type}/${id}`;
}

/** Kjører et verktøy for en ekstern klient. Ukjente eller ikke-tillatte verktøy gir null. */
export async function runExternalTool(ctx: ExternalContext, name: string, input: unknown): Promise<(ToolOutcome & { url?: string }) | null> {
  const tools = await externalTools(ctx);
  const found = tools.find((t) => t.def.tool.name === name);
  if (!found) return null;
  const tc = toolContext(ctx);
  const outcome = await executeTool(tc, new Map([[name, found.def]]), name, input);
  const url = outcome.link ? entityUrl(ctx.origin, ctx.orgId, outcome.link.type, outcome.link.id) : undefined;
  return { ...outcome, url };
}
