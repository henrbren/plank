import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv, Env, SessionUser } from "../env";
import { FULL_ACCESS, loadAccess, runWithAccess, type Access, type MembershipAccessRow } from "./access";
import { authenticateToken, bearerToken, type ApiKeyInfo } from "./apiKeys";
import { first } from "./db";
import { isPlatformAdmin } from "./billing";
import { ApiError, forbidden } from "./http";
import { now, osloDateLong, randomToken, sha256 } from "./util";

export const SESSION_COOKIE = "plank_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function createSession(env: Env, userId: string, userAgent: string | null): Promise<string> {
  const token = randomToken(32);
  const idHash = await sha256(token);
  await env.DB.prepare(`INSERT INTO sessions (id_hash, user_id, expires_at, user_agent, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(idHash, userId, now() + SESSION_TTL_MS, userAgent?.slice(0, 200) ?? null, now())
    .run();
  return token;
}

export function setSessionCookie(c: Context, token: string) {
  const secure = new URL(c.req.url).protocol === "https:";
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function getSessionUser(env: Env, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const idHash = await sha256(token);
  const row = await first<SessionUser & { expires_at: number }>(
    env.DB,
    `SELECT u.id, u.email, u.name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
    idHash,
  );
  if (!row || row.expires_at < now()) return null;
  return { id: row.id, email: row.email, name: row.name };
}

export async function destroySession(env: Env, token: string | undefined) {
  if (!token) return;
  await env.DB.prepare(`DELETE FROM sessions WHERE id_hash = ?`).bind(await sha256(token)).run();
}

/**
 * Krever innlogget bruker: sesjonscookie fra appen, eller bearer-token (API-nøkkel / OAuth) fra
 * integrasjoner og MCP-klienter. Med Authorization-header brukes bare tokenet – aldri cookien.
 */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("authorization");
  if (header) {
    const token = bearerToken(header);
    const auth = token ? await authenticateToken(c.env, token) : null;
    if (!auth) throw new ApiError(401, "Ugyldig eller utløpt API-nøkkel");
    c.set("user", auth.user);
    c.set("apiKey", auth.key);
    await next();
    return;
  }
  const user = await getSessionUser(c.env, getCookie(c, SESSION_COOKIE));
  if (!user) throw new ApiError(401, "Du må logge inn");
  c.set("user", user);
  await next();
};

/** Avviser forespørsler som kommer med API-nøkkel (f.eks. for å lage nye nøkler) */
export function assertSession(c: Context<AppEnv>, what = "Dette") {
  if (c.get("apiKey")) throw forbidden(`${what} krever innlogging i appen og kan ikke gjøres med API-nøkkel`);
}

export interface OrgAccess {
  role: "owner" | "admin" | "member";
  access: Access;
}

/**
 * Brukerens rolle og tilgang i organisasjonen. Med API-nøkkel må nøkkelen gjelde denne organisasjonen,
 * og en lesenøkkel gir bare lesetilgang. Plattformadministratorer slipper inn uten medlemskap, men ikke med nøkkel.
 */
export async function orgAccess(env: Env, user: SessionUser, orgId: string, key?: ApiKeyInfo): Promise<OrgAccess> {
  if (key && key.orgId !== orgId) throw forbidden("API-nøkkelen gjelder en annen organisasjon");
  const m = await first<MembershipAccessRow>(env.DB, `SELECT role, can_edit, scope, expires_at FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, user.id);
  if (!m) {
    if (!key && isPlatformAdmin(env, user.email)) return { role: "member", access: { ...FULL_ACCESS, userId: user.id, admin: false } };
    throw forbidden("Du er ikke medlem av denne organisasjonen");
  }
  if (m.role === "member" && m.expires_at && m.expires_at <= now()) {
    throw forbidden(`Tilgangen din utløp ${osloDateLong(m.expires_at - 1)}. Be en administrator om å forlenge den.`);
  }
  const access = await loadAccess(env, orgId, user.id, m);
  if (key && !key.canWrite) return { role: m.role, access: { ...access, canEdit: false } };
  return { role: m.role, access };
}

/** Krever medlemskap i organisasjonen i :orgId, og setter tilgangen for resten av forespørselen */
export const requireOrg: MiddlewareHandler<AppEnv> = async (c, next) => {
  const orgId = c.req.param("orgId");
  if (!orgId) throw forbidden();
  const { role, access } = await orgAccess(c.env, c.get("user"), orgId, c.get("apiKey"));
  c.set("orgId", orgId);
  c.set("role", role);
  c.set("access", access);
  await runWithAccess(access, () => next());
};

export function requireAdmin(c: Context<AppEnv>) {
  const role = c.get("role");
  if (role !== "owner" && role !== "admin") throw forbidden("Krever administrator-tilgang");
}

/**
 * Enkel CSRF-beskyttelse: alle muterende kall må ha headeren X-Plank.
 * Egendefinerte headere tvinger fram CORS-preflight, og vi tillater ikke CORS.
 * Kall med Authorization-header bruker ikke cookien (se requireUser), og trenger derfor ikke vernet.
 */
export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && c.req.header("x-plank") !== "1" && !c.req.header("authorization")) {
    throw forbidden("Mangler X-Plank-header");
  }
  await next();
};
