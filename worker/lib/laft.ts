import type { Env } from "../env";
import { first, insert } from "./db";
import { ApiError, badRequest } from "./http";
import { newId, now, truncate } from "./util";

/**
 * LAFT-klient. Innlogging går via LAFT ID (id.laft.io), som kjenner alle LAFT-instansene og har
 * tjenestenøklene. Vi får tilbake en JWT (kort levetid) og et refresh-token som roteres ved hver
 * fornyelse. LAFT sletter hele tokenfamilien hvis et brukt refresh-token sendes på nytt, så
 * fornyelse skjer under en lås i D1.
 */

const ID_URL = "https://id.laft.io";
const LOOKUP_MS = 60_000;
const CALL_MS = 45_000;
const REFRESH_LOCK_MS = 25_000;
export const MAX_FILE_BYTES = 60 * 1024 * 1024;

export interface LaftInstance {
  name: string;
  url: string;
  host: string;
  mfa: boolean;
  test: boolean;
}

export interface LaftTokens {
  jwt: string;
  refreshToken: string;
}

export interface LaftIdentity {
  id: string;
  email: string;
  name: string;
  role: string | null;
  areaId: string | null;
  areaName: string | null;
}

export interface LaftAccountRow {
  id: string;
  user_id: string | null;
  server_url: string;
  server_name: string;
  laft_user_id: string;
  email: string;
  name: string | null;
  role: string | null;
  area_id: string | null;
  area_name: string | null;
  jwt_enc: string | null;
  jwt_expires_at: number | null;
  refresh_enc: string | null;
  refresh_expires_at: number | null;
  refresh_lock_until: number | null;
  status: "ok" | "expired";
  error: string | null;
  refreshed_at: number | null;
  created_at: number;
  updated_at: number;
}

function idUrl(env: Env): string {
  return (env.LAFT_ID_URL || ID_URL).replace(/\/+$/, "");
}

/** Godtar bare https://<navn>.laft.io/ – tokenet sendes aldri andre steder. */
export function laftServer(raw: string): { url: string; host: string } | null {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "https:" || !/^[a-z0-9-]+\.laft\.io$/.test(host) || u.port || u.pathname.replace(/\/+$/, "") !== "") return null;
    return { url: `https://${host}/`, host };
  } catch {
    return null;
  }
}

export function hostOf(serverUrl: string): string {
  return new URL(serverUrl).hostname;
}

/** Lenke inn i LAFT web */
export function laftLink(serverUrl: string, path: string): string {
  return `${serverUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** «kommune.laft.io:123» – lagres på objekter som er hentet fra LAFT */
export function laftRef(serverUrl: string, id: string | number): string {
  return `${hostOf(serverUrl)}:${id}`;
}

export function refId(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const i = ref.lastIndexOf(":");
  return i >= 0 ? ref.slice(i + 1) : null;
}

// ─── Kryptering av tokens ────────────────────────────────────────────────────

let keyCache: { raw: string; key: CryptoKey } | null = null;

async function tokenKey(env: Env): Promise<CryptoKey> {
  const raw = env.LAFT_TOKEN_KEY ?? (env.DEV_MODE === "true" ? "dev" : "");
  if (!raw) throw new ApiError(503, "LAFT er ikke satt opp på serveren (LAFT_TOKEN_KEY mangler).");
  if (keyCache?.raw === raw) return keyCache.key;
  let bytes: Uint8Array;
  if (raw === "dev") {
    bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("plank-laft-dev")));
  } else {
    bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    if (bytes.byteLength !== 32) throw new ApiError(503, "LAFT_TOKEN_KEY må være 32 byte, base64-kodet.");
  }
  const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  keyCache = { raw, key };
  return key;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** AES-GCM, bundet til konto-ID-en slik at et token ikke kan flyttes til en annen rad. */
async function seal(env: Env, accountId: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(accountId) }, await tokenKey(env), new TextEncoder().encode(plain));
  return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

async function unseal(env: Env, accountId: string, sealed: string): Promise<string> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("Ukjent tokenformat");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: new TextEncoder().encode(accountId) }, await tokenKey(env), unb64(ct));
  return new TextDecoder().decode(plain);
}

/** exp fra JWT-payload (uverifisert – brukes bare til å vite når vi bør fornye) */
function jwtExpiry(token: string): number | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="))) as { exp?: unknown };
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

// ─── LAFT ID ─────────────────────────────────────────────────────────────────

/** Finner LAFT-instansene der e-postadressen har en bruker. */
export async function laftLookup(env: Env, email: string): Promise<LaftInstance[]> {
  let res: Response;
  try {
    res = await fetch(`${idUrl(env)}/retrieve-customer-endpoints`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(LOOKUP_MS),
    });
  } catch {
    throw new ApiError(502, "LAFT ID svarer ikke akkurat nå. Prøv igjen om litt.");
  }
  if (!res.ok) throw new ApiError(502, "LAFT ID svarer ikke akkurat nå. Prøv igjen om litt.");
  const list = (await res.json().catch(() => [])) as { error?: boolean; name?: string; usage?: string; url?: string; data?: { userEndpointQuery?: { mfaEnabled?: boolean; userPresent?: boolean } } }[];
  const out: LaftInstance[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (item.error || !item.url || !item.data?.userEndpointQuery?.userPresent) continue;
    const server = laftServer(item.url);
    if (!server) continue;
    if (out.some((o) => o.url === server.url)) continue;
    out.push({ name: item.name || server.host, url: server.url, host: server.host, mfa: Boolean(item.data.userEndpointQuery.mfaEnabled), test: item.usage === "test" });
  }
  return out.sort((a, b) => Number(a.test) - Number(b.test));
}

/** Logger inn med e-post og passord (og evt. 2FA-kode) på én LAFT-instans. Passordet lagres aldri. */
export async function laftIdLogin(env: Env, input: { email: string; password: string; otp?: string | null; url: string }): Promise<LaftTokens> {
  const server = laftServer(input.url);
  if (!server) throw badRequest("Ukjent LAFT-instans");
  let res: Response;
  try {
    res = await fetch(`${idUrl(env)}/login-user`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email: input.email, password: input.password, mfa: input.otp?.replace(/\s+/g, "") ?? "", endpoint: server.url }),
      signal: AbortSignal.timeout(CALL_MS),
    });
  } catch {
    throw new ApiError(502, "LAFT ID svarer ikke akkurat nå. Prøv igjen om litt.");
  }
  const data = (await res.json().catch(() => null)) as { error?: boolean; errorMessage?: string; jwt?: string; refreshToken?: string } | null;
  if (!data) throw new ApiError(502, "LAFT ID svarte med en feil. Prøv igjen om litt.");
  if (data.error || !data.jwt || !data.refreshToken) {
    const msg = String(data.errorMessage ?? "");
    if (/otp|2-?faktor|two.?factor|mfa/i.test(msg)) throw new ApiError(401, msg.trim() ? truncate(msg.trim(), 160) : "Feil 2-faktor-kode");
    throw new ApiError(401, msg.trim() ? truncate(msg.trim(), 160) : "Feil e-post eller passord");
  }
  return { jwt: data.jwt, refreshToken: data.refreshToken };
}

// ─── GraphQL ─────────────────────────────────────────────────────────────────

interface GqlError {
  message?: string;
  extensions?: { code?: string; error_type?: string };
  path?: (string | number)[];
}

interface GqlResult {
  status: number;
  data: Record<string, unknown> | null;
  errors: GqlError[];
}

async function post(serverUrl: string, headers: Record<string, string>, query: string, variables?: Record<string, unknown>): Promise<GqlResult> {
  let res: Response;
  try {
    res = await fetch(laftLink(serverUrl, "graphql"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify({ query, variables: variables ?? {} }),
      redirect: "manual",
      signal: AbortSignal.timeout(CALL_MS),
    });
  } catch {
    throw new ApiError(502, "LAFT svarer ikke akkurat nå. Prøv igjen om litt.");
  }
  const body = (await res.json().catch(() => null)) as { data?: Record<string, unknown> | null; errors?: GqlError[]; error_type?: string } | null;
  const errors = Array.isArray(body?.errors) ? body!.errors! : [];
  if (body?.error_type) errors.push({ message: body.error_type, extensions: { error_type: body.error_type } });
  return { status: res.status, data: body?.data ?? null, errors };
}

function rejected(r: GqlResult): boolean {
  if (r.status === 401) return true;
  return r.errors.some((e) => e.extensions?.code === "UNAUTHORIZED" || /^Jwt::Errors::/.test(e.extensions?.error_type ?? ""));
}

const WHOAMI = `query PlankWhoAmI { currentUser { id email name firstname lastname role { title } area { id name } } }`;

export async function laftWhoAmI(serverUrl: string, jwt: string): Promise<LaftIdentity> {
  const r = await post(serverUrl, { "JWT-Authorization": `Bearer ${jwt}` }, WHOAMI);
  const u = r.data?.currentUser as { id: number; email: string; name?: string; firstname?: string; lastname?: string; role?: { title?: string } | null; area?: { id: string; name: string } | null } | undefined;
  if (!u?.id) throw new ApiError(502, r.errors[0]?.message ? `LAFT: ${truncate(r.errors[0].message, 160)}` : "Fant ikke brukeren i LAFT");
  return {
    id: String(u.id),
    email: String(u.email ?? "").trim().toLowerCase(),
    name: (u.name || [u.firstname, u.lastname].filter(Boolean).join(" ")).trim() || u.email,
    role: u.role?.title ?? null,
    areaId: u.area?.id != null ? String(u.area.id) : null,
    areaName: u.area?.name ?? null,
  };
}

/**
 * Sperrer alt som ikke er lesing. Strenger og kommentarer fjernes først; alt på nivå 0
 * (utenfor utvalgssett) sjekkes for mutation/subscription.
 */
export function assertReadOnly(query: string): void {
  const stripped = query
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/#[^\n\r]*/g, " ");
  let depth = 0;
  let top = "";
  for (const ch of stripped) {
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) top += ch;
  }
  if (/\b(mutation|subscription)\b/i.test(top)) throw badRequest("Bare lesing (query) er tillatt her. Endringer i LAFT gjøres med egne verktøy.");
}

// ─── Kontoer og tokens ───────────────────────────────────────────────────────

export async function getAccount(env: Env, id: string): Promise<LaftAccountRow | null> {
  return first<LaftAccountRow>(env.DB, `SELECT * FROM laft_accounts WHERE id = ?`, id);
}

export async function orgAccount(env: Env, orgId: string): Promise<LaftAccountRow | null> {
  return first<LaftAccountRow>(env.DB, `SELECT a.* FROM orgs o JOIN laft_accounts a ON a.id = o.laft_account_id WHERE o.id = ?`, orgId);
}

export async function requireOrgAccount(env: Env, orgId: string): Promise<LaftAccountRow> {
  const a = await orgAccount(env, orgId);
  if (!a) throw new ApiError(409, "LAFT er ikke koblet til organisasjonen ennå. En administrator kobler til under LAFT i menyen.");
  if (a.status === "expired" || !a.refresh_enc) throw new ApiError(409, "LAFT-tilkoblingen har utløpt. Logg inn med LAFT på nytt under LAFT i menyen.");
  return a;
}

/** Oppretter eller oppdaterer kontoen for en LAFT-bruker, og lagrer nye tokens. */
export async function upsertAccount(env: Env, instance: { url: string; name: string }, who: LaftIdentity, tokens: LaftTokens): Promise<LaftAccountRow> {
  const t = now();
  let row = await first<LaftAccountRow>(env.DB, `SELECT * FROM laft_accounts WHERE server_url = ? AND laft_user_id = ?`, instance.url, who.id);
  if (!row) {
    const id = newId("lft");
    await insert(env.DB, "laft_accounts", {
      id,
      user_id: null,
      server_url: instance.url,
      server_name: instance.name,
      laft_user_id: who.id,
      email: who.email,
      name: who.name,
      role: who.role,
      area_id: who.areaId,
      area_name: who.areaName,
      status: "ok",
      created_at: t,
      updated_at: t,
    }).run();
    row = (await getAccount(env, id))!;
  } else {
    await env.DB.prepare(`UPDATE laft_accounts SET server_name = ?, email = ?, name = ?, role = ?, area_id = ?, area_name = ?, updated_at = ? WHERE id = ?`)
      .bind(instance.name, who.email, who.name, who.role, who.areaId, who.areaName, t, row.id)
      .run();
  }
  await saveTokens(env, row.id, tokens);
  return (await getAccount(env, row.id))!;
}

async function saveTokens(env: Env, accountId: string, tokens: LaftTokens): Promise<void> {
  const t = now();
  await env.DB.prepare(
    `UPDATE laft_accounts SET jwt_enc = ?, jwt_expires_at = ?, refresh_enc = ?, refresh_expires_at = ?, refresh_lock_until = NULL, status = 'ok', error = NULL, refreshed_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(await seal(env, accountId, tokens.jwt), jwtExpiry(tokens.jwt) ?? t + 10 * 60_000, await seal(env, accountId, tokens.refreshToken), jwtExpiry(tokens.refreshToken), t, t, accountId)
    .run();
}

/** Glemmer tokens (kontoen beholdes som innloggingskobling). */
export async function forgetTokens(env: Env, accountId: string): Promise<void> {
  await env.DB.prepare(`UPDATE laft_accounts SET jwt_enc = NULL, jwt_expires_at = NULL, refresh_enc = NULL, refresh_expires_at = NULL, refresh_lock_until = NULL, updated_at = ? WHERE id = ?`)
    .bind(now(), accountId)
    .run();
}

async function markExpired(env: Env, accountId: string, message: string): Promise<void> {
  await env.DB.prepare(`UPDATE laft_accounts SET status = 'expired', error = ?, refresh_lock_until = NULL, updated_at = ? WHERE id = ?`).bind(message, now(), accountId).run();
}

const expiredError = () => new ApiError(409, "LAFT-tilkoblingen har utløpt. Logg inn med LAFT på nytt under LAFT i menyen.");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Gir en gyldig JWT. Fornyer under lås når den er i ferd med å gå ut (eller når LAFT avviste den,
 * `force`). Har en annen forespørsel allerede fornyet, brukes det nye tokenet.
 */
async function accessToken(env: Env, account: LaftAccountRow, force = false): Promise<string> {
  const seenRefresh = account.refreshed_at ?? 0;
  let row: LaftAccountRow | null = account;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!row || row.status === "expired" || !row.refresh_enc) throw expiredError();
    const renewedByOther = (row.refreshed_at ?? 0) > seenRefresh;
    const fresh = row.jwt_enc && (row.jwt_expires_at ?? 0) > now() + 60_000;
    if (fresh && (!force || renewedByOther)) return unseal(env, row.id, row.jwt_enc!);

    const t = now();
    const lock = await env.DB.prepare(`UPDATE laft_accounts SET refresh_lock_until = ? WHERE id = ? AND (refresh_lock_until IS NULL OR refresh_lock_until < ?)`)
      .bind(t + REFRESH_LOCK_MS, row.id, t)
      .run();
    if (lock.meta.changes) {
      const locked = await getAccount(env, row.id);
      if (!locked || !locked.refresh_enc) throw expiredError();
      if ((locked.refreshed_at ?? 0) > seenRefresh && locked.jwt_enc && (locked.jwt_expires_at ?? 0) > now() + 60_000) {
        await env.DB.prepare(`UPDATE laft_accounts SET refresh_lock_until = NULL WHERE id = ?`).bind(locked.id).run();
        return unseal(env, locked.id, locked.jwt_enc);
      }
      try {
        const r = await post(locked.server_url, { Authorization: `Bearer ${await unseal(env, locked.id, locked.refresh_enc)}` }, `mutation refresh { refresh { jwt refreshToken } }`);
        const next = r.data?.refresh as { jwt?: string; refreshToken?: string } | undefined;
        if (next?.jwt && next.refreshToken) {
          await saveTokens(env, locked.id, { jwt: next.jwt, refreshToken: next.refreshToken });
          return next.jwt;
        }
        if (rejected(r)) {
          await markExpired(env, locked.id, "LAFT avviste fornyelsen. Logg inn på nytt.");
          throw expiredError();
        }
        throw new ApiError(502, `LAFT kunne ikke fornye tilgangen${r.errors[0]?.message ? `: ${truncate(r.errors[0].message, 120)}` : ""}`);
      } catch (err) {
        await env.DB.prepare(`UPDATE laft_accounts SET refresh_lock_until = NULL WHERE id = ? AND status = 'ok' AND refreshed_at IS ?`)
          .bind(locked.id, locked.refreshed_at)
          .run()
          .catch(() => undefined);
        throw err;
      }
    }
    await sleep(700);
    row = await getAccount(env, row.id);
  }
  throw new ApiError(503, "LAFT-tilkoblingen er opptatt. Prøv igjen om litt.");
}

export interface LaftQueryResult<T> {
  data: T;
  errors: GqlError[];
}

/** Kjører en GraphQL-forespørsel mot organisasjonens LAFT. Prøver én gang til etter fornyelse hvis LAFT avviser tokenet. */
export async function laftGraphql<T = Record<string, unknown>>(
  env: Env,
  account: LaftAccountRow,
  query: string,
  variables?: Record<string, unknown>,
  opts: { allowPartial?: boolean } = {},
): Promise<LaftQueryResult<T>> {
  let jwt = await accessToken(env, account);
  let r = await post(account.server_url, { "JWT-Authorization": `Bearer ${jwt}` }, query, variables);
  if (rejected(r)) {
    jwt = await accessToken(env, account, true);
    r = await post(account.server_url, { "JWT-Authorization": `Bearer ${jwt}` }, query, variables);
    if (rejected(r)) throw new ApiError(403, "LAFT avviste forespørselen. Brukeren mangler kanskje tilgang til dette.");
  }
  if (r.status >= 500) throw new ApiError(502, `LAFT svarte med feil (${r.status}). Prøv igjen om litt.`);
  if (!r.data || (r.errors.length && !opts.allowPartial)) {
    const msg = r.errors.map((e) => e.message).filter(Boolean).join("; ");
    throw new ApiError(r.status === 400 ? 400 : 502, msg ? `LAFT: ${truncate(msg, 400)}` : `LAFT svarte uten data (${r.status})`);
  }
  return { data: r.data as T, errors: r.errors };
}

export async function laftQuery<T = Record<string, unknown>>(env: Env, orgId: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const account = await requireOrgAccount(env, orgId);
  return (await laftGraphql<T>(env, account, query, variables)).data;
}

/** Laster ned en fil fra LAFT-dokumentarkivet. */
export async function laftDownload(env: Env, account: LaftAccountRow, nodeId: number): Promise<{ bytes: Uint8Array; mime: string | null; filename: string | null }> {
  const url = laftLink(account.server_url, `app_content_upload/document_node_download/${nodeId}`);
  const get = async (jwt: string) => {
    try {
      return await fetch(url, { headers: { "JWT-Authorization": `Bearer ${jwt}` }, redirect: "manual", signal: AbortSignal.timeout(90_000) });
    } catch {
      throw new ApiError(502, "LAFT svarte ikke på nedlastingen. Prøv igjen om litt.");
    }
  };
  let res = await get(await accessToken(env, account));
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) res = await get(await accessToken(env, account, true));
  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) throw new ApiError(403, "LAFT ga ikke tilgang til filen");
  if (res.status === 404) throw new ApiError(404, "Filen finnes ikke i LAFT");
  if (!res.ok) throw new ApiError(502, `LAFT svarte med feil på nedlastingen (${res.status})`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_FILE_BYTES) throw badRequest("Filen er for stor (maks 60 MB)");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) throw badRequest("Filen er for stor (maks 60 MB)");
  const cd = res.headers.get("content-disposition") ?? "";
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd)?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(cd)?.[1];
  let filename: string | null = null;
  try {
    filename = star ? decodeURIComponent(star.trim().replace(/^"|"$/g, "")) : plain?.trim() ?? null;
  } catch {
    filename = plain?.trim() ?? null;
  }
  return { bytes, mime: res.headers.get("content-type")?.split(";")[0]?.trim() || null, filename };
}

/** Holder tokenkjeden i live: fornyer kontoer som ikke er fornyet det siste døgnet. */
export async function keepLaftAlive(env: Env): Promise<void> {
  if (!env.LAFT_TOKEN_KEY && env.DEV_MODE !== "true") return;
  // Innlogginger som aldri ble bekreftet på e-post skal ikke ligge med gyldige tokens
  await env.DB.prepare(`UPDATE laft_accounts SET jwt_enc = NULL, refresh_enc = NULL, status = 'expired' WHERE user_id IS NULL AND refresh_enc IS NOT NULL AND updated_at < ?`)
    .bind(now() - 24 * 60 * 60 * 1000)
    .run();
  const due = await env.DB.prepare(
    `SELECT * FROM laft_accounts WHERE status = 'ok' AND user_id IS NOT NULL AND refresh_enc IS NOT NULL AND (refreshed_at IS NULL OR refreshed_at < ?) ORDER BY refreshed_at LIMIT 10`,
  )
    .bind(now() - 20 * 60 * 60 * 1000)
    .all<LaftAccountRow>();
  for (const a of due.results ?? []) {
    try {
      await accessToken(env, { ...a, jwt_expires_at: 0 }, true);
    } catch (err) {
      console.error("LAFT keepalive", a.id, err instanceof Error ? err.message : err);
    }
  }
}
