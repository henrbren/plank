import { Hono } from "hono";
import type { AppEnv } from "../env";
import { logActivity } from "../lib/activity";
import { first, insert } from "../lib/db";
import { guessMime, INLINE_SAFE_MIME, isIfc, processDocument } from "../lib/documents";
import { ApiError, badRequest, body } from "../lib/http";
import { newId, now } from "../lib/util";
import { DOCUMENT_KINDS } from "../../shared/types";
import { deleteDocument, documentPatchSchema, getDocument, listDocuments, readDocumentText, searchDocuments, updateDocument } from "../services/documents";
import { resolveLocation } from "../services/portfolio";

const MAX_UPLOAD = 95 * 1024 * 1024;

export const documents = new Hono<AppEnv>();

documents.get("/", async (c) => {
  const q = c.req.query();
  return c.json(
    await listDocuments(c.env, c.get("orgId"), {
      property_id: q.property_id,
      building_id: q.building_id,
      floor_id: q.floor_id,
      room_id: q.room_id,
      component_id: q.component_id,
      kind: q.kind,
      q: q.q,
    }),
  );
});

documents.get("/search", async (c) => {
  const q = c.req.query("q") ?? "";
  return c.json(await searchDocuments(c.env, c.get("orgId"), q, { building_id: c.req.query("building_id"), limit: 20 }));
});

documents.post("/", async (c) => {
  const orgId = c.get("orgId");
  const user = c.get("user");
  const form = await c.req.formData().catch(() => null);
  if (!form) throw badRequest("Forventet multipart/form-data");
  const file = form.get("file");
  if (!file || typeof file === "string") throw badRequest("Mangler fil");
  if (file.size === 0) throw badRequest("Filen er tom");
  if (file.size > MAX_UPLOAD) throw new ApiError(413, "Filen er for stor (maks 95 MB)");

  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const loc = await resolveLocation(c.env, orgId, {
    property_id: str("property_id"),
    building_id: str("building_id"),
    floor_id: str("floor_id"),
    room_id: str("room_id"),
  });
  const componentId = str("component_id");
  if (componentId) {
    const comp = await first(c.env.DB, `SELECT id FROM components WHERE id = ? AND org_id = ?`, componentId, orgId);
    if (!comp) throw badRequest("Ukjent komponent");
  }
  const kindInput = str("kind");
  const filename = file.name.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 180) || "fil";
  const kind = isIfc(filename) ? "ifc" : kindInput && kindInput in DOCUMENT_KINDS ? kindInput : "annet";
  const mime = guessMime(filename);
  const id = newId("doc");
  const key = `orgs/${orgId}/documents/${id}/${filename}`;

  // R2 krever kjent lengde på strømmer
  const { readable, writable } = new FixedLengthStream(file.size);
  const pipe = file.stream().pipeTo(writable);
  await c.env.FILES.put(key, readable, { httpMetadata: { contentType: mime } });
  await pipe;
  const t = now();
  await insert(c.env.DB, "documents", {
    id,
    org_id: orgId,
    ...loc,
    component_id: componentId,
    title: (str("title") ?? filename.replace(/\.[^.]+$/, "")).slice(0, 200),
    filename,
    mime,
    size: file.size,
    r2_key: key,
    kind,
    ns3451: str("ns3451"),
    status: "processing",
    uploaded_by: user.id,
    created_at: t,
    updated_at: t,
  }).run();

  c.executionCtx.waitUntil(processDocument(c.env, id));
  await logActivity(c.env, {
    orgId,
    actor: { type: "user", id: user.id, name: user.name ?? user.email },
    action: "document.uploaded",
    entityType: "document",
    entityId: id,
    summary: `Lastet opp ${filename}`,
  });
  return c.json(await getDocument(c.env, orgId, id), 201);
});

documents.get("/:id", async (c) => {
  const d = await getDocument(c.env, c.get("orgId"), c.req.param("id"));
  const { r2_key: _k, ...rest } = d;
  return c.json(rest);
});

documents.get("/:id/text", async (c) => {
  const offset = Number(c.req.query("offset") ?? 0);
  const res = await readDocumentText(c.env, c.get("orgId"), c.req.param("id"), offset, 200_000);
  return c.json({ text: res.text, total_chars: res.total_chars, has_more: res.has_more });
});

documents.get("/:id/file", async (c) => {
  const d = await getDocument(c.env, c.get("orgId"), c.req.param("id"));
  const obj = await c.env.FILES.get(d.r2_key);
  if (!obj) throw new ApiError(404, "Filen finnes ikke i lagringen");
  // Bare et fast sett med trygge typer vises inline – alt annet lastes ned
  const inline = INLINE_SAFE_MIME.has(d.mime) && c.req.query("download") !== "1";
  const headers = new Headers({
    "Content-Type": inline ? d.mime : "application/octet-stream",
    "Content-Length": String(obj.size),
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(d.filename)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=300",
  });
  // Chrome sin PDF-visning fungerer ikke i sandkasse; PDF kan uansett ikke kjøre skript på vårt domene
  if (d.mime !== "application/pdf" || !inline) headers.set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
  return new Response(obj.body, { headers });
});

documents.patch("/:id", async (c) => c.json(await updateDocument(c.env, c.get("orgId"), c.req.param("id"), await body(c, documentPatchSchema))));

documents.post("/:id/reprocess", async (c) => {
  const d = await getDocument(c.env, c.get("orgId"), c.req.param("id"));
  await c.env.DB.prepare(`UPDATE documents SET status = 'processing', error = NULL, updated_at = ? WHERE id = ?`).bind(now(), d.id).run();
  c.executionCtx.waitUntil(processDocument(c.env, d.id));
  return c.json({ ok: true });
});

documents.delete("/:id", async (c) => {
  await deleteDocument(c.env, c.get("orgId"), c.req.param("id"));
  return c.json({ ok: true });
});

// ─── Globalt søk (kommandopalett) ───────────────────────────────────────────

export const search = new Hono<AppEnv>();

search.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const orgId = c.get("orgId");
  if (q.length < 2) return c.json({ documents: [], entities: [] });
  const like = `%${q}%`;
  const db = c.env.DB;
  // D1 begrenser antall ledd i UNION – kjør hver type som egen spørring i én batch
  const queries = [
    db.prepare(`SELECT 'property' AS type, id, name AS label, city AS sub FROM properties WHERE org_id = ?1 AND (name LIKE ?2 OR address LIKE ?2) LIMIT 5`),
    db.prepare(`SELECT 'building' AS type, b.id, b.name AS label, p.name AS sub FROM buildings b JOIN properties p ON p.id = b.property_id WHERE b.org_id = ?1 AND b.name LIKE ?2 LIMIT 5`),
    db.prepare(
      `SELECT 'room' AS type, r.id, COALESCE(r.number || ' ', '') || r.name AS label, b.name AS sub FROM rooms r JOIN buildings b ON b.id = r.building_id WHERE r.org_id = ?1 AND (r.name LIKE ?2 OR r.number LIKE ?2) LIMIT 5`,
    ),
    db.prepare(`SELECT 'component' AS type, id, name AS label, tfm AS sub FROM components WHERE org_id = ?1 AND (name LIKE ?2 OR tfm LIKE ?2 OR manufacturer LIKE ?2) LIMIT 5`),
    db.prepare(`SELECT 'task' AS type, id, title AS label, status AS sub FROM tasks WHERE org_id = ?1 AND title LIKE ?2 LIMIT 5`),
    db.prepare(`SELECT 'artifact' AS type, id, title AS label, description AS sub FROM artifacts WHERE org_id = ?1 AND title LIKE ?2 LIMIT 5`),
  ].map((st) => st.bind(orgId, like));
  const [docs, results] = await Promise.all([searchDocuments(c.env, orgId, q, { limit: 8 }), db.batch<{ type: string; id: string; label: string; sub: string | null }>(queries)]);
  const entities = results.flatMap((r) => r.results ?? []);
  return c.json({ documents: docs, entities });
});
