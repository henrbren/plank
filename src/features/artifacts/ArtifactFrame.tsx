import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useEffectiveTheme, useOrg } from "@/lib/app";
import { entityPath } from "@/lib/format";
import { TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES, type TaskPriority, type TaskStatus, type TaskType } from "@shared/types";
import { Button, Modal } from "@/components/ui";

/**
 * Viser en artifact i en sandkasse (opaque origin, ingen nettverkstilgang) og tilbyr
 * window.plank-API-et via postMessage. Alle kall går gjennom appen med brukerens tilgang.
 */

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
  "style-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
  "font-src data: https://cdn.jsdelivr.net",
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Samme flate som appen. Sidens egen CSS kommer etterpå og kan bare bygge videre på variablene. */
const BASE_CSS = `<style>
@font-face {
  font-family: "Inter Variable";
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url("https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5.3.0/files/inter-latin-wght-normal.woff2") format("woff2");
}
:root {
  color-scheme: light;
  --bg: #f7f5f1; --panel: #fdfcfa; --panel-2: #f1eee8; --panel-3: #e9e5dd;
  --line: #e6e1d8; --line-strong: #d4cdc0;
  --ink: #1d1b18; --ink-2: #4a453e; --muted: #857d71;
  --accent: #a65b24;
  --ok: #2f7a4f; --ok-soft: #e3f0e7;
  --warn: #a8720d; --warn-soft: #f7ecd2;
  --bad: #b4442b; --bad-soft: #f7e1db;
  --info: #2c6a9a; --info-soft: #e0ecf5;
}
html[data-theme="dark"] {
  color-scheme: dark;
  --bg: #141311; --panel: #1b1a17; --panel-2: #23211e; --panel-3: #2c2a26;
  --line: #2e2b27; --line-strong: #3e3a34;
  --ink: #ece8e1; --ink-2: #c4bdb2; --muted: #8f877b;
  --accent: #d08a4f;
  --ok: #6cbf8a; --ok-soft: #1d3125;
  --warn: #e0b44f; --warn-soft: #362b14;
  --bad: #ec8a72; --bad-soft: #3c211b;
  --info: #79b3e0; --info-soft: #1b2b38;
}
@media (prefers-color-scheme: dark) {
  html:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #141311; --panel: #1b1a17; --panel-2: #23211e; --panel-3: #2c2a26;
    --line: #2e2b27; --line-strong: #3e3a34;
    --ink: #ece8e1; --ink-2: #c4bdb2; --muted: #8f877b;
    --accent: #d08a4f;
    --ok: #6cbf8a; --ok-soft: #1d3125;
    --warn: #e0b44f; --warn-soft: #362b14;
    --bad: #ec8a72; --bad-soft: #3c211b;
    --info: #79b3e0; --info-soft: #1b2b38;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.5 "Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
</style>`;

function bridgeScript(parentOrigin: string, context: Record<string, unknown>) {
  return `<script>
(() => {
  const PARENT = ${JSON.stringify(parentOrigin)};
  document.documentElement.dataset.theme = ${JSON.stringify(context.theme ?? "")};
  const pending = new Map();
  let seq = 0;
  const call = (kind, name, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parent.postMessage({ __plank: true, kind, id, name, params: params || {} }, PARENT);
  });
  window.addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const d = e.data;
    if (!d || !d.__plank) return;
    if (d.type === "response") {
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      d.ok ? p.resolve(d.data) : p.reject(new Error(d.error || "Feil"));
    } else if (d.type === "context") {
      window.plank.context = d.context;
      document.documentElement.dataset.theme = d.context.theme;
      window.dispatchEvent(new CustomEvent("plank:context", { detail: d.context }));
    }
  });
  window.plank = {
    context: ${JSON.stringify(context)},
    query: (resource, params) => call("query", resource, params),
    action: (name, params) => call("action", name, params),
    open: (type, id) => parent.postMessage({ __plank: true, kind: "open", type, id }, PARENT),
  };
  window.addEventListener("error", (e) => parent.postMessage({ __plank: true, kind: "error", message: String(e.message || e) }, PARENT));
  window.addEventListener("unhandledrejection", (e) => parent.postMessage({ __plank: true, kind: "error", message: String((e.reason && e.reason.message) || e.reason) }, PARENT));
})();
</script>`;
}

export function buildSrcDoc(html: string, parentOrigin: string, context: Record<string, unknown>): string {
  // CSP og bro settes inn helt først (rett etter doctype), slik at de gjelder før noe av sidens eget innhold.
  // Parseren legger dem i <head> selv om siden har sin egen <html>/<head> lenger ned.
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="color-scheme" content="light dark">${BASE_CSS}${bridgeScript(parentOrigin, context)}`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + head + html.slice(doctype[0].length);
  return `<!doctype html>${head}${html}`;
}

const FIELD_LABELS: Record<string, string> = {
  title: "Tittel",
  description: "Beskrivelse",
  type: "Type",
  priority: "Prioritet",
  status: "Status",
  due_date: "Frist",
};

function actionLead(name: string, params: Record<string, unknown>): string {
  const title = typeof params.title === "string" && params.title.trim() ? ` «${params.title.trim()}»` : "";
  if (name === "tasks.create") return `Siden vil opprette en oppgave${title}.`;
  if (name === "tasks.update") return `Siden vil oppdatere en oppgave${title}.`;
  return "Siden vil gjøre en endring.";
}

function actionRows(params: Record<string, unknown>): [string, string][] {
  const rows: [string, string][] = [];
  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    if (key === "title") continue;
    const raw = params[key];
    if (raw == null || raw === "") continue;
    const text = String(raw);
    let value = text;
    if (key === "type" && text in TASK_TYPES) value = TASK_TYPES[text as TaskType];
    else if (key === "priority" && text in TASK_PRIORITIES) value = TASK_PRIORITIES[text as TaskPriority];
    else if (key === "status" && text in TASK_STATUSES) value = TASK_STATUSES[text as TaskStatus];
    else if (key === "due_date" && /^\d{4}-\d{2}-\d{2}/.test(text)) {
      const date = new Date(text.length === 10 ? `${text}T12:00:00` : text);
      if (!Number.isNaN(date.getTime())) value = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", day: "numeric", month: "long", year: "numeric" }).format(date);
    }
    rows.push([label, value]);
  }
  return rows;
}

const pick = (params: Record<string, unknown>, keys: string[]) => {
  const q = new URLSearchParams();
  for (const k of keys) {
    const v = params[k];
    if (v != null && v !== "") q.set(k, String(v));
  }
  return q.toString();
};

export function ArtifactFrame({
  html,
  artifactId,
  buildingId,
  propertyId,
  onRuntimeError,
  className,
}: {
  html: string;
  artifactId: string;
  buildingId?: string | null;
  propertyId?: string | null;
  onRuntimeError?: (msg: string) => void;
  className?: string;
}) {
  const { orgId, org } = useOrg();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const theme = useEffectiveTheme();
  const ref = useRef<HTMLIFrameElement>(null);
  const [confirmAction, setConfirmAction] = useState<{ name: string; params: Record<string, unknown>; resolve: (ok: boolean) => void } | null>(null);
  const pendingAction = useRef(false);
  // Navigasjonsvakt: srcdoc lastes nøyaktig én gang. Flere load-hendelser betyr at siden har navigert
  // bort (f.eks. forsøk på å sende data ut via URL) – da kobles broen fra og rammen lastes på nytt.
  const loads = useRef(0);
  const remounts = useRef(0);
  const [generation, setGeneration] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const onLoad = () => {
    loads.current += 1;
    if (loads.current <= 1) return;
    onRuntimeError?.("Siden forsøkte å navigere bort fra Plank og ble stoppet.");
    if (remounts.current < 2) {
      remounts.current += 1;
      loads.current = 0;
      setGeneration((g) => g + 1);
    } else setBlocked(true);
  };

  const context = useMemo(() => ({ orgName: org.name, artifactId, buildingId: buildingId ?? null, propertyId: propertyId ?? null, theme }), [org.name, artifactId, buildingId, propertyId, theme]);
  // srcdoc bygges bare når HTML endres (ikke ved temabytte – det sendes som melding)
  const srcDoc = useMemo(() => buildSrcDoc(html, window.location.origin, context), [html]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    ref.current?.contentWindow?.postMessage({ __plank: true, type: "context", context }, "*");
  }, [context]);

  useEffect(() => {
    const base = `/orgs/${orgId}`;
    const query = async (name: string, p: Record<string, unknown>): Promise<unknown> => {
      switch (name) {
        case "portfolio.tree":
          return api(`${base}/portfolio/tree`);
        case "properties.list":
          return api(`${base}/portfolio/properties`);
        case "buildings.get":
          return api(`${base}/portfolio/buildings/${encodeURIComponent(String(p.id ?? ""))}`);
        case "components.list":
          return api(`${base}/components?${pick(p, ["building_id", "floor_id", "room_id", "ns3451", "q", "service_due_before", "property_id"])}`);
        case "tasks.list":
          return api(`${base}/tasks?${pick(p, ["status", "type", "building_id", "property_id", "component_id", "due_before", "q"])}`);
        case "documents.list":
          return api(`${base}/documents?${pick(p, ["building_id", "property_id", "kind", "component_id", "q"])}`);
        case "documents.search":
          return api(`${base}/documents/search?${pick(p, ["q", "building_id"])}`);
        case "ifc.models":
          return api(`${base}/ifc/models?${pick(p, ["building_id"])}`);
        case "ifc.elements":
          return api(`${base}/ifc/elements?${pick(p, ["building_id", "document_id", "type", "storey", "q", "limit"])}`);
        case "laft.status":
          return api(`${base}/laft`);
        case "laft.buildings":
          return api(`${base}/laft/buildings`);
        case "laft.building":
          return api(`${base}/laft/buildings/${encodeURIComponent(String(p.id ?? ""))}`);
        case "laft.dashboard":
          return api(`${base}/laft/dashboard`);
        case "laft.work_orders":
          return api(`${base}/laft/work-orders?${pick(p, ["status", "building", "type", "past_due", "deviations", "q", "first"])}`);
        case "laft.documents":
          return api(`${base}/laft/documents?${pick(p, ["building", "parent"])}`);
        case "laft.search":
          return api(`${base}/laft/search?${pick(p, ["q", "building"])}`);
        case "boligmappa.tree":
          return api(`${base}/boligmappa`);
        case "boligmappa.documents":
          return api(`${base}/boligmappa/documents?${pick(p, ["building"])}`);
        default:
          throw new Error(`Ukjent ressurs: ${name}`);
      }
    };
    const action = async (name: string, p: Record<string, unknown>): Promise<unknown> => {
      if (pendingAction.current) throw new Error("En annen handling venter allerede på bekreftelse");
      pendingAction.current = true;
      let ok = false;
      try {
        ok = await new Promise<boolean>((resolve) => setConfirmAction({ name, params: p, resolve }));
      } finally {
        pendingAction.current = false;
      }
      if (!ok) throw new Error("Brukeren avbrøt handlingen");
      let res: unknown;
      if (name === "tasks.create") res = await api(`${base}/tasks`, { body: p });
      else if (name === "tasks.update") {
        const { id, ...rest } = p;
        res = await api(`${base}/tasks/${encodeURIComponent(String(id))}`, { method: "PATCH", body: rest });
      } else throw new Error(`Ukjent handling: ${name}`);
      void qc.invalidateQueries({ queryKey: ["org", orgId] });
      return res;
    };

    const onMessage = async (e: MessageEvent) => {
      const frame = ref.current?.contentWindow;
      if (!frame || e.source !== frame || loads.current > 1) return;
      const d = e.data as { __plank?: boolean; kind?: string; id?: number; name?: string; params?: Record<string, unknown>; type?: string; message?: string };
      if (!d?.__plank) return;
      if (d.kind === "open" && d.type && typeof (d as { id?: unknown }).id === "string") {
        navigate(entityPath(orgId, d.type, String((d as { id?: unknown }).id)));
        return;
      }
      if (d.kind === "error") {
        onRuntimeError?.(String(d.message ?? "Ukjent feil"));
        return;
      }
      if (d.kind !== "query" && d.kind !== "action") return;
      try {
        const data = d.kind === "query" ? await query(String(d.name), d.params ?? {}) : await action(String(d.name), d.params ?? {});
        frame.postMessage({ __plank: true, type: "response", id: d.id, ok: true, data }, "*");
      } catch (err) {
        frame.postMessage({ __plank: true, type: "response", id: d.id, ok: false, error: err instanceof Error ? err.message : String(err) }, "*");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [orgId, navigate, qc, onRuntimeError]);

  return (
    <>
      {blocked ? (
        <div className="flex h-full items-center justify-center p-6 text-center text-[13.5px] text-muted">Siden ble stoppet fordi den gjentatte ganger forsøkte å navigere bort fra Plank.</div>
      ) : (
        <iframe
          key={generation}
          ref={ref}
          title="Artifact"
          sandbox="allow-scripts allow-modals allow-downloads"
          srcDoc={srcDoc}
          onLoad={onLoad}
          className={className ?? "h-full w-full border-0 bg-panel"}
        />
      )}
      <Modal
        open={!!confirmAction}
        onClose={() => {
          confirmAction?.resolve(false);
          setConfirmAction(null);
        }}
        size="sm"
        title="Siden vil gjøre en endring"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                confirmAction?.resolve(false);
                setConfirmAction(null);
              }}
            >
              Avvis
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                confirmAction?.resolve(true);
                setConfirmAction(null);
              }}
            >
              Tillat
            </Button>
          </>
        }
      >
        {confirmAction && (
          <div className="text-[13.5px]">
            <p className="text-ink-2">{actionLead(confirmAction.name, confirmAction.params)}</p>
            {actionRows(confirmAction.params).length > 0 && (
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                {actionRows(confirmAction.params).map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-muted">{label}</dt>
                    <dd className="min-w-0 break-words">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
