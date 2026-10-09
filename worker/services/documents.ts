import { z } from "zod";
import type { Env } from "../env";
import { all, first, update } from "../lib/db";
import { notFound } from "../lib/http";
import { ftsQuery, reindexTitle } from "../lib/documents";
import { optId, optStr } from "../lib/schemas";
import { now } from "../lib/util";
import { DOCUMENT_KINDS, type Document, type SearchHit } from "../../shared/types";
import { resolveLocation } from "./portfolio";

export const documentPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  kind: z.enum(Object.keys(DOCUMENT_KINDS) as [string, ...string[]]).optional(),
  ns3451: optStr(20).optional(),
  summary: optStr(4000).optional(),
  property_id: optId().optional(),
  building_id: optId().optional(),
  floor_id: optId().optional(),
  room_id: optId().optional(),
  component_id: optId().optional(),
});

export interface DocumentFilter {
  property_id?: string | null;
  building_id?: string | null;
  floor_id?: string | null;
  room_id?: string | null;
  component_id?: string | null;
  kind?: string | null;
  q?: string | null;
  limit?: number;
}

const SELECT = `SELECT d.*, b.name AS building_name, p.name AS property_name
  FROM documents d
  LEFT JOIN buildings b ON b.id = d.building_id
  LEFT JOIN properties p ON p.id = d.property_id`;

export async function listDocuments(env: Env, orgId: string, f: DocumentFilter = {}): Promise<Document[]> {
  const where = ["d.org_id = ?"];
  const params: unknown[] = [orgId];
  if (f.property_id) where.push("d.property_id = ?"), params.push(f.property_id);
  if (f.building_id) where.push("d.building_id = ?"), params.push(f.building_id);
  if (f.floor_id) where.push("d.floor_id = ?"), params.push(f.floor_id);
  if (f.room_id) where.push("d.room_id = ?"), params.push(f.room_id);
  if (f.component_id) where.push("d.component_id = ?"), params.push(f.component_id);
  if (f.kind) where.push("d.kind = ?"), params.push(f.kind);
  if (f.q) where.push("(d.title LIKE ? OR d.filename LIKE ?)"), params.push(`%${f.q}%`, `%${f.q}%`);
  const limit = Math.min(Math.max(f.limit ?? 500, 1), 1000);
  return all<Document>(env.DB, `${SELECT} WHERE ${where.join(" AND ")} ORDER BY d.created_at DESC LIMIT ${limit}`, ...params);
}

export async function getDocument(env: Env, orgId: string, id: string): Promise<Document & { r2_key: string }> {
  const d = await first<Document & { r2_key: string }>(env.DB, `${SELECT} WHERE d.id = ? AND d.org_id = ?`, id, orgId);
  if (!d) throw notFound("Dokumentet");
  return d;
}

export async function updateDocument(env: Env, orgId: string, id: string, patch: z.infer<typeof documentPatchSchema>): Promise<Document> {
  const existing = await getDocument(env, orgId, id);
  const next: Record<string, unknown> = { ...patch, updated_at: now() };
  const locKeys = ["property_id", "building_id", "floor_id", "room_id"] as const;
  if (locKeys.some((k) => k in patch)) {
    const loc = await resolveLocation(env, orgId, {
      property_id: patch.property_id !== undefined ? patch.property_id : existing.property_id,
      building_id: patch.building_id !== undefined ? patch.building_id : patch.property_id !== undefined ? null : existing.building_id,
      floor_id: patch.floor_id !== undefined ? patch.floor_id : patch.building_id !== undefined || patch.property_id !== undefined ? null : existing.floor_id,
      room_id: patch.room_id !== undefined ? patch.room_id : locKeys.slice(0, 3).some((k) => patch[k] !== undefined) ? null : existing.room_id,
    });
    Object.assign(next, loc);
  }
  if (patch.component_id) {
    const c = await first(env.DB, `SELECT id FROM components WHERE id = ? AND org_id = ?`, patch.component_id, orgId);
    if (!c) throw notFound("Komponenten");
  }
  const stmt = update(
    env.DB,
    "documents",
    next,
    ["title", "kind", "ns3451", "summary", "property_id", "building_id", "floor_id", "room_id", "component_id", "updated_at"],
    { sql: "id = ? AND org_id = ?", params: [id, orgId] },
  );
  if (stmt) await stmt.run();
  if (patch.title && patch.title !== existing.title) await reindexTitle(env, id, patch.title);
  return getDocument(env, orgId, id);
}

export async function deleteDocument(env: Env, orgId: string, id: string) {
  const d = await getDocument(env, orgId, id);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM document_chunks_fts WHERE document_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM documents WHERE id = ? AND org_id = ?`).bind(id, orgId),
  ]);
  await env.FILES.delete(d.r2_key);
}

/** Fulltekstsøk i dokumenter. Prøver AND først, deretter OR. */
export async function searchDocuments(
  env: Env,
  orgId: string,
  q: string,
  f: { building_id?: string | null; property_id?: string | null; kind?: string | null; limit?: number } = {},
): Promise<SearchHit[]> {
  const base = ftsQuery(q);
  if (!base) return [];
  const limit = Math.min(Math.max(f.limit ?? 12, 1), 50);
  const run = async (match: string) => {
    const where = ["document_chunks_fts MATCH ?", "fts.org_id = ?"];
    const params: unknown[] = [match, orgId];
    if (f.building_id) where.push("d.building_id = ?"), params.push(f.building_id);
    if (f.property_id) where.push("d.property_id = ?"), params.push(f.property_id);
    if (f.kind) where.push("d.kind = ?"), params.push(f.kind);
    // Hent flere treff enn grensen og slå sammen per dokument
    const rows = await all<SearchHit & { rank: number }>(
      env.DB,
      `SELECT fts.document_id AS document_id, d.title AS title, d.kind AS kind, d.building_id AS building_id, b.name AS building_name,
              snippet(document_chunks_fts, 0, '«', '»', ' … ', 24) AS snippet, rank
       FROM document_chunks_fts fts
       JOIN documents d ON d.id = fts.document_id
       LEFT JOIN buildings b ON b.id = d.building_id
       WHERE ${where.join(" AND ")}
       ORDER BY rank LIMIT ${limit * 4}`,
      ...params,
    );
    const seen = new Map<string, SearchHit>();
    for (const r of rows) {
      const existing = seen.get(r.document_id);
      if (!existing) seen.set(r.document_id, { document_id: r.document_id, title: r.title, kind: r.kind, building_id: r.building_id, building_name: r.building_name, snippet: r.snippet });
      else if (existing.snippet.length < 600) existing.snippet += "\n" + r.snippet;
      if (seen.size >= limit) break;
    }
    return [...seen.values()];
  };
  const hits = await run(base);
  if (hits.length > 0 || !base.includes(" ")) return hits;
  return run(base.split(" ").join(" OR "));
}

/** Leser uttrukket tekst i sider (for agenter) */
export async function readDocumentText(env: Env, orgId: string, id: string, offset = 0, maxChars = 12000) {
  const doc = await getDocument(env, orgId, id);
  const row = await first<{ content: string }>(env.DB, `SELECT content FROM document_text WHERE document_id = ?`, id);
  const text = row?.content ?? "";
  const start = Math.max(0, offset);
  const slice = text.slice(start, start + Math.min(Math.max(maxChars, 500), 40000));
  return {
    document: doc,
    total_chars: text.length,
    offset: start,
    text: slice,
    has_more: start + slice.length < text.length,
    next_offset: start + slice.length < text.length ? start + slice.length : null,
  };
}
