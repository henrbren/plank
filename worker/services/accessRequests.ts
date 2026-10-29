import type { Env, SessionUser } from "../env";
import { all, first } from "../lib/db";
import { escapeHtml, newId, now } from "../lib/util";
import { logActivity } from "../lib/activity";
import { brregRoles, nameMatches, type BrregCompany } from "../lib/brreg";
import { enqueueKommune, fetchAccessDecision, grantedBuildingCount, msBase, sendAccessRequest } from "../lib/boligmappaMs";
import { boligmappaConfigured, connectBoligmappa } from "../lib/boligmappa";
import { emailConfigured, emailLayout, sendEmail } from "../lib/email";
import { emailFrom } from "../lib/brand";
import { createOrg } from "../routes/orgs";
import { createLoginLink, INVITE_TTL_MS } from "../routes/auth";
import { grantAgents } from "./laft";
import { accessConsentText } from "../../shared/access";
import { BRANDS, type Brand, type BrandId } from "../../shared/brand";

export interface AccessRequestRow {
  id: string;
  kind: "org" | "kommune";
  org_nr: string;
  org_name: string | null;
  org_form: string | null;
  brand: string;
  origin: string;
  email: string;
  name: string;
  user_id: string | null;
  consent_text: string;
  consent_at: number;
  ip: string | null;
  context: string | null;
  status: "pending" | "approving" | "approved" | "rejected";
  ms_synced_at: number | null;
  ms_error: string | null;
  ms_attempts: number;
  decision_note: string | null;
  decided_by: string | null;
  decided_at: number | null;
  org_id: string | null;
  created_at: number;
}

export interface AccessContext {
  roles: { title: string; name: string }[] | null;
  nameMatch: { title: string; name: string } | null;
  grantedBuildings: number | null;
}

const MAX_MS_ATTEMPTS = 30;
/** En godkjenning som ble avbrutt midt i, slippes fri igjen etter dette */
const APPROVING_STALE_MS = 10 * 60 * 1000;

function brandFor(id: string): Brand {
  return BRANDS[id as BrandId] ?? BRANDS.naeringsmappa;
}

function staffEmails(env: Env): string[] {
  return (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

/** Det admin trenger for å vurdere forespørselen: roller i Brønnøysund og bygg Boligmappa har gitt tilgang til */
async function accessContext(env: Env, orgNr: string, name: string): Promise<AccessContext> {
  const [roles, granted] = await Promise.allSettled([brregRoles(orgNr), grantedBuildingCount(env, orgNr)]);
  const list = roles.status === "fulfilled" ? roles.value : null;
  return {
    roles: list,
    nameMatch: list?.find((r) => nameMatches(name, r.name)) ?? null,
    grantedBuildings: granted.status === "fulfilled" ? granted.value : null,
  };
}

/** Bedrifter til Tilgangsforespørsler, kommuner til lead-køen. Kaster ikke; cron prøver igjen. */
async function deliver(env: Env, row: AccessRequestRow): Promise<boolean> {
  if (row.kind === "kommune") {
    const company: BrregCompany = { orgNr: row.org_nr, name: row.org_name ?? row.org_nr, orgForm: row.org_form, orgFormKode: null, municipal: true };
    const ok = await enqueueKommune(env, company, { email: row.email, name: row.name }, row.consent_text);
    await env.DB.prepare(`UPDATE access_requests SET ms_synced_at = ?, ms_error = ?, ms_attempts = ms_attempts + 1 WHERE id = ?`)
      .bind(ok ? now() : null, ok ? null : "Fikk ikke lagt kommunen i lead-køen", row.id)
      .run();
    return ok;
  }
  if (!row.context) {
    row.context = JSON.stringify(await accessContext(env, row.org_nr, row.name));
    await env.DB.prepare(`UPDATE access_requests SET context = ? WHERE id = ?`).bind(row.context, row.id).run();
  }
  try {
    await sendAccessRequest(env, {
      plankId: row.id,
      orgNr: row.org_nr,
      orgName: row.org_name,
      orgForm: row.org_form,
      brand: row.brand,
      origin: row.origin,
      name: row.name,
      email: row.email,
      emailVerified: Boolean(row.user_id),
      consentText: row.consent_text,
      consentAt: new Date(row.consent_at).toISOString(),
      ip: row.ip,
      context: row.context ? JSON.parse(row.context) : null,
    });
    await env.DB.prepare(`UPDATE access_requests SET ms_synced_at = ?, ms_error = NULL, ms_attempts = ms_attempts + 1 WHERE id = ?`).bind(now(), row.id).run();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("Fikk ikke sendt tilgangsforespørselen til boligmappa-ms", row.id, message);
    await env.DB.prepare(`UPDATE access_requests SET ms_error = ?, ms_attempts = ms_attempts + 1 WHERE id = ?`).bind(message.slice(0, 500), row.id).run();
    return false;
  }
}

async function notifyStaff(env: Env, row: AccessRequestRow, brand: Brand): Promise<void> {
  const staff = staffEmails(env);
  if (!staff.length || !emailConfigured(env)) return;
  const where =
    row.kind === "kommune"
      ? "Kommunen ligger i lead-køen i boligmappa-ms-admin."
      : `Godkjenn eller avslå i boligmappa-ms-admin: ${msBase(env)}/admin/access-requests.html`;
  await sendEmail(env, {
    to: staff,
    from: emailFrom(env, brand),
    subject: `Tilgangsforespørsel: ${row.org_name ?? row.org_nr}`,
    html: `<p>${escapeHtml(row.name)} (${escapeHtml(row.email)}) ber om tilgang til <b>${escapeHtml(row.org_name ?? row.org_nr)}</b> (${row.org_nr}) i ${escapeHtml(brand.name)}, uten Vipps.</p><p>${escapeHtml(where)}</p>`,
    text: `${row.name} (${row.email}) ber om tilgang til ${row.org_name ?? row.org_nr} (${row.org_nr}) i ${brand.name}, uten Vipps.\n\n${where}`,
  }).catch((err) => console.error("Kunne ikke varsle om tilgangsforespørsel", err));
}

/**
 * Lagrer forespørselen og returnerer med en gang. `deliver` (rollesjekk, videresending, varsel)
 * kan ta lang tid når Boligmappa er treg, så den kjøres i bakgrunnen og av cron hvis den feiler.
 */
export async function createAccessRequest(
  env: Env,
  input: { company: BrregCompany; brand: Brand; origin: string; email: string; name: string; user: SessionUser | null; ip: string | null },
): Promise<{ row: AccessRequestRow; deliver: () => Promise<void> }> {
  const { company, brand } = input;
  const existing = await first<AccessRequestRow>(
    env.DB,
    `SELECT * FROM access_requests WHERE email = ? AND org_nr = ? AND status IN ('pending', 'approving') ORDER BY created_at DESC LIMIT 1`,
    input.email,
    company.orgNr,
  );
  if (existing) {
    return {
      row: existing,
      deliver: async () => {
        if (!existing.ms_synced_at) await deliver(env, existing);
      },
    };
  }

  const kind = company.municipal ? "kommune" : "org";
  const row: AccessRequestRow = {
    id: newId("acr"),
    kind,
    org_nr: company.orgNr,
    org_name: company.name,
    org_form: company.orgForm,
    brand: brand.id,
    origin: input.origin,
    email: input.email,
    name: input.name,
    user_id: input.user?.id ?? null,
    consent_text: accessConsentText(company.name, company.orgNr),
    consent_at: now(),
    ip: input.ip,
    context: null,
    status: "pending",
    ms_synced_at: null,
    ms_error: null,
    ms_attempts: 0,
    decision_note: null,
    decided_by: null,
    decided_at: null,
    org_id: null,
    created_at: now(),
  };
  await env.DB.prepare(
    `INSERT INTO access_requests (id, kind, org_nr, org_name, org_form, brand, origin, email, name, user_id, consent_text, consent_at, ip, context, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(row.id, row.kind, row.org_nr, row.org_name, row.org_form, row.brand, row.origin, row.email, row.name, row.user_id, row.consent_text, row.consent_at, row.ip, row.context, row.created_at)
    .run();

  return {
    row,
    deliver: async () => {
      await deliver(env, row);
      await notifyStaff(env, row, brand);
    },
  };
}

export interface AccessDecision {
  status: "approved" | "rejected";
  note: string | null;
  decidedBy: string | null;
}

/** Bruker finnes eller lages, får en organisasjon for org.nr-et og Boligmappa-henting satt i gang */
async function provision(env: Env, row: AccessRequestRow, brand: Brand): Promise<string> {
  let user = await first<{ id: string; name: string | null }>(env.DB, `SELECT id, name FROM users WHERE email = ?`, row.email);
  if (!user) {
    user = { id: newId("usr"), name: row.name };
    await env.DB.prepare(`INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)`).bind(user.id, row.email, row.name, now()).run();
  } else if (!user.name) {
    await env.DB.prepare(`UPDATE users SET name = ? WHERE id = ?`).bind(row.name, user.id).run();
  }

  const mine = await first<{ id: string }>(
    env.DB,
    `SELECT o.id FROM orgs o JOIN memberships m ON m.org_id = o.id WHERE m.user_id = ? AND o.org_nr = ? ORDER BY o.created_at LIMIT 1`,
    user.id,
    row.org_nr,
  );
  if (mine) return mine.id;

  const org = await createOrg(env, (row.org_name || row.org_nr).slice(0, 100), user.id);
  await env.DB.prepare(`UPDATE orgs SET org_nr = ?, brand = ? WHERE id = ?`).bind(row.org_nr, brand.id, org.id).run();
  if (boligmappaConfigured(env)) {
    try {
      await connectBoligmappa(env, org.id, row.org_nr, { autoImport: true });
      await grantAgents(env, org.id, ["boligmappa"]);
    } catch (err) {
      console.error("Kunne ikke koble Boligmappa etter godkjent tilgang", err);
    }
  }
  return org.id;
}

async function sendDecisionEmail(env: Env, row: AccessRequestRow, brand: Brand, decision: AccessDecision, orgId: string | null): Promise<void> {
  if (!emailConfigured(env)) {
    if (env.DEV_MODE === "true" && orgId) {
      const link = await createLoginLink(env, row.email, `/velkommen/${orgId}`, INVITE_TTL_MS, "login", null, row.origin);
      console.log(`[plank] Tilgang godkjent for ${row.email}: ${link}`);
    }
    return;
  }
  const company = row.org_name ?? row.org_nr;
  const note = decision.note?.trim();
  if (decision.status === "approved" && orgId) {
    const link = await createLoginLink(env, row.email, `/velkommen/${orgId}`, INVITE_TTL_MS, "login", null, row.origin);
    const login = `${row.origin.replace(/\/$/, "")}/login`;
    await sendEmail(env, {
      to: row.email,
      from: emailFrom(env, brand),
      idempotencyKey: `access-approved-${row.id}`,
      subject: `Du har fått tilgang til ${company} i ${brand.name}`,
      html: emailLayout({
        brand: brand.name,
        title: "Tilgangen er godkjent",
        bodyHtml:
          `<p>LAFT har godkjent forespørselen din for <b>${escapeHtml(company)}</b>. Vi har begynt å hente byggene og dokumentene fra Boligmappa.</p>` +
          (note ? `<p>${escapeHtml(note)}</p>` : "") +
          `<p>Knappen logger deg rett inn. Lenken virker i 7 dager og kan brukes én gang. Senere logger du inn på <a href="${escapeHtml(login)}">${escapeHtml(login)}</a> med e-postadressen din.</p>`,
        cta: { label: `Åpne ${brand.name}`, url: link },
        footer: "Ba du ikke om tilgang? Da kan du se bort fra e-posten.",
      }),
      text: `LAFT har godkjent forespørselen din for ${company}. Vi har begynt å hente byggene og dokumentene fra Boligmappa.\n\n${note ? `${note}\n\n` : ""}Åpne ${brand.name} (lenken virker i 7 dager og kan brukes én gang):\n${link}\n\nSenere logger du inn på ${login} med e-postadressen din.`,
    });
    return;
  }
  await sendEmail(env, {
    to: row.email,
    from: emailFrom(env, brand),
    idempotencyKey: `access-rejected-${row.id}`,
    subject: `Forespørselen om tilgang til ${company}`,
    html: emailLayout({
      brand: brand.name,
      title: "Vi kunne ikke gi deg tilgang",
      bodyHtml:
        `<p>LAFT har gått gjennom forespørselen din om tilgang til <b>${escapeHtml(company)}</b> i ${escapeHtml(brand.name)}, og kunne ikke godkjenne den nå.</p>` +
        (note ? `<p>${escapeHtml(note)}</p>` : "") +
        "<p>Har du en rolle i Brønnøysundregistrene, kan du logge inn med Vipps i stedet. Da sjekker vi rollen med en gang.</p>",
    }),
    text: `LAFT har gått gjennom forespørselen din om tilgang til ${company} i ${brand.name}, og kunne ikke godkjenne den nå.\n\n${note ? `${note}\n\n` : ""}Har du en rolle i Brønnøysundregistrene, kan du logge inn med Vipps i stedet.`,
  });
}

/**
 * Tar imot avgjørelsen fra boligmappa-ms. Idempotent: samme svar tilbake hvis den alt er avgjort.
 * Kaster hvis godkjenningen feiler, så boligmappa-ms kan prøve igjen.
 */
export async function decideAccessRequest(env: Env, id: string, decision: AccessDecision): Promise<{ status: string; orgId: string | null } | null> {
  const row = await first<AccessRequestRow>(env.DB, `SELECT * FROM access_requests WHERE id = ?`, id);
  if (!row) return null;
  if (row.kind !== "org") return { status: row.status, orgId: row.org_id };

  const claimed = await env.DB.prepare(`UPDATE access_requests SET status = 'approving', decided_at = ? WHERE id = ? AND status = 'pending'`)
    .bind(now(), id)
    .run();
  if (!claimed.meta.changes) {
    const current = await first<{ status: string; org_id: string | null }>(env.DB, `SELECT status, org_id FROM access_requests WHERE id = ?`, id);
    return { status: current?.status ?? row.status, orgId: current?.org_id ?? null };
  }

  const brand = brandFor(row.brand);
  try {
    const orgId = decision.status === "approved" ? await provision(env, row, brand) : null;
    await env.DB.prepare(`UPDATE access_requests SET status = ?, decision_note = ?, decided_by = ?, decided_at = ?, org_id = ? WHERE id = ?`)
      .bind(decision.status, decision.note, decision.decidedBy, now(), orgId, id)
      .run();
    if (orgId) {
      await logActivity(env, {
        orgId,
        actor: { type: "system", name: "LAFT" },
        action: "access.approved",
        summary: `${row.name} fikk tilgang etter godkjenning i boligmappa-ms`,
      });
    }
    await sendDecisionEmail(env, row, brand, decision, orgId).catch((err) => console.error("Kunne ikke sende e-post om tilgang", row.id, err));
    return { status: decision.status, orgId };
  } catch (err) {
    await env.DB.prepare(`UPDATE access_requests SET status = 'pending', decided_at = NULL WHERE id = ? AND status = 'approving'`).bind(id).run();
    throw err;
  }
}

/** Siste forespørsel som venter for brukeren (på bruker-id eller e-post) */
export async function pendingRequestFor(env: Env, user: SessionUser): Promise<AccessRequestRow | null> {
  return first<AccessRequestRow>(
    env.DB,
    `SELECT * FROM access_requests WHERE (user_id = ? OR email = ?) AND status IN ('pending', 'approving') ORDER BY created_at DESC LIMIT 1`,
    user.id,
    user.email,
  );
}

/** Cron: send det som ikke kom fram, og hent avgjørelser i tilfelle tilbakekallet fra boligmappa-ms gikk tapt */
export async function syncAccessRequests(env: Env): Promise<void> {
  if (!env.BOLIGMAPPA_MS_KEY) return;
  const t = now();
  await env.DB.prepare(`UPDATE access_requests SET status = 'pending', decided_at = NULL WHERE status = 'approving' AND decided_at < ?`)
    .bind(t - APPROVING_STALE_MS)
    .run();

  const unsent = await all<AccessRequestRow>(
    env.DB,
    `SELECT * FROM access_requests WHERE status = 'pending' AND ms_synced_at IS NULL AND ms_attempts < ? AND created_at < ? ORDER BY created_at LIMIT 20`,
    MAX_MS_ATTEMPTS,
    t - 60 * 1000,
  );
  for (const row of unsent) await deliver(env, row);

  const waiting = await all<AccessRequestRow>(
    env.DB,
    `SELECT * FROM access_requests WHERE kind = 'org' AND status = 'pending' AND ms_synced_at IS NOT NULL AND ms_synced_at < ? ORDER BY created_at LIMIT 25`,
    t - 2 * 60 * 1000,
  );
  for (const row of waiting) {
    try {
      const remote = await fetchAccessDecision(env, row.id);
      if (!remote) {
        await env.DB.prepare(`UPDATE access_requests SET ms_synced_at = NULL WHERE id = ?`).bind(row.id).run();
        continue;
      }
      if (remote.status === "approved" || remote.status === "rejected") {
        await decideAccessRequest(env, row.id, { status: remote.status, note: remote.note, decidedBy: remote.decidedBy });
      }
    } catch (err) {
      console.warn("Fikk ikke sjekket tilgangsforespørsel i boligmappa-ms", row.id, err);
    }
  }
}
