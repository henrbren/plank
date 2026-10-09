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

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
