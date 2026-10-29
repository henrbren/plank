import type { Env } from "../env";
import { assertCanEdit, assertFullScope, scopeSql, sees } from "../lib/access";
import { all, first, insert } from "../lib/db";
import { badRequest, notFound } from "../lib/http";
import { newId, now } from "../lib/util";
import { SIDEBAR_ICONS, type Artifact, type ArtifactVersion, type SidebarIcon, type SidebarPage } from "../../shared/types";

const MAX_HTML = 600_000;
const MAX_SIDEBAR = 12;

/** Sider som ligger i sidemenyen, i rekkefølge */
export async function sidebarPages(env: Env, orgId: string): Promise<SidebarPage[]> {
  const scope = scopeSql({ building: "building_id", property: "property_id" });
  return all<SidebarPage>(
    env.DB,
    `SELECT id, title, sidebar_icon, sidebar_order FROM artifacts WHERE org_id = ? AND sidebar_order IS NOT NULL AND ${scope.sql} ORDER BY sidebar_order, created_at LIMIT ${MAX_SIDEBAR}`,
    orgId,
    ...scope.params,
  );
}

export function sidebarIcon(raw: unknown): SidebarIcon | null {
  return typeof raw === "string" && (SIDEBAR_ICONS as readonly string[]).includes(raw) ? (raw as SidebarIcon) : null;
}

/** Legger siden i sidemenyen (nederst) eller tar den ut. Ikonet beholdes hvis det ikke oppgis. */
export async function setSidebar(env: Env, orgId: string, id: string, opts: { show: boolean; icon?: string | null }): Promise<Artifact> {
  assertCanEdit();
  assertFullScope("Sidemenyen");
  const a = await getArtifact(env, orgId, id);
  if (!opts.show) {
    await env.DB.prepare(`UPDATE artifacts SET sidebar_order = NULL WHERE id = ? AND org_id = ?`).bind(id, orgId).run();
    return getArtifact(env, orgId, id);
  }
  let order = a.sidebar_order;
  if (order == null) {
    const r = await first<{ n: number; max: number | null }>(env.DB, `SELECT COUNT(*) AS n, MAX(sidebar_order) AS max FROM artifacts WHERE org_id = ? AND sidebar_order IS NOT NULL`, orgId);
    if ((r?.n ?? 0) >= MAX_SIDEBAR) throw badRequest(`Sidemenyen har plass til ${MAX_SIDEBAR} sider. Ta ut en side først.`);
    order = (r?.max ?? 0) + 1;
  }
  await env.DB.prepare(`UPDATE artifacts SET sidebar_order = ?, sidebar_icon = COALESCE(?, sidebar_icon) WHERE id = ? AND org_id = ?`)
    .bind(order, sidebarIcon(opts.icon), id, orgId)
    .run();
  return getArtifact(env, orgId, id);
}

/** Flytter en side ett hakk opp eller ned i sidemenyen */
export async function moveSidebar(env: Env, orgId: string, id: string, dir: -1 | 1): Promise<void> {
  assertCanEdit();
  assertFullScope("Sidemenyen");
  const pages = await sidebarPages(env, orgId);
  const i = pages.findIndex((p) => p.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= pages.length) return;
  [pages[i], pages[j]] = [pages[j]!, pages[i]!];
  await env.DB.batch(pages.map((p, n) => env.DB.prepare(`UPDATE artifacts SET sidebar_order = ? WHERE id = ? AND org_id = ?`).bind(n + 1, p.id, orgId)));
}

const SELECT = `SELECT a.*, b.name AS building_name FROM artifacts a LEFT JOIN buildings b ON b.id = a.building_id`;

export async function listArtifacts(env: Env, orgId: string, f: { building_id?: string | null; property_id?: string | null } = {}) {
  const where = ["a.org_id = ?"];
  const params: unknown[] = [orgId];
  if (f.building_id) where.push("a.building_id = ?"), params.push(f.building_id);
  if (f.property_id) where.push("a.property_id = ?"), params.push(f.property_id);
  const scope = scopeSql({ building: "a.building_id", property: "a.property_id" });
  where.push(scope.sql), params.push(...scope.params);
  return all<Artifact>(env.DB, `${SELECT} WHERE ${where.join(" AND ")} ORDER BY a.pinned DESC, a.updated_at DESC LIMIT 300`, ...params);
}

export async function getArtifact(env: Env, orgId: string, id: string): Promise<Artifact> {
  const a = await first<Artifact>(env.DB, `${SELECT} WHERE a.id = ? AND a.org_id = ?`, id, orgId);
  if (!a || !sees(a)) throw notFound("Siden");
  return a;
}

export async function getArtifactHtml(env: Env, orgId: string, id: string, version?: number) {
  const a = await getArtifact(env, orgId, id);
  const v = version ?? a.current_version;
  const row = await first<{ html: string; version: number }>(env.DB, `SELECT html, version FROM artifact_versions WHERE artifact_id = ? AND version = ?`, id, v);
  if (!row) throw notFound("Versjonen");
  return { artifact: a, html: row.html, version: row.version };
}

export async function listVersions(env: Env, orgId: string, id: string): Promise<ArtifactVersion[]> {
  await getArtifact(env, orgId, id);
  return all<ArtifactVersion>(env.DB, `SELECT version, note, created_by, created_at FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC`, id);
}

function checkHtml(html: string) {
  if (!html || html.trim().length < 20) throw badRequest("HTML-en er tom");
  if (html.length > MAX_HTML) throw badRequest("Siden er for stor (maks 600 kB)");
}

export async function createArtifact(
  env: Env,
  orgId: string,
  input: { title: string; description?: string | null; html: string; property_id?: string | null; building_id?: string | null; conversation_id?: string | null },
  actor: { userId?: string | null; agentId?: string | null },
): Promise<Artifact> {
  checkHtml(input.html);
  let propertyId = input.property_id ?? null;
  if (input.building_id) {
    const b = await first<{ property_id: string }>(env.DB, `SELECT property_id FROM buildings WHERE id = ? AND org_id = ?`, input.building_id, orgId);
    if (!b) throw notFound("Bygget");
    propertyId = b.property_id;
  } else if (propertyId) {
    const p = await first(env.DB, `SELECT id FROM properties WHERE id = ? AND org_id = ?`, propertyId, orgId);
    if (!p) throw notFound("Eiendommen");
  }
  assertCanEdit({ property_id: propertyId, building_id: input.building_id ?? null });
  const id = newId("art");
  const t = now();
  const createdBy = actor.agentId ? `agent:${actor.agentId}` : `user:${actor.userId}`;
  await env.DB.batch([
    insert(env.DB, "artifacts", {
      id,
      org_id: orgId,
      title: input.title.slice(0, 200),
      description: input.description?.slice(0, 1000) ?? null,
      property_id: propertyId,
      building_id: input.building_id ?? null,
      current_version: 1,
      pinned: 0,
      created_by_user: actor.userId ?? null,
      created_by_agent: actor.agentId ?? null,
      conversation_id: input.conversation_id ?? null,
      created_at: t,
      updated_at: t,
    }),
    insert(env.DB, "artifact_versions", { artifact_id: id, version: 1, html: input.html, note: "Første versjon", created_by: createdBy, created_at: t }),
  ]);
  return getArtifact(env, orgId, id);
}

export async function saveArtifactVersion(
  env: Env,
  orgId: string,
  id: string,
  input: { html: string; note?: string | null; title?: string | null; description?: string | null },
  actor: { userId?: string | null; agentId?: string | null },
): Promise<Artifact> {
  checkHtml(input.html);
  const a = await getArtifact(env, orgId, id);
  assertCanEdit(a);
  const max = await first<{ v: number }>(env.DB, `SELECT MAX(version) AS v FROM artifact_versions WHERE artifact_id = ?`, id);
  const version = (max?.v ?? a.current_version) + 1;
  const t = now();
  await env.DB.batch([
    insert(env.DB, "artifact_versions", {
      artifact_id: id,
      version,
      html: input.html,
      note: input.note?.slice(0, 500) ?? null,
      created_by: actor.agentId ? `agent:${actor.agentId}` : `user:${actor.userId}`,
      created_at: t,
    }),
    env.DB.prepare(`UPDATE artifacts SET current_version = ?, title = COALESCE(?, title), description = COALESCE(?, description), updated_at = ? WHERE id = ?`).bind(
      version,
      input.title ?? null,
      input.description ?? null,
      t,
      id,
    ),
  ]);
  return getArtifact(env, orgId, id);
}
