import type { Env } from "../env";
import supplierPageHtml from "../../src/features/artifacts/supplier-page.html";
import { BRANDS, type BrandId } from "../../shared/brand";
import { logActivity } from "../lib/activity";
import { emailFrom } from "../lib/brand";
import { all, first, insert } from "../lib/db";
import { emailConfigured, sendEmail, supplierFoundEmail } from "../lib/email";
import { newId, now } from "../lib/util";
import { setSidebar } from "./artifacts";

const TEMPLATE = "leverandorer";
const TITLE = "Leverandører";
const LOOSE = "Dokumenter uten plassering";

interface AreaRow {
  property_id: string;
  name: string | null;
  processing: number;
  suppliers: number;
}

function brandFromId(id: string | null) {
  if (id === "naeringsmappa" || id === "sameie") return BRANDS[id as BrandId];
  return BRANDS.plank;
}

/** Oppretter siden én gang og legger den i sidemenyen. Finnes den fra før, brukes den. */
export async function ensureSupplierPage(env: Env, orgId: string): Promise<{ id: string; title: string }> {
  const existing = await first<{ id: string; title: string }>(
    env.DB,
    `SELECT id, title FROM artifacts WHERE org_id = ? AND template = ?`,
    orgId,
    TEMPLATE,
  );
  if (existing) {
    await pin(env, orgId, existing.id);
    return existing;
  }
  const named = await first<{ id: string; title: string }>(
    env.DB,
    `SELECT id, title FROM artifacts WHERE org_id = ? AND title = ? ORDER BY created_at LIMIT 1`,
    orgId,
    TITLE,
  );
  if (named) {
    await env.DB.prepare(`UPDATE artifacts SET template = ? WHERE id = ? AND org_id = ? AND template IS NULL`).bind(TEMPLATE, named.id, orgId).run();
    await pin(env, orgId, named.id);
    return named;
  }

  const id = newId("art");
  const t = now();
  try {
    await env.DB.batch([
      insert(env.DB, "artifacts", {
        id,
        org_id: orgId,
        title: TITLE,
        description: "Firma som har utført arbeid eller laget dokumentasjon, hentet fra dokumentene.",
        current_version: 1,
        pinned: 0,
        template: TEMPLATE,
        created_at: t,
        updated_at: t,
      }),
      insert(env.DB, "artifact_versions", {
        artifact_id: id,
        version: 1,
        html: supplierPageHtml,
        note: "Første versjon",
        created_by: "system:plank",
        created_at: t,
      }),
    ]);
  } catch (err) {
    const raced = await first<{ id: string; title: string }>(env.DB, `SELECT id, title FROM artifacts WHERE org_id = ? AND template = ?`, orgId, TEMPLATE);
    if (!raced) throw err;
    await pin(env, orgId, raced.id);
    return raced;
  }
  await pin(env, orgId, id);
  await logActivity(env, { orgId, actor: { type: "system", name: "Plank" }, action: "artifact.created", entityType: "artifact", entityId: id, summary: TITLE });
  return { id, title: TITLE };
}

async function pin(env: Env, orgId: string, id: string): Promise<void> {
  const row = await first<{ sidebar_order: number | null }>(env.DB, `SELECT sidebar_order FROM artifacts WHERE id = ? AND org_id = ?`, id, orgId);
  if (!row || row.sidebar_order != null) return;
  try {
    await setSidebar(env, orgId, id, { show: true, icon: "users" });
  } catch (err) {
    console.warn("Leverandørsiden ble ikke lagt i sidemenyen", err);
  }
}

/**
 * Viser leverandørsiden og varsler eieren første gang et område er ferdig indeksert
 * og faktisk har en leverandør. Hopper over mens Boligmappa fortsatt henter, og mens
 * dokumenter på området fortsatt leses.
 */
export async function publishSuppliersForOrg(env: Env, orgId: string): Promise<void> {
  const source = await first<{ auto_import: number; status: string }>(env.DB, `SELECT auto_import, status FROM bm_sources WHERE org_id = ?`, orgId);
  if (source && (source.auto_import === 1 || source.status === "syncing")) return;

  const areas = await all<AreaRow>(
    env.DB,
    `SELECT COALESCE(d.property_id, '') AS property_id,
            MAX(p.name) AS name,
            SUM(CASE WHEN d.status = 'processing' THEN 1 ELSE 0 END) AS processing,
            SUM(CASE WHEN d.status = 'ready' AND d.extracted LIKE '{%' AND COALESCE(json_extract(d.extracted, '$.supplier'), '') != '' THEN 1 ELSE 0 END) AS suppliers
     FROM documents d
     LEFT JOIN properties p ON p.id = d.property_id AND p.org_id = d.org_id
     WHERE d.org_id = ?
     GROUP BY COALESCE(d.property_id, '')`,
    orgId,
  );
  const ready = areas.filter((area) => Number(area.processing) === 0 && Number(area.suppliers) > 0);
  if (!ready.length) return;

  const pending: AreaRow[] = [];
  for (const area of ready) {
    const sent = await first<{ mailed_at: number }>(env.DB, `SELECT mailed_at FROM supplier_notices WHERE org_id = ? AND property_id = ?`, orgId, area.property_id);
    if (!sent) pending.push(area);
  }
  if (!pending.length) return;

  const page = await ensureSupplierPage(env, orgId);
  for (const area of pending.slice(0, 5)) {
    await mailArea(env, orgId, page.id, area);
  }
}

/** Org som har en ulest leverandør. Cron tar noen av gangen. */
export async function publishSupplierPages(env: Env): Promise<void> {
  const orgs = await all<{ org_id: string }>(
    env.DB,
    `SELECT DISTINCT d.org_id AS org_id
     FROM documents d
     WHERE d.status = 'ready'
       AND d.extracted LIKE '{%'
       AND COALESCE(json_extract(d.extracted, '$.supplier'), '') != ''
       AND NOT EXISTS (
         SELECT 1 FROM supplier_notices n
         WHERE n.org_id = d.org_id AND n.property_id = COALESCE(d.property_id, '')
       )
     LIMIT 20`,
  );
  for (const org of orgs) {
    try {
      await publishSuppliersForOrg(env, org.org_id);
    } catch (err) {
      console.error("Leverandørside feilet", org.org_id, err);
    }
  }
}

async function mailArea(env: Env, orgId: string, pageId: string, area: AreaRow): Promise<void> {
  const propertyId = area.property_id;
  const claimed = await env.DB.prepare(`INSERT INTO supplier_notices (org_id, property_id, mailed_at) VALUES (?, ?, ?)`)
    .bind(orgId, propertyId, now())
    .run()
    .catch(() => null);
  if (!claimed || !claimed.meta.changes) return;

  const undo = () => env.DB.prepare(`DELETE FROM supplier_notices WHERE org_id = ? AND property_id = ?`).bind(orgId, propertyId).run();
  try {
    const org = await first<{ name: string; brand: string | null }>(env.DB, `SELECT name, brand FROM orgs WHERE id = ?`, orgId);
    const owners = await all<{ email: string }>(
      env.DB,
      `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.role = 'owner' AND u.email IS NOT NULL`,
      orgId,
    );
    const areaName = area.name?.trim() || LOOSE;
    const names = await supplierNames(env, orgId, propertyId);
    if (!emailConfigured(env) || owners.length === 0 || !org || !env.APP_URL) {
      await logActivity(env, {
        orgId,
        actor: { type: "system", name: "Plank" },
        action: "supplier.found",
        entityType: "artifact",
        entityId: pageId,
        summary: `Leverandør funnet på ${areaName}`,
      });
      return;
    }
    const brand = brandFromId(org.brand);
    const url = `${env.APP_URL.replace(/\/$/, "")}/o/${orgId}/artifacts/${pageId}`;
    const mail = supplierFoundEmail({ brand: brand.name, orgName: org.name, areaName, suppliers: names, url });
    await sendEmail(env, {
      to: owners.map((owner) => owner.email),
      from: emailFrom(env, brand),
      ...mail,
      idempotencyKey: `supplier-found-${orgId}-${propertyId || "loose"}`,
    });
    await logActivity(env, {
      orgId,
      actor: { type: "system", name: "Plank" },
      action: "supplier.found",
      entityType: "artifact",
      entityId: pageId,
      summary: `Varslet om leverandør på ${areaName}`,
    });
  } catch (err) {
    await undo();
    throw err;
  }
}

async function supplierNames(env: Env, orgId: string, propertyId: string): Promise<string[]> {
  const where = propertyId ? "org_id = ? AND property_id = ?" : "org_id = ? AND property_id IS NULL";
  const params = propertyId ? [orgId, propertyId] : [orgId];
  const rows = await all<{ name: string }>(
    env.DB,
    `SELECT DISTINCT json_extract(extracted, '$.supplier') AS name
     FROM documents
     WHERE ${where} AND status = 'ready' AND extracted LIKE '{%' AND COALESCE(json_extract(extracted, '$.supplier'), '') != ''
     ORDER BY name
     LIMIT 3`,
    ...params,
  );
  return rows.map((row) => row.name).filter(Boolean);
}
