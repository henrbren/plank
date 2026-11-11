const dateFmt = new Intl.DateTimeFormat("nb-NO", { day: "numeric", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("nb-NO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const rtf = new Intl.RelativeTimeFormat("nb-NO", { numeric: "auto" });

export function formatOre(ore: number): string {
  const kr = ore / 100;
  const digits = Math.abs(kr) > 0 && Math.abs(kr) < 100 ? 2 : 0;
  return new Intl.NumberFormat("nb-NO", { style: "currency", currency: "NOK", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(kr);
}

export function formatDate(v: string | number | null | undefined): string {
  if (v == null || v === "") return "–";
  const d = typeof v === "number" ? new Date(v) : new Date(v.length === 10 ? v + "T00:00:00" : v);
  return Number.isNaN(d.getTime()) ? String(v) : dateFmt.format(d);
}

export function formatDateTime(v: number | null | undefined): string {
  if (v == null) return "–";
  return dateTimeFmt.format(new Date(v));
}

export function timeAgo(ms: number): string {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  if (abs < 60_000) return "nå nettopp";
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  if (abs < 7 * 86_400_000) return rtf.format(Math.round(diff / 86_400_000), "day");
  return formatDate(ms);
}

/** Dager fra i dag til en ISO-dato (negativ = passert) */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime();
  const d = new Date(iso.slice(0, 10) + "T00:00:00Z").getTime();
  return Math.round((d - today) / 86_400_000);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function formatArea(n: number | null | undefined): string {
  if (n == null) return "–";
  return `${new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 1 }).format(n)} m²`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null) return "–";
  return new Intl.NumberFormat("nb-NO").format(n);
}

export const ENTITY_PATHS: Record<string, string> = {
  property: "properties",
  building: "buildings",
  floor: "floors",
  room: "rooms",
  document: "documents",
  component: "components",
  task: "tasks",
  artifact: "artifacts",
  conversation: "conversations",
  model: "models",
  desk: "pult",
};

export function entityPath(orgId: string, type: string, id: string): string {
  return `/o/${orgId}/${ENTITY_PATHS[type] ?? type}/${id}`;
}

export function formatOrgNr(nr: string) {
  return nr.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3");
}

/** Faste skjermer. Nøkkelen er det agenten skriver, verdien er stien under /o/:orgId. Tom streng er oversikten. */
const APP_PAGES: Record<string, string> = {
  oversikt: "",
  home: "",
  start: "",
  pult: "pult",
  drift: "drift",
  kart: "kart",
  map: "kart",
  oppgaver: "tasks",
  oppgave: "tasks",
  tasks: "tasks",
  task: "tasks",
  dokumenter: "documents",
  dokument: "documents",
  documents: "documents",
  document: "documents",
  komponenter: "components",
  komponent: "components",
  components: "components",
  component: "components",
  "fdv-register": "components",
  sider: "artifacts",
  pages: "artifacts",
  artifacts: "artifacts",
  agenter: "agents",
  agents: "agents",
  hjelp: "hjelp",
  help: "hjelp",
  boligmappa: "boligmappa",
  laft: "laft",
  innstillinger: "settings",
  settings: "settings",
  tilganger: "tilganger",
  access: "tilganger",
  abonnement: "abonnement",
  subscription: "abonnement",
};

function appHref(orgId: string, key: string): string | null {
  const route = APP_PAGES[key.trim().toLowerCase()];
  if (route === undefined) return null;
  return route ? `/o/${orgId}/${route}` : `/o/${orgId}`;
}

/** art_…, tsk_… og tilsvarende. Et vanlig navn som «Oppgaver» er ikke en id. */
function looksLikeId(id: string): boolean {
  return /^[a-z]{2,5}_[a-z0-9]+$/i.test(id);
}

function namedOrEntity(orgId: string, type: string, id: string): string {
  if (!looksLikeId(id)) {
    const named = appHref(orgId, id);
    if (named) return named;
  }
  return entityPath(orgId, type, id);
}

/** Gjør plank://-lenker og kjente stier om til sider i denne organisasjonen. */
export function resolvePlankHref(orgId: string, href: string): string | null {
  const raw = href.trim();
  if (/^plank:/i.test(raw)) {
    const named = /^plank:\/\/(?:nav|page|side)\/([^/?#]+)/i.exec(raw);
    if (named) return appHref(orgId, decodeURIComponent(named[1]!));
    const bare = /^plank:\/\/([^/?#]+)$/i.exec(raw);
    if (bare) return appHref(orgId, decodeURIComponent(bare[1]!));
    const entity = /^plank:\/\/(\w+)\/([^/?#]+)/.exec(raw);
    if (!entity) return null;
    return namedOrEntity(orgId, entity[1]!, decodeURIComponent(entity[2]!));
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  let path = raw.replace(/^\.\//, "");
  if (!path.startsWith("/") && !/^[A-Za-z0-9_-]+$/.test(path)) return null;
  if (!path.startsWith("/")) path = `/${path}`;
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  path = path.replace(/\/+$/, "") || "/";
  const inOrg = /^\/o\/[^/]+(\/.*)?$/.exec(path);
  const rest = inOrg ? inOrg[1] || "/" : path;
  if (rest === "/") return `/o/${orgId}`;
  const helpArticle = /^\/hjelp\/([a-z0-9-]+)$/i.exec(rest);
  if (helpArticle) return `/o/${orgId}/hjelp/${helpArticle[1]}`;
  const nested = /^\/(tasks|documents|components|artifacts|agents|buildings|properties|floors|rooms|models|conversations)\/([^/]+)$/.exec(rest);
  if (nested) return namedOrEntity(orgId, nested[1]!, decodeURIComponent(nested[2]!));
  return appHref(orgId, rest.slice(1));
}
