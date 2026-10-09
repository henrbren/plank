import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, ChevronDown, History, Plus, Settings2, Square, Trash2, X } from "lucide-react";
import type { Agent, ChatEvent, Conversation, FocusContext, StoredMessage } from "@shared/types";
import { api, ApiError, streamPost } from "@/lib/api";
import { useAgentPanel, useFocus, useOrg, useOrgQuery } from "@/lib/app";
import { timeAgo } from "@/lib/format";
import { AgentAvatar, ENTITY_ICONS } from "@/components/domain";
import { cn, IconButton, Menu, MenuItem, Spinner } from "@/components/ui";
import { AssistantTurn, toItems, toolLabel, UserBubble, type Item, type Part } from "./transcript";

const WRITE_TOOLS = /^(create_|update_|save_|send_)/;

function suggestionsFor(focus: FocusContext, agent: Agent | undefined): string[] {
  const label = focus.label ? `«${focus.label}»` : "";
  if (agent?.template === "sidebygger") {
    return focus.type === "building"
      ? [`Lag et dashboard for ${label} med åpne oppgaver og service som forfaller`, "Lag en sjekkliste for månedlig vernerunde", "Lag en romliste med arealer per etasje"]
      : ["Lag et dashboard over åpne avvik i porteføljen", "Lag en oversikt over komponenter med tilstandsgrad TG2 og TG3", "Lag en servicekalender for de neste 12 månedene"];
  }
  switch (focus.type) {
    case "building":
      return [`Oppsummer status for ${label}`, "Hvilke komponenter har service som forfaller de neste 60 dagene?", "Hvilken FDV-dokumentasjon mangler for bygget?"];
    case "property":
      return [`Gi meg en oversikt over ${label}`, "Hva bør prioriteres i vedlikeholdet her?", "Lag et dashboard for eiendommen"];
    case "floor":
    case "room":
      return [`Hva finnes av tekniske komponenter i ${label}?`, `Registrer et avvik i ${label}`, "Hvilke dokumenter gjelder her?"];
    case "document":
      return ["Oppsummer dokumentet", "Hvilke vedlikeholdskrav står i dokumentet?", "Lag vedlikeholdsoppgaver fra dokumentet"];
    case "component":
      return ["Når er neste service, og hva skal gjøres?", "Finn dokumentasjonen for komponenten", "Hvilke reservedeler bør vi ha på lager?"];
    case "artifact":
      return ["Gjør siden mer oversiktlig", "Legg til et diagram", "Legg til filtrering per bygg"];
    case "task":
      return ["Hva må til for å lukke denne oppgaven?", "Finn relevant dokumentasjon"];
    default:
      return ["Hva bør jeg prioritere denne uken?", "Hvilke komponenter har service på overtid?", "Lag et dashboard over åpne avvik og oppgaver"];
  }
}

export function AgentPanel() {
  const { orgId } = useOrg();
  const panel = useAgentPanel();
  const { focus } = useFocus();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const agents = useOrgQuery<(Agent & { schedule_label: string })[]>("/agents");
  const conversations = useOrgQuery<Conversation[]>(panel.open ? "/conversations" : null);
  const [showHistory, setShowHistory] = useState(false);

  const [convData, setConvData] = useState<(Conversation & { messages: StoredMessage[] }) | null>(null);
  const [loadingConv, setLoadingConv] = useState(false);
  const [live, setLive] = useState<Item & { kind: "assistant" } | null>(null);
  const [pendingUser, setPendingUser] = useState<Item & { kind: "user" } | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [useContext, setUseContext] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);

  const agentList = agents.data ?? [];
  const activeAgentId = convData?.agent_id ?? panel.agentId ?? agentList[0]?.id ?? null;
  const agent = agentList.find((a) => a.id === activeAgentId);

  useEffect(() => setUseContext(true), [focus.type, focus.id]);

  // Last samtale
  const loadConversation = useCallback(
    async (id: string) => {
      setLoadingConv(true);
      try {
        const data = await api<Conversation & { messages: StoredMessage[] }>(`/orgs/${orgId}/conversations/${id}`);
        setConvData(data);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) panel.setConversationId(null);
        setConvData(null);
      } finally {
        setLoadingConv(false);
      }
    },
    [orgId, panel],
  );

  useEffect(() => {
    if (!panel.conversationId) {
      setConvData(null);
      return;
    }
    if (convData?.id === panel.conversationId) return;
    if (!streaming) void loadConversation(panel.conversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.conversationId]);

  const items = useMemo(() => {
    const base = convData ? toItems(convData.messages) : [];
    if (pendingUser) base.push(pendingUser);
    if (live) base.push(live);
    return base;
  }, [convData, pendingUser, live]);

  // Autoscroll
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const newChat = useCallback(
    (agentId?: string) => {
      abortRef.current?.abort();
      if (agentId) panel.setAgentId(agentId);
      panel.setConversationId(null);
      setConvData(null);
      setLive(null);
      setPendingUser(null);
      setError(null);
      setShowHistory(false);
      setTimeout(() => textareaRef.current?.focus(), 30);
    },
    [panel],
  );

  const send = useCallback(
    async (message: string, opts: { agentId?: string; newConversation?: boolean } = {}) => {
      const body = message.trim();
      if (!body || streaming) return;
      const targetAgent = opts.agentId ?? activeAgentId;
      if (!targetAgent) {
        setError("Ingen agent er valgt");
        return;
      }
      setError(null);
      setShowHistory(false);
      stickToBottom.current = true;
      const context: FocusContext | null = useContext && focus.type !== "org" ? focus : null;

      let convId = opts.newConversation || (opts.agentId && opts.agentId !== convData?.agent_id) ? null : panel.conversationId;
      if (convData?.source === "schedule") convId = null;
      try {
        if (!convId) {
          const conv = await api<Conversation>(`/orgs/${orgId}/conversations`, { body: { agent_id: targetAgent } });
          convId = conv.id;
          panel.setAgentId(targetAgent);
          setConvData({ ...conv, messages: [] });
          panel.setConversationId(conv.id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Kunne ikke starte samtale");
        return;
      }

      setText("");
      setPendingUser({ kind: "user", id: "pending", text: body, context });
      const turn: Item & { kind: "assistant" } = { kind: "assistant", id: "live", parts: [] };
      setLive({ ...turn });
      setStreaming(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      let wrote = false;

      const update = (fn: (parts: Part[]) => void) => {
        fn(turn.parts);
        setLive({ ...turn, parts: [...turn.parts] });
      };

      try {
        await streamPost<ChatEvent>(
          `/orgs/${orgId}/conversations/${convId}/messages`,
          { text: body, context },
          (e) => {
            switch (e.type) {
              case "text":
                update((parts) => {
                  const last = parts[parts.length - 1];
                  if (last?.type === "text") last.text += e.text;
                  else parts.push({ type: "text", text: e.text });
                });
                break;
              case "thinking":
                update((parts) => {
                  const last = parts[parts.length - 1];
                  if (last?.type === "thinking") last.text += e.text;
                  else parts.push({ type: "thinking", text: e.text });
                });
                break;
              case "tool_start":
                update((parts) => parts.push({ type: "tool", id: e.id, name: e.name, label: e.label || toolLabel(e.name, {}), status: "running" }));
                break;
              case "tool_input":
                update((parts) => {
                  const p = parts.find((x) => x.type === "tool" && x.id === e.id);
                  const label = (e.input as { label?: string })?.label;
                  if (p && p.type === "tool" && label) p.label = label;
                });
                break;
              case "tool_result":
                if (WRITE_TOOLS.test(e.name)) wrote = true;
                update((parts) => {
                  const p = parts.find((x) => x.type === "tool" && x.id === e.id);
                  if (p && p.type === "tool") {
                    p.status = e.ok ? "ok" : "error";
                    p.summary = e.summary;
                    p.link = e.link;
                  }
                });
                if (wrote) void qc.invalidateQueries({ queryKey: ["org", orgId] });
                break;
              case "title":
                void qc.invalidateQueries({ queryKey: ["org", orgId, "/conversations"] });
                break;
              case "error":
                turn.error = e.error;
                setLive({ ...turn });
                break;
            }
          },
          ctrl.signal,
        );
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          turn.error = err instanceof Error ? err.message : "Noe gikk galt";
          setLive({ ...turn });
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
        // Synk med lagret samtale
        try {
          const data = await api<Conversation & { messages: StoredMessage[] }>(`/orgs/${orgId}/conversations/${convId}`);
          setConvData(data);
          setPendingUser(null);
          setLive(turn.error ? { kind: "assistant", id: "err", parts: [], error: turn.error } : null);
        } catch {
          /* behold live-visning */
        }
        void qc.invalidateQueries({ queryKey: ["org", orgId, "/conversations"] });
        if (wrote) void qc.invalidateQueries({ queryKey: ["org", orgId] });
      }
    },
    [streaming, activeAgentId, useContext, focus, convData, panel, orgId, qc],
  );

  // Meldinger fra resten av appen («Spør agenten om …»)
  useEffect(() => {
    if (!panel.pending || streaming || !agents.data) return;
    const { text: t, opts } = panel.pending;
    panel.clearPending();
    void send(t, { agentId: opts.agentId, newConversation: opts.newConversation });
  }, [panel.pending, streaming, agents.data, panel, send]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(text);
    }
  };

  // Autohøyde på tekstfelt
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [text]);

  if (!panel.open) return null;

  const FocusIcon = ENTITY_ICONS[focus.type];
  const readOnly = convData?.source === "schedule";

  return (
    <aside className="fixed inset-0 z-40 flex flex-col border-l border-line bg-panel lg:static lg:z-auto lg:w-[420px] lg:shrink-0 xl:w-[440px]">
      {/* Topp */}
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2">
        <Menu
          align="start"
          className="min-w-0 flex-1"
          trigger={() => (
            <button className="flex max-w-full items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-panel-2">
              {agent ? <AgentAvatar icon={agent.icon} color={agent.color} size="sm" /> : <Spinner />}
              <span className="truncate text-[13.5px] font-semibold">{agent?.name ?? "Velg agent"}</span>
              <ChevronDown className="size-3.5 shrink-0 text-muted" />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="px-2.5 pt-1.5 pb-1 text-[11.5px] font-medium text-muted">Ny samtale med</div>
              {agentList.map((a) => (
                <MenuItem
                  key={a.id}
                  active={a.id === activeAgentId}
                  icon={<AgentAvatar icon={a.icon} color={a.color} size="sm" />}
                  onClick={() => {
                    close();
                    newChat(a.id);
                  }}
                >
                  {a.name}
                </MenuItem>
              ))}
              <div className="my-1 border-t border-line" />
              <MenuItem
                icon={<Settings2 className="size-4" />}
                onClick={() => {
                  close();
                  navigate(`/o/${orgId}/agents`);
                }}
              >
                Administrer agenter
              </MenuItem>
            </>
          )}
        </Menu>
        <IconButton label="Historikk" active={showHistory} onClick={() => setShowHistory((s) => !s)}>
          <History className="size-4" />
        </IconButton>
        <IconButton label="Ny samtale" onClick={() => newChat()}>
          <Plus className="size-4" />
        </IconButton>
        <IconButton label="Lukk panel (⌘J)" onClick={() => panel.setOpen(false)}>
          <X className="size-4" />
        </IconButton>
      </div>

      {showHistory ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {conversations.isLoading && <Spinner className="m-4" />}
          {conversations.data?.length === 0 && <div className="p-4 text-[13px] text-muted">Ingen samtaler ennå.</div>}
          {conversations.data?.map((c) => (
            <div key={c.id} className={cn("group flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-panel-2", c.id === panel.conversationId && "bg-panel-2")}>
              <button
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                onClick={() => {
                  setShowHistory(false);
                  setLive(null);
                  setPendingUser(null);
                  panel.setConversationId(c.id);
                  void loadConversation(c.id);
                }}
              >
                <AgentAvatar icon={c.agent_icon} color={c.agent_color} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px]">{c.title ?? "Uten tittel"}</span>
                  <span className="block text-[11.5px] text-muted">
                    {c.agent_name} · {c.source === "schedule" ? "planlagt · " : ""}
                    {timeAgo(c.updated_at)}
                  </span>
                </span>
              </button>
              {c.source === "chat" && (
                <IconButton
                  label="Slett"
                  size="sm"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={async () => {
                    await api(`/orgs/${orgId}/conversations/${c.id}`, { method: "DELETE" });
                    if (c.id === panel.conversationId) newChat();
                    void conversations.refetch();
                  }}
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {loadingConv && <Spinner className="mx-auto my-6" />}
          {!loadingConv && items.length === 0 && (
            <div className="flex h-full flex-col justify-end pb-2">
              {agent && (
                <div className="mb-5">
                  <AgentAvatar icon={agent.icon} color={agent.color} size="lg" />
                  <div className="mt-3 text-[16px] font-semibold">{agent.name}</div>
                  {agent.description && <div className="mt-1 text-[13px] text-muted">{agent.description}</div>}
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                {suggestionsFor(focus, agent).map((s) => (
                  <button key={s} onClick={() => send(s)} className="rounded-xl border border-line px-3 py-2 text-left text-[13px] text-ink-2 transition-colors hover:border-line-strong hover:bg-panel-2 hover:text-ink">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-col gap-5">
            {items.map((it) =>
              it.kind === "user" ? <UserBubble key={it.id} item={it} /> : <AssistantTurn key={it.id} item={it} orgId={orgId} live={it.id === "live" && streaming} />,
            )}
          </div>
          {error && <div className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</div>}
        </div>
      )}

      {/* Komponer */}
      {readOnly ? (
        <div className="border-t border-line p-3 text-center text-[12.5px] text-muted">
          Dette er en planlagt kjøring.{" "}
          <button className="text-accent underline" onClick={() => newChat(convData?.agent_id)}>
            Start en ny samtale
          </button>
        </div>
      ) : (
        <div className="shrink-0 border-t border-line p-3">
          <div className="rounded-xl border border-line-strong bg-bg focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
            {focus.type !== "org" && useContext && (
              <div className="flex items-center gap-1.5 px-2.5 pt-2">
                <span className="flex max-w-full items-center gap-1.5 rounded-md border border-line bg-panel px-1.5 py-0.5 text-[11.5px] text-ink-2">
                  {FocusIcon && <FocusIcon className="size-3 text-muted" />}
                  <span className="truncate">{focus.label ?? focus.type}</span>
                  <button onClick={() => setUseContext(false)} className="text-muted hover:text-ink" aria-label="Fjern kontekst">
                    <X className="size-3" />
                  </button>
                </span>
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              rows={1}
              placeholder={agent ? `Spør ${agent.name} …` : "Skriv en melding …"}
              className="block max-h-56 w-full resize-none bg-transparent px-3 py-2.5 text-[14px] outline-none placeholder:text-muted"
            />
            <div className="flex items-center justify-between px-2 pb-2">
              <Link to={agent ? `/o/${orgId}/agents/${agent.id}` : `/o/${orgId}/agents`} className="truncate px-1 text-[11.5px] text-muted hover:text-ink">
                {agent ? agent.model.replace("claude-", "").replace(/-/g, " ") : ""}
              </Link>
              {streaming ? (
                <IconButton label="Stopp" className="bg-ink text-bg hover:bg-ink/85 hover:text-bg" onClick={() => abortRef.current?.abort()}>
                  <Square className="size-3.5 fill-current" />
                </IconButton>
              ) : (
                <IconButton label="Send" disabled={!text.trim()} className="bg-accent text-accent-ink hover:bg-accent-hover hover:text-accent-ink disabled:bg-panel-3 disabled:text-muted" onClick={() => send(text)}>
                  <ArrowUp className="size-4" />
                </IconButton>
              )}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
