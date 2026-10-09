import type { Env } from "../env";
import { all, first, insert } from "../lib/db";
import { badRequest, notFound } from "../lib/http";
import { newId, now } from "../lib/util";
import type { Artifact, ArtifactVersion } from "../../shared/types";

const MAX_HTML = 600_000;

const SELECT = `SELECT a.*, b.name AS building_name FROM artifacts a LEFT JOIN buildings b ON b.id = a.building_id`;

export async function listArtifacts(env: Env, orgId: string, f: { building_id?: string | null; property_id?: string | null } = {}) {
  const where = ["a.org_id = ?"];
  const params: unknown[] = [orgId];
  if (f.building_id) where.push("a.building_id = ?"), params.push(f.building_id);
  if (f.property_id) where.push("a.property_id = ?"), params.push(f.property_id);
  return all<Artifact>(env.DB, `${SELECT} WHERE ${where.join(" AND ")} ORDER BY a.pinned DESC, a.updated_at DESC LIMIT 300`, ...params);
}

export async function getArtifact(env: Env, orgId: string, id: string): Promise<Artifact> {
  const a = await first<Artifact>(env.DB, `${SELECT} WHERE a.id = ? AND a.org_id = ?`, id, orgId);
  if (!a) throw notFound("Siden");
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
