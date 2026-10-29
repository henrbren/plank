import type { Env, SessionUser } from "../env";
import { all, first } from "./db";
import { notFound } from "./http";
import { newId, now, randomToken, sha256 } from "./util";
import type { ApiKeySummary } from "../../shared/types";

/**
 * API-nøkler og OAuth-tilganger. Begge er bearer-tokens som gir en bruker tilgang til én organisasjon,
 * med lese- eller skrivetilgang – men aldri mer enn medlemskapet gir (det sjekkes på hver forespørsel).
 */

export const KEY_PREFIX = "plk_";
export const OAUTH_ACCESS_PREFIX = "plko_";
export const OAUTH_REFRESH_PREFIX = "plkr_";

/** OAuth: tilgangstoken lever et døgn, fornyelsestoken 90 dager (roteres ved bruk) */
export const OAUTH_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
export const OAUTH_REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface ApiKeyInfo {
  id: string;
  orgId: string;
  name: string;
  kind: "key" | "oauth";
  canWrite: boolean;
}

interface KeyRow {
  id: string;
  org_id: string;
  user_id: string;
  name: string;
  kind: "key" | "oauth";
  prefix: string;
  can_write: number;
  client_id: string | null;
  expires_at: number | null;
  refresh_expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

/** Leser bearer-token fra Authorization-headeren */
export function bearerToken(header: string | undefined | null): string | null {
  const m = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1]! : null;
}

/** Slår opp et bearer-token. Returnerer null hvis det er ukjent, tilbakekalt eller utløpt. */
export async function authenticateToken(env: Env, token: string): Promise<{ user: SessionUser; key: ApiKeyInfo } | null> {
  if (!token.startsWith(KEY_PREFIX) && !token.startsWith(OAUTH_ACCESS_PREFIX)) return null;
  const row = await first<KeyRow & { email: string; user_name: string | null }>(
    env.DB,
    `SELECT k.*, u.email, u.name AS user_name FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.token_hash = ?`,
    await sha256(token),
  );
  const t = now();
  if (!row || row.revoked_at || (row.expires_at && row.expires_at < t)) return null;
  // Oppdater «sist brukt» høyst én gang i minuttet
  if (!row.last_used_at || row.last_used_at < t - 60_000) {
    await env.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).bind(t, row.id).run().catch(() => undefined);
  }
  return {
    user: { id: row.user_id, email: row.email, name: row.user_name },
    key: { id: row.id, orgId: row.org_id, name: row.name, kind: row.kind, canWrite: row.can_write === 1 },
  };
}

export async function createApiKey(
  env: Env,
  input: { orgId: string; userId: string; name: string; canWrite: boolean; expiresAt: number | null },
): Promise<{ id: string; token: string }> {
  const token = `${KEY_PREFIX}${randomToken(32)}`;
  const id = newId("key");
  await env.DB.prepare(
    `INSERT INTO api_keys (id, org_id, user_id, name, kind, token_hash, prefix, can_write, expires_at, created_at) VALUES (?, ?, ?, ?, 'key', ?, ?, ?, ?, ?)`,
  )
    .bind(id, input.orgId, input.userId, input.name, await sha256(token), token.slice(0, 10), input.canWrite ? 1 : 0, input.expiresAt, now())
    .run();
  return { id, token };
}

/** Utsteder (eller roterer) OAuth-tokens. Uten id opprettes en ny tilgang. */
export async function issueOAuthTokens(
  env: Env,
  input: { id?: string; orgId: string; userId: string; clientId: string; clientName: string; canWrite: boolean },
): Promise<{ id: string; accessToken: string; refreshToken: string; expiresIn: number }> {
  const accessToken = `${OAUTH_ACCESS_PREFIX}${randomToken(32)}`;
  const refreshToken = `${OAUTH_REFRESH_PREFIX}${randomToken(32)}`;
  const t = now();
  const [accessHash, refreshHash] = await Promise.all([sha256(accessToken), sha256(refreshToken)]);
  if (input.id) {
    await env.DB.prepare(`UPDATE api_keys SET token_hash = ?, prefix = ?, refresh_hash = ?, expires_at = ?, refresh_expires_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .bind(accessHash, accessToken.slice(0, 10), refreshHash, t + OAUTH_ACCESS_TTL_MS, t + OAUTH_REFRESH_TTL_MS, input.id)
      .run();
    return { id: input.id, accessToken, refreshToken, expiresIn: OAUTH_ACCESS_TTL_MS / 1000 };
  }
  const id = newId("key");
  await env.DB.prepare(
    `INSERT INTO api_keys (id, org_id, user_id, name, kind, token_hash, prefix, can_write, client_id, refresh_hash, expires_at, refresh_expires_at, created_at)
     VALUES (?, ?, ?, ?, 'oauth', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.orgId,
      input.userId,
      input.clientName.slice(0, 100),
      accessHash,
      accessToken.slice(0, 10),
      input.canWrite ? 1 : 0,
      input.clientId,
      refreshHash,
      t + OAUTH_ACCESS_TTL_MS,
      t + OAUTH_REFRESH_TTL_MS,
      t,
    )
    .run();
  return { id, accessToken, refreshToken, expiresIn: OAUTH_ACCESS_TTL_MS / 1000 };
}

/** Finner OAuth-tilgangen bak et fornyelsestoken */
export async function findRefreshGrant(env: Env, refreshToken: string): Promise<KeyRow | null> {
  if (!refreshToken.startsWith(OAUTH_REFRESH_PREFIX)) return null;
  const row = await first<KeyRow>(env.DB, `SELECT * FROM api_keys WHERE refresh_hash = ? AND kind = 'oauth'`, await sha256(refreshToken));
  if (!row || row.revoked_at || (row.refresh_expires_at && row.refresh_expires_at < now())) return null;
  return row;
}

/** Tilbakekaller tokenet (tilgang eller fornyelse) hvis det finnes. Ukjente tokens ignoreres (RFC 7009). */
export async function revokeToken(env: Env, token: string): Promise<void> {
  const hash = await sha256(token);
  await env.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE (token_hash = ? OR refresh_hash = ?) AND revoked_at IS NULL`).bind(now(), hash, hash).run();
}

/** Nøkler i organisasjonen. Administratorer ser alle, andre bare sine egne. */
export async function listApiKeys(env: Env, orgId: string, viewer: { userId: string; admin: boolean }): Promise<ApiKeySummary[]> {
  const rows = await all<KeyRow & { email: string }>(
    env.DB,
    `SELECT k.*, u.email FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.org_id = ? AND k.revoked_at IS NULL AND (k.kind = 'key' OR k.refresh_expires_at > ?) ${viewer.admin ? "" : "AND k.user_id = ?"}
     ORDER BY k.created_at DESC`,
    ...(viewer.admin ? [orgId, now()] : [orgId, now(), viewer.userId]),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    prefix: r.prefix,
    can_write: r.can_write === 1,
    user_id: r.user_id,
    user_email: r.email,
    expires_at: r.kind === "oauth" ? r.refresh_expires_at : r.expires_at,
    last_used_at: r.last_used_at,
    created_at: r.created_at,
  }));
}

export async function revokeApiKey(env: Env, orgId: string, id: string, viewer: { userId: string; admin: boolean }): Promise<void> {
  const res = await env.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL ${viewer.admin ? "" : "AND user_id = ?"}`)
    .bind(...(viewer.admin ? [now(), id, orgId] : [now(), id, orgId, viewer.userId]))
    .run();
  if (!res.meta.changes) throw notFound("Nøkkelen");
}
