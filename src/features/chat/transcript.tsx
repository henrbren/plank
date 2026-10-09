import { useState, type MouseEvent } from "react";
import { useNavigate } from "react-router";
import { Check, ChevronRight, CircleAlert, Globe, LoaderCircle } from "lucide-react";
import type { ContentBlock, EntityLink, FocusContext, StoredMessage } from "@shared/types";
import { cn } from "@/components/ui";
import { ENTITY_ICONS } from "@/components/domain";
import { entityPath, resolvePlankHref } from "@/lib/format";
import { renderMarkdown } from "@/lib/markdown";

// ─── Visningsmodell ──────────────────────────────────────────────────────────

export type Part =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; id: string; name: string; label: string; status: "running" | "ok" | "error"; summary?: string; link?: EntityLink };

export type Item = { kind: "user"; id: string; text: string; context: FocusContext | null } | { kind: "assistant"; id: string; parts: Part[]; error?: string };

const TOOL_LABELS: Record<string, (i: any) => string> = {
  search_documents: (i) => `Søker i dokumenter etter «${i.query ?? ""}»`,
  read_document: () => "Leser dokument",
  list_documents: () => "Lister dokumenter",
  update_document: () => "Oppdaterer dokument",
  get_portfolio: () => "Henter porteføljen",
  get_location: () => "Henter plassering",
  create_location: (i) => `Oppretter «${i.name ?? ""}»`,
  update_location: () => "Oppdaterer plassering",
  list_components: () => "Søker i FDV-registeret",
  get_component: () => "Henter komponent",
  save_component: (i) => (i.component_id ? "Oppdaterer komponent" : `Registrerer «${i.name ?? "komponent"}»`),
  list_tasks: () => "Henter oppgaver",
  create_task: (i) => `Oppretter oppgave «${i.title ?? ""}»`,
  update_task: () => "Oppdaterer oppgave",
  create_artifact: (i) => `Bygger siden «${i.title ?? ""}»`,
  update_artifact: () => "Oppdaterer siden",
  get_artifact: () => "Leser siden",
  list_artifacts: () => "Lister sider",
  ifc_overview: () => "Henter BIM-modeller",
  query_ifc_elements: (i) => `Spør BIM-modellen${i.ifc_type ? ` (${i.ifc_type})` : ""}`,
  send_email: (i) => `Sender e-post «${i.subject ?? ""}»`,
  web_search: (i) => `Søker på nettet${i.query ? ` etter «${i.query}»` : ""}`,
};

export function toolLabel(name: string, input: unknown): string {
  try {
    return TOOL_LABELS[name]?.((input ?? {}) as Record<string, unknown>) ?? name;
  } catch {
    return name;
  }
}

const LINK_TOOLS: Record<string, EntityLink["type"]> = {
  create_task: "task",
  update_task: "task",
  create_artifact: "artifact",
  update_artifact: "artifact",
  save_component: "component",
  read_document: "document",
  update_document: "document",
  get_component: "component",
};

function linkFromResult(name: string, input: any, content: unknown): EntityLink | undefined {
  const type = LINK_TOOLS[name];
  if (!type) return undefined;
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  const id =
    input?.document_id ??
    input?.artifact_id ??
    input?.task_id ??
    input?.component_id ??
    /"(?:id|artifact_id)":"([a-z]{3}_[a-z0-9]+)"/.exec(text)?.[1];
  if (!id) return undefined;
  return { type, id, label: toolLabel(name, input) };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => c?.text ?? "").join(" ");
  return "";
}

/** Gjør lagrede API-meldinger om til visningselementer */
export function toItems(messages: StoredMessage[]): Item[] {
  const items: Item[] = [];
  const toolIndex = new Map<string, Part & { type: "tool" }>();
  let current: (Item & { kind: "assistant" }) | null = null;

  for (const m of messages) {
    if (m.role === "user") {
      const results = m.content.filter((b) => b.type === "tool_result") as Extract<ContentBlock, { type: "tool_result" }>[];
      for (const r of results) {
        const part = toolIndex.get(r.tool_use_id);
        if (part) {
          part.status = r.is_error ? "error" : "ok";
          const txt = resultText(r.content);
          part.summary = r.is_error ? txt.replace(/^Feil:\s*/, "").slice(0, 140) : undefined;
          part.link = r.is_error ? undefined : linkFromResult(part.name, (part as any).input, r.content);
        }
      }
      const texts = m.content.filter((b) => b.type === "text").map((b) => String((b as { text: string }).text));
      const userText = texts.filter((t) => !t.startsWith("<kontekst>")).join("\n").trim();
      if (userText) {
        items.push({ kind: "user", id: m.id, text: userText, context: m.context });
        current = null;
      }
      continue;
    }
    if (!current) {
      current = { kind: "assistant", id: m.id, parts: [] };
      items.push(current);
    }
    for (const b of m.content) {
      if (b.type === "text" && (b as { text: string }).text) current.parts.push({ type: "text", text: (b as { text: string }).text });
      else if (b.type === "thinking" && (b as { thinking: string }).thinking) current.parts.push({ type: "thinking", text: (b as { thinking: string }).thinking });
      else if (b.type === "tool_use" || b.type === "server_tool_use") {
        const tb = b as { id: string; name: string; input: unknown };
        const part = { type: "tool" as const, id: tb.id, name: tb.name, label: toolLabel(tb.name, tb.input), status: (b.type === "server_tool_use" ? "ok" : "running") as "running" | "ok" | "error", input: tb.input };
        toolIndex.set(tb.id, part);
        current.parts.push(part);
      }
    }
  }
  // Verktøy uten resultat (avbrutt) vises som feil
  for (const p of toolIndex.values()) if (p.status === "running") p.status = "error";
  return items;
}

// ─── Komponenter ─────────────────────────────────────────────────────────────

export function Markdown({ text, orgId, streaming }: { text: string; orgId: string; streaming?: boolean }) {
  const navigate = useNavigate();
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    const internal = resolvePlankHref(orgId, href);
    if (internal) {
      e.preventDefault();
      navigate(internal);
    } else if (/^https?:/.test(href)) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    }
  };
  return <div className={cn("prose-plank text-[14px]", streaming && "typing-caret")} onClick={onClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

function ToolStep({ part, orgId }: { part: Extract<Part, { type: "tool" }>; orgId: string }) {
  const navigate = useNavigate();
  const Icon = part.link ? ENTITY_ICONS[part.link.type] : null;
  return (
    <div className="flex min-h-7 items-center gap-2 text-[12.5px]">
      <span className="flex size-4 shrink-0 items-center justify-center">
        {part.status === "running" ? (
          <LoaderCircle className="size-3.5 animate-spin text-accent" />
        ) : part.status === "error" ? (
          <CircleAlert className="size-3.5 text-bad" />
        ) : part.name === "web_search" ? (
          <Globe className="size-3.5 text-muted" />
        ) : (
          <Check className="size-3.5 text-ok" />
        )}
      </span>
      <span className={cn("min-w-0 flex-1 truncate", part.status === "running" ? "shimmer-text" : "text-ink-2")} title={part.label}>
        {part.label}
        {part.summary && <span className={cn("ml-1.5", part.status === "error" ? "text-bad" : "text-muted")}>· {part.summary}</span>}
      </span>
      {part.link && part.status !== "running" && (
        <button
          onClick={() => navigate(entityPath(orgId, part.link!.type, part.link!.id))}
          className="flex shrink-0 items-center gap-1 rounded-md border border-line bg-panel px-1.5 py-0.5 text-[11.5px] text-ink-2 hover:border-line-strong hover:text-ink"
        >
          {Icon && <Icon className="size-3" />}
          Åpne
        </button>
      )}
    </div>
  );
}

function ToolGroup({ parts, orgId, live }: { parts: Extract<Part, { type: "tool" }>[]; orgId: string; live: boolean }) {
  const running = parts.some((p) => p.status === "running");
  const [open, setOpen] = useState(false);
  if (parts.length <= 2 || running || live) {
    return (
      <div className="my-1.5 rounded-lg border border-line bg-panel-2/40 px-2.5 py-1">
        {parts.map((p) => (
          <ToolStep key={p.id} part={p} orgId={orgId} />
        ))}
      </div>
    );
  }
  const linked = parts.filter((p) => p.link && (p.name.startsWith("create") || p.name.startsWith("update") || p.name.startsWith("save")));
  return (
    <div className="my-1.5 rounded-lg border border-line bg-panel-2/40 px-2.5 py-1">
      <button onClick={() => setOpen((o) => !o)} className="flex min-h-7 w-full items-center gap-2 text-[12.5px] text-ink-2 hover:text-ink">
        <ChevronRight className={cn("size-3.5 text-muted transition-transform", open && "rotate-90")} />
        {parts.length} steg {parts.some((p) => p.status === "error") && <span className="text-bad">(noen feilet)</span>}
      </button>
      {(open ? parts : linked).map((p) => (
        <ToolStep key={p.id} part={p} orgId={orgId} />
      ))}
    </div>
  );
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-[12.5px] text-muted hover:text-ink">
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        <span className={live ? "shimmer-text" : ""}>{live ? "Tenker …" : "Tankegang"}</span>
      </button>
      {open && <div className="mt-1 ml-5 border-l border-line pl-3 text-[12.5px] leading-relaxed whitespace-pre-wrap text-muted">{text}</div>}
    </div>
  );
}

/** Viser én assistenttur: tankegang, verktøysteg og tekst i riktig rekkefølge */
export function AssistantTurn({ item, orgId, live }: { item: Item & { kind: "assistant" }; orgId: string; live?: boolean }) {
  // Grupper påfølgende verktøy-deler
  const groups: (Part | Extract<Part, { type: "tool" }>[])[] = [];
  for (const p of item.parts) {
    const last = groups[groups.length - 1];
    if (p.type === "tool") {
      if (Array.isArray(last)) last.push(p);
      else groups.push([p]);
    } else if (p.type === "thinking" && Array.isArray(last)) {
      // tanker mellom verktøykall vises ikke separat – hold gruppen samlet
      continue;
    } else groups.push(p);
  }
  const lastIdx = groups.length - 1;
  return (
    <div className="flex flex-col">
      {groups.map((g, i) =>
        Array.isArray(g) ? (
          <ToolGroup key={i} parts={g} orgId={orgId} live={Boolean(live)} />
        ) : g.type === "thinking" ? (
          <Thinking key={i} text={g.text} live={Boolean(live) && i === lastIdx} />
        ) : g.type === "text" ? (
          <Markdown key={i} text={g.text} orgId={orgId} streaming={live && i === lastIdx} />
        ) : null,
      )}
      {live && groups.length === 0 && <div className="shimmer-text text-[13px]">Jobber …</div>}
      {item.error && <div className="mt-2 rounded-lg bg-bad-soft px-3 py-2 text-[13px] text-bad">{item.error}</div>}
    </div>
  );
}

export function UserBubble({ item }: { item: Item & { kind: "user" } }) {
  return (
    <div className="flex flex-col items-end">
      {item.context && item.context.type !== "org" && item.context.label && <div className="mb-1 text-[11.5px] text-muted">{item.context.label}</div>}
      <div className="max-w-[88%] rounded-2xl rounded-br-md bg-panel-3 px-3.5 py-2 text-[14px] whitespace-pre-wrap">{item.text}</div>
    </div>
  );
}
