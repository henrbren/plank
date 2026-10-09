// Enkel mock av Claude Messages API (streaming) for lokal testing uten API-nøkkel.
// Start: npm run mock:claude  – og sett ANTHROPIC_BASE_URL=http://localhost:8788 i .dev.vars
//
// Oppførsel:
//  - Validerer at forespørselen er gyldig (vekslende roller, tool_result matcher tool_use, thinking-blokker med signatur)
//  - «side»/«dashboard» i meldingen → create_artifact
//  - «oppgave»/«avvik» → create_task
//  - ellers → search_documents, deretter et tekstsvar som oppsummerer verktøyresultatet
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8788);
let counter = 0;
const id = (p) => `${p}_mock${Date.now().toString(36)}${counter++}`;

function validate(body) {
  const errors = [];
  if ("temperature" in body) errors.push("temperature er ikke støttet");
  const msgs = body.messages ?? [];
  if (msgs.length === 0 || msgs[0].role !== "user") errors.push("første melding må være user");
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (i > 0 && msgs[i - 1].role === m.role) errors.push(`melding ${i}: to ${m.role} på rad`);
    if (!Array.isArray(m.content)) continue;
    if (m.role === "assistant") {
      for (const b of m.content) if (b.type === "thinking" && !b.signature) errors.push(`melding ${i}: thinking uten signatur`);
      const toolIds = m.content.filter((b) => b.type === "tool_use").map((b) => b.id);
      if (toolIds.length) {
        const next = msgs[i + 1];
        const results = (next?.content ?? []).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
        for (const t of toolIds) if (!results.includes(t)) errors.push(`tool_use ${t} mangler tool_result`);
        const firstNonResult = (next?.content ?? []).findIndex((b) => b.type !== "tool_result");
        const lastResult = (next?.content ?? []).map((b) => b.type).lastIndexOf("tool_result");
        if (firstNonResult !== -1 && firstNonResult < lastResult) errors.push("tool_result må komme først");
      }
    }
  }
  if (msgs.length && msgs[msgs.length - 1].role === "assistant") errors.push("prefill (siste melding er assistant) er ikke støttet");
  return errors;
}

function lastUserText(msgs) {
  const last = msgs[msgs.length - 1];
  if (!last || !Array.isArray(last.content)) return typeof last?.content === "string" ? last.content : "";
  return last.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function plan(body) {
  const msgs = body.messages;
  const last = msgs[msgs.length - 1];
  const toolNames = new Set((body.tools ?? []).map((t) => t.name));
  const results = Array.isArray(last.content) ? last.content.filter((b) => b.type === "tool_result") : [];
  if (results.length) {
    const r = results[0];
    const content = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
    let link = "";
    const m = content.match(/"(?:id|artifact_id|document_id)":"((?:doc|tsk|art|cmp)_[a-z0-9]+)"/);
    if (m) {
      const type = { doc: "document", tsk: "task", art: "artifact", cmp: "component" }[m[1].slice(0, 3)];
      link = ` Se [${type}](plank://${type}/${m[1]}).`;
    }
    return {
      blocks: [{ type: "text", text: `Jeg sjekket dette for deg (mock-svar).${link}\n\n| Felt | Verdi |\n|---|---|\n| Resultat | ${r.is_error ? "Feil" : "OK"} |\n| Lengde | ${content.length} tegn |` }],
      stop: "end_turn",
    };
  }
  const text = lastUserText(msgs).toLowerCase();
  if ((text.includes("side") || text.includes("dashboard")) && toolNames.has("create_artifact")) {
    return {
      blocks: [
        {
          type: "tool_use",
          id: id("toolu"),
          name: "create_artifact",
          input: {
            title: "Testside fra mock",
            description: "Viser antall åpne oppgaver",
            html: '<!doctype html><html><body><h1>Åpne oppgaver</h1><p id="n">Laster…</p><script>plank.query("tasks.list",{}).then(t=>document.getElementById("n").textContent=t.length+" åpne oppgaver")</script></body></html>',
          },
        },
      ],
      stop: "tool_use",
    };
  }
  if ((text.includes("oppgave") || text.includes("avvik")) && toolNames.has("create_task")) {
    return {
      blocks: [{ type: "tool_use", id: id("toolu"), name: "create_task", input: { title: "Testavvik fra mock", type: "avvik", priority: "normal" } }],
      stop: "tool_use",
    };
  }
  if (toolNames.has("search_documents")) {
    return {
      blocks: [{ type: "tool_use", id: id("toolu"), name: "search_documents", input: { query: "filter ventilasjon" } }],
      stop: "tool_use",
    };
  }
  return { blocks: [{ type: "text", text: "Hei! Dette er et mock-svar fra Claude." }], stop: "end_turn" };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
}

createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const errors = validate(body);
  console.log(`[mock] ${body.model} · ${body.messages.length} meldinger · ${(body.tools ?? []).length} verktøy${errors.length ? " · FEIL: " + errors.join("; ") : ""}`);
  if (errors.length) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: errors.join("; ") } }));
    return;
  }
  const { blocks, stop } = plan(body);
  const all = [{ type: "thinking", thinking: "Vurderer hvilket verktøy som passer …", signature: "sig_" + id("s") }, ...blocks];

  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: id("msg"), type: "message", role: "assistant", model: body.model, content: all, stop_reason: stop, usage: { input_tokens: 100, output_tokens: 50 } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  sse(res, "message_start", { message: { id: id("msg"), type: "message", role: "assistant", model: body.model, content: [], usage: { input_tokens: 100, output_tokens: 1 } } });
  for (const [index, b] of all.entries()) {
    if (b.type === "thinking") {
      sse(res, "content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
      sse(res, "content_block_delta", { index, delta: { type: "thinking_delta", thinking: b.thinking } });
      sse(res, "content_block_delta", { index, delta: { type: "signature_delta", signature: b.signature } });
    } else if (b.type === "text") {
      sse(res, "content_block_start", { index, content_block: { type: "text", text: "" } });
      for (const part of b.text.match(/[\s\S]{1,12}/g) ?? []) {
        sse(res, "content_block_delta", { index, delta: { type: "text_delta", text: part } });
        await new Promise((r) => setTimeout(r, 15));
      }
    } else if (b.type === "tool_use") {
      sse(res, "content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      for (const part of json.match(/[\s\S]{1,40}/g) ?? []) sse(res, "content_block_delta", { index, delta: { type: "input_json_delta", partial_json: part } });
    }
    sse(res, "content_block_stop", { index });
  }
  sse(res, "message_delta", { delta: { stop_reason: stop }, usage: { output_tokens: 42 } });
  sse(res, "message_stop", {});
  res.end();
}).listen(PORT, () => console.log(`[mock] Claude-mock lytter på http://localhost:${PORT}`));
