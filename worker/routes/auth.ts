import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { clearSessionCookie, createSession, destroySession, getSessionUser, requireUser, SESSION_COOKIE, setSessionCookie } from "../lib/auth";
import { all, first } from "../lib/db";
import { demoInviteEmail, emailConfigured, laftLinkEmail, magicLinkEmail, sendEmail } from "../lib/email";
import { seedDemo } from "../lib/demo";
import { logActivity } from "../lib/activity";
import { ApiError, badRequest, body } from "../lib/http";
import { getAccount, laftIdLogin, laftLookup, laftServer, laftWhoAmI, upsertAccount, type LaftAccountRow } from "../lib/laft";
import { connectOrg } from "../services/laft";
import { escapeHtml, newId, normalizeEmail, now, osloDay, randomToken, sha256 } from "../lib/util";
import type { Me, OrgSummary, Role } from "../../shared/types";
import { isPlatformAdmin } from "../lib/billing";
import { createOrg } from "./orgs";
import { brandOf, emailFrom, laftHost, publicOrigin } from "../lib/brand";
import { brregRoles, lookupBrreg, nameMatches, type BrregCompany } from "../lib/brreg";
import { enqueueKommune, grantedBuildingCount } from "../lib/boligmappaMs";
import { boligmappaConfigured, connectBoligmappa } from "../lib/boligmappa";
import { grantAgents } from "../services/laft";
import { createAccessRequest, pendingRequestFor } from "../services/accessRequests";

const LOGIN_TTL_MS = 15 * 60 * 1000;
const DEMO_TTL_MS = 48 * 60 * 60 * 1000;
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
export async function createLoginLink(
  env: Env,
  email: string,
  redirect: string | null,
  ttlMs = LOGIN_TTL_MS,
  kind: "login" | "demo" | "laft" = "login",
  payload: string | null = null,
  origin?: string,
): Promise<string> {
  const token = randomToken(32);
  await env.DB.prepare(`INSERT INTO login_tokens (token_hash, email, redirect, expires_at, created_at, kind, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(await sha256(token), email, redirect, now() + ttlMs, now(), kind, payload)
    .run();
  const base = (origin ?? env.APP_URL).replace(/\/$/, "");
  return `${base}/auth/verify?token=${encodeURIComponent(token)}`;
}

function safeRedirect(r: string | null | undefined): string | null {
  return r && r.startsWith("/") && !r.startsWith("//") && !r.startsWith("/\\") ? r : null;
}

/** Teller forsøk per nøkkel og avviser når grensen er nådd */
export async function throttle(env: Env, key: string, max: number, windowMs: number, message: string): Promise<void> {
  const t = now();
  const row = await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM auth_attempts WHERE key = ? AND created_at > ?`, key, t - windowMs);
  if ((row?.n ?? 0) >= max) throw new ApiError(429, message);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO auth_attempts (key, created_at) VALUES (?, ?)`).bind(key, t),
    env.DB.prepare(`DELETE FROM auth_attempts WHERE key = ? AND created_at < ?`).bind(key, t - 24 * 60 * 60 * 1000),
  ]);
}

const INSTANCE_NAMES: Record<string, string> = { kommune: "Kommune", privat: "Privat", app: "App", lite: "Næringsmappa", tyr: "Tyr" };

export function instanceName(host: string, given?: string | null): string {
  const clean = given?.replace(/[^\p{L}\p{N} .\-]/gu, "").trim().slice(0, 60);
  return clean || INSTANCE_NAMES[host.split(".")[0] ?? ""] || host;
}

export const laftLoginSchema = z.object({
  email: z.string().trim().email("Ugyldig e-postadresse").max(200),
  password: z.string().min(1, "Skriv passordet").max(500),
  otp: z.string().trim().max(20).optional(),
  url: z.string().max(200),
  name: z.string().max(80).optional(),
});

/** Etter LAFT-innlogging: ny bruker får en organisasjon koblet til LAFT, ellers går vi dit LAFT kan kobles til. */
async function laftLanding(env: Env, userId: string, account: LaftAccountRow, redirect: string | null): Promise<{ redirect: string | null; needsOnboarding: boolean }> {
  const orgs = await all<{ id: string; role: string; laft_account_id: string | null }>(
    env.DB,
    `SELECT o.id, m.role, o.laft_account_id FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY m.created_at`,
    userId,
  );
  if (orgs.length === 0) {
    const user = await first<{ name: string | null; email: string }>(env.DB, `SELECT name, email FROM users WHERE id = ?`, userId);
    const org = await createOrg(env, (account.area_name || "Min portefølje").slice(0, 100), userId);
    await connectOrg(env, org.id, account, { type: "user", id: userId, name: user?.name ?? user?.email ?? "Bruker" });
    return { redirect: `/o/${org.id}/laft?welcome=1`, needsOnboarding: false };
  }
  if (redirect) return { redirect, needsOnboarding: false };
  if (orgs.some((o) => o.laft_account_id === account.id)) return { redirect: null, needsOnboarding: false };
  const open = orgs.find((o) => o.role !== "member" && !o.laft_account_id);
  return { redirect: open ? `/o/${open.id}/laft` : null, needsOnboarding: false };
}

auth.post("/laft/lookup", async (c) => {
  const { email } = await body(c, z.object({ email: z.string().trim().email("Ugyldig e-postadresse").max(200) }));
  await throttle(c.env, `laft-lookup:${c.req.header("cf-connecting-ip") ?? "ukjent"}`, 40, 15 * 60 * 1000, "For mange oppslag. Vent litt og prøv igjen.");
  return c.json({ instances: await laftLookup(c.env, normalizeEmail(email)) });
});

auth.post("/laft/login", async (c) => {
  const input = await body(c, laftLoginSchema.extend({ redirect: z.string().max(300).optional() }));
  const email = normalizeEmail(input.email);
  const server = laftServer(input.url);
  if (!server) throw badRequest("Ukjent LAFT-instans");
  const ip = c.req.header("cf-connecting-ip") ?? "ukjent";
  const wait = "For mange innloggingsforsøk. Vent et kvarter og prøv igjen.";
  await throttle(c.env, `laft-login:${email}`, 8, 15 * 60 * 1000, wait);
  await throttle(c.env, `laft-login-ip:${ip}`, 30, 15 * 60 * 1000, wait);

  const tokens = await laftIdLogin(c.env, { email, password: input.password, otp: input.otp, url: server.url });
  const who = await laftWhoAmI(server.url, tokens.jwt);
  const account = await upsertAccount(c.env, { url: server.url, name: instanceName(server.host, input.name) }, who, tokens);
  const redirect = safeRedirect(input.redirect);

  let userId = account.user_id;
  if (!userId) {
    const loginEmail = who.email || email;
    const existing = await first<{ id: string; email: string }>(c.env.DB, `SELECT id, email FROM users WHERE email = ?`, loginEmail);
    if (existing) {
      // Plank-kontoen finnes allerede: eieren av e-postadressen bekrefter koblingen én gang.
      const link = await createLoginLink(c.env, existing.email, redirect, LOGIN_TTL_MS, "laft", account.id, publicOrigin(c));
      const label = [who.name, account.area_name ?? account.server_name].filter(Boolean).join(", ");
      if (emailConfigured(c.env)) {
        await sendEmail(c.env, { to: existing.email, from: emailFrom(c.env, brandOf(c)), ...laftLinkEmail(link, label, brandOf(c).name) });
        return c.json({ ok: true, confirmEmail: true, email: existing.email });
      }
      if (c.env.DEV_MODE === "true") {
        console.log(`[plank] LAFT-bekreftelse for ${existing.email}: ${link}`);
        return c.json({ ok: true, confirmEmail: true, email: existing.email, devLink: link });
      }
      throw new ApiError(503, "E-post er ikke konfigurert (RESEND_API_KEY mangler)");
    }
    if (!emailAllowed(c.env, loginEmail)) throw new ApiError(403, "Denne e-postadressen har ikke tilgang. Be en administrator om en invitasjon.");
    userId = newId("usr");
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)`).bind(userId, loginEmail, who.name || null, now()),
      c.env.DB.prepare(`UPDATE laft_accounts SET user_id = ? WHERE id = ? AND user_id IS NULL`).bind(userId, account.id),
    ]);
  }
  const session = await createSession(c.env, userId, c.req.header("user-agent") ?? null);
  setSessionCookie(c, session);
  const landing = await laftLanding(c.env, userId, (await getAccount(c.env, account.id)) ?? account, redirect);
  return c.json({ ok: true, ...landing });
});

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
  const link = await createLoginLink(c.env, email, redirect, LOGIN_TTL_MS, "login", null, publicOrigin(c));

  if (emailConfigured(c.env)) {
    const mail = magicLinkEmail(link, brandOf(c).name);
    await sendEmail(c.env, { to: email, from: emailFrom(c.env, brandOf(c)), ...mail });
    return c.json({ ok: true });
  }
  if (c.env.DEV_MODE === "true") {
    console.log(`[plank] Innloggingslenke for ${email}: ${link}`);
    return c.json({ ok: true, devLink: link });
  }
  throw new ApiError(503, "E-post er ikke konfigurert (RESEND_API_KEY mangler)");
});

/** Sender en 48-timers demolenke. Nye brukere får en ferdig demoportefølje ved innlogging. */
auth.post("/demo", async (c) => {
  const input = await body(c, z.object({ email: z.string().trim().email("Ugyldig e-postadresse").max(200) }));
  const email = normalizeEmail(input.email);
  const t = now();
  const perEmail = await first<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM login_tokens WHERE kind = 'demo' AND email = ? AND created_at > ?`,
    email,
    t - 24 * 60 * 60 * 1000,
  );
  if ((perEmail?.n ?? 0) >= 3) throw new ApiError(429, "Det er allerede sendt en demo til denne adressen i dag. Prøv igjen i morgen.");
  const recent = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM login_tokens WHERE kind = 'demo' AND created_at > ?`, t - 60 * 60 * 1000);
  if ((recent?.n ?? 0) >= 40) throw new ApiError(429, "For mange demoer er sendt den siste timen. Prøv igjen om litt.");

  const link = await createLoginLink(c.env, email, null, DEMO_TTL_MS, "demo");
  if (emailConfigured(c.env)) {
    await sendEmail(c.env, { to: email, ...demoInviteEmail(link) });
    return c.json({ ok: true });
  }
  if (c.env.DEV_MODE === "true") {
    console.log(`[plank] Demolenke for ${email}: ${link}`);
    return c.json({ ok: true, devLink: link });
  }
  throw new ApiError(503, "E-post er ikke konfigurert (RESEND_API_KEY mangler)");
});

auth.post("/verify", async (c) => {
  const { token } = await body(c, z.object({ token: z.string().min(10).max(200) }));
  const tokenHash = await sha256(token);
  const row = await first<{ email: string; redirect: string | null; expires_at: number; used_at: number | null; kind: string; payload: string | null }>(
    c.env.DB,
    `SELECT email, redirect, expires_at, used_at, kind, payload FROM login_tokens WHERE token_hash = ?`,
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

  if (row.kind === "laft" && row.payload) {
    await c.env.DB.prepare(`UPDATE laft_accounts SET user_id = ? WHERE id = ? AND user_id IS NULL`).bind(user.id, row.payload).run();
    const account = await getAccount(c.env, row.payload);
    if (account?.user_id === user.id) return c.json({ ok: true, ...(await laftLanding(c.env, user.id, account, row.redirect)) });
  }

  const orgCount = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?`, user.id);
  if (row.kind === "demo" && (orgCount?.n ?? 0) === 0) {
    const org = await createOrg(c.env, "Demoportefølje", user.id);
    try {
      await c.env.DB.prepare(`UPDATE orgs SET billing_status = 'demo' WHERE id = ?`).bind(org.id).run();
      await seedDemo(c.env, org.id, user.id);
      await logActivity(c.env, {
        orgId: org.id,
        actor: { type: "system", name: "Plank" },
        action: "demo.seeded",
        summary: "Satte opp demoportefølje",
      });
    } catch (err) {
      console.error("Kunne ikke laste demodata for demoinvitasjon", err);
    }
    return c.json({ ok: true, redirect: `/o/${org.id}`, needsOnboarding: false });
  }
  return c.json({ ok: true, redirect: row.redirect, needsOnboarding: (orgCount?.n ?? 0) === 0 });
});

auth.get("/vipps/config", async (c) => {
  const idUrl = (c.env.LAFT_ID_URL || "https://id.laft.io").replace(/\/$/, "");
  const res = await fetch(`${idUrl}/auth/vipps-config`);
  if (!res.ok) throw new ApiError(503, "Vipps er ikke satt opp ennå");
  const data = (await res.json()) as { clientId?: string };
  if (!data.clientId) throw new ApiError(503, "Vipps er ikke satt opp ennå");
  return c.json({ clientId: data.clientId, idUrl, callback: `${idUrl}/auth/vipps/callback` });
});

auth.post("/vipps", async (c) => {
  const input = await body(c, z.object({ code: z.string().min(8).max(400), codeVerifier: z.string().min(16).max(200), redirect: z.string().max(300).optional() }));
  const idUrl = (c.env.LAFT_ID_URL || "https://id.laft.io").replace(/\/$/, "");
  const ip = c.req.header("cf-connecting-ip") ?? "ukjent";
  await throttle(c.env, `vipps:${ip}`, 20, 15 * 60 * 1000, "For mange Vipps-forsøk. Vent litt og prøv igjen.");

  const res = await fetch(`${idUrl}/auth/vipps-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: input.code, redirectUri: `${idUrl}/auth/vipps/callback`, codeVerifier: input.codeVerifier }),
  });
  const data = (await res.json().catch(() => null)) as {
    error?: boolean;
    errorMessage?: string;
    errorCode?: string;
    isNewUser?: boolean;
    vippsEmail?: string;
    vippsFirstname?: string;
    vippsLastname?: string;
    vippsProof?: string;
    jwt?: string;
    refreshToken?: string;
    loginUrl?: string;
    email?: string;
  } | null;
  if (!res.ok || !data || data.error) {
    throw new ApiError(res.status === 401 ? 401 : 400, data?.errorMessage || "Vipps-innloggingen feilet");
  }

  if (data.isNewUser) {
    const email = normalizeEmail(data.vippsEmail || "");
    if (!email) throw new ApiError(400, "Vipps ga ingen e-postadresse");
    if (!emailAllowed(c.env, email)) throw new ApiError(403, "Denne e-postadressen har ikke tilgang.");
    const name = [data.vippsFirstname, data.vippsLastname].filter(Boolean).join(" ") || null;
    let user = await first<{ id: string }>(c.env.DB, `SELECT id FROM users WHERE email = ?`, email);
    if (!user) {
      user = { id: newId("usr") };
      await c.env.DB.prepare(`INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)`).bind(user.id, email, name, now()).run();
    } else if (name) {
      await c.env.DB.prepare(`UPDATE users SET name = COALESCE(name, ?) WHERE id = ?`).bind(name, user.id).run();
    }
    if (name) {
      await c.env.DB.prepare(`UPDATE users SET vipps_name = ?, vipps_verified_at = ? WHERE id = ?`).bind(name, now(), user.id).run();
    }
    const session = await createSession(c.env, user.id, c.req.header("user-agent") ?? null);
    setSessionCookie(c, session);
    const orgCount = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?`, user.id);
    return c.json({
      ok: true,
      needsOnboarding: (orgCount?.n ?? 0) === 0,
      name,
      email,
      redirect: (orgCount?.n ?? 0) === 0 ? null : safeRedirect(input.redirect),
    });
  }

  if (!data.jwt || !data.refreshToken || !data.loginUrl) throw new ApiError(400, "Vipps svarte uten sesjon");
  const server = laftServer(data.loginUrl);
  if (!server) throw badRequest("Ukjent Næringsmappa-instans");
  const who = await laftWhoAmI(server.url, data.jwt);
  const account = await upsertAccount(c.env, { url: server.url, name: instanceName(server.host, "Næringsmappa") }, who, { jwt: data.jwt, refreshToken: data.refreshToken });
  let userId = account.user_id;
  if (!userId) {
    const loginEmail = who.email || normalizeEmail(data.email || data.vippsEmail || "");
    const existing = await first<{ id: string }>(c.env.DB, `SELECT id FROM users WHERE email = ?`, loginEmail);
    if (existing) {
      userId = existing.id;
      await c.env.DB.prepare(`UPDATE laft_accounts SET user_id = ? WHERE id = ? AND user_id IS NULL`).bind(userId, account.id).run();
    } else {
      if (!emailAllowed(c.env, loginEmail)) throw new ApiError(403, "Denne e-postadressen har ikke tilgang.");
      userId = newId("usr");
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)`).bind(userId, loginEmail, who.name || null, now()),
        c.env.DB.prepare(`UPDATE laft_accounts SET user_id = ? WHERE id = ? AND user_id IS NULL`).bind(userId, account.id),
      ]);
    }
  }
  if (who.name?.trim()) {
    await c.env.DB.prepare(`UPDATE users SET vipps_name = ?, vipps_verified_at = ? WHERE id = ?`).bind(who.name.trim(), now(), userId).run();
  }
  const session = await createSession(c.env, userId, c.req.header("user-agent") ?? null);
  setSessionCookie(c, session);
  return c.json({ ok: true, ...(await laftLanding(c.env, userId, (await getAccount(c.env, account.id)) ?? account, safeRedirect(input.redirect))) });
});

/** Navn og organisasjonsform fra Brønnøysund, for skjemaet som brukes uten innlogging */
auth.post("/org-name", async (c) => {
  const { orgNr } = await body(c, z.object({ orgNr: z.string().trim().min(9).max(20) }));
  await throttle(c.env, `org-name:${c.req.header("cf-connecting-ip") ?? "ukjent"}`, 40, 15 * 60 * 1000, "For mange oppslag. Vent litt og prøv igjen.");
  return c.json(await lookupBrreg(orgNr));
});

/** Tilgang uten Vipps: navn, e-post og samtykke. LAFT godkjenner i boligmappa-ms. */
auth.post("/access-request", async (c) => {
  if (!laftHost(c)) throw badRequest("Tilgangsforespørsler gjelder bare LAFT-domenene");
  const input = await body(
    c,
    z.object({
      orgNr: z.string().trim().min(9).max(20),
      name: z.string().trim().min(3, "Skriv fullt navn").max(120),
      email: z.string().trim().email("Ugyldig e-postadresse").max(200),
      consent: z.boolean().refine((v) => v, "Du må bekrefte at du har lov til å hente dokumentene"),
    }),
  );
  const ip = c.req.header("cf-connecting-ip") ?? null;
  await throttle(c.env, `access-request-ip:${ip ?? "ukjent"}`, 8, 60 * 60 * 1000, "For mange forespørsler. Vent en time og prøv igjen.");
  const user = await getSessionUser(c.env, getCookie(c, SESSION_COOKIE));
  const email = user ? user.email : normalizeEmail(input.email);
  await throttle(c.env, `access-request:${email}`, 5, 24 * 60 * 60 * 1000, "Du har sendt mange forespørsler i dag. Vent til i morgen, eller ta kontakt med LAFT.");
  const company = await lookupBrreg(input.orgNr);
  const { row, deliver } = await createAccessRequest(c.env, { company, brand: brandOf(c), origin: publicOrigin(c), email, name: input.name, user, ip });
  c.executionCtx.waitUntil(deliver().catch((e) => console.warn("Tilgangsforespørsel ble ikke levert", row.id, e)));
  return c.json({ ok: true, id: row.id, kind: row.kind, email, orgName: company.name, orgNr: company.orgNr }, 201);
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
  const rows = await all<{ id: string; name: string; role: Role; can_edit: number; scope: "all" | "limited"; expires_at: number | null }>(
    c.env.DB,
    `SELECT o.id, o.name, m.role, m.can_edit, m.scope, m.expires_at FROM memberships m JOIN orgs o ON o.id = m.org_id
     WHERE m.user_id = ? AND (m.role != 'member' OR m.expires_at IS NULL OR m.expires_at > ?) ORDER BY o.name`,
    user.id,
    now(),
  );
  const orgs: OrgSummary[] = rows.map((r) => {
    const member = r.role === "member";
    return {
      id: r.id,
      name: r.name,
      role: r.role,
      can_edit: !member || r.can_edit === 1,
      limited: member && r.scope === "limited",
      expires_on: member && r.expires_at ? osloDay(r.expires_at - 1) : null,
    };
  });
  const result: Me = { user, orgs, platformAdmin: isPlatformAdmin(c.env, user.email) };
  return c.json(result);
});

me.patch("/", async (c) => {
  const input = await body(c, z.object({ name: z.string().trim().max(100) }));
  await c.env.DB.prepare(`UPDATE users SET name = ? WHERE id = ?`).bind(input.name || null, c.get("user").id).run();
  return c.json({ ok: true });
});

type OrgAccess =
  | { access: "kommune" }
  | { access: "vipps" }
  | { access: "none"; vippsName: string }
  | { access: "role"; role: string; vippsName: string | null }
  | { access: "granted"; granted: number; vippsName: string };

/** Samme regel som Næringsmappa-appen: Vipps-navnet må stå i en rolle, eller Boligmappa må ha gitt virksomheten tilgang. */
async function orgAccess(env: Env, user: { id: string; email: string }, company: BrregCompany): Promise<OrgAccess> {
  if (company.municipal) return { access: "kommune" };
  if (isPlatformAdmin(env, user.email)) return { access: "role", role: "Plattformadministrator", vippsName: null };
  const row = await first<{ vipps_name: string | null }>(env.DB, `SELECT vipps_name FROM users WHERE id = ?`, user.id);
  const vippsName = row?.vipps_name?.trim();
  if (!vippsName) return { access: "vipps" };
  const hit = (await brregRoles(company.orgNr)).find((r) => nameMatches(vippsName, r.name));
  if (hit) return { access: "role", role: hit.title, vippsName };
  const granted = await grantedBuildingCount(env, company.orgNr);
  if (granted === null) throw new ApiError(503, "Boligmappa svarer ikke akkurat nå, så vi får ikke sjekket tilgangen. Prøv igjen om litt.");
  if (granted > 0) return { access: "granted", granted, vippsName };
  return { access: "none", vippsName };
}

/** Opprett ny organisasjon (brukeren blir eier). På LAFT-domenene går kommuner i kø, ikke inn i løsningen. */
me.post("/orgs", async (c) => {
  const input = await body(c, z.object({ name: z.string().trim().max(100).optional(), orgNr: z.string().trim().max(20).optional() }));
  const user = c.get("user");
  const brand = brandOf(c);

  if (laftHost(c)) {
    if (!input.orgNr) throw badRequest("Skriv organisasjonsnummeret");
    const company = await lookupBrreg(input.orgNr);
    const access = await orgAccess(c.env, user, company);
    if (access.access === "kommune") {
      const existing = await first<{ id: string }>(c.env.DB, `SELECT id FROM brand_signups WHERE org_nr = ? AND user_id = ? AND status = 'queued'`, company.orgNr, user.id);
      if (!existing) {
        await c.env.DB.prepare(
          `INSERT INTO brand_signups (id, user_id, org_nr, org_name, org_form, org_form_kode, brand, status, email, name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
          .bind(newId("sgn"), user.id, company.orgNr, company.name, company.orgForm, company.orgFormKode, brand.id, user.email, user.name, now())
          .run();
      }
      await enqueueKommune(c.env, company, { email: user.email, name: user.name });
      if (emailConfigured(c.env)) {
        const staff = (c.env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim()).filter(Boolean);
        if (staff.length) {
          await sendEmail(c.env, {
            to: staff,
            from: emailFrom(c.env, brand),
            subject: `Kommune i kø: ${company.name}`,
            html: `<p>${escapeHtml(user.name || user.email)} ba om tilgang for <b>${escapeHtml(company.name)}</b> (${company.orgNr}). Godkjenn i boligmappa-ms-admin. Overføring til kommune.laft.io skjer først etter godkjenning.</p>`,
            text: `${user.name || user.email} ba om tilgang for ${company.name} (${company.orgNr}).`,
          }).catch((err) => console.error("Kunne ikke varsle om kommune", err));
        }
      }
      return c.json({ queued: true, kind: "kommune", name: company.name, orgNr: company.orgNr }, 202);
    }
    if (access.access === "vipps") throw new ApiError(403, "Logg inn med Vipps først, så vi kan sjekke rollen din i Brønnøysund.");
    if (access.access === "none") {
      throw new ApiError(403, `Vi fant ingen registrert rolle for ${access.vippsName} i ${company.name}. Du må ha en rolle i Brønnøysundregistrene for å hente dokumentene.`);
    }
    const org = await createOrg(c.env, (input.name || company.name).slice(0, 100), user.id);
    await c.env.DB.prepare(`UPDATE orgs SET org_nr = ?, brand = ? WHERE id = ?`).bind(company.orgNr, brand.id, org.id).run();
    let autoImport = false;
    if (boligmappaConfigured(c.env)) {
      try {
        await connectBoligmappa(c.env, org.id, company.orgNr, { autoImport: true });
        await grantAgents(c.env, org.id, ["boligmappa"]);
        autoImport = true;
      } catch (err) {
        console.error("Kunne ikke koble Boligmappa på ny organisasjon", err);
      }
    }
    return c.json({ ...org, name: input.name || company.name, orgNr: company.orgNr, autoImport }, 201);
  }

  const name = (input.name || "").trim();
  if (name.length < 2) throw badRequest("Skriv navn på organisasjonen");
  const org = await createOrg(c.env, name, user.id);
  return c.json(org, 201);
});

me.post("/org-lookup", async (c) => {
  const { orgNr } = await body(c, z.object({ orgNr: z.string().trim().min(9).max(20) }));
  await throttle(c.env, `org-lookup:${c.get("user").id}`, 30, 15 * 60 * 1000, "For mange oppslag. Vent litt og prøv igjen.");
  const company = await lookupBrreg(orgNr);
  if (!laftHost(c)) return c.json(company);
  return c.json({ ...company, ...(await orgAccess(c.env, c.get("user"), company)) });
});

/** Det brukeren venter på: kommune i kø eller tilgang som skal godkjennes */
me.get("/signup", async (c) => {
  const user = c.get("user");
  const signup = await first<{ id: string; org_nr: string; org_name: string | null; status: string; created_at: number }>(
    c.env.DB,
    `SELECT id, org_nr, org_name, status, created_at FROM brand_signups WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
    user.id,
  );
  const request = await pendingRequestFor(c.env, user);
  if (request && (!signup || signup.status !== "queued" || request.created_at > signup.created_at)) {
    return c.json({ id: request.id, org_nr: request.org_nr, org_name: request.org_name, status: "queued", kind: request.kind === "kommune" ? "kommune" : "access", created_at: request.created_at });
  }
  return c.json(signup ? { ...signup, kind: "kommune" } : null);
});
