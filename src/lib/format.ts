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
};

export function entityPath(orgId: string, type: string, id: string): string {
  return `/o/${orgId}/${ENTITY_PATHS[type] ?? type}/${id}`;
}

export function formatOrgNr(nr: string) {
  return nr.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3");
}

/** Gjør plank://type/id om til interne stier */
export function resolvePlankHref(orgId: string, href: string): string | null {
  const m = /^plank:\/\/(\w+)\/([\w-]+)/.exec(href);
  if (!m) return null;
  return entityPath(orgId, m[1]!, m[2]!);
}
