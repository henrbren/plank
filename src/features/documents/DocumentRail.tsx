import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Square, X } from "lucide-react";
import type { Agent, ChatEvent, Conversation, Document, FocusContext, StoredMessage } from "@shared/types";
import { DOCUMENT_KINDS } from "@shared/types";
import { api, streamPost } from "@/lib/api";
import { useOrgQuery } from "@/lib/app";
import { formatBytes, formatDate, formatDateTime, formatOrgNr } from "@/lib/format";
import { DocStatus } from "@/components/domain";
import { cn, IconButton, KeyValues } from "@/components/ui";
import { AssistantTurn, toItems, toolLabel, UserBubble, type Item, type Part } from "@/features/chat/transcript";

/** Samtaler her er egne, så de ikke bytter ut samtalen i agentpanelet. */
const threads = new Map<string, string>();

const WRITE_TOOLS = /^(create_|update_|save_|send_|delete_)|^capture_screen$/;

function threadKey(orgId: string, docId: string) {
  return `${orgId}:${docId}`;
}

function pickAgent(agents: Agent[] | undefined): Agent | undefined {
  if (!agents?.length) return undefined;
  return agents.find((a) => a.template === "fdv-assistent") ?? agents.find((a) => a.template !== "hjelp" && a.template !== "sidebygger") ?? agents[0];
}

export function DocumentRail({
  orgId,
  doc,
  loading,
  error,
  onClose,
}: {
  orgId: string;
  doc: Document | null;
  loading: boolean;
  error?: string | null;
  onClose?: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <div className="min-w-0 flex-1 truncate text-[13px] font-semibold">Om dokumentet</div>
        {onClose && (
          <IconButton label="Lukk" className="xl:hidden" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3.5 py-3">
        {!doc && error && <p className="text-[13px] text-bad">{error}</p>}
        {!doc && !error && loading && <p className="text-[13px] text-muted">Henter opplysninger …</p>}
        {!doc && !error && !loading && <p className="text-[13px] text-muted">Velg et dokument.</p>}
        {doc && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 text-[14.5px] leading-snug font-semibold">{doc.title}</h2>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-muted">
              <span>{DOCUMENT_KINDS[doc.kind]}</span>
              {doc.status !== "ready" && <DocStatus status={doc.status} error={doc.error} />}
            </div>
            <section className="mt-4">
              <h3 className="mb-1.5 text-[11.5px] font-semibold tracking-wide text-muted uppercase">Sammendrag</h3>
              {doc.summary ? (
                <p className="text-[13.5px] leading-relaxed break-words text-ink-2">{doc.summary}</p>
              ) : (
                <p className="text-[13px] leading-relaxed text-muted">
                  {doc.status === "processing"
                    ? "Teksten leses. Sammendraget kommer når den er ferdig."
                    : doc.status === "error"
                      ? doc.error || "Teksten kunne ikke leses."
                      : "Ingen sammendrag er lagret for denne filen."}
                </p>
              )}
            </section>
            <section className="mt-4">
              <h3 className="mb-2 text-[11.5px] font-semibold tracking-wide text-muted uppercase">Detaljer</h3>
              <KeyValues items={metaItems(orgId, doc)} />
            </section>
          </>
        )}
      </div>
      {doc && <DocumentChat orgId={orgId} docId={doc.id} title={doc.title} />}
    </div>
  );
}

function metaItems(orgId: string, doc: Document): [string, ReactNode][] {
  const x = doc.extracted;
  const items: [string, ReactNode][] = [];
  if (doc.ns3451) items.push(["NS 3451", doc.ns3451]);
  if (doc.building_id) {
    items.push([
      "Bygg",
      <Link key="b" className="hover:underline" to={`/o/${orgId}/buildings/${doc.building_id}`}>
        {doc.building_name ?? "Bygget"}
      </Link>,
    ]);
  } else if (doc.property_id && doc.property_name) {
    items.push([
      "Eiendom",
      <Link key="p" className="hover:underline" to={`/o/${orgId}/properties/${doc.property_id}`}>
        {doc.property_name}
      </Link>,
    ]);
  }
  if (doc.component_id) {
    items.push([
      "Komponent",
      <Link key="c" className="hover:underline" to={`/o/${orgId}/components/${doc.component_id}`}>
        {x?.component || "Åpne komponenten"}
      </Link>,
    ]);
  }
  if (x?.supplier) items.push(["Leverandør", x.supplier_org_nr ? `${x.supplier} · ${formatOrgNr(x.supplier_org_nr)}` : x.supplier]);
  if (x?.manufacturer) items.push(["Produsent", x.model ? `${x.manufacturer} ${x.model}` : x.manufacturer]);
  else if (x?.model) items.push(["Modell", x.model]);
  if (x?.serial_number) items.push(["Serienr.", x.serial_number]);
  if (x?.tfm) items.push(["TFM", x.tfm]);
  if (x?.installed_at) items.push(["Installert", formatDate(x.installed_at)]);
  if (x?.warranty_until) items.push(["Garanti til", formatDate(x.warranty_until)]);
  if (x?.last_service_at) items.push(["Siste service", formatDate(x.last_service_at)]);
  if (x?.service_interval_months) items.push(["Intervall", `Hver ${x.service_interval_months}. måned`]);
  const named = new Set([x?.supplier, x?.manufacturer].filter(Boolean));
  const others = (x?.parties ?? []).filter((party) => party.name && !named.has(party.name));
  if (others.length) items.push(["Andre", others.map((party) => `${party.name} (${party.role})`).join(", ")]);
  items.push(["Fil", doc.filename]);
  if (doc.size) items.push(["Størrelse", formatBytes(doc.size)]);
  if (doc.text_chars) items.push(["Tegn", new Intl.NumberFormat("nb-NO").format(doc.text_chars)]);
  items.push(["Lastet opp", formatDateTime(doc.created_at)]);
  return items;
}

export function DocumentChat({ orgId, docId, title, className }: { orgId: string; docId: string; title: string; className?: string }) {
  const qc = useQueryClient();
  const agents = useOrgQuery<Agent[]>("/agents");
  const agent = pickAgent(agents.data);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const gen = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const mine = ++gen.current;
    abortRef.current?.abort();
    setStreaming(false);
    setError(null);
    setText("");
    const saved = threads.get(threadKey(orgId, docId));
    if (!saved) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    void api<Conversation & { messages: StoredMessage[] }>(`/orgs/${orgId}/conversations/${saved}`)
      .then((data) => {
        if (gen.current === mine) setItems(toItems(data.messages));
      })
      .catch(() => {
        threads.delete(threadKey(orgId, docId));
        if (gen.current === mine) setItems([]);
      })
      .finally(() => {
        if (gen.current === mine) setLoading(false);
      });
  }, [orgId, docId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, streaming]);

  const prompts = [
    { label: "Oppsummer", text: `Oppsummer «${title}». Hva er det viktigste for drift og vedlikehold?` },
    { label: "Vedlikehold", text: `Hvilke vedlikeholdskrav står i «${title}»?` },
    { label: "Lag oppgaver", text: `Lag vedlikeholdsoppgaver fra «${title}» der dokumentet sier hva som skal gjøres.` },
  ];

  const send = async (message: string) => {
    const body = message.trim();
    if (!body || streaming) return;
    if (!agent) {
      setError("Ingen agent er klar.");
      return;
    }
    const mine = gen.current;
    const context: FocusContext = { type: "document", id: docId, label: title };
    setError(null);
    let convId = threads.get(threadKey(orgId, docId)) ?? null;
    try {
      if (!convId) {
        const conv = await api<Conversation>(`/orgs/${orgId}/conversations`, { body: { agent_id: agent.id } });
        if (gen.current !== mine) return;
        convId = conv.id;
        threads.set(threadKey(orgId, docId), conv.id);
      }
    } catch (err) {
      if (gen.current === mine) setError(err instanceof Error ? err.message : "Kunne ikke starte samtalen");
      return;
    }

    setText("");
    const pending: Item = { kind: "user", id: "pending", text: body, context };
    const turn: Item & { kind: "assistant" } = { kind: "assistant", id: "live", parts: [] };
    setItems((cur) => [...cur.filter((item) => item.id !== "pending" && item.id !== "live"), pending, turn]);
    setStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let wrote = false;

    const update = (fn: (parts: Part[]) => void) => {
      if (gen.current !== mine) return;
      fn(turn.parts);
      const next = { ...turn, parts: [...turn.parts] };
      setItems((cur) => cur.map((item) => (item.id === "live" ? next : item)));
    };

    try {
      await streamPost<ChatEvent>(
        `/orgs/${orgId}/conversations/${convId}/messages`,
        { text: body, context },
        (event) => {
          if (event.type === "text") {
            update((parts) => {
              const last = parts[parts.length - 1];
              if (last?.type === "text") last.text += event.text;
              else parts.push({ type: "text", text: event.text });
            });
          } else if (event.type === "thinking") {
            update((parts) => {
              const last = parts[parts.length - 1];
              if (last?.type === "thinking") last.text += event.text;
              else parts.push({ type: "thinking", text: event.text });
            });
          } else if (event.type === "tool_start") {
            update((parts) => parts.push({ type: "tool", id: event.id, name: event.name, label: event.label || toolLabel(event.name, {}), status: "running" }));
          } else if (event.type === "tool_result") {
            if (WRITE_TOOLS.test(event.name)) wrote = true;
            update((parts) => {
              const part = parts.find((item) => item.type === "tool" && item.id === event.id);
              if (part && part.type === "tool") {
                part.status = event.ok ? "ok" : "error";
                part.summary = event.summary;
                part.link = event.link;
              }
            });
          } else if (event.type === "error") {
            turn.error = event.error;
            update(() => undefined);
          }
        },
        ctrl.signal,
      );
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError") && gen.current === mine) {
        turn.error = err instanceof Error ? err.message : "Noe gikk galt";
        update(() => undefined);
      }
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      if (gen.current === mine) setStreaming(false);
      try {
        const data = await api<Conversation & { messages: StoredMessage[] }>(`/orgs/${orgId}/conversations/${convId}`);
        if (gen.current === mine) setItems(toItems(data.messages));
      } catch {
        /* behold det som er strømmet */
      }
      if (wrote) void qc.invalidateQueries({ queryKey: ["org", orgId] });
      void qc.invalidateQueries({ queryKey: ["org", orgId, "/conversations"] });
    }
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(text);
    }
  };

  return (
    <div className={cn("shrink-0 border-t border-line bg-panel", className)}>
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <div className="min-w-0 flex-1 text-[11.5px] font-semibold tracking-wide text-muted uppercase">Spør om dokumentet</div>
      </div>
      <div ref={scrollRef} className="max-h-[min(280px,36vh)] overflow-auto px-3 py-2">
        {loading && <p className="text-[12.5px] text-muted">Henter samtalen …</p>}
        {!loading && items.length === 0 && !agent && !agents.isLoading && <p className="text-[12.5px] text-bad">Ingen agent er klar.</p>}
        {!loading && items.length === 0 && (agent || agents.isLoading) && (
          <div className="flex flex-wrap gap-1.5">
            {prompts.map((prompt) => (
              <button
                key={prompt.label}
                type="button"
                disabled={!agent || streaming}
                onClick={() => void send(prompt.text)}
                className="rounded-full border border-line px-2.5 py-1 text-[12.5px] text-ink-2 hover:border-line-strong hover:bg-panel-2 hover:text-ink disabled:opacity-40"
              >
                {prompt.label}
              </button>
            ))}
          </div>
        )}
        {items.length > 0 && (
          <div className="flex flex-col gap-3">
            {items.map((item) =>
              item.kind === "user" ? (
                <UserBubble
                  key={item.id}
                  item={item.context?.type === "document" ? { ...item, context: { type: "document", id: item.context.id } } : item}
                  color={agent?.color}
                />
              ) : (
                <AssistantTurn key={item.id} item={item} orgId={orgId} live={item.id === "live" && streaming} />
              ),
            )}
          </div>
        )}
        {error && <p className="mt-2 text-[12.5px] text-bad">{error}</p>}
      </div>
      <form
        className="px-3 pb-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send(text);
        }}
      >
        <div className="flex items-end gap-1.5 rounded-xl border border-line-strong bg-bg px-2 py-1.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
          <textarea
            ref={boxRef}
            value={text}
            rows={1}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKey}
            placeholder="Spør om denne filen"
            className="max-h-28 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-[13.5px] outline-none placeholder:text-muted"
          />
          {streaming ? (
            <IconButton label="Stopp" onClick={() => abortRef.current?.abort()}>
              <Square className="size-3.5" />
            </IconButton>
          ) : (
            <button
              type="submit"
              disabled={!text.trim()}
              aria-label="Send"
              className="mb-0.5 flex size-7 items-center justify-center rounded-lg bg-accent text-white disabled:opacity-40"
            >
              <ArrowUp className="size-3.5" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
