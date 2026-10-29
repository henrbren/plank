import type { Env } from "../env";
import type { BrregCompany } from "./brreg";
import { fetchRetry } from "./retry";

const DEFAULT_MS = "https://boligmappa-ms.laft.io";

export function msBase(env: Env): string {
  return (env.BOLIGMAPPA_MS_URL || DEFAULT_MS).replace(/\/$/, "");
}

function msHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.BOLIGMAPPA_MS_KEY) headers.Authorization = `Bearer ${env.BOLIGMAPPA_MS_KEY}`;
  return headers;
}

/** Sjekker Authorization-headeren på kall fra boligmappa-ms mot den delte nøkkelen */
export async function msKeyMatches(env: Env, header: string | undefined): Promise<boolean> {
  if (!env.BOLIGMAPPA_MS_KEY || !header) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(header)),
    crypto.subtle.digest("SHA-256", enc.encode(`Bearer ${env.BOLIGMAPPA_MS_KEY}`)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export interface MsAccessRequest {
  plankId: string;
  orgNr: string;
  orgName: string | null;
  orgForm: string | null;
  brand: string;
  origin: string;
  name: string;
  email: string;
  emailVerified: boolean;
  consentText: string;
  consentAt: string;
  ip: string | null;
  context: unknown;
}

/** Legger forespørselen i Tilgangsforespørsler i boligmappa-ms-admin. Kaster ved feil, så cron kan prøve igjen. */
export async function sendAccessRequest(env: Env, req: MsAccessRequest): Promise<void> {
  if (!env.BOLIGMAPPA_MS_KEY) throw new Error("BOLIGMAPPA_MS_KEY er ikke satt");
  const res = await fetchRetry(
    `${msBase(env)}/access-requests`,
    { method: "POST", headers: msHeaders(env), body: JSON.stringify(req) },
    { label: "boligmappa-ms", timeoutMs: 15_000, budgetMs: 25_000 },
  );
  if (!res.ok) throw new Error(`boligmappa-ms svarte ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

export interface MsAccessDecision {
  status: "pending" | "approved" | "rejected";
  note: string | null;
  decidedBy: string | null;
}

/** Status i boligmappa-ms. null betyr at forespørselen ikke finnes der. */
export async function fetchAccessDecision(env: Env, plankId: string): Promise<MsAccessDecision | null> {
  if (!env.BOLIGMAPPA_MS_KEY) throw new Error("BOLIGMAPPA_MS_KEY er ikke satt");
  const res = await fetchRetry(
    `${msBase(env)}/access-requests/${encodeURIComponent(plankId)}`,
    { headers: msHeaders(env) },
    { label: "boligmappa-ms", timeoutMs: 10_000, budgetMs: 15_000, tries: 2 },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`boligmappa-ms svarte ${res.status}`);
  return (await res.json()) as MsAccessDecision;
}

/**
 * Bygg Boligmappa har gitt virksomheten tilgang til, uten at personen står i Brønnøysund.
 * null betyr at vi ikke fikk svar. Det er ikke det samme som at virksomheten mangler tilgang.
 */
export async function grantedBuildingCount(env: Env, orgNr: string): Promise<number | null> {
  const base = msBase(env);
  try {
    const res = await fetchRetry(
      `${base}/granted-buildings`,
      { method: "POST", headers: msHeaders(env), body: JSON.stringify({ orgNr }) },
      { label: "Boligmappa", timeoutMs: 25_000, budgetMs: 40_000 },
    );
    if (res.status === 404) return 0;
    if (!res.ok) return null;
    const json = (await res.json()) as { buildings?: { resolved?: boolean }[] };
    return (json.buildings ?? []).filter((b) => b?.resolved).length;
  } catch (err) {
    console.warn("Fikk ikke sjekket tilgang i boligmappa-ms", orgNr, err);
    return null;
  }
}

/**
 * Legger kommunen inn som lead i boligmappa-ms-admin.
 * Godkjenning og overføring til kommune.laft.io skjer der, ikke her.
 */
export async function enqueueKommune(
  env: Env,
  company: BrregCompany,
  contact: { email: string; name: string | null },
  consent: string | null = null,
): Promise<boolean> {
  const base = msBase(env);
  const headers = msHeaders(env);
  const note = [
    `Kommune ba om tilgang via ${contact.name || contact.email}.`,
    `Organisasjonsform: ${company.orgForm ?? company.orgFormKode ?? "kommune"}.`,
    consent ? `Uten Vipps, med samtykke: «${consent}»` : null,
    "Må godkjennes i admin før overføring til kommune.laft.io.",
  ]
    .filter(Boolean)
    .join(" ");

  try {
    const existing = await fetch(`${base}/leads/${company.orgNr}`, { headers, signal: AbortSignal.timeout(12_000) })
      .then((r) => (r.ok ? (r.json() as Promise<{ lead?: { status?: string | null; notes?: string | null } | null }>) : null))
      .catch(() => null);
    const lead = existing?.lead ?? null;
    const keepStatus = Boolean(lead?.status && lead.status !== "new");

    const put = await fetch(`${base}/leads/${company.orgNr}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        status: keepStatus ? "" : "new",
        contact_name: contact.name,
        contact_email: contact.email,
        notes: lead?.notes || note,
      }),
      signal: AbortSignal.timeout(12_000),
    });

    await fetch(`${base}/leads/enrich`, {
      method: "POST",
      headers,
      body: JSON.stringify({ orgNrs: [company.orgNr] }),
      signal: AbortSignal.timeout(12_000),
    }).catch(() => undefined);

    await fetch(`${base}/leads/${company.orgNr}/activity`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "note",
        description: `${contact.name || contact.email} ba om tilgang. Godkjenn i admin før overføring til kommune.laft.io.`,
      }),
      signal: AbortSignal.timeout(12_000),
    }).catch(() => undefined);

    return put.ok || put.status === 409;
  } catch (err) {
    console.error("Kunne ikke legge kommunen i boligmappa-ms-køen", err);
    return false;
  }
}
