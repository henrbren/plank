import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import type { FocusContext, Me, OrgSummary } from "@shared/types";
import { api } from "./api";

// ─── Sesjon ──────────────────────────────────────────────────────────────────

export function useMe() {
  return useQuery<Me>({ queryKey: ["me"], queryFn: () => api<Me>("/me"), retry: false, staleTime: 60_000 });
}

// ─── Organisasjon ────────────────────────────────────────────────────────────

interface OrgCtx {
  orgId: string;
  org: OrgSummary;
  me: Me;
  isAdmin: boolean;
  /** false = lesetilgang */
  canEdit: boolean;
  /** Bare utvalgte eiendommer/bygg */
  limited: boolean;
}
const OrgContext = createContext<OrgCtx | null>(null);

export function OrgProvider({ value, children }: { value: OrgCtx; children: ReactNode }) {
  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgCtx {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error("useOrg må brukes inne i OrgProvider");
  return ctx;
}

/** Spørring mot /api/orgs/:orgId/... */
export function useOrgQuery<T>(path: string | null, options?: Partial<UseQueryOptions<T>>) {
  const { orgId } = useOrg();
  return useQuery<T>({
    queryKey: ["org", orgId, path],
    queryFn: () => api<T>(`/orgs/${orgId}${path}`),
    enabled: path != null,
    ...options,
  });
}

/** Kall mot /api/orgs/:orgId/... som invaliderer org-data etterpå */
export function useOrgApi() {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  return useCallback(
    async <T,>(path: string, opts: Parameters<typeof api>[1] = {}, invalidate = true): Promise<T> => {
      const res = await api<T>(`/orgs/${orgId}${path}`, opts);
      if (invalidate) await qc.invalidateQueries({ queryKey: ["org", orgId] });
      return res;
    },
    [orgId, qc],
  );
}

// ─── Fokus: hva brukeren ser på (sendes som kontekst til agenten) ───────────

interface FocusCtx {
  focus: FocusContext;
  setFocus: (f: FocusContext) => void;
}
const FocusCtxReact = createContext<FocusCtx | null>(null);

export function FocusProvider({ children }: { children: ReactNode }) {
  const [focus, setFocus] = useState<FocusContext>({ type: "org" });
  const value = useMemo(() => ({ focus, setFocus }), [focus]);
  return <FocusCtxReact.Provider value={value}>{children}</FocusCtxReact.Provider>;
}

export function useFocus() {
  const ctx = useContext(FocusCtxReact);
  if (!ctx) throw new Error("FocusProvider mangler");
  return ctx;
}

/** Sider kaller denne for å sette fokus */
export function useSetFocus(type: FocusContext["type"], id?: string, label?: string) {
  const { setFocus } = useFocus();
  useEffect(() => {
    setFocus({ type, id, label });
  }, [type, id, label, setFocus]);
}

// ─── Agentpanel ──────────────────────────────────────────────────────────────

interface AskOptions {
  agentId?: string;
  newConversation?: boolean;
}
interface PanelCtx {
  open: boolean;
  setOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  conversationId: string | null;
  setConversationId: (id: string | null) => void;
  agentId: string | null;
  setAgentId: (id: string | null) => void;
  /** Åpner panelet og sender en melding */
  ask: (text: string, opts?: AskOptions) => void;
  pending: { text: string; opts: AskOptions; nonce: number } | null;
  clearPending: () => void;
}
const PanelContext = createContext<PanelCtx | null>(null);

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignorer */
  }
}

export function AgentPanelProvider({ orgId, children }: { orgId: string; children: ReactNode }) {
  const [open, setOpenState] = useState(() => stored("plank-panel") !== "closed" && window.innerWidth >= 1100);
  const [conversationId, setConv] = useState<string | null>(() => stored(`plank-conv-${orgId}`));
  const [agentId, setAgent] = useState<string | null>(() => stored(`plank-agent-${orgId}`));
  const [pending, setPending] = useState<PanelCtx["pending"]>(null);
  const nonce = useRef(0);

  const setOpen = useCallback((v: boolean | ((p: boolean) => boolean)) => {
    setOpenState((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      store("plank-panel", next ? "open" : "closed");
      return next;
    });
  }, []);
  const setConversationId = useCallback(
    (id: string | null) => {
      setConv(id);
      store(`plank-conv-${orgId}`, id);
    },
    [orgId],
  );
  const setAgentId = useCallback(
    (id: string | null) => {
      setAgent(id);
      store(`plank-agent-${orgId}`, id);
    },
    [orgId],
  );
  const ask = useCallback(
    (text: string, opts: AskOptions = {}) => {
      setOpen(true);
      setPending({ text, opts, nonce: ++nonce.current });
    },
    [setOpen],
  );
  const clearPending = useCallback(() => setPending(null), []);

  const value = useMemo(
    () => ({ open, setOpen, conversationId, setConversationId, agentId, setAgentId, ask, pending, clearPending }),
    [open, setOpen, conversationId, setConversationId, agentId, setAgentId, ask, pending, clearPending],
  );
  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

export function useAgentPanel() {
  const ctx = useContext(PanelContext);
  if (!ctx) throw new Error("AgentPanelProvider mangler");
  return ctx;
}

// ─── Tema ────────────────────────────────────────────────────────────────────

export type ThemeChoice = "system" | "light" | "dark";

export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void, "light" | "dark"] {
  const [choice, setChoice] = useState<ThemeChoice>(() => (stored("plank-theme") as ThemeChoice) || "system");
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = () => setSystemDark(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  const set = useCallback((t: ThemeChoice) => {
    setChoice(t);
    store("plank-theme", t === "system" ? null : t);
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    window.dispatchEvent(new CustomEvent("plank:theme"));
  }, []);
  const effective = choice === "system" ? (systemDark ? "dark" : "light") : choice;
  return [choice, set, effective];
}

/** Effektivt tema (lytter på endringer) */
export function useEffectiveTheme(): "light" | "dark" {
  const read = (): "light" | "dark" => {
    const t = document.documentElement.dataset.theme;
    if (t === "light" || t === "dark") return t;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const fn = () => setTheme(read());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", fn);
    window.addEventListener("plank:theme", fn);
    return () => {
      mq.removeEventListener("change", fn);
      window.removeEventListener("plank:theme", fn);
    };
  }, []);
  return theme;
}
