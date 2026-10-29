const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Kort, sorterbar ID med prefiks, f.eks. bld_lx3k9a2b7c4d */
export function newId(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, "0");
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let rand = "";
  for (const b of bytes) rand += ALPHABET[b % 36];
  return `${prefix}_${time}${rand}`;
}

export function now(): number {
  return Date.now();
}

export function randomToken(bytes = 32): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return base64url(arr);
}

export function base64url(arr: Uint8Array): string {
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function todayIso(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** Legger til måneder på en ISO-dato (YYYY-MM-DD) */
export function addMonths(iso: string, months: number): string | null {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

/** Starten av måneden i Europe/Oslo, som epoch-ms */
export function osloMonthStart(at = Date.now()): number {
  const ym = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit" }).format(new Date(at));
  const guess = Date.parse(`${ym}-01T00:00:00Z`);
  for (let t = guess - 14 * 3_600_000; t < guess + 14 * 3_600_000; t += 60_000) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Oslo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(t));
    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    if (get("day") === "01" && get("hour") === "00" && get("minute") === "00" && `${get("year")}-${get("month")}` === ym) return t;
  }
  return guess;
}

export function osloNextMonthStart(at = Date.now()): number {
  return osloMonthStart(osloMonthStart(at) + 32 * 86_400_000);
}

/** Datoen (YYYY-MM-DD) i Europe/Oslo */
export function osloDay(at: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

/** «31. desember 2026» i Europe/Oslo */
export function osloDateLong(at: number): string {
  return new Date(at).toLocaleDateString("nb-NO", { timeZone: "Europe/Oslo", day: "numeric", month: "long", year: "numeric" });
}

/** Slutten av datoen (YYYY-MM-DD) i Europe/Oslo, som epoch-ms (midnatt mot neste dag) */
export function osloDayEnd(iso: string): number {
  const next = new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const midnight = Date.parse(`${next}T00:00:00Z`);
  for (const hours of [1, 2]) {
    const t = midnight - hours * 3_600_000;
    if (osloDay(t) === next && osloDay(t - 1) === iso) return t;
  }
  return midnight - 3_600_000;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
