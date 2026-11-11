import type { Env } from "../env";
import { all, first } from "./db";
import { now } from "./util";

/** Hvor mange nye oppslag ett kall gjør. Treff som alt er lagret skrives ut uten nett. */
const LOOKUP_LIMIT = 12;
const WALL_MS = 20_000;
/** Ingen treff huskes, så vi ikke spør om det samme bygget hver gang. */
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface Resolution {
  address: string | null;
  street: string | null;
  houseNumber: string | null;
  houseLetter: string | null;
  postalCode: string | null;
  city: string | null;
}

interface BmAddressRow {
  org_id: string;
  bmn: string;
  building_number: string;
  name: string;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  estate_key: string;
  street: string | null;
  house_number: string | null;
  house_letter: string | null;
  resolved_address: string | null;
  resolved_postal: string | null;
  resolved_city: string | null;
}

/** Boligmappa gir «Hyllveien». resolvar gir «Hyllveien 12, 0580 OSLO». */
export function parseResolvarAddress(address: string): Resolution {
  const raw = address.trim();
  const match = raw.match(/^(.+?)\s+(\d+)\s*([A-Za-zÆØÅæøå])?\s*,\s*(\d{4})\s+(.+)$/);
  if (!match) {
    const head = raw.split(",")[0]?.trim() ?? "";
    return { address: raw || null, street: head || null, houseNumber: null, houseLetter: null, postalCode: null, city: null };
  }
  return {
    address: raw,
    street: match[1]!.trim(),
    houseNumber: match[2]!,
    houseLetter: match[3]?.trim() || null,
    postalCode: match[4]!,
    city: match[5]!.trim(),
  };
}

export function streetLine(street: string | null, houseNumber: string | null, houseLetter: string | null, fallback: string | null): string | null {
  if (street && houseNumber) {
    const number = houseLetter ? `${houseNumber}${houseLetter}` : houseNumber;
    return `${street} ${number}`.slice(0, 200);
  }
  const head = fallback?.split(",")[0]?.trim() ?? "";
  return /\d/.test(head) ? head.slice(0, 200) : null;
}

function digits(value: string | null | undefined): string | null {
  const found = String(value ?? "").replace(/\D/g, "");
  return found || null;
}

function configured(env: Env): { baseUrl: string; apiKey: string } | null {
  const apiKey = env.RESOLVAR_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (env.RESOLVAR_BASE_URL?.trim() || "https://resolvar.laft.io").replace(/\/+$/, "");
  return { baseUrl, apiKey };
}

async function lookup(env: Env, buildingNumber: string): Promise<Resolution | null> {
  const cfg = configured(env);
  if (!cfg) return null;
  const url = `${cfg.baseUrl}/reverse/${encodeURIComponent(buildingNumber)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "X-API-Key": cfg.apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    console.warn("resolvar svarte ikke", buildingNumber, err instanceof Error ? err.message : err);
    return null;
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    return { address: null, street: null, houseNumber: null, houseLetter: null, postalCode: null, city: null };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    console.warn("resolvar svarte", res.status, "for", buildingNumber);
    return null;
  }
  const data = (await res.json().catch(() => null)) as { address?: unknown } | null;
  if (!data || typeof data.address !== "string" || !data.address.trim()) {
    return { address: null, street: null, houseNumber: null, houseLetter: null, postalCode: null, city: null };
  }
  return parseResolvarAddress(data.address);
}

async function storeResolution(env: Env, buildingNumber: string, found: Resolution): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO resolved_addresses (building_number, address, street, house_number, house_letter, postal_code, city, looked_up_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(building_number) DO UPDATE SET
       address = excluded.address, street = excluded.street, house_number = excluded.house_number,
       house_letter = excluded.house_letter, postal_code = excluded.postal_code, city = excluded.city,
       looked_up_at = excluded.looked_up_at`,
  )
    .bind(buildingNumber, found.address, found.street, found.houseNumber, found.houseLetter, found.postalCode, found.city, now())
    .run();
}

async function applyRow(env: Env, row: BmAddressRow): Promise<boolean> {
  const line = streetLine(row.street, row.house_number, row.house_letter, row.resolved_address);
  if (!line || line === row.address) return false;
  const t = now();
  await env.DB.prepare(
    `UPDATE bm_buildings
     SET name = ?, address = ?, postal_code = COALESCE(postal_code, ?), city = COALESCE(city, ?)
     WHERE org_id = ? AND bmn = ? AND (address IS NULL OR address NOT GLOB '*[0-9]*')`,
  )
    .bind(line, line, row.resolved_postal, row.resolved_city, row.org_id, row.bmn)
    .run();
  await env.DB.prepare(
    `UPDATE buildings SET name = ?, updated_at = ?
     WHERE org_id = ? AND boligmappa_number = ? AND name IN (?, ?)`,
  )
    .bind(line, t, row.org_id, row.bmn, row.name, row.address ?? row.name)
    .run();
  await refreshProperty(env, row.org_id, row.estate_key, row.address ?? row.name, line, row.resolved_postal, row.resolved_city);
  return true;
}

/** Eiendommen får nummeret bare når alle byggene der har samme adresse. Ellers beholder den gatenavnet. */
async function refreshProperty(env: Env, orgId: string, estateKey: string, previous: string, line: string, postal: string | null, city: string | null): Promise<void> {
  const counts = await first<{ plain: number; kinds: number }>(
    env.DB,
    `SELECT
       SUM(CASE WHEN address IS NULL OR address NOT GLOB '*[0-9]*' THEN 1 ELSE 0 END) AS plain,
       COUNT(DISTINCT CASE WHEN address GLOB '*[0-9]*' THEN address END) AS kinds
     FROM bm_buildings WHERE org_id = ? AND estate_key = ?`,
    orgId,
    estateKey,
  );
  if (!counts || Number(counts.plain) !== 0 || Number(counts.kinds) !== 1) return;
  await env.DB.prepare(
    `UPDATE properties
     SET name = ?, address = ?, postal_code = COALESCE(postal_code, ?), city = COALESCE(city, ?), updated_at = ?
     WHERE org_id = ? AND boligmappa_key = ? AND name NOT GLOB '*[0-9]*' AND (name = ? OR address = ?)`,
  )
    .bind(line, line, postal, city, now(), orgId, estateKey, previous, previous)
    .run();
}

async function pendingRows(env: Env, orgId: string | undefined, limit: number): Promise<BmAddressRow[]> {
  const missAfter = now() - MISS_TTL_MS;
  const orgSql = orgId ? "AND b.org_id = ?" : "";
  const params = orgId ? [missAfter, orgId, limit] : [missAfter, limit];
  return all<BmAddressRow>(
    env.DB,
    `SELECT b.org_id, b.bmn, b.building_number, b.name, b.address, b.postal_code, b.city, b.estate_key,
            r.street, r.house_number, r.house_letter, r.address AS resolved_address,
            r.postal_code AS resolved_postal, r.city AS resolved_city
     FROM bm_buildings b
     LEFT JOIN resolved_addresses r ON r.building_number = b.building_number
     WHERE b.building_number GLOB '[0-9]*'
       AND (b.address IS NULL OR b.address NOT GLOB '*[0-9]*')
       AND (r.building_number IS NULL OR r.house_number IS NOT NULL OR r.looked_up_at < ?)
       ${orgSql}
     LIMIT ?`,
    ...params,
  );
}

/**
 * Fyller inn husnummer på bygg som Boligmappa bare ga gatenavn for.
 * Bruker samme reverse-oppslag som boligmappa-ms, og skriver bare over navn som fortsatt er gaten uten tall.
 */
export async function fillStreetNumbers(env: Env, opts: { orgId?: string; limit?: number } = {}): Promise<number> {
  let updated = 0;
  let rows: BmAddressRow[];
  try {
    rows = await pendingRows(env, opts.orgId, opts.limit ?? 40);
  } catch (err) {
    console.warn("Kunne ikke lese adresser som mangler husnummer", err instanceof Error ? err.message : err);
    return 0;
  }
  const started = Date.now();
  let lookups = 0;
  const limit = opts.limit ?? LOOKUP_LIMIT;
  for (const row of rows) {
    const key = digits(row.building_number);
    if (!key) continue;
    let resolved = row.house_number ? row : null;
    if (!resolved) {
      if (!configured(env) || lookups >= limit || Date.now() - started > WALL_MS) continue;
      lookups += 1;
      const found = await lookup(env, key);
      if (!found) continue;
      await storeResolution(env, row.building_number, found);
      resolved = {
        ...row,
        street: found.street,
        house_number: found.houseNumber,
        house_letter: found.houseLetter,
        resolved_address: found.address,
        resolved_postal: found.postalCode,
        resolved_city: found.city,
      };
    }
    if (!resolved.house_number) continue;
    if (await applyRow(env, resolved)) updated += 1;
  }
  return updated;
}
