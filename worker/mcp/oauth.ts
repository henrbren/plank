import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { findRefreshGrant, issueOAuthTokens, revokeToken } from "../lib/apiKeys";
import { getSessionUser, SESSION_COOKIE } from "../lib/auth";
import { brandOf } from "../lib/brand";
import { all, first } from "../lib/db";
import { base64url, escapeHtml, newId, now, parseJson, randomToken, sha256 } from "../lib/util";
import { throttle } from "../routes/auth";
import { CORS_HEADERS, origin } from "./server";

/**
 * OAuth 2.1 for MCP-klienter (autorisasjonskode + PKCE, dynamisk klientregistrering).
 * Claude og andre klienter finner endepunktene via /.well-known, sender brukeren til /oauth/authorize,
 * der hen logger inn som vanlig, velger organisasjon og tilgang, og godkjenner.
 * Tokenet som utstedes er en API-nøkkel av typen «oauth» (se lib/apiKeys.ts), og vises i innstillingene.
 */

const CODE_TTL_MS = 10 * 60 * 1000;
const SCOPES = ["plank:read", "plank:write"];

export const oauth = new Hono<AppEnv>();
export const wellKnown = new Hono<AppEnv>();

const corsJson = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });

const oauthError = (error: string, description: string, status = 400) => corsJson({ error, error_description: description }, status);

// ─── Oppdagelse ──────────────────────────────────────────────────────────────

const protectedResource = (c: Context<AppEnv>) => {
  const base = origin(c);
  return corsJson({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: SCOPES,
    resource_name: brandOf(c).name,
  });
};
wellKnown.get("/oauth-protected-resource", protectedResource);
wellKnown.get("/oauth-protected-resource/*", protectedResource);

const authServer = (c: Context<AppEnv>) => {
  const base = origin(c);
  return corsJson({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: SCOPES,
  });
};
wellKnown.get("/oauth-authorization-server", authServer);
wellKnown.get("/oauth-authorization-server/*", authServer);
wellKnown.get("/openid-configuration", authServer);
wellKnown.options("*", () => new Response(null, { status: 204, headers: CORS_HEADERS }));
oauth.options("*", () => new Response(null, { status: 204, headers: CORS_HEADERS }));

// ─── Klientregistrering (RFC 7591) ───────────────────────────────────────────

/** https, http mot localhost, eller egne app-skjemaer (cursor://, vscode:// …) */
function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 500) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !["javascript:", "data:", "file:", "blob:", "vbscript:"].includes(u.protocol);
}

oauth.post("/register", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "ukjent";
  try {
    await throttle(c.env, `oauth-register:${ip}`, 30, 60 * 60 * 1000, "For mange registreringer");
  } catch {
    return oauthError("invalid_client_metadata", "For mange registreringer. Prøv igjen senere.", 429);
  }
  const input = (await c.req.json().catch(() => null)) as { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown } | null;
  if (!input || !Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0 || input.redirect_uris.length > 10) {
    return oauthError("invalid_redirect_uri", "Oppgi 1–10 redirect_uris");
  }
  if (!input.redirect_uris.every(validRedirectUri)) return oauthError("invalid_redirect_uri", "Ugyldig redirect_uri");
  const name = typeof input.client_name === "string" && input.client_name.trim() ? input.client_name.trim().slice(0, 80) : "MCP-klient";
  const id = newId("mcpc");
  const t = now();
  await c.env.DB.prepare(`INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)`).bind(id, name, JSON.stringify(input.redirect_uris), t).run();
  return corsJson(
    {
      client_id: id,
      client_id_issued_at: Math.floor(t / 1000),
      client_name: name,
      redirect_uris: input.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
  );
});

// ─── Godkjenning ─────────────────────────────────────────────────────────────

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  scope: string | null;
}

type ClientRow = { id: string; name: string; redirect_uris: string };

/** Sjekker klient og redirect_uri. Feil her vises til brukeren – vi sender aldri videre til en ukjent adresse. */
async function checkAuthorize(c: Context<AppEnv>, q: Record<string, string | undefined>): Promise<{ params: AuthorizeParams; client: ClientRow } | string> {
  const client = q.client_id ? await first<ClientRow>(c.env.DB, `SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?`, q.client_id) : null;
  if (!client) return "Ukjent klient. Prøv å koble til på nytt fra appen du bruker.";
  if (!q.redirect_uri || !parseJson<string[]>(client.redirect_uris, []).includes(q.redirect_uri)) return "Adressen klienten vil sende deg tilbake til, er ikke registrert.";
  if (q.response_type !== "code") return "Bare response_type=code støttes.";
  if (!q.code_challenge || q.code_challenge_method !== "S256") return "Klienten må bruke PKCE (S256).";
  return {
    client,
    params: { client_id: client.id, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge, state: q.state ?? null, scope: q.scope ?? null },
  };
}

function redirectWith(uri: string, params: Record<string, string | null>): Response {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: u.toString(), "Cache-Control": "no-store" } });
}

async function csrfFor(sessionToken: string): Promise<string> {
  return (await sha256(`${sessionToken}:oauth-consent`)).slice(0, 32);
}

interface OrgChoice {
  id: string;
  name: string;
  canWrite: boolean;
}

async function orgChoices(c: Context<AppEnv>, userId: string): Promise<OrgChoice[]> {
  const rows = await all<{ id: string; name: string; role: string; can_edit: number }>(
    c.env.DB,
    `SELECT o.id, o.name, m.role, m.can_edit FROM memberships m JOIN orgs o ON o.id = m.org_id
     WHERE m.user_id = ? AND (m.role != 'member' OR m.expires_at IS NULL OR m.expires_at > ?) ORDER BY o.name`,
    userId,
    now(),
  );
  return rows.map((r) => ({ id: r.id, name: r.name, canWrite: r.role !== "member" || r.can_edit === 1 }));
}

oauth.get("/authorize", async (c) => {
  const q = c.req.query();
  const checked = await checkAuthorize(c, q);
  if (typeof checked === "string") return page(c, "Kan ikke koble til", `<p>${escapeHtml(checked)}</p>`, 400);

  const sessionToken = getCookie(c, SESSION_COOKIE);
  const user = await getSessionUser(c.env, sessionToken);
  if (!user || !sessionToken) {
    const url = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
  }
  const orgs = await orgChoices(c, user.id);
  if (orgs.length === 0) return page(c, "Ingen organisasjon", `<p>Du er ikke medlem av noen organisasjon ennå. Logg inn i ${escapeHtml(brandOf(c).name)} og opprett eller bli invitert til en først.</p>`, 403);

  const { params, client } = checked;
  const wantsRead = params.scope ? !params.scope.split(" ").includes("plank:write") : false;
  const redirectHost = (() => {
    try {
      const u = new URL(params.redirect_uri);
      return u.host || u.protocol;
    } catch {
      return params.redirect_uri;
    }
  })();
  const hidden = Object.entries({ ...params, csrf: await csrfFor(sessionToken) })
    .filter(([, v]) => v != null)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(String(v))}">`)
    .join("");
  const orgOptions = orgs
    .map(
      (o, idx) =>
        `<label class="opt"><input type="radio" name="org_id" value="${escapeHtml(o.id)}" data-write="${o.canWrite ? 1 : 0}" ${idx === 0 ? "checked" : ""}><span>${escapeHtml(o.name)}${o.canWrite ? "" : " <em>(lesetilgang)</em>"}</span></label>`,
    )
    .join("");
  const body = `
    <p><b>${escapeHtml(client.name)}</b> ber om tilgang til ${escapeHtml(brandOf(c).name)} som <b>${escapeHtml(user.name ?? user.email)}</b>.</p>
    <p class="muted">Etter godkjenning sendes du tilbake til <code>${escapeHtml(redirectHost)}</code>. Klienten får aldri mer tilgang enn du har selv, og du kan trekke tilgangen tilbake under Innstillinger.</p>
    <form method="post" action="/oauth/authorize">
      ${hidden}
      ${orgs.length > 1 ? `<h2>Organisasjon</h2>${orgOptions}` : orgOptions.replace("<label class=\"opt\">", "<label class=\"opt hidden\">") + `<p>Organisasjon: <b>${escapeHtml(orgs[0]!.name)}</b></p>`}
      <h2>Tilgang</h2>
      <label class="opt"><input type="radio" name="access" value="read" ${wantsRead ? "checked" : ""}><span>Lese – se portefølje, dokumenter, FDV-register og oppgaver</span></label>
      <label class="opt" id="write"><input type="radio" name="access" value="write" ${wantsRead ? "" : "checked"}><span>Lese og endre – også opprette oppgaver, komponenter, sider og hente fra Boligmappa</span></label>
      <div class="row">
        <button type="submit" name="decision" value="deny" class="secondary">Avbryt</button>
        <button type="submit" name="decision" value="allow">Gi tilgang</button>
      </div>
    </form>
    <script>
      const sync = () => {
        const org = document.querySelector('input[name=org_id]:checked');
        const can = org && org.dataset.write === "1";
        const w = document.querySelector('input[name=access][value=write]');
        w.disabled = !can;
        if (!can) document.querySelector('input[name=access][value=read]').checked = true;
        document.getElementById('write').style.opacity = can ? 1 : .5;
      };
      document.querySelectorAll('input[name=org_id]').forEach((el) => el.addEventListener('change', sync));
      sync();
    </script>`;
  return page(c, `Koble ${client.name} til ${brandOf(c).name}`, body);
});

oauth.post("/authorize", async (c) => {
  const form = await c.req.parseBody();
  const q: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(form)) if (typeof v === "string") q[k] = v;
  // Skjemaet sender ikke response_type/metode – de ble sjekket da siden ble vist
  const checked = await checkAuthorize(c, { ...q, response_type: "code", code_challenge_method: "S256" });
  if (typeof checked === "string") return page(c, "Kan ikke koble til", `<p>${escapeHtml(checked)}</p>`, 400);
  const { params } = checked;

  const sessionToken = getCookie(c, SESSION_COOKIE);
  const user = await getSessionUser(c.env, sessionToken);
  if (!user || !sessionToken || q.csrf !== (await csrfFor(sessionToken))) {
    return page(c, "Økten er utløpt", "<p>Gå tilbake til appen du koblet fra, og prøv igjen.</p>", 400);
  }
  if (q.decision !== "allow") return redirectWith(params.redirect_uri, { error: "access_denied", state: params.state });

  const org = (await orgChoices(c, user.id)).find((o) => o.id === q.org_id);
  if (!org) return page(c, "Ingen tilgang", "<p>Du er ikke medlem av denne organisasjonen.</p>", 403);
  const canWrite = q.access === "write" && org.canWrite;

  const code = randomToken(32);
  await c.env.DB.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, org_id, can_write, redirect_uri, code_challenge, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(await sha256(code), params.client_id, user.id, org.id, canWrite ? 1 : 0, params.redirect_uri, params.code_challenge, now() + CODE_TTL_MS, now())
    .run();
  return redirectWith(params.redirect_uri, { code, state: params.state });
});

// ─── Token ───────────────────────────────────────────────────────────────────

async function formOrJson(c: Context<AppEnv>): Promise<Record<string, string>> {
  const type = c.req.header("content-type") ?? "";
  const raw = type.includes("application/json") ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>) : await c.req.parseBody().catch(() => ({}));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  return out;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

oauth.post("/token", async (c) => {
  const p = await formOrJson(c);
  if (p.grant_type === "authorization_code") {
    if (!p.code || !p.code_verifier || !p.client_id) return oauthError("invalid_request", "Mangler code, code_verifier eller client_id");
    const codeHash = await sha256(p.code);
    const row = await first<{ client_id: string; user_id: string; org_id: string; can_write: number; redirect_uri: string; code_challenge: string; expires_at: number; used_at: number | null }>(
      c.env.DB,
      `SELECT client_id, user_id, org_id, can_write, redirect_uri, code_challenge, expires_at, used_at FROM oauth_codes WHERE code_hash = ?`,
      codeHash,
    );
    if (!row || row.used_at || row.expires_at < now() || row.client_id !== p.client_id) return oauthError("invalid_grant", "Koden er ugyldig eller utløpt");
    if (p.redirect_uri && p.redirect_uri !== row.redirect_uri) return oauthError("invalid_grant", "redirect_uri stemmer ikke");
    if ((await pkceChallenge(p.code_verifier)) !== row.code_challenge) return oauthError("invalid_grant", "PKCE-kontrollen feilet");
    const used = await c.env.DB.prepare(`UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL`).bind(now(), codeHash).run();
    if (!used.meta.changes) return oauthError("invalid_grant", "Koden er allerede brukt");
    const client = await first<{ name: string }>(c.env.DB, `SELECT name FROM oauth_clients WHERE id = ?`, row.client_id);
    const t = await issueOAuthTokens(c.env, {
      orgId: row.org_id,
      userId: row.user_id,
      clientId: row.client_id,
      clientName: client?.name ?? "MCP-klient",
      canWrite: row.can_write === 1,
    });
    return corsJson({ access_token: t.accessToken, token_type: "Bearer", expires_in: t.expiresIn, refresh_token: t.refreshToken, scope: row.can_write ? "plank:read plank:write" : "plank:read" });
  }
  if (p.grant_type === "refresh_token") {
    if (!p.refresh_token) return oauthError("invalid_request", "Mangler refresh_token");
    const grant = await findRefreshGrant(c.env, p.refresh_token);
    if (!grant || (p.client_id && grant.client_id !== p.client_id)) return oauthError("invalid_grant", "Fornyelsestokenet er ugyldig eller utløpt");
    const t = await issueOAuthTokens(c.env, {
      id: grant.id,
      orgId: grant.org_id,
      userId: grant.user_id,
      clientId: grant.client_id ?? "",
      clientName: grant.name,
      canWrite: grant.can_write === 1,
    });
    return corsJson({ access_token: t.accessToken, token_type: "Bearer", expires_in: t.expiresIn, refresh_token: t.refreshToken, scope: grant.can_write ? "plank:read plank:write" : "plank:read" });
  }
  return oauthError("unsupported_grant_type", "Støtter authorization_code og refresh_token");
});

oauth.post("/revoke", async (c) => {
  const p = await formOrJson(c);
  if (p.token) await revokeToken(c.env, p.token);
  return new Response(null, { status: 200, headers: CORS_HEADERS });
});

// ─── Enkel side for godkjenning og feil ──────────────────────────────────────

function page(c: Context<AppEnv>, title: string, body: string, status = 200): Response {
  const brand = brandOf(c);
  const html = `<!doctype html>
<html lang="nb"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f4f0; --panel:#fff; --ink:#1d1b18; --muted:#6b665e; --line:#e5e0d8; --accent:${escapeHtml(brand.accent)}; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161513; --panel:#201e1b; --ink:#f1ede6; --muted:#a39d93; --line:#34312c; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px 16px; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width:100%; max-width:480px; background:var(--panel); border:1px solid var(--line); border-radius:16px; padding:28px; }
  h1 { font-size:20px; margin:0 0 14px; } h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:20px 0 8px; }
  .muted { color:var(--muted); font-size:13.5px; } code { font-size:13px; }
  .opt { display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border:1px solid var(--line); border-radius:10px; margin-bottom:8px; cursor:pointer; }
  .opt.hidden { display:none; } .opt input { margin-top:4px; }
  .row { display:flex; gap:10px; justify-content:flex-end; margin-top:22px; }
  button { font:inherit; font-weight:600; border:0; border-radius:10px; padding:10px 18px; background:var(--accent); color:#fff; cursor:pointer; }
  button.secondary { background:transparent; color:var(--ink); border:1px solid var(--line); }
</style></head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

