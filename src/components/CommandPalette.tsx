import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { Bot, FileText, Search, Sparkles } from "lucide-react";
import type { SearchHit } from "@shared/types";
import { api } from "@/lib/api";
import { useAgentPanel, useOrg } from "@/lib/app";
import { entityPath } from "@/lib/format";
import { ENTITY_ICONS, ENTITY_LABELS } from "./domain";
import { cn, Spinner } from "./ui";

interface Result {
  key: string;
  icon: React.ReactNode;
  label: string;
  sub?: string | null;
  snippet?: string;
  run: () => void;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { orgId } = useOrg();
  const navigate = useNavigate();
  const panel = useAgentPanel();
  const [q, setQ] = useState("");
  const [data, setData] = useState<{ documents: SearchHit[]; entities: { type: string; id: string; label: string; sub: string | null }[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setData(null);
      setIndex(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  useEffect(() => {
    if (!open || q.trim().length < 2) {
      setData(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      api<typeof data>(`/orgs/${orgId}/search?q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal })
        .then((d) => {
          setData(d);
          setIndex(0);
        })
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, 180);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, open, orgId]);

  const results: Result[] = useMemo(() => {
    const out: Result[] = [];
    const go = (path: string) => () => {
      onClose();
      navigate(path);
    };
    if (q.trim()) {
      out.push({
        key: "ask",
        icon: <Sparkles className="size-4 text-accent" />,
        label: `Spør agenten: «${q.trim()}»`,
        run: () => {
          onClose();
          panel.ask(q.trim());
        },
      });
    }
    for (const e of data?.entities ?? []) {
      const Icon = ENTITY_ICONS[e.type] ?? FileText;
      out.push({ key: `${e.type}-${e.id}`, icon: <Icon className="size-4" />, label: e.label, sub: `${ENTITY_LABELS[e.type] ?? e.type}${e.sub ? ` · ${e.sub}` : ""}`, run: go(entityPath(orgId, e.type, e.id)) });
    }
    for (const d of data?.documents ?? []) {
      out.push({
        key: `doc-${d.document_id}`,
        icon: <FileText className="size-4" />,
        label: d.title,
        sub: d.building_name ? `Dokument · ${d.building_name}` : "Dokument",
        snippet: d.snippet,
        run: go(entityPath(orgId, "document", d.document_id)),
      });
    }
    if (!q.trim()) {
      out.push(
        { key: "nav-tasks", icon: <ENTITY_ICONS.task className="size-4" />, label: "Oppgaver", run: go(`/o/${orgId}/tasks`) },
        { key: "nav-docs", icon: <FileText className="size-4" />, label: "Dokumenter", run: go(`/o/${orgId}/documents`) },
        { key: "nav-agents", icon: <Bot className="size-4" />, label: "Agenter", run: go(`/o/${orgId}/agents`) },
        { key: "nav-artifacts", icon: <ENTITY_ICONS.artifact className="size-4" />, label: "Sider", run: go(`/o/${orgId}/artifacts`) },
        { key: "nav-laft", icon: <ENTITY_ICONS.building className="size-4" />, label: "LAFT", sub: "Datakilde", run: go(`/o/${orgId}/laft`) },
        { key: "nav-boligmappa", icon: <FileText className="size-4" />, label: "Boligmappa", sub: "Datakilde", run: go(`/o/${orgId}/boligmappa`) },
      );
    }
    return out;
  }, [data, q, orgId, navigate, onClose, panel]);

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      results[index]?.run();
    } else if (e.key === "Escape") onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[12vh]">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-panel shadow-pop">
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search className="size-4 text-muted" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Søk i bygg, rom, komponenter, oppgaver og dokumenter …"
            className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted"
          />
          {loading && <Spinner />}
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-1.5">
          {results.length === 0 && q.trim().length >= 2 && !loading && <div className="px-3 py-6 text-center text-[13px] text-muted">Ingen treff</div>}
          {results.map((r, i) => (
            <button
              key={r.key}
              onMouseEnter={() => setIndex(i)}
              onClick={r.run}
              className={cn("flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left", i === index && "bg-panel-2")}
            >
              <span className="mt-0.5 text-muted">{r.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px]">{r.label}</span>
                {r.sub && <span className="block truncate text-[12px] text-muted">{r.sub}</span>}
                {r.snippet && <span className="mt-0.5 line-clamp-2 block text-[12px] text-ink-2">{r.snippet.replace(/[«»]/g, "")}</span>}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
