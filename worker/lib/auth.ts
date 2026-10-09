import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv, Env, SessionUser } from "../env";
import { first } from "./db";
import { ApiError, forbidden } from "./http";
import { now, randomToken, sha256 } from "./util";

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

/** Krever innlogget bruker */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await getSessionUser(c.env, getCookie(c, SESSION_COOKIE));
  if (!user) throw new ApiError(401, "Du må logge inn");
  c.set("user", user);
  await next();
};

/** Krever medlemskap i organisasjonen i :orgId */
export const requireOrg: MiddlewareHandler<AppEnv> = async (c, next) => {
  const orgId = c.req.param("orgId");
  if (!orgId) throw forbidden();
  const m = await first<{ role: "owner" | "admin" | "member" }>(
    c.env.DB,
    `SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`,
    orgId,
    c.get("user").id,
  );
  if (!m) throw forbidden("Du er ikke medlem av denne organisasjonen");
  c.set("orgId", orgId);
  c.set("role", m.role);
  await next();
};

export function requireAdmin(c: Context<AppEnv>) {
  const role = c.get("role");
  if (role !== "owner" && role !== "admin") throw forbidden("Krever administrator-tilgang");
}

/**
 * Enkel CSRF-beskyttelse: alle muterende kall må ha headeren X-Plank.
 * Egendefinerte headere tvinger fram CORS-preflight, og vi tillater ikke CORS.
 */
export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && c.req.header("x-plank") !== "1") {
    throw forbidden("Mangler X-Plank-header");
  }
  await next();
};
