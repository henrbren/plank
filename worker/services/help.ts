import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer";
import type { HelpArticle, HelpDetail, HelpIndex } from "../../shared/types";
import { nextRunAt } from "../agent/schedule";
import { AGENT_TEMPLATES } from "../agent/templates";
import type { Env } from "../env";
import { currentAccess } from "../lib/access";
import { logActivity, type ActivityInput } from "../lib/activity";
import { createSession, destroySession, SESSION_COOKIE } from "../lib/auth";
import { all, first, insert } from "../lib/db";
import { newId, now, sha256 } from "../lib/util";
import { CATALOG_VERSION, HELP_CATALOG } from "./helpCatalog";

const SLUG_RE = /^[a-z0-9-]{2,48}$/;
const HELP_TEMPLATE = "hjelp";
const HELP_SCHEDULE = "weekly:1@06:00";
const EMPTY_PREFIX = "Tom:";
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const CAPTURE_BUDGET = 2;
const AGENT_CAPTURES_PER_HOUR = 16;
const NO_PROPERTY = "Tom: organisasjonen har ingen eiendommer ennå, så eiendomssiden kan ikke vises.";

/** document/location finnes bare i siden puppeteer åpner, ikke i workeren. */
declare const document: {
  title: string;
  body: { innerText: string } | null;
  querySelectorAll: (sel: string) => Iterable<{ textContent: string | null; innerText?: string }>;
};
declare const location: { pathname: string };

export function isHelpSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

export function helpShotKey(orgId: string, slug: string): string {
  return `help/${orgId}/${slug}.jpg`;
}

interface ArticleRow {
  slug: string;
  title: string;
  summary: string;
  body: string;
  category: string;
  route: string;
  sort: number;
  has_shot: number;
  needs_rewrite: number;
  seen_text: string | null;
  seen_hash: string | null;
  shot_key: string | null;
  updated_at: number;
}

export async function seedHelp(env: Env, orgId: string): Promise<void> {
  const slugs = HELP_CATALOG.map((item) => item.slug);
  const have = await first<{ n: number }>(
    env.DB,
    `SELECT COUNT(*) AS n FROM help_articles WHERE org_id = ? AND catalog_version >= ? AND slug IN (${slugs.map(() => "?").join(", ")})`,
    orgId,
    CATALOG_VERSION,
    ...slugs,
  );
  if (Number(have?.n ?? 0) === slugs.length) {
    await syncPropertyRoute(env, orgId);
    return;
  }
  const t = now();
  const stmts = HELP_CATALOG.map((item) =>
    env.DB.prepare(
      `INSERT INTO help_articles (
         org_id, slug, title, summary, body, category, route, sort, needs_rewrite, catalog_version, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(org_id, slug) DO UPDATE SET
         category = excluded.category,
         sort = excluded.sort,
         route = CASE WHEN excluded.route != '' THEN excluded.route ELSE help_articles.route END,
         needs_rewrite = CASE WHEN help_articles.catalog_version < excluded.catalog_version THEN 1 ELSE help_articles.needs_rewrite END,
         catalog_version = CASE WHEN help_articles.catalog_version < excluded.catalog_version THEN excluded.catalog_version ELSE help_articles.catalog_version END`,
    ).bind(orgId, item.slug, item.title, item.summary, item.body, item.category, item.path, item.sort, CATALOG_VERSION, t),
  );
  if (stmts.length) await env.DB.batch(stmts);
  await syncPropertyRoute(env, orgId);
}

/** Oppretter Hjelp-agenten der den mangler, og setter tidsplan der createOrg har nullet den. */
export async function ensureHelpAgent(env: Env, orgId: string, createdBy: string | null): Promise<string | null> {
  const existing = await first<{ id: string; archived: number; schedule: string | null; next_run_at: number | null }>(
    env.DB,
    `SELECT id, archived, schedule, next_run_at FROM agents WHERE org_id = ? AND template = ? ORDER BY archived, created_at LIMIT 1`,
    orgId,
    HELP_TEMPLATE,
  );
  const tpl = AGENT_TEMPLATES.find((item) => item.key === HELP_TEMPLATE);
  if (!tpl) return existing && !existing.archived ? existing.id : null;
  if (existing?.archived) return null;
  const schedule = tpl.schedule || HELP_SCHEDULE;
  if (!existing) {
    const id = newId("agt");
    const t = now();
    await insert(env.DB, "agents", {
      id,
      org_id: orgId,
      name: tpl.name,
      icon: tpl.icon,
      color: tpl.color,
      description: tpl.description,
      instructions: tpl.instructions,
      model: env.DEFAULT_MODEL || "claude-sonnet-5-5",
      effort: tpl.effort,
      tools: tpl.tools,
      scope_type: "org",
      schedule,
      schedule_prompt: tpl.schedule_prompt ?? null,
      notify_emails: [],
      next_run_at: nextRunAt(schedule, t),
      template: tpl.key,
      created_by: createdBy,
      created_at: t,
      updated_at: t,
    }).run();
    return id;
  }
  if (!existing.schedule || existing.next_run_at == null) {
    const nextSchedule = existing.schedule || schedule;
    await env.DB.prepare(
      `UPDATE agents SET schedule = ?, schedule_prompt = COALESCE(schedule_prompt, ?), next_run_at = COALESCE(next_run_at, ?), updated_at = ? WHERE id = ? AND org_id = ?`,
    )
      .bind(nextSchedule, tpl.schedule_prompt ?? null, nextRunAt(nextSchedule, now()), now(), existing.id, orgId)
      .run();
  }
  return existing.id;
}

export async function helpIndex(env: Env, orgId: string, createdBy: string | null): Promise<HelpIndex> {
  await ensureHelpAgent(env, orgId, createdBy);
  await seedHelp(env, orgId);
  const hideShots = Boolean(currentAccess().scope);
  const rows = await all<ArticleRow>(
    env.DB,
    `SELECT slug, title, summary, '' AS body, category, route, sort, shot_key IS NOT NULL AS has_shot, 0 AS needs_rewrite, NULL AS seen_text, NULL AS seen_hash, shot_key, updated_at
     FROM help_articles WHERE org_id = ? ORDER BY sort, title`,
    orgId,
  );
  const agent = await first<{ id: string }>(
    env.DB,
    `SELECT id FROM agents WHERE org_id = ? AND template = ? AND archived = 0 ORDER BY created_at LIMIT 1`,
    orgId,
    HELP_TEMPLATE,
  );
  return {
    agent_id: agent?.id ?? null,
    can_view_shots: !hideShots,
    articles: rows.map((row) => mapArticle(row, hideShots)),
  };
}

export async function helpDetail(env: Env, orgId: string, slug: string): Promise<HelpDetail | null> {
  if (!isHelpSlug(slug)) return null;
  const row = await first<ArticleRow>(
    env.DB,
    `SELECT slug, title, summary, body, category, route, sort, shot_key IS NOT NULL AS has_shot, needs_rewrite, seen_text, seen_hash, shot_key, updated_at
     FROM help_articles WHERE org_id = ? AND slug = ?`,
    orgId,
    slug,
  );
  if (!row) return null;
  const hideShots = Boolean(currentAccess().scope);
  const agent = await first<{ id: string }>(
    env.DB,
    `SELECT id FROM agents WHERE org_id = ? AND template = ? AND archived = 0 ORDER BY created_at LIMIT 1`,
    orgId,
    HELP_TEMPLATE,
  );
  return {
    agent_id: agent?.id ?? null,
    can_view_shots: !hideShots,
    article: { ...mapArticle(row, hideShots), body: row.body },
  };
}

export async function listHelpForAgent(env: Env, orgId: string, needsRewriteOnly: boolean): Promise<string> {
  const rows = await all<{
    slug: string;
    title: string;
    summary: string;
    category: string;
    route: string;
    needs_rewrite: number;
    has_shot: number;
    has_seen: number;
  }>(
    env.DB,
    `SELECT slug, title, summary, category, route, needs_rewrite, shot_key IS NOT NULL AS has_shot, seen_text IS NOT NULL AS has_seen
     FROM help_articles WHERE org_id = ? ${needsRewriteOnly ? "AND needs_rewrite = 1" : ""} ORDER BY sort, title`,
    orgId,
  );
  return JSON.stringify({
    count: rows.length,
    articles: rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      category: row.category,
      route: row.route,
      needs_rewrite: row.needs_rewrite,
      has_shot: Boolean(row.has_shot),
      has_seen: Boolean(row.has_seen),
    })),
  });
}

export async function readHelpForAgent(env: Env, orgId: string, slug: string): Promise<string | null> {
  if (!isHelpSlug(slug)) return null;
  const row = await first<ArticleRow>(
    env.DB,
    `SELECT slug, title, summary, body, category, route, sort, shot_key IS NOT NULL AS has_shot, needs_rewrite, seen_text, seen_hash, shot_key, updated_at
     FROM help_articles WHERE org_id = ? AND slug = ?`,
    orgId,
    slug,
  );
  if (!row) return null;
  const scoped = Boolean(currentAccess().scope);
  return JSON.stringify({
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    body: row.body,
    category: row.category,
    route: row.route,
    needs_rewrite: row.needs_rewrite,
    has_shot: Boolean(row.has_shot),
    seen_text: scoped ? null : row.seen_text,
    seen_hidden: scoped,
  });
}

export async function saveHelpArticle(
  env: Env,
  orgId: string,
  input: { slug: string; title: string; summary: string; body: string; category?: string; route?: string },
  actor: ActivityInput["actor"],
): Promise<{ ok: true; created: boolean; title: string } | { ok: false; message: string }> {
  const slug = input.slug.trim();
  const title = input.title.trim();
  const summary = input.summary.trim();
  const body = input.body.trim();
  if (!isHelpSlug(slug)) return { ok: false, message: "slug må være 2–48 tegn: små bokstaver, tall og bindestrek." };
  if (!title || title.length > 120) return { ok: false, message: "Tittelen må være 1–120 tegn." };
  if (!summary || summary.length > 280) return { ok: false, message: "Ingressen må være 1–280 tegn." };
  if (!body || body.length > 12000) return { ok: false, message: "Brødteksten må være 1–12000 tegn." };
  let route = "";
  if (input.route?.trim()) {
    const full = pagePath(orgId, input.route);
    if (!full) return { ok: false, message: "Stien må peke på en side i denne organisasjonen." };
    route = relativeRoute(orgId, full);
  }
  const category = (input.category?.trim() || "Mer").slice(0, 40);
  const existing = await first<{ slug: string; route: string }>(env.DB, `SELECT slug, route FROM help_articles WHERE org_id = ? AND slug = ?`, orgId, slug);
  const t = now();
  if (!existing) {
    await insert(env.DB, "help_articles", {
      org_id: orgId,
      slug,
      title,
      summary,
      body,
      category,
      route,
      sort: 100,
      needs_rewrite: 0,
      catalog_version: 0,
      updated_at: t,
    }).run();
  } else {
    const routeChanged = Boolean(route) && route !== existing.route;
    await env.DB.prepare(
      `UPDATE help_articles
       SET title = ?, summary = ?, body = ?, category = ?, needs_rewrite = 0, updated_at = ?,
           route = CASE WHEN ? != '' THEN ? ELSE route END,
           shot_key = CASE WHEN ? = 1 THEN NULL ELSE shot_key END,
           seen_text = CASE WHEN ? = 1 THEN NULL ELSE seen_text END,
           seen_hash = CASE WHEN ? = 1 THEN NULL ELSE seen_hash END
       WHERE org_id = ? AND slug = ?`,
    )
      .bind(title, summary, body, category, t, route, route, routeChanged ? 1 : 0, routeChanged ? 1 : 0, routeChanged ? 1 : 0, orgId, slug)
      .run();
  }
  await logActivity(env, {
    orgId,
    actor,
    action: "help.save",
    entityType: "help_article",
    entityId: slug,
    summary: `${existing ? "Oppdaterte" : "Opprettet"} hjelpeartikkelen «${title}»`,
  });
  return { ok: true, created: !existing, title };
}

export interface CaptureOutcome {
  ok: boolean;
  message: string;
  stored: boolean;
  path: string;
  title: string;
  headings: string[];
  controls: string[];
  text: string;
}

export async function captureForAgent(env: Env, orgId: string, rawPath: string, slug: string | undefined, userId: string | null): Promise<CaptureOutcome> {
  const full = pagePath(orgId, rawPath);
  if (!full) {
    return { ok: false, message: "Stien må peke på en side i denne organisasjonen.", stored: false, path: "", title: "", headings: [], controls: [], text: "" };
  }
  if (slug && !isHelpSlug(slug)) {
    return { ok: false, message: "Ugyldig slug.", stored: false, path: relativeRoute(orgId, full), title: "", headings: [], controls: [], text: "" };
  }
  const origin = originOf(env);
  if (!env.BROWSER || !origin) {
    return { ok: false, message: "Skjermbilder er ikke slått på i dette miljøet.", stored: false, path: relativeRoute(orgId, full), title: "", headings: [], controls: [], text: "" };
  }
  if (isLocalHost(origin.hostname)) {
    return {
      ok: false,
      message: "Skjermbilder tas mot den offentlige adressen til Plank. Lokalt blir de ikke lagret.",
      stored: false,
      path: relativeRoute(orgId, full),
      title: "",
      headings: [],
      controls: [],
      text: "",
    };
  }
  const since = now() - 60 * 60 * 1000;
  const count = await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM activity WHERE org_id = ? AND action = 'help.capture' AND created_at > ?`, orgId, since);
  if (Number(count?.n ?? 0) >= AGENT_CAPTURES_PER_HOUR) {
    return { ok: false, message: "For mange skjermbilder den siste timen. Vent litt, så prøver du igjen.", stored: false, path: relativeRoute(orgId, full), title: "", headings: [], controls: [], text: "" };
  }
  const target = slug || (await slugForPath(env, orgId, full));
  const store = Boolean(target) && !currentAccess().scope;
  try {
    return await withBrowser(env, orgId, userId, async (page) => shoot(env, page, origin, orgId, full, store ? target : null));
  } catch (err) {
    console.error("Skjermbilde feilet", orgId, err);
    return { ok: false, message: "Klarte ikke å åpne siden.", stored: false, path: relativeRoute(orgId, full), title: "", headings: [], controls: [], text: "" };
  }
}

/** Cron: sørg for agent og artikler, ta noen få skjermbilder, og vekk Hjelp når teksten bør skrives om. */
export async function maintainHelp(env: Env): Promise<void> {
  const missingAgents = await all<{ id: string }>(
    env.DB,
    `SELECT o.id FROM orgs o
     WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.org_id = o.id AND a.template = ?)
     LIMIT 2`,
    HELP_TEMPLATE,
  );
  for (const org of missingAgents) {
    await ensureHelpAgent(env, org.id, null);
    await seedHelp(env, org.id);
  }
  const unscheduled = await all<{ org_id: string }>(
    env.DB,
    `SELECT org_id FROM agents WHERE template = ? AND archived = 0 AND (schedule IS NULL OR next_run_at IS NULL) LIMIT 2`,
    HELP_TEMPLATE,
  );
  for (const row of unscheduled) await ensureHelpAgent(env, row.org_id, null);

  const slugs = HELP_CATALOG.map((item) => item.slug);
  const placeholders = slugs.map(() => "?").join(", ");
  const behind = await all<{ id: string }>(
    env.DB,
    `SELECT o.id FROM orgs o
     WHERE (SELECT COUNT(*) FROM help_articles h WHERE h.org_id = o.id AND h.slug IN (${placeholders})) < ?
     LIMIT 5`,
    ...slugs,
    slugs.length,
  );
  for (const org of behind) await seedHelp(env, org.id);

  await clearPropertySentinels(env);
  const origin = originOf(env);
  if (!env.BROWSER || !origin || isLocalHost(origin.hostname)) return;

  const { empties, shots } = await collectJobs(env, CAPTURE_BUDGET);
  const orgIds = new Set<string>([...empties.map((job) => job.orgId), ...shots.map((job) => job.orgId)]);
  for (const orgId of orgIds) {
    try {
      const unseenBefore = await hasUnseen(env, orgId);
      let changed = false;
      for (const job of empties.filter((item) => item.orgId === orgId)) {
        if (await markEmpty(env, orgId, job.slug, job.reason)) changed = true;
      }
      const mine = shots.filter((item) => item.orgId === orgId);
      if (mine.length && (await captureOrg(env, origin, orgId, mine))) changed = true;
      const unseenAfter = await hasUnseen(env, orgId);
      const filled = unseenBefore && !unseenAfter;
      if ((changed || filled) && (await pendingRewrite(env, orgId))) await wakeHelpAgent(env, orgId);
    } catch (err) {
      console.error("Hjelpesenter feilet", orgId, err);
    }
  }
}

function mapArticle(row: ArticleRow, hideShots: boolean): HelpArticle {
  return {
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    category: row.category,
    route: row.route,
    sort: row.sort,
    has_shot: hideShots ? false : Boolean(row.has_shot),
    updated_at: row.updated_at,
  };
}

async function syncPropertyRoute(env: Env, orgId: string): Promise<void> {
  const property = await first<{ id: string }>(env.DB, `SELECT id FROM properties WHERE org_id = ? ORDER BY created_at LIMIT 1`, orgId);
  if (!property) return;
  const row = await first<{ route: string }>(env.DB, `SELECT route FROM help_articles WHERE org_id = ? AND slug = 'portefolje'`, orgId);
  if (!row) return;
  const id = /^\/properties\/([^/]+)$/.exec(row.route)?.[1];
  if (id) {
    const ok = await first<{ id: string }>(env.DB, `SELECT id FROM properties WHERE id = ? AND org_id = ?`, id, orgId);
    if (ok) return;
  }
  await env.DB.prepare(`UPDATE help_articles SET route = ? WHERE org_id = ? AND slug = 'portefolje'`).bind(`/properties/${property.id}`, orgId).run();
}

async function clearPropertySentinels(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE help_articles SET seen_text = NULL, seen_hash = NULL
     WHERE slug = 'portefolje' AND shot_key IS NULL AND seen_text LIKE ?
       AND org_id IN (SELECT org_id FROM properties)`,
  )
    .bind(`${EMPTY_PREFIX}%`)
    .run();
}

interface EmptyJob {
  orgId: string;
  slug: string;
  reason: string;
}
interface ShotJob {
  orgId: string;
  slug: string;
  path: string;
}

async function collectJobs(env: Env, budget: number): Promise<{ empties: EmptyJob[]; shots: ShotJob[] }> {
  const empties: EmptyJob[] = [];
  const shots: ShotJob[] = [];
  const missing = await all<{ org_id: string; slug: string; route: string }>(
    env.DB,
    `SELECT org_id, slug, route FROM help_articles
     WHERE shot_key IS NULL AND (seen_text IS NULL OR seen_text NOT LIKE ?)
     ORDER BY updated_at LIMIT 30`,
    `${EMPTY_PREFIX}%`,
  );
  for (const row of missing) {
    const resolved = await resolveArticlePath(env, row.org_id, row.slug, row.route);
    if ("empty" in resolved) empties.push({ orgId: row.org_id, slug: row.slug, reason: resolved.empty });
    else if ("path" in resolved && shots.length < budget) shots.push({ orgId: row.org_id, slug: row.slug, path: resolved.path });
    if (shots.length >= budget) break;
  }
  if (shots.length < budget) {
    const stale = await all<{ org_id: string; slug: string; route: string }>(
      env.DB,
      `SELECT org_id, slug, route FROM help_articles WHERE shot_key IS NOT NULL AND updated_at < ? ORDER BY updated_at LIMIT ?`,
      now() - STALE_MS,
      budget - shots.length,
    );
    for (const row of stale) {
      const resolved = await resolveArticlePath(env, row.org_id, row.slug, row.route);
      if ("empty" in resolved) empties.push({ orgId: row.org_id, slug: row.slug, reason: resolved.empty });
      else if ("path" in resolved) shots.push({ orgId: row.org_id, slug: row.slug, path: resolved.path });
    }
  }
  return { empties, shots };
}

async function resolveArticlePath(env: Env, orgId: string, slug: string, route: string): Promise<{ path: string } | { empty: string } | { skip: true }> {
  const seed = HELP_CATALOG.find((item) => item.slug === slug);
  if (seed?.dynamic === "property") {
    const property = await first<{ id: string }>(env.DB, `SELECT id FROM properties WHERE org_id = ? ORDER BY created_at LIMIT 1`, orgId);
    if (!property) return { empty: NO_PROPERTY };
    const full = pagePath(orgId, `/properties/${property.id}`);
    return full ? { path: full } : { skip: true };
  }
  if (seed?.path) {
    const full = pagePath(orgId, seed.path);
    return full ? { path: full } : { skip: true };
  }
  if (route) {
    const full = pagePath(orgId, route);
    return full ? { path: full } : { skip: true };
  }
  return { skip: true };
}

async function markEmpty(env: Env, orgId: string, slug: string, reason: string): Promise<boolean> {
  const row = await first<{ seen_text: string | null; shot_key: string | null }>(
    env.DB,
    `SELECT seen_text, shot_key FROM help_articles WHERE org_id = ? AND slug = ?`,
    orgId,
    slug,
  );
  if (!row || (row.seen_text === reason && !row.shot_key)) return false;
  const hadShot = Boolean(row.shot_key);
  const hash = await sha256(reason);
  await env.DB.prepare(
    `UPDATE help_articles
     SET seen_text = ?, seen_hash = ?, shot_key = NULL,
         needs_rewrite = CASE WHEN shot_key IS NOT NULL THEN 1 ELSE needs_rewrite END,
         updated_at = ?
     WHERE org_id = ? AND slug = ?`,
  )
    .bind(reason, hash, now(), orgId, slug)
    .run();
  return hadShot;
}

async function captureOrg(env: Env, origin: URL, orgId: string, shots: ShotJob[]): Promise<boolean> {
  let changed = false;
  await withBrowser(env, orgId, null, async (page) => {
    for (const shot of shots) {
      const result = await shoot(env, page, origin, orgId, shot.path, shot.slug);
      if (result.changed) changed = true;
      if (result.loginFailed) break;
    }
    return changed;
  });
  return changed;
}

interface ScreenRead {
  title: string;
  headings: string[];
  controls: string[];
  text: string;
  path: string;
}

async function shoot(
  env: Env,
  page: Page,
  origin: URL,
  orgId: string,
  fullPath: string,
  slug: string | null,
): Promise<CaptureOutcome & { changed: boolean; loginFailed: boolean }> {
  const route = relativeRoute(orgId, fullPath);
  const blank = { stored: false, path: route, title: "", headings: [] as string[], controls: [] as string[], text: "", changed: false, loginFailed: false };
  try {
    await page.goto(new URL(fullPath, origin).href, { waitUntil: "load", timeout: 20000 });
    await page.waitForSelector("h1, nav", { timeout: 8000 }).catch(() => undefined);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
    const read = await readScreen(page);
    if (isLoginPath(read.path)) {
      return { ...blank, ok: false, loginFailed: true, message: "Fikk ikke åpnet siden innlogget. Skjermbildet ble ikke lagret." };
    }
    if (!read.text && read.headings.length === 0) {
      return { ...blank, ok: false, message: "Siden rakk ikke å tegne seg. Skjermbildet ble ikke lagret." };
    }
    const text = read.text || "Tom: siden viste ingen tekst.";
    let stored = false;
    let changed = false;
    if (slug && isHelpSlug(slug)) {
      const saved = await storeShot(env, page, orgId, slug, route, text);
      stored = saved.stored;
      changed = saved.changed;
    }
    return { ok: true, message: "", stored, path: route, title: read.title, headings: read.headings, controls: read.controls, text, changed, loginFailed: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Skjermbilde feilet", orgId, fullPath, message);
    return { ...blank, ok: false, message: "Klarte ikke å åpne siden." };
  }
}

async function readScreen(page: Page): Promise<ScreenRead> {
  return page.evaluate(() => {
    const norm = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const headings: string[] = [];
    for (const el of document.querySelectorAll("h1, h2, h3")) {
      const text = norm(el.textContent);
      if (text && headings.length < 20) headings.push(text);
    }
    const seen = new Set<string>();
    const controls: string[] = [];
    for (const el of document.querySelectorAll("button, a")) {
      const text = norm(el.innerText || el.textContent);
      if (!text || text.length > 80 || seen.has(text)) continue;
      seen.add(text);
      controls.push(text);
      if (controls.length >= 40) break;
    }
    const text = (document.body?.innerText ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 3500);
    return { title: norm(document.title), headings, controls, text, path: location.pathname };
  });
}

async function storeShot(env: Env, page: Page, orgId: string, slug: string, route: string, text: string): Promise<{ stored: boolean; changed: boolean }> {
  const row = await first<{ seen_hash: string | null; title: string }>(env.DB, `SELECT seen_hash, title FROM help_articles WHERE org_id = ? AND slug = ?`, orgId, slug);
  if (!row) return { stored: false, changed: false };
  const raw: unknown = await page.screenshot({ type: "jpeg", quality: 65 });
  const bytes = toBytes(raw);
  const key = helpShotKey(orgId, slug);
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  const hash = await sha256(text);
  const changed = Boolean(row.seen_hash) && row.seen_hash !== hash;
  await env.DB.prepare(
    `UPDATE help_articles
     SET shot_key = ?, seen_text = ?, seen_hash = ?,
         route = CASE WHEN route = '' THEN ? ELSE route END,
         needs_rewrite = CASE WHEN ? = 1 THEN 1 ELSE needs_rewrite END,
         updated_at = ?
     WHERE org_id = ? AND slug = ?`,
  )
    .bind(key, text, hash, route, changed ? 1 : 0, now(), orgId, slug)
    .run();
  await logActivity(env, {
    orgId,
    actor: { type: "system", name: "Hjelp" },
    action: "help.capture",
    entityType: "help_article",
    entityId: slug,
    summary: `Tok skjermbilde av «${row.title}»`,
  });
  return { stored: true, changed };
}

async function withBrowser<T>(env: Env, orgId: string, preferUserId: string | null, fn: (page: Page) => Promise<T>): Promise<T> {
  const browserBinding = env.BROWSER;
  const origin = originOf(env);
  if (!browserBinding || !origin) throw new Error("Skjermbilder er ikke slått på");
  const userId = await captureUser(env, orgId, preferUserId);
  if (!userId) throw new Error("Fant ingen bruker å åpne siden som");
  let token: string | undefined;
  let browser: Browser | undefined;
  try {
    token = await createSession(env, userId, "Plank hjelp");
    const guard = isLocalHost(origin.hostname) ? undefined : { guardrails: { allowedDomains: [origin.hostname] } };
    browser = await puppeteer.launch(browserBinding, guard);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.setCookie({
      name: SESSION_COOKIE,
      value: token,
      url: `${origin.origin}/`,
      path: "/",
      httpOnly: true,
      secure: origin.protocol === "https:",
      sameSite: "Lax",
    });
    return await fn(page);
  } finally {
    await browser?.close().catch((err) => console.error("Nettleseren lot seg ikke lukke", err));
    if (token) await destroySession(env, token).catch((err) => console.error("Klarte ikke å slette hjelp-økten", err));
  }
}

async function captureUser(env: Env, orgId: string, prefer: string | null): Promise<string | null> {
  if (prefer) {
    const member = await first<{ user_id: string }>(env.DB, `SELECT user_id FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, prefer);
    if (member) return prefer;
  }
  const owner = await first<{ user_id: string }>(
    env.DB,
    `SELECT user_id FROM memberships WHERE org_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1`,
    orgId,
  );
  return owner?.user_id ?? null;
}

async function slugForPath(env: Env, orgId: string, fullPath: string): Promise<string | null> {
  const route = relativeRoute(orgId, fullPath);
  const row = await first<{ slug: string }>(env.DB, `SELECT slug FROM help_articles WHERE org_id = ? AND route = ?`, orgId, route);
  if (row) return row.slug;
  const seed = HELP_CATALOG.find((item) => item.path === route);
  return seed?.slug ?? null;
}

async function hasUnseen(env: Env, orgId: string): Promise<boolean> {
  const row = await first<{ x: number }>(env.DB, `SELECT 1 AS x FROM help_articles WHERE org_id = ? AND seen_text IS NULL LIMIT 1`, orgId);
  return Boolean(row);
}

async function pendingRewrite(env: Env, orgId: string): Promise<boolean> {
  const row = await first<{ x: number }>(env.DB, `SELECT 1 AS x FROM help_articles WHERE org_id = ? AND needs_rewrite = 1 LIMIT 1`, orgId);
  return Boolean(row);
}

async function wakeHelpAgent(env: Env, orgId: string): Promise<void> {
  const t = now();
  await env.DB.prepare(
    `UPDATE agents SET next_run_at = ? WHERE org_id = ? AND template = ? AND archived = 0 AND schedule IS NOT NULL AND (next_run_at IS NULL OR next_run_at > ?)`,
  )
    .bind(t, orgId, HELP_TEMPLATE, t)
    .run();
}

function originOf(env: Env): URL | null {
  try {
    const url = new URL(env.APP_URL);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isLoginPath(path: string): boolean {
  return path === "/login" || path === "/onboarding" || path === "/venter" || path === "/demo" || path.startsWith("/auth");
}

/** Gjør en sti om til /o/:orgId/..., og avviser alt utenfor organisasjonen. */
export function pagePath(orgId: string, raw: string): string | null {
  let path = raw.trim();
  if (!path || path.length > 300) return null;
  if (path.includes("\\") || path.includes("://") || path.includes("..") || path.includes("\0")) return null;
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  if (!path.startsWith("/")) path = `/${path}`;
  const prefix = `/o/${orgId}`;
  if (path === prefix || path.startsWith(`${prefix}/`)) {
    /* ferdig */
  } else if (path.startsWith("/o/") || path.startsWith("/api") || path.startsWith("/auth") || path.startsWith("/login") || path.startsWith("/admin")) {
    return null;
  } else {
    path = path === "/" ? prefix : `${prefix}${path}`;
  }
  if (path.includes("//")) return null;
  return path;
}

function relativeRoute(orgId: string, fullPath: string): string {
  const prefix = `/o/${orgId}`;
  if (fullPath === prefix || fullPath === `${prefix}/`) return "/";
  if (fullPath.startsWith(`${prefix}/`)) return fullPath.slice(prefix.length);
  return fullPath;
}

function toBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  throw new Error("Skjermbildet kom ikke som bytes");
}
