import { z } from "zod";
import type { Env } from "../env";
import { all, first, update } from "../lib/db";
import { notFound } from "../lib/http";
import { ensurePreviewMime, ftsQuery, reindexTitle, stripConverterMetadata } from "../lib/documents";
import { parseStoredExtract } from "../lib/extract";
import { optId, optStr } from "../lib/schemas";
import { now } from "../lib/util";
import { DOCUMENT_KINDS, type Document, type DocumentBrief, type DocumentPlace, type SearchHit } from "../../shared/types";
import { assertCanEdit, scopeSql, sees } from "../lib/access";
import { resolveWritableLocation } from "./portfolio";

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
  /** Bare dokumenter som ikke ligger på en eiendom eller et bygg */
  unplaced?: boolean;
  /** Med building_id: ta også med dokumenter på samme eiendom som ikke er lagt på et bygg */
  includeProperty?: boolean;
  limit?: number;
}

function documentFilter(orgId: string, f: DocumentFilter, max = 1000): { where: string; params: unknown[]; limit: number } {
  const where = ["d.org_id = ?"];
  const params: unknown[] = [orgId];
  if (f.unplaced) where.push("d.property_id IS NULL AND d.building_id IS NULL");
  else {
    if (f.property_id) where.push("d.property_id = ?"), params.push(f.property_id);
    if (f.building_id && f.includeProperty) {
      where.push("(d.building_id = ? OR (d.building_id IS NULL AND d.property_id = (SELECT property_id FROM buildings WHERE id = ? AND org_id = ?)))");
      params.push(f.building_id, f.building_id, orgId);
    } else if (f.building_id) where.push("d.building_id = ?"), params.push(f.building_id);
  }
  if (f.floor_id) where.push("d.floor_id = ?"), params.push(f.floor_id);
  if (f.room_id) where.push("d.room_id = ?"), params.push(f.room_id);
  if (f.component_id) where.push("d.component_id = ?"), params.push(f.component_id);
  if (f.kind) where.push("d.kind = ?"), params.push(f.kind);
  if (f.q) where.push("(d.title LIKE ? OR d.filename LIKE ? OR d.extracted LIKE ?)"), params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
  const scope = scopeSql({ building: "d.building_id", property: "d.property_id" });
  where.push(scope.sql), params.push(...scope.params);
  const requested = Number(f.limit);
  const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 500, 1), max);
  return { where: where.join(" AND "), params, limit };
}

const SELECT = `SELECT d.*, b.name AS building_name, p.name AS property_name
  FROM documents d
  LEFT JOIN buildings b ON b.id = d.building_id
  LEFT JOIN properties p ON p.id = d.property_id`;

export async function listDocuments(env: Env, orgId: string, f: DocumentFilter = {}): Promise<Document[]> {
  const { where, params, limit } = documentFilter(orgId, f);
  const rows = await all<Document & { extracted: string | null }>(env.DB, `${SELECT} WHERE ${where} ORDER BY d.created_at DESC LIMIT ${limit}`, ...params);
  return rows.map(presentDocument);
}

const TEXT_HEAD = 5000;
const TEXT_TAIL = 2000;
const TEXT_LIMIT = 500;

/** Utdrag av dokumenttekst til sider som leter etter firmanavn. Starten og slutten, ikke hele filen. */
export async function listDocumentTexts(env: Env, orgId: string): Promise<{ id: string; text: string }[]> {
  const scope = scopeSql({ building: "d.building_id", property: "d.property_id" });
  const rows = await all<{ id: string; text: string | null }>(
    env.DB,
    `SELECT d.id AS id,
            CASE
              WHEN t.content IS NULL OR t.content = '' THEN NULL
              WHEN length(t.content) <= ${TEXT_HEAD + TEXT_TAIL} THEN t.content
              ELSE substr(t.content, 1, ${TEXT_HEAD}) || char(10) || '…' || char(10) || substr(t.content, -${TEXT_TAIL})
            END AS text
     FROM documents d
     LEFT JOIN document_text t ON t.document_id = d.id
     WHERE d.org_id = ? AND ${scope.sql}
     ORDER BY d.created_at DESC
     LIMIT ${TEXT_LIMIT}`,
    orgId,
    ...scope.params,
  );
  const out: { id: string; text: string }[] = [];
  for (const row of rows) {
    const text = stripConverterMetadata(row.text ?? "").trim();
    if (text) out.push({ id: row.id, text });
  }
  return out;
}

/** Tittel og dato til listen under et kort. Uten uttrukket tekst. Tar også med filer som er listet, men ikke kopiert inn ennå. */
export async function listDocumentBriefs(env: Env, orgId: string, f: DocumentFilter = {}): Promise<DocumentBrief[]> {
  const { where, params, limit } = documentFilter(orgId, f, 5000);
  const rows = await all<DocumentBrief>(
    env.DB,
    `SELECT d.id, d.property_id, d.building_id, d.title, d.filename, d.mime, d.kind, d.status, d.created_at, b.name AS building_name
     FROM documents d
     LEFT JOIN buildings b ON b.id = d.building_id
     WHERE ${where} ORDER BY d.created_at DESC LIMIT ${limit}`,
    ...params,
  );
  if (f.q || f.kind || f.floor_id || f.room_id || f.component_id || f.unplaced) return rows;
  const incoming = await incomingBriefs(env, orgId, { buildingId: f.building_id ?? null, propertyId: f.property_id ?? null });
  return [...rows, ...incoming].slice(0, limit);
}

/** Boligmappa-rader som hører til et bygg, før filen ligger i arkivet. */
async function incomingBriefs(
  env: Env,
  orgId: string,
  filter: { buildingId: string | null; propertyId: string | null },
): Promise<DocumentBrief[]> {
  const buildings = await all<{ id: string; property_id: string; name: string; boligmappa_number: string | null; building_number: string | null }>(
    env.DB,
    `SELECT id, property_id, name, boligmappa_number, building_number FROM buildings WHERE org_id = ?`,
    orgId,
  );
  const visible = buildings.filter((b) => sees({ building_id: b.id, property_id: b.property_id }));
  const wanted = visible.filter((b) => {
    if (filter.buildingId && b.id !== filter.buildingId) return false;
    if (filter.propertyId && b.property_id !== filter.propertyId) return false;
    return true;
  });
  if (wanted.length === 0) return [];
  const byBmn = new Map<string, (typeof wanted)[number]>();
  for (const b of wanted) if (b.boligmappa_number) byBmn.set(b.boligmappa_number, b);
  const units = await all<{ bmn: string; building_bmn: string | null; building_number: string | null }>(
    env.DB,
    `SELECT bmn, building_bmn, building_number FROM bm_units WHERE org_id = ?`,
    orgId,
  );
  const byNumber = new Map<string, (typeof wanted)[number]>();
  for (const b of wanted) if (b.building_number && !byNumber.has(b.building_number)) byNumber.set(b.building_number, b);
  const unitBuilding = new Map<string, (typeof wanted)[number]>();
  for (const u of units) {
    const parent = (u.building_bmn ? byBmn.get(u.building_bmn) : undefined) ?? (u.building_number ? byNumber.get(u.building_number) : undefined);
    if (parent) unitBuilding.set(u.bmn, parent);
  }
  const docs = await all<{ remote_id: string; title: string; filename: string | null; owner_kind: string; owner_bmn: string }>(
    env.DB,
    `SELECT remote_id, title, filename, owner_kind, owner_bmn FROM bm_documents
     WHERE org_id = ? AND imported_document_id IS NULL AND error IS NULL
     ORDER BY title LIMIT 2000`,
    orgId,
  );
  const out: DocumentBrief[] = [];
  for (const doc of docs) {
    const building = doc.owner_kind === "unit" ? unitBuilding.get(doc.owner_bmn) : byBmn.get(doc.owner_bmn);
    if (!building) continue;
    out.push({
      id: `bm:${doc.remote_id}`,
      property_id: building.property_id,
      building_id: building.id,
      title: doc.title,
      filename: doc.filename || doc.title,
      mime: "",
      kind: "annet",
      status: "processing",
      created_at: 0,
      building_name: building.name,
      incoming: true,
    });
  }
  return out;
}

function addressLine(street: string | null | undefined, postal: string | null | undefined, city: string | null | undefined): string | null {
  const road = street?.trim() || "";
  if (road.includes(",")) return road;
  const post = [postal?.trim(), city?.trim()].filter(Boolean).join(" ");
  const line = [road, post].filter(Boolean).join(", ");
  return line || null;
}

function propertyNumber(row: { boligmappa_key: string | null; gnr: string | null; bnr: string | null }): string | null {
  const key = row.boligmappa_key?.trim() || "";
  if (key.startsWith("bmn:")) return key.slice(4).trim() || null;
  if (key.startsWith("adr:")) return null;
  const fromKey = key.startsWith("mat:") ? key.split(":") : [];
  const gnr = row.gnr?.trim() || fromKey[2] || "";
  const bnr = row.bnr?.trim() || fromKey[3] || "";
  const cadastre = [gnr && `gnr ${gnr}`, bnr && `bnr ${bnr}`].filter(Boolean).join(" / ");
  if (cadastre) return cadastre;
  if (key.startsWith("mat:") || key.startsWith("adr:")) return null;
  return key || null;
}

/** Oversikt som på vis-siden: ett kort per eiendom og bygg, med antall dokumenter. */
export async function documentCatalog(env: Env, orgId: string): Promise<DocumentPlace[]> {
  const props = scopeSql({ property: "p.id" });
  const blds = scopeSql({ building: "b.id" });
  const docs = scopeSql({ building: "d.building_id", property: "d.property_id" });
  const [properties, buildings, counts, pending, units] = await Promise.all([
    all<{ id: string; name: string; address: string | null; postal_code: string | null; city: string | null; gnr: string | null; bnr: string | null; boligmappa_key: string | null }>(
      env.DB,
      `SELECT p.id, p.name, p.address, p.postal_code, p.city, p.gnr, p.bnr, p.boligmappa_key
       FROM properties p WHERE p.org_id = ? AND ${props.sql} ORDER BY p.name`,
      orgId,
      ...props.params,
    ),
    all<{
      id: string;
      property_id: string;
      name: string;
      building_number: string | null;
      boligmappa_number: string | null;
      bm_address: string | null;
      bm_postal: string | null;
      bm_city: string | null;
      docs_fetched_at: number | null;
      has_bm: number;
      p_address: string | null;
      p_postal: string | null;
      p_city: string | null;
    }>(
      env.DB,
      `SELECT b.id, b.property_id, b.name, b.building_number, b.boligmappa_number,
              bm.address AS bm_address, bm.postal_code AS bm_postal, bm.city AS bm_city, bm.docs_fetched_at,
              bm.org_id IS NOT NULL AS has_bm,
              p.address AS p_address, p.postal_code AS p_postal, p.city AS p_city
       FROM buildings b
       JOIN properties p ON p.id = b.property_id AND p.org_id = b.org_id
       LEFT JOIN bm_buildings bm ON bm.org_id = b.org_id AND bm.bmn = b.boligmappa_number
       WHERE b.org_id = ? AND ${blds.sql}`,
      orgId,
      ...blds.params,
    ),
    all<{ property_id: string | null; building_id: string | null; n: number }>(
      env.DB,
      `SELECT d.property_id, d.building_id, COUNT(*) AS n
       FROM documents d WHERE d.org_id = ? AND ${docs.sql}
       GROUP BY d.property_id, d.building_id`,
      orgId,
      ...docs.params,
    ),
    all<{ owner_kind: string; owner_bmn: string; n: number }>(
      env.DB,
      `SELECT owner_kind, owner_bmn, COUNT(*) AS n FROM bm_documents
       WHERE org_id = ? AND imported_document_id IS NULL AND error IS NULL
       GROUP BY owner_kind, owner_bmn`,
      orgId,
    ),
    all<{ bmn: string; building_bmn: string | null; building_number: string | null }>(
      env.DB,
      `SELECT bmn, building_bmn, building_number FROM bm_units WHERE org_id = ?`,
      orgId,
    ),
  ]);

  const byBuilding = new Map<string, number>();
  const byProperty = new Map<string, number>();
  const sharedByProperty = new Map<string, number>();
  let loose = 0;
  for (const row of counts) {
    const n = Number(row.n) || 0;
    if (row.building_id) byBuilding.set(row.building_id, (byBuilding.get(row.building_id) ?? 0) + n);
    if (row.property_id) byProperty.set(row.property_id, (byProperty.get(row.property_id) ?? 0) + n);
    if (row.property_id && !row.building_id) sharedByProperty.set(row.property_id, (sharedByProperty.get(row.property_id) ?? 0) + n);
    if (!row.property_id && !row.building_id) loose += n;
  }
  const pendingOnBuilding = new Map<string, number>();
  const idByBmn = new Map<string, string>();
  const idByNumber = new Map<string, string>();
  for (const b of buildings) {
    if (b.boligmappa_number) idByBmn.set(b.boligmappa_number, b.id);
    if (b.building_number && !idByNumber.has(b.building_number)) idByNumber.set(b.building_number, b.id);
  }
  const addPending = (id: string | undefined, n: number) => {
    if (!id || n <= 0) return;
    pendingOnBuilding.set(id, (pendingOnBuilding.get(id) ?? 0) + n);
  };
  const unitParent = new Map<string, string>();
  for (const u of units) {
    const id = (u.building_bmn ? idByBmn.get(u.building_bmn) : undefined) ?? (u.building_number ? idByNumber.get(u.building_number) : undefined);
    if (id) unitParent.set(u.bmn, id);
  }
  for (const row of pending) {
    const n = Number(row.n) || 0;
    if (row.owner_kind === "unit") addPending(unitParent.get(row.owner_bmn), n);
    else addPending(idByBmn.get(row.owner_bmn), n);
  }
  const pendingOnProperty = new Map<string, number>();
  for (const b of buildings) {
    const n = pendingOnBuilding.get(b.id) ?? 0;
    if (n > 0) pendingOnProperty.set(b.property_id, (pendingOnProperty.get(b.property_id) ?? 0) + n);
  }

  const buildingPlaces: DocumentPlace[] = buildings.map((b) => {
    const pendingCount = pendingOnBuilding.get(b.id) ?? 0;
    const count = (byBuilding.get(b.id) ?? 0) + (sharedByProperty.get(b.property_id) ?? 0) + pendingCount;
    const bmn = b.boligmappa_number?.trim() || null;
    const stillFetching = Boolean(b.has_bm) && b.docs_fetched_at == null;
    const stillImporting = pendingCount > 0;
    const address = addressLine(b.bm_address, b.bm_postal, b.bm_city) ?? addressLine(b.p_address, b.p_postal, b.p_city);
    return {
      kind: "building",
      id: b.id,
      property_id: b.property_id,
      name: b.name?.trim() || "Bygg",
      address: address && address.localeCompare(b.name?.trim() || "", "nb", { sensitivity: "accent" }) !== 0 ? address : null,
      number: bmn || b.building_number?.trim() || null,
      document_count: count,
      files_ready: !(stillFetching || stillImporting),
    };
  });
  const waitingProperties = new Set(buildingPlaces.filter((b) => !b.files_ready && b.property_id).map((b) => b.property_id as string));

  const items: DocumentPlace[] = [
    ...buildingPlaces,
    ...properties.map((p): DocumentPlace => {
      const count = (byProperty.get(p.id) ?? 0) + (pendingOnProperty.get(p.id) ?? 0);
      const address = addressLine(p.address, p.postal_code, p.city);
      return {
        kind: "property",
        id: p.id,
        property_id: p.id,
        name: p.name?.trim() || "Eiendom",
        address: address && address.localeCompare(p.name?.trim() || "", "nb", { sensitivity: "accent" }) !== 0 ? address : null,
        number: propertyNumber(p),
        document_count: count,
        files_ready: !waitingProperties.has(p.id),
      };
    }),
  ];
  if (loose > 0) {
    items.push({
      kind: "loose",
      id: "loose",
      property_id: null,
      name: "Uten plassering",
      address: "Dokumenter som ikke ligger på en eiendom eller et bygg",
      number: null,
      document_count: loose,
      files_ready: true,
    });
  }
  const rank = (kind: DocumentPlace["kind"]) => (kind === "building" ? 0 : kind === "property" ? 1 : 2);
  items.sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name, "nb"));
  return items;
}

function presentDocument<T extends { extracted: string | Document["extracted"] | null }>(row: T): T {
  if (typeof row.extracted !== "string") return row;
  return { ...row, extracted: parseStoredExtract(row.extracted) };
}

export async function getDocument(env: Env, orgId: string, id: string): Promise<Document & { r2_key: string }> {
  const d = await first<Document & { r2_key: string; extracted: string | null }>(env.DB, `${SELECT} WHERE d.id = ? AND d.org_id = ?`, id, orgId);
  if (!d || !sees(d)) throw notFound("Dokumentet");
  d.mime = await ensurePreviewMime(env, d);
  return presentDocument(d);
}

export async function updateDocument(env: Env, orgId: string, id: string, patch: z.infer<typeof documentPatchSchema>): Promise<Document> {
  const existing = await getDocument(env, orgId, id);
  assertCanEdit(existing);
  const next: Record<string, unknown> = { ...patch, updated_at: now() };
  const locKeys = ["property_id", "building_id", "floor_id", "room_id"] as const;
  if (locKeys.some((k) => k in patch)) {
    const loc = await resolveWritableLocation(env, orgId, {
      property_id: patch.property_id !== undefined ? patch.property_id : existing.property_id,
      building_id: patch.building_id !== undefined ? patch.building_id : patch.property_id !== undefined ? null : existing.building_id,
      floor_id: patch.floor_id !== undefined ? patch.floor_id : patch.building_id !== undefined || patch.property_id !== undefined ? null : existing.floor_id,
      room_id: patch.room_id !== undefined ? patch.room_id : locKeys.slice(0, 3).some((k) => patch[k] !== undefined) ? null : existing.room_id,
    });
    Object.assign(next, loc);
  }
  if (patch.component_id) {
    const c = await first<{ building_id: string | null }>(env.DB, `SELECT building_id FROM components WHERE id = ? AND org_id = ?`, patch.component_id, orgId);
    if (!c || !sees(c)) throw notFound("Komponenten");
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
  assertCanEdit(d);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM document_chunks_fts WHERE document_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM document_text WHERE document_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM ifc_elements WHERE document_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM ifc_models WHERE document_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM documents WHERE id = ? AND org_id = ?`).bind(id, orgId),
  ]);
  await env.FILES.delete(d.r2_key);
  return d;
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
    const scope = scopeSql({ building: "d.building_id", property: "d.property_id" });
    where.push(scope.sql), params.push(...scope.params);
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
  const found = hits.length > 0 || !base.includes(" ") ? hits : await run(base.split(" ").join(" OR "));
  const needle = q.replace(/[%_]/g, "").trim();
  if (needle.length < 2) return found;
  const where = ["d.org_id = ?", "d.extracted LIKE ?"];
  const params: unknown[] = [orgId, `%${needle}%`];
  if (f.building_id) where.push("d.building_id = ?"), params.push(f.building_id);
  if (f.property_id) where.push("d.property_id = ?"), params.push(f.property_id);
  if (f.kind) where.push("d.kind = ?"), params.push(f.kind);
  const scope = scopeSql({ building: "d.building_id", property: "d.property_id" });
  where.push(scope.sql), params.push(...scope.params);
  const meta = await all<{ id: string; title: string; kind: Document["kind"]; building_id: string | null; building_name: string | null; extracted: string | null }>(
    env.DB,
    `SELECT d.id, d.title, d.kind, d.building_id, b.name AS building_name, d.extracted
     FROM documents d LEFT JOIN buildings b ON b.id = d.building_id
     WHERE ${where.join(" AND ")} ORDER BY d.updated_at DESC LIMIT ${limit}`,
    ...params,
  );
  const seen = new Set(found.map((h) => h.document_id));
  for (const row of meta) {
    if (seen.has(row.id) || found.length >= limit) continue;
    const extract = parseStoredExtract(row.extracted);
    const snippet = [extract?.supplier && `Leverandør: ${extract.supplier}`, extract?.component && `Anlegg: ${extract.component}`].filter(Boolean).join(" · ");
    if (!snippet) continue;
    found.push({ document_id: row.id, title: row.title, kind: row.kind, building_id: row.building_id, building_name: row.building_name, snippet });
    seen.add(row.id);
  }
  return found;
}

/** Leser uttrukket tekst i sider (for agenter) */
export async function readDocumentText(env: Env, orgId: string, id: string, offset = 0, maxChars = 12000) {
  const doc = await getDocument(env, orgId, id);
  const row = await first<{ content: string }>(env.DB, `SELECT content FROM document_text WHERE document_id = ?`, id);
  const text = stripConverterMetadata(row?.content ?? "");
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
