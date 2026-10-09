import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { clearSessionCookie, createSession, destroySession, requireUser, SESSION_COOKIE, setSessionCookie } from "../lib/auth";
import { all, first } from "../lib/db";
import { emailConfigured, magicLinkEmail, sendEmail } from "../lib/email";
import { ApiError, badRequest, body } from "../lib/http";
import { newId, normalizeEmail, now, randomToken, sha256 } from "../lib/util";
import type { Me, OrgSummary } from "../../shared/types";
import { createOrg } from "./orgs";

const LOGIN_TTL_MS = 15 * 60 * 1000;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const auth = new Hono<AppEnv>();

function emailAllowed(env: Env, email: string): boolean {
  const list = (env.ALLOWED_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return true;
  const domain = email.split("@")[1] ?? "";
  return list.includes(domain);
}

/** Lager en innloggingslenke og lagrer hash av token */
export async function createLoginLink(env: Env, email: string, redirect: string | null, ttlMs = LOGIN_TTL_MS): Promise<string> {
  const token = randomToken(32);
  await env.DB.prepare(`INSERT INTO login_tokens (token_hash, email, redirect, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(await sha256(token), email, redirect, now() + ttlMs, now())
    .run();
  const base = env.APP_URL.replace(/\/$/, "");
  return `${base}/auth/verify?token=${encodeURIComponent(token)}`;
}

auth.post("/request", async (c) => {
  const input = await body(c, z.object({ email: z.string().trim().email("Ugyldig e-postadresse").max(200), redirect: z.string().max(300).optional() }));
  const email = normalizeEmail(input.email);
  const existing = await first<{ id: string }>(c.env.DB, `SELECT id FROM users WHERE email = ?`, email);
  if (!existing && !emailAllowed(c.env, email)) {
    throw new ApiError(403, "Denne e-postadressen har ikke tilgang. Be en administrator om en invitasjon.");
  }

  const recent = await first<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > ?`,
    email,
    now() - LOGIN_TTL_MS,
  );
  if ((recent?.n ?? 0) >= 5) throw new ApiError(429, "For mange forsøk. Vent noen minutter og prøv igjen.");

  const redirect = input.redirect && input.redirect.startsWith("/") && !input.redirect.startsWith("//") ? input.redirect : null;
  const link = await createLoginLink(c.env, email, redirect);

  if (emailConfigured(c.env)) {
    const mail = magicLinkEmail(link);
    await sendEmail(c.env, { to: email, ...mail });
    return c.json({ ok: true });
  }
  if (c.env.DEV_MODE === "true") {
    console.log(`[plank] Innloggingslenke for ${email}: ${link}`);
    return c.json({ ok: true, devLink: link });
  }
  throw new ApiError(503, "E-post er ikke konfigurert (RESEND_API_KEY mangler)");
});

auth.post("/verify", async (c) => {
  const { token } = await body(c, z.object({ token: z.string().min(10).max(200) }));
  const tokenHash = await sha256(token);
  const row = await first<{ email: string; redirect: string | null; expires_at: number; used_at: number | null }>(
    c.env.DB,
    `SELECT email, redirect, expires_at, used_at FROM login_tokens WHERE token_hash = ?`,
    tokenHash,
  );
  if (!row || row.used_at || row.expires_at < now()) {
    throw badRequest("Lenken er ugyldig eller utløpt. Be om en ny innloggingslenke.");
  }
  // Marker som brukt (atomisk – bare én forespørsel vinner)
  const upd = await c.env.DB.prepare(`UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`).bind(now(), tokenHash).run();
  if (!upd.meta.changes) throw badRequest("Lenken er allerede brukt.");

  let user = await first<{ id: string }>(c.env.DB, `SELECT id FROM users WHERE email = ?`, row.email);
  if (!user) {
    user = { id: newId("usr") };
    await c.env.DB.prepare(`INSERT INTO users (id, email, name, created_at) VALUES (?, ?, NULL, ?)`).bind(user.id, row.email, now()).run();
  }
  const session = await createSession(c.env, user.id, c.req.header("user-agent") ?? null);
  setSessionCookie(c, session);

  const orgCount = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?`, user.id);
  return c.json({ ok: true, redirect: row.redirect, needsOnboarding: (orgCount?.n ?? 0) === 0 });
});

auth.post("/logout", async (c) => {
  await destroySession(c.env, getCookie(c, SESSION_COOKIE));
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// ─── /api/me ──────────────────────────────────────────────────────────────────

export const me = new Hono<AppEnv>();
me.use("*", requireUser);

me.get("/", async (c) => {
  const user = c.get("user");
  const orgs = await all<OrgSummary>(
    c.env.DB,
    `SELECT o.id, o.name, m.role FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY o.name`,
    user.id,
  );
  const result: Me = { user, orgs };
  return c.json(result);
});

me.patch("/", async (c) => {
  const input = await body(c, z.object({ name: z.string().trim().max(100) }));
  await c.env.DB.prepare(`UPDATE users SET name = ? WHERE id = ?`).bind(input.name || null, c.get("user").id).run();
  return c.json({ ok: true });
});

/** Opprett ny organisasjon (brukeren blir eier) */
me.post("/orgs", async (c) => {
  const input = await body(c, z.object({ name: z.string().trim().min(2, "Navnet er for kort").max(100) }));
  const org = await createOrg(c.env, input.name, c.get("user").id);
  return c.json(org, 201);
});
