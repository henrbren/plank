import type { Env } from "../env";

/**
 * Minimal Claude Messages API-klient for Workers (fetch + SSE), uten SDK.
 * Holder full kontroll på content blocks slik at de kan lagres og spilles av uendret
 * (nødvendig for adaptive thinking i verktøyløkker).
 */

export type Block = Record<string, unknown> & { type: string };

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | Block[];
}

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: { type: "ephemeral" };
}

export interface ServerTool {
  type: string;
  name: string;
  [key: string]: unknown;
}

export interface ClaudeRequest {
  model: string;
  max_tokens: number;
  system?: string | Block[];
  messages: ClaudeMessage[];
  tools?: (ClaudeTool | ServerTool)[];
  thinking?: { type: "adaptive"; display?: "summarized" | "omitted" };
  output_config?: { effort?: "low" | "medium" | "high" | "xhigh" | "max" };
  metadata?: { user_id?: string };
}

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClaudeResponse {
  id: string;
  role: "assistant";
  model: string;
  content: Block[];
  stop_reason: string | null;
  usage: ClaudeUsage;
}

export type StreamEvent =
  | { type: "text_delta"; index: number; text: string }
  | { type: "thinking_delta"; index: number; text: string }
  | { type: "block_start"; index: number; block: Block }
  | { type: "block_stop"; index: number; block: Block }
  | { type: "done"; message: ClaudeResponse };

export class ClaudeError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function claudeConfigured(env: Env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

function endpoint(env: Env): string {
  return (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "") + "/v1/messages";
}

async function post(env: Env, req: ClaudeRequest & { stream?: boolean }, signal?: AbortSignal): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) throw new ClaudeError(503, "ANTHROPIC_API_KEY er ikke satt");
  let attempt = 0;
  let current: ClaudeRequest & { stream?: boolean } = req;
  let strippedOptional = false;
  for (;;) {
    const res = await fetch(endpoint(env), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(current),
      signal,
    });
    if (res.ok) return res;

    const text = await res.text().catch(() => "");
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
    } catch {
      /* ignorer */
    }

    // Noen modeller støtter ikke alle valgfrie parametere – prøv én gang uten dem.
    if (res.status === 400 && !strippedOptional && /thinking|effort|output_config|display/i.test(message)) {
      strippedOptional = true;
      const { thinking: _t, output_config: _o, ...rest } = current;
      current = rest;
      continue;
    }
    // Overbelastet / rate limit: vent og prøv igjen noen ganger.
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 3) {
      attempt++;
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 20) * 1000 : 1000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new ClaudeError(res.status, `Claude API-feil (${res.status}): ${message.slice(0, 500)}`);
  }
}

/** Ikke-strømmende kall */
export async function callClaude(env: Env, req: ClaudeRequest, signal?: AbortSignal): Promise<ClaudeResponse> {
  const res = await post(env, req, signal);
  return (await res.json()) as ClaudeResponse;
}

/** Strømmende kall. Gir deltaer underveis og hele meldingen til slutt. */
export async function* streamClaude(env: Env, req: ClaudeRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
  const res = await post(env, { ...req, stream: true }, signal);
  if (!res.body) throw new ClaudeError(502, "Tomt svar fra Claude");

  const message: ClaudeResponse = { id: "", role: "assistant", model: req.model, content: [], stop_reason: null, usage: {} };
  const partialJson = new Map<number, string>();

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let complete = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
      const data = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      let evt: Record<string, any>;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      switch (evt.type) {
        case "message_start": {
          const m = evt.message ?? {};
          message.id = m.id ?? "";
          message.model = m.model ?? req.model;
          message.usage = { ...(m.usage ?? {}) };
          break;
        }
        case "content_block_start": {
          const block = { ...(evt.content_block as Block) };
          if (block.type === "tool_use" || block.type === "server_tool_use") partialJson.set(evt.index, "");
          message.content[evt.index] = block;
          yield { type: "block_start", index: evt.index, block };
          break;
        }
        case "content_block_delta": {
          const block = message.content[evt.index];
          const d = evt.delta ?? {};
          if (!block) break;
          if (d.type === "text_delta") {
            block.text = String(block.text ?? "") + d.text;
            yield { type: "text_delta", index: evt.index, text: d.text };
          } else if (d.type === "thinking_delta") {
            block.thinking = String(block.thinking ?? "") + d.thinking;
            yield { type: "thinking_delta", index: evt.index, text: d.thinking };
          } else if (d.type === "signature_delta") {
            block.signature = d.signature;
          } else if (d.type === "input_json_delta") {
            partialJson.set(evt.index, (partialJson.get(evt.index) ?? "") + d.partial_json);
          } else if (d.type === "citations_delta") {
            const list = (block.citations as unknown[]) ?? [];
            list.push(d.citation);
            block.citations = list;
          }
          break;
        }
        case "content_block_stop": {
          const block = message.content[evt.index];
          if (!block) break;
          if (partialJson.has(evt.index)) {
            const json = partialJson.get(evt.index) ?? "";
            try {
              block.input = json ? JSON.parse(json) : {};
            } catch {
              block.input = {};
            }
            partialJson.delete(evt.index);
          }
          yield { type: "block_stop", index: evt.index, block };
          break;
        }
        case "message_delta": {
          if (evt.delta?.stop_reason !== undefined) message.stop_reason = evt.delta.stop_reason;
          if (evt.usage) message.usage = { ...message.usage, ...evt.usage };
          break;
        }
        case "message_stop":
          complete = true;
          break;
        case "error": {
          throw new ClaudeError(502, `Claude strømmefeil: ${evt.error?.message ?? "ukjent"}`);
        }
      }
    }
  }
  // En avbrutt strøm må ikke lagres som et fullstendig svar (ufullstendige thinking-blokker gir 400 senere)
  if (!complete) throw new ClaudeError(502, "Svaret fra Claude ble avbrutt underveis");
  message.content = message.content.filter(Boolean);
  yield { type: "done", message };
}

export function addUsage(a: ClaudeUsage, b: ClaudeUsage): ClaudeUsage {
  return {
    input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
    output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
  };
}

/** Henter all tekst fra et svar */
export function textOf(content: Block[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("\n")
    .trim();
}
