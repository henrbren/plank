import type { Env } from "../env";
import type { AutoImportStep, BmBuilding, BmDocument, BmEstate, BmTree, DocumentKind } from "../../shared/types";
import { activityStatement, logActivity } from "./activity";
import { assertCanAddBuilding, buildingLimit } from "./billing";
import { all, first, insert } from "./db";
import { guessMime, processDocument } from "./documents";
import { ApiError } from "./http";
import { fetchRetry, isTransient, sleep, TransientError } from "./retry";
import { newId, now, parseJson } from "./util";

const PAGE_SIZE = 100;
const TOKEN_MS = 15_000;
/** Boligmappa svarer ofte tregt, så hvert forsøk får god tid. Raske feil (5xx, 429) prøves på nytt innenfor STEP_MS. */
const CALL_MS = 45_000;
const STEP_MS = 55_000;
const MAX_DOC_BYTES = 95 * 1024 * 1024;
/** Dokumenter som lastes ned samtidig i ett importsteg */
const DOCS_PER_STEP = 3;
/** Nedlastinger som feiler forbigående, prøves så mange ganger før dokumentet merkes med feil */
const MAX_DOC_ATTEMPTS = 5;
/**
 * Forsøk på dokumentlisten før vi gir opp ett bygg eller én boenhet. Boligmappa gir ofte 504 på boenheter,
 * og de er et tillegg til byggets egne dokumenter, så de får færre forsøk.
 */
const MAX_LIST_ATTEMPTS = { bm_buildings: 6, bm_units: 3 } as const;
/** Etter så mange feil på rad i bygg- og leilighetslistene stopper synken med feil */
const GIVE_UP_AFTER = 15;
/** Automatisk henting slås av etter så mange feil på rad */
const AUTO_OFF_AFTER = 40;
/** Ventetid før neste forsøk etter n feil på rad */
const RETRY_DELAYS = [0, 2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 900_000];

function retryDelay(failures: number, retryAfterMs: number | null): number {
  const base = RETRY_DELAYS[Math.min(failures, RETRY_DELAYS.length - 1)]!;
  return Math.max(base, Math.min(retryAfterMs ?? 0, 900_000));
}

const BM = { label: "Boligmappa" } as const;

type Json = Record<string, unknown>;

/** Hvem som henter: en bruker eller en agent */
export interface BmActor {
  type: "user" | "agent";
  id: string;
  name: string;
}

interface TokenCache {
  key: string;
  token: string;
  exp: number;
}
let tokenCache: TokenCache | null = null;

export function boligmappaConfigured(env: Env): boolean {
  return Boolean(env.BOLIGMAPPA_CLIENT_ID && env.BOLIGMAPPA_CLIENT_SECRET && env.BOLIGMAPPA_TOKEN_HOST && env.BOLIGMAPPA_API_BASE_URL);
}

function baseUrl(env: Env): string {
  return (env.BOLIGMAPPA_API_BASE_URL ?? "").replace(/\/?$/, "/");
}

export function normalizeOrgNr(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 9) throw new ApiError(400, "Organisasjonsnummeret må ha 9 siffer");
  return digits;
}

async function accessToken(env: Env): Promise<string> {
  const key = env.BOLIGMAPPA_CLIENT_ID ?? "";
  if (tokenCache && tokenCache.key === key && tokenCache.exp > Date.now()) return tokenCache.token;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.BOLIGMAPPA_CLIENT_ID ?? "",
    client_secret: env.BOLIGMAPPA_CLIENT_SECRET ?? "",
    scope: "openid",
  });
  const res = await fetchRetry(
    env.BOLIGMAPPA_TOKEN_HOST ?? "",
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
    { ...BM, timeoutMs: TOKEN_MS, budgetMs: 30_000 },
  );
  const json = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number; error_description?: string } | null;
  if (!res.ok || !json?.access_token) {
    throw new ApiError(502, json?.error_description || "Fikk ikke tilgang til Boligmappa");
  }
  const ttl = Math.max(30, (json.expires_in ?? 300) - 60) * 1000;
  tokenCache = { key, token: json.access_token, exp: Date.now() + ttl };
  return json.access_token;
}

interface Page {
  items: Json[];
  pageCount: number | null;
  total: number | null;
}

function metaNumber(meta: Json, keys: string[]): number | null {
  for (const key of keys) {
    const value = num(meta[key]);
    if (value != null) return value;
  }
  return null;
}

function pageOf(json: { meta?: Json; metadata?: Json; pagination?: Json }): { pageCount: number | null; total: number | null } {
  const blocks = [json.meta, json.metadata, json.pagination].flatMap((block) => {
    const obj = asObj(block);
    if (!obj) return [];
    const nested = asObj(obj.pagination);
    return nested ? [obj, nested] : [obj];
  });
  let pageCount: number | null = null;
  let total: number | null = null;
  for (const meta of blocks) {
    pageCount ??= metaNumber(meta, ["pageCount", "totalPages", "pages"]);
    total ??= metaNumber(meta, ["totalCount", "total", "totalItems"]);
  }
  return { pageCount, total };
}

async function apiGet(env: Env, path: string): Promise<Page> {
  const call = async () =>
    fetchRetry(`${baseUrl(env)}${path}`, { headers: { Authorization: `Bearer ${await accessToken(env)}`, Accept: "application/json" } }, { ...BM, timeoutMs: CALL_MS, budgetMs: STEP_MS });
  let res = await call();
  if (res.status === 401) {
    tokenCache = null;
    res = await call();
  }
  if (res.status === 404) return { items: [], pageCount: 1, total: 0 };
  if (!res.ok) throw new ApiError(502, `Boligmappa svarte ${res.status}`);
  const json = (await res.json().catch(() => {
    throw new TransientError("Boligmappa sendte et ufullstendig svar");
  })) as { success?: boolean; response?: unknown; meta?: Json; metadata?: Json; pagination?: Json };
  const items = Array.isArray(json.response) ? (json.response as Json[]) : [];
  return { items, ...pageOf(json) };
}

/**
 * En kort side er ikke siste side. Boligmappa kan levere færre enn pageSize selv om neste side finnes,
 * og da ble resten (typisk «22 av 44») aldri hentet.
 */
export function pageDone(input: { itemCount: number; page: number; pageCount: number | null; total: number | null; have: number; added: number }): boolean {
  if (input.page >= 50) return true;
  if (input.itemCount === 0) return true;
  if (input.total != null && input.total > 0) return input.have >= input.total;
  if (input.pageCount != null && input.pageCount > 0) return input.page >= input.pageCount;
  // Side 1 som ikke la til noe nytt, kan være en reprise. Da må neste side sjekkes før vi gir oss.
  return input.page > 1 && input.added === 0;
}

async function countWhere(env: Env, sql: string, ...params: (string | number | null)[]): Promise<number> {
  const row = await first<{ n: number }>(env.DB, sql, ...params);
  return row?.n ?? 0;
}

function text(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asObj(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function labelOf(value: unknown): string | null {
  const direct = text(value);
  if (direct) return direct;
  const obj = asObj(value);
  return text(obj?.name) ?? text(obj?.code) ?? text(obj?.description);
}

function addressOf(raw: Json): { street: string | null; postal: string | null; city: string | null; municipality: string | null; knr: string | null } {
  const list = Array.isArray(raw.addresses) ? raw.addresses : [];
  const a = asObj(list[0]) ?? asObj(raw.address) ?? {};
  const street = [text(a.streetName), text(a.houseNumber), text(a.houseSubNumber)].filter(Boolean).join(" ") || null;
  return {
    street,
    postal: text(a.postalCode),
    city: text(a.postalPlace) ?? text(a.city),
    municipality: text(a.municipalityName),
    knr: text(a.municipalityNumber),
  };
}

function cadastreOf(raw: Json, fallbackKnr: string | null): { knr: string | null; gnr: string | null; bnr: string | null } {
  const c = asObj(raw.cadastre) ?? asObj(raw.matrikkel) ?? asObj(raw.cadastralUnit) ?? {};
  return {
    knr: text(c.municipalityNumber) ?? text(c.knr) ?? text(c.kommunenummer) ?? fallbackKnr,
    gnr: text(c.gnr) ?? text(c.gaard) ?? text(c.gaardsnummer) ?? text(raw.gnr),
    bnr: text(c.bnr) ?? text(c.bruk) ?? text(c.bruksnummer) ?? text(raw.bnr),
  };
}

function estateKey(knr: string | null, gnr: string | null, bnr: string | null, street: string | null, postal: string | null, bmn: string): string {
  if (gnr && bnr) return `mat:${knr ?? ""}:${gnr}:${bnr}`;
  if (street) return `adr:${postal ?? ""}:${street.toLowerCase()}`;
  return `bmn:${bmn}`;
}

function areaM2(raw: Json): number | null {
  const total = num(raw.totalBuildingArea);
  const utilized = num(raw.utilizedBuildingArea);
  const space = num(asObj(raw.propertyFact)?.totalSpace);
  if (total != null && space != null && space > 0 && Math.abs(total / 100 - space) <= 1.5) return Math.round(space);
  if (total != null && total >= 10_000) return Math.round(total / 100);
  if (total != null && total > 0) return total;
  if (utilized != null && utilized >= 10_000) return Math.round(utilized / 100);
  if (utilized != null && utilized > 0) return utilized;
  if (space != null && space > 0) return Math.round(space);
  return null;
}

export function kindOf(category: string | null, filename: string | null): DocumentKind {
  const hay = `${category ?? ""} ${filename ?? ""}`.toLowerCase();
  if (hay.includes("ifc")) return "ifc";
  if (hay.includes("fdv")) return "fdv";
  if (hay.includes("datablad")) return "produktdatablad";
  if (hay.includes("manual") || hay.includes("bruksanvis") || hay.includes("vedlikehold")) return "brukermanual";
  if (hay.includes("tegning") || hay.includes("plan")) return "tegning";
  if (hay.includes("sertifikat") || hay.includes("samsvar")) return "sertifikat";
  if (hay.includes("tilstand") || hay.includes("rapport")) return "rapport";
  if (hay.includes("kontroll") || hay.includes("service")) return "kontroll";
  if (hay.includes("kontrakt") || hay.includes("avtale")) return "avtale";
  if (hay.includes("bilde") || hay.includes("foto") || /\.(jpe?g|png|webp)$/.test(hay)) return "bilde";
  return "annet";
}

interface SourceRow {
  org_id: string;
  org_nr: string;
  status: string;
  phase: string;
  page: number;
  building_count: number;
  unit_count: number;
  document_count: number;
  error: string | null;
  updated_at: number;
  fail_count: number;
  retry_at: number | null;
}

async function sourceOf(env: Env, orgId: string): Promise<SourceRow | null> {
  return first<SourceRow>(env.DB, `SELECT * FROM bm_sources WHERE org_id = ?`, orgId);
}

async function saveSource(env: Env, row: SourceRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO bm_sources (org_id, org_nr, status, phase, page, building_count, unit_count, document_count, error, updated_at, fail_count, retry_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id) DO UPDATE SET
       org_nr = excluded.org_nr, status = excluded.status, phase = excluded.phase, page = excluded.page,
       building_count = excluded.building_count, unit_count = excluded.unit_count, document_count = excluded.document_count,
       error = excluded.error, updated_at = excluded.updated_at, fail_count = excluded.fail_count, retry_at = excluded.retry_at`,
  )
    .bind(
      row.org_id,
      row.org_nr,
      row.status,
      row.phase,
      row.page,
      row.building_count,
      row.unit_count,
      row.document_count,
      row.error,
      row.updated_at,
      row.fail_count ?? 0,
      row.retry_at ?? null,
    )
    .run();
}

export async function connectBoligmappa(env: Env, orgId: string, orgNr: string, opts: { autoImport?: boolean } = {}): Promise<void> {
  if (!boligmappaConfigured(env)) throw new ApiError(503, "Boligmappa er ikke konfigurert på serveren");
  const existing = await sourceOf(env, orgId);
  if (opts.autoImport) {
    await saveSource(env, {
      org_id: orgId,
      org_nr: orgNr,
      status: "idle",
      phase: "buildings",
      page: 1,
      building_count: 0,
      unit_count: 0,
      document_count: 0,
      error: null,
      updated_at: now(),
      fail_count: 0,
      retry_at: null,
    });
    await env.DB.prepare(`UPDATE bm_sources SET auto_import = 1 WHERE org_id = ?`).bind(orgId).run();
    return;
  }
  const t = now();
  await saveSource(env, {
    org_id: orgId,
    org_nr: orgNr,
    status: "idle",
    phase: "buildings",
    page: 1,
    building_count: existing && existing.org_nr === orgNr ? existing.building_count : 0,
    unit_count: existing && existing.org_nr === orgNr ? existing.unit_count : 0,
    document_count: existing && existing.org_nr === orgNr ? existing.document_count : 0,
    error: null,
    updated_at: t,
    fail_count: 0,
    retry_at: null,
  });
}

async function clearCache(env: Env, orgId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM bm_documents WHERE org_id = ?`).bind(orgId),
    env.DB.prepare(`DELETE FROM bm_units WHERE org_id = ?`).bind(orgId),
    env.DB.prepare(`DELETE FROM bm_buildings WHERE org_id = ?`).bind(orgId),
  ]);
}

function buildingRow(orgId: string, raw: Json) {
  const bmn = text(raw.boligmappaNumber);
  if (!bmn) return null;
  const addr = addressOf(raw);
  const cad = cadastreOf(raw, addr.knr);
  const name = addr.street || labelOf(raw.buildingType) || `Bygg ${bmn}`;
  return {
    orgId,
    bmn,
    buildingNumber: text(raw.buildingNumber) ?? text(raw.mainBuildingNumber),
    name: name.slice(0, 200),
    address: addr.street,
    postal: addr.postal,
    city: addr.city,
    municipality: addr.municipality,
    knr: cad.knr,
    gnr: cad.gnr,
    bnr: cad.bnr,
    buildingType: labelOf(raw.buildingType)?.slice(0, 100) ?? null,
    year: num(raw.constructionYear) ?? num(raw.yearBuilt),
    area: areaM2(raw),
    estateKey: estateKey(cad.knr, cad.gnr, cad.bnr, addr.street, addr.postal, bmn),
  };
}

function unitRow(orgId: string, raw: Json) {
  const bmn = text(raw.boligmappaNumber);
  if (!bmn) return null;
  const building = asObj(raw.building) ?? {};
  const addr = addressOf(raw);
  const cad = cadastreOf(raw, addr.knr);
  const unit = text(raw.unitNumber) ?? text(raw.apartmentNumber) ?? text(raw.propertyNumber);
  const street = addr.street;
  const name = unit ? `${street ?? "Boenhet"} ${unit}`.trim() : street || `Boenhet ${bmn}`;
  const buildingBmn = text(building.boligmappaNumber);
  return {
    orgId,
    bmn,
    buildingBmn,
    buildingNumber: text(building.mainBuildingNumber) ?? text(building.buildingNumber),
    name: name.slice(0, 200),
    address: street,
    postal: addr.postal,
    city: addr.city,
    unit,
    estateKey: estateKey(cad.knr, cad.gnr, cad.bnr, street, addr.postal, buildingBmn ?? bmn),
  };
}

async function storeBuildings(env: Env, rows: NonNullable<ReturnType<typeof buildingRow>>[]): Promise<void> {
  for (const r of rows) {
    await env.DB.prepare(
      `INSERT INTO bm_buildings (org_id, bmn, building_number, name, address, postal_code, city, municipality, knr, gnr, bnr, building_type, year_built, area_m2, estate_key, docs_fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(org_id, bmn) DO UPDATE SET
         building_number = excluded.building_number, name = excluded.name, address = excluded.address, postal_code = excluded.postal_code,
         city = excluded.city, municipality = excluded.municipality, knr = excluded.knr, gnr = excluded.gnr, bnr = excluded.bnr,
         building_type = excluded.building_type, year_built = excluded.year_built, area_m2 = excluded.area_m2, estate_key = excluded.estate_key`,
    )
      .bind(r.orgId, r.bmn, r.buildingNumber, r.name, r.address, r.postal, r.city, r.municipality, r.knr, r.gnr, r.bnr, r.buildingType, r.year, r.area, r.estateKey)
      .run();
  }
}

async function storeUnits(env: Env, rows: NonNullable<ReturnType<typeof unitRow>>[]): Promise<void> {
  for (const r of rows) {
    await env.DB.prepare(
      `INSERT INTO bm_units (org_id, bmn, building_bmn, building_number, name, address, postal_code, city, unit_number, estate_key, docs_fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(org_id, bmn) DO UPDATE SET
         building_bmn = excluded.building_bmn, building_number = excluded.building_number, name = excluded.name, address = excluded.address,
         postal_code = excluded.postal_code, city = excluded.city, unit_number = excluded.unit_number, estate_key = excluded.estate_key`,
    )
      .bind(r.orgId, r.bmn, r.buildingBmn, r.buildingNumber, r.name, r.address, r.postal, r.city, r.unit, r.estateKey)
      .run();
  }
}

function docRemoteId(raw: Json, ownerKind: string, ownerBmn: string): string | null {
  const id = text(raw.id) ?? text(raw.documentId);
  if (id) return id;
  const url = text(asObj(raw.url)?.link) ?? text(raw.downloadUrl);
  return url ? `${ownerKind}:${ownerBmn}:${url.split("?")[0]!.slice(-80)}` : null;
}

async function storeDocuments(env: Env, orgId: string, ownerKind: "building" | "unit", ownerBmn: string, items: Json[]): Promise<number> {
  let n = 0;
  for (const raw of items) {
    const remoteId = docRemoteId(raw, ownerKind, ownerBmn);
    if (!remoteId) continue;
    const filename = text(raw.fileName) ?? text(raw.filename) ?? text(raw.name);
    const title = (text(raw.title) ?? filename ?? "Dokument").slice(0, 200);
    const url = text(asObj(raw.url)?.link) ?? text(raw.downloadUrl) ?? text(raw.pdfConversion);
    await env.DB.prepare(
      `INSERT INTO bm_documents (org_id, remote_id, owner_kind, owner_bmn, title, filename, category, download_url, error, imported_document_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(org_id, remote_id) DO UPDATE SET
         title = excluded.title, filename = excluded.filename, category = excluded.category, download_url = excluded.download_url
         WHERE imported_document_id IS NULL`,
    )
      .bind(orgId, remoteId, ownerKind, ownerBmn, title, filename, labelOf(raw.documentType) ?? labelOf(raw.category), url)
      .run();
    n++;
  }
  return n;
}

export type SyncResult = SourceRow & { waited: boolean; retryInMs: number | null };

/**
 * Ett kall mot Boligmappa. Kalles igjen til status er ready. Lesing skjer alltid fra cachen.
 * Feil teller opp fail_count og setter retry_at. Bakgrunnskall venter til retry_at, mens force (brukeren trykket selv) prøver med en gang.
 */
export async function syncChunk(env: Env, orgId: string, restart: boolean, opts: { force?: boolean } = {}): Promise<SyncResult> {
  if (!boligmappaConfigured(env)) throw new ApiError(503, "Boligmappa er ikke konfigurert på serveren");
  let source = await sourceOf(env, orgId);
  if (!source) throw new ApiError(400, "Legg inn organisasjonsnummeret først");
  if (restart) {
    await clearCache(env, orgId);
    source = {
      ...source,
      status: "syncing",
      phase: "buildings",
      page: 1,
      building_count: 0,
      unit_count: 0,
      document_count: 0,
      error: null,
      updated_at: now(),
      fail_count: 0,
      retry_at: null,
    };
    await saveSource(env, source);
  } else {
    if (!opts.force && source.status !== "ready" && source.retry_at && source.retry_at > now()) {
      return { ...source, waited: true, retryInMs: source.retry_at - now() };
    }
    // Oppdater på en ferdig kilde skal hente sider som mangler, uten å slette bygg og filer som allerede er inne.
    if (opts.force && (source.status === "ready" || source.phase === "done")) {
      await reopenDocumentLists(env, orgId);
      const fresh = await sourceOf(env, orgId);
      source = {
        ...(fresh ?? source),
        status: "syncing",
        phase: "buildings",
        page: 1,
        error: null,
        updated_at: now(),
        fail_count: 0,
        retry_at: null,
      };
      await saveSource(env, source);
    } else if (source.status !== "syncing") {
      source = { ...source, status: "syncing", error: null, updated_at: now() };
      await saveSource(env, source);
    }
  }

  let waited = false;
  let current: { table: "bm_buildings" | "bm_units"; bmn: string } | null = null;
  try {
    do {
      if (source.phase === "buildings" || source.phase === "properties") {
        const path = source.phase === "buildings" ? "buildings" : "properties";
        const { items, pageCount, total } = await apiGet(env, `organizations/${source.org_nr}/${path}?page=${source.page}&pageSize=${PAGE_SIZE}`);
        const countSql = source.phase === "buildings" ? `SELECT COUNT(*) AS n FROM bm_buildings WHERE org_id = ?` : `SELECT COUNT(*) AS n FROM bm_units WHERE org_id = ?`;
        const before = await countWhere(env, countSql, orgId);
        if (source.phase === "buildings") {
          const rows = items.map((item) => buildingRow(orgId, item)).filter((r) => r != null);
          await storeBuildings(env, rows);
        } else {
          const rows = items.map((item) => unitRow(orgId, item)).filter((r) => r != null);
          await storeUnits(env, rows);
        }
        const have = await countWhere(env, countSql, orgId);
        if (source.phase === "buildings") source.building_count = have;
        else source.unit_count = have;
        const last = pageDone({ itemCount: items.length, page: source.page, pageCount, total, have, added: have - before });
        if (last) {
          source.phase = source.phase === "buildings" ? "properties" : "documents";
          source.page = 1;
        } else {
          source.page += 1;
        }
      } else if (source.phase === "documents") {
        // De som har feilet, kommer sist, så én treg boenhet ikke holder igjen resten
        const building = await first<{ bmn: string; docs_page: number }>(
          env.DB,
          `SELECT bmn, docs_page FROM bm_buildings WHERE org_id = ? AND docs_fetched_at IS NULL ORDER BY docs_attempts, bmn LIMIT 1`,
          orgId,
        );
        const unit = building
          ? null
          : await first<{ bmn: string; docs_page: number }>(
              env.DB,
              `SELECT bmn, docs_page FROM bm_units WHERE org_id = ? AND docs_fetched_at IS NULL ORDER BY docs_attempts, bmn LIMIT 1`,
              orgId,
            );
        const owner = building ? { kind: "building" as const, ...building } : unit ? { kind: "unit" as const, ...unit } : null;
        if (!owner) {
          const docs = await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM bm_documents WHERE org_id = ?`, orgId);
          source.document_count = docs?.n ?? 0;
          source.status = "ready";
          source.phase = "done";
          source.error = null;
          break;
        }
        const entity = owner.kind === "building" ? "buildings" : "properties";
        const table = owner.kind === "building" ? "bm_buildings" : "bm_units";
        current = { table, bmn: owner.bmn };
        const page = owner.docs_page + 1;
        const { items, pageCount, total } = await apiGet(env, `${entity}/${encodeURIComponent(owner.bmn)}/documents?page=${page}&pageSize=${PAGE_SIZE}`);
        const before = await countWhere(env, `SELECT COUNT(*) AS n FROM bm_documents WHERE org_id = ? AND owner_kind = ? AND owner_bmn = ?`, orgId, owner.kind, owner.bmn);
        await storeDocuments(env, orgId, owner.kind, owner.bmn, items);
        const have = await countWhere(env, `SELECT COUNT(*) AS n FROM bm_documents WHERE org_id = ? AND owner_kind = ? AND owner_bmn = ?`, orgId, owner.kind, owner.bmn);
        const last = pageDone({ itemCount: items.length, page, pageCount, total, have, added: have - before });
        await env.DB.prepare(`UPDATE ${table} SET docs_page = ?, docs_fetched_at = ?, docs_error = NULL, docs_attempts = 0 WHERE org_id = ? AND bmn = ?`)
          .bind(page, last ? now() : null, orgId, owner.bmn)
          .run();
      } else {
        source.status = "ready";
        break;
      }
      source.updated_at = now();
      source.error = null;
    } while (false);
    source.fail_count = 0;
    source.retry_at = null;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Kunne ikke hente fra Boligmappa";
    const transient = isTransient(err);
    source.updated_at = now();
    if (current && (transient || err instanceof ApiError)) {
      // Dokumentlisten til ett bygg eller én boenhet feilet. Den legges bakerst, og resten av synken går videre.
      const row = await first<{ docs_attempts: number }>(
        env.DB,
        `UPDATE ${current.table} SET docs_attempts = docs_attempts + 1, docs_error = ? WHERE org_id = ? AND bmn = ? RETURNING docs_attempts`,
        message,
        orgId,
        current.bmn,
      );
      if (!transient || (row?.docs_attempts ?? 0) >= MAX_LIST_ATTEMPTS[current.table]) {
        await env.DB.prepare(`UPDATE ${current.table} SET docs_fetched_at = ? WHERE org_id = ? AND bmn = ?`).bind(now(), orgId, current.bmn).run();
        console.warn("Gir opp dokumentlisten", orgId, current.bmn, message);
      }
      source.status = "syncing";
      if (transient) {
        waited = true;
        source.fail_count = (source.fail_count ?? 0) + 1;
        source.error = "Boligmappa svarer tregt. Vi prøver igjen automatisk.";
        // Køen roterer forbi det som feiler, så pausen holdes kort her
        source.retry_at = now() + retryDelay(Math.min(source.fail_count, 5), err instanceof TransientError ? err.retryAfterMs : null);
      } else {
        source.error = null;
      }
    } else {
      source.fail_count = (source.fail_count ?? 0) + 1;
      if (transient && source.fail_count < GIVE_UP_AFTER) {
        waited = true;
        source.status = "syncing";
        source.error = "Boligmappa svarer tregt. Vi prøver igjen automatisk.";
      } else {
        source.status = "error";
        source.error = transient ? `Boligmappa har ikke svart på lenge (${message}). Trykk Oppdater for å prøve igjen.` : message;
      }
      source.retry_at = now() + retryDelay(source.fail_count, err instanceof TransientError ? err.retryAfterMs : null);
    }
  }
  const docs = await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM bm_documents WHERE org_id = ?`, orgId);
  source.document_count = docs?.n ?? source.document_count;
  await saveSource(env, source);
  return { ...source, waited, retryInMs: source.retry_at ? Math.max(0, source.retry_at - now()) : null };
}

export async function disconnectBoligmappa(env: Env, orgId: string, actor: BmActor): Promise<void> {
  await env.DB.prepare(`DELETE FROM bm_sources WHERE org_id = ?`).bind(orgId).run();
  await clearCache(env, orgId);
  await activityStatement(env, { orgId, actor, action: "boligmappa.disconnected", summary: "Koblet fra Boligmappa" })
    .run()
    .catch(() => undefined);
}

async function agentCounts(env: Env, orgId: string): Promise<{ total: number; withTool: number }> {
  const rows = await all<{ tools: string }>(env.DB, `SELECT tools FROM agents WHERE org_id = ?`, orgId);
  return {
    total: rows.length,
    withTool: rows.filter((r) => parseJson<string[]>(r.tools, []).includes("boligmappa")).length,
  };
}

export async function boligmappaTree(env: Env, orgId: string): Promise<BmTree> {
  const source = await sourceOf(env, orgId);
  const [agents, imported] = await Promise.all([
    agentCounts(env, orgId),
    Promise.all([
      first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM properties WHERE org_id = ? AND boligmappa_key IS NOT NULL`, orgId),
      first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM buildings WHERE org_id = ? AND boligmappa_number IS NOT NULL`, orgId),
      first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM documents WHERE org_id = ? AND boligmappa_id IS NOT NULL`, orgId),
    ]).then(([properties, buildings, documents]) => ({
      properties: properties?.n ?? 0,
      buildings: buildings?.n ?? 0,
      documents: documents?.n ?? 0,
    })),
  ]);
  const empty: BmTree = {
    configured: boligmappaConfigured(env),
    orgNr: source?.org_nr ?? null,
    status: source?.status ?? "idle",
    phase: source?.phase ?? "buildings",
    page: source?.page ?? 1,
    buildingCount: source?.building_count ?? 0,
    unitCount: source?.unit_count ?? 0,
    documentCount: source?.document_count ?? 0,
    error: source?.error ?? null,
    updatedAt: source?.updated_at ?? null,
    estates: [],
    agents,
    imported,
  };
  if (!source) return empty;

  const [buildings, units, docCounts, importedProps, importedBuildings] = await Promise.all([
    all<{ bmn: string; building_number: string | null; name: string; address: string | null; postal_code: string | null; city: string | null; municipality: string | null; gnr: string | null; bnr: string | null; building_type: string | null; year_built: number | null; area_m2: number | null; estate_key: string }>(
      env.DB,
      `SELECT bmn, building_number, name, address, postal_code, city, municipality, gnr, bnr, building_type, year_built, area_m2, estate_key FROM bm_buildings WHERE org_id = ? ORDER BY name`,
      orgId,
    ),
    all<{ bmn: string; building_bmn: string | null; building_number: string | null; name: string; estate_key: string }>(
      env.DB,
      `SELECT bmn, building_bmn, building_number, name, estate_key FROM bm_units WHERE org_id = ? ORDER BY name`,
      orgId,
    ),
    all<{ owner_kind: string; owner_bmn: string; n: number }>(env.DB, `SELECT owner_kind, owner_bmn, COUNT(*) AS n FROM bm_documents WHERE org_id = ? GROUP BY owner_kind, owner_bmn`, orgId),
    all<{ id: string; boligmappa_key: string }>(env.DB, `SELECT id, boligmappa_key FROM properties WHERE org_id = ? AND boligmappa_key IS NOT NULL`, orgId),
    all<{ id: string; boligmappa_number: string }>(env.DB, `SELECT id, boligmappa_number FROM buildings WHERE org_id = ? AND boligmappa_number IS NOT NULL`, orgId),
  ]);

  const docs = new Map(docCounts.map((d) => [`${d.owner_kind}:${d.owner_bmn}`, d.n]));
  const propByKey = new Map(importedProps.map((p) => [p.boligmappa_key, p.id]));
  const bldByBmn = new Map(importedBuildings.map((b) => [b.boligmappa_number, b.id]));
  const byNumber = new Map<string, string>();
  for (const b of buildings) if (b.building_number) byNumber.set(b.building_number, b.bmn);

  const unitsByBuilding = new Map<string, BmBuilding["units"]>();
  const orphans = new Map<string, { bmn: string; name: string; documentCount: number; estate: string }[]>();
  for (const u of units) {
    const parent = (u.building_bmn && buildings.some((b) => b.bmn === u.building_bmn) ? u.building_bmn : null) ?? (u.building_number ? byNumber.get(u.building_number) : null);
    const node = { bmn: u.bmn, name: u.name, documentCount: docs.get(`unit:${u.bmn}`) ?? 0 };
    if (parent) {
      const list = unitsByBuilding.get(parent) ?? [];
      list.push(node);
      unitsByBuilding.set(parent, list);
    } else {
      const list = orphans.get(u.estate_key) ?? [];
      list.push({ ...node, estate: u.estate_key });
      orphans.set(u.estate_key, list);
    }
  }

  const estates = new Map<string, BmEstate>();
  const ensure = (key: string, seed: Partial<BmEstate>): BmEstate => {
    const found = estates.get(key);
    if (found) return found;
    const created: BmEstate = {
      key,
      name: seed.name || "Eiendom",
      address: seed.address ?? null,
      postalCode: seed.postalCode ?? null,
      city: seed.city ?? null,
      municipality: seed.municipality ?? null,
      gnr: seed.gnr ?? null,
      bnr: seed.bnr ?? null,
      importedPropertyId: propByKey.get(key) ?? null,
      buildings: [],
      documents: 0,
    };
    estates.set(key, created);
    return created;
  };

  for (const b of buildings) {
    const estate = ensure(b.estate_key, {
      name: b.address || (b.gnr ? `gnr. ${b.gnr} / bnr. ${b.bnr ?? "–"}` : b.name),
      address: b.address,
      postalCode: b.postal_code,
      city: b.city,
      municipality: b.municipality,
      gnr: b.gnr,
      bnr: b.bnr,
    });
    const ownDocs = docs.get(`building:${b.bmn}`) ?? 0;
    const children = unitsByBuilding.get(b.bmn) ?? [];
    const childDocs = children.reduce((sum, u) => sum + u.documentCount, 0);
    estate.buildings.push({
      bmn: b.bmn,
      name: b.name,
      buildingNumber: b.building_number,
      buildingType: b.building_type,
      area: b.area_m2,
      yearBuilt: b.year_built,
      documentCount: ownDocs + childDocs,
      importedBuildingId: bldByBmn.get(b.bmn) ?? null,
      units: children,
    });
    estate.documents += ownDocs + childDocs;
  }

  for (const [key, list] of orphans) {
    const estate = ensure(key, { name: "Boenheter" });
    for (const u of list) {
      estate.buildings.push({
        bmn: `unit:${u.bmn}`,
        name: u.name,
        buildingNumber: null,
        buildingType: "Boenhet",
        area: null,
        yearBuilt: null,
        documentCount: u.documentCount,
        importedBuildingId: null,
        units: [],
      });
      estate.documents += u.documentCount;
    }
  }

  empty.estates = [...estates.values()].sort((a, b) => a.name.localeCompare(b.name, "nb"));
  return empty;
}

export async function listBmDocuments(env: Env, orgId: string, ownerBmn?: string): Promise<BmDocument[]> {
  const rows = await all<{
    remote_id: string;
    owner_kind: string;
    owner_bmn: string;
    title: string;
    filename: string | null;
    category: string | null;
    error: string | null;
    imported_document_id: string | null;
    building_name: string | null;
    unit_name: string | null;
    parent_bmn: string | null;
  }>(
    env.DB,
    `SELECT d.remote_id, d.owner_kind, d.owner_bmn, d.title, d.filename, d.category, d.error, d.imported_document_id,
            b.name AS building_name, u.name AS unit_name, u.building_bmn AS parent_bmn
     FROM bm_documents d
     LEFT JOIN bm_buildings b ON b.org_id = d.org_id AND d.owner_kind = 'building' AND b.bmn = d.owner_bmn
     LEFT JOIN bm_units u ON u.org_id = d.org_id AND d.owner_kind = 'unit' AND u.bmn = d.owner_bmn
     WHERE d.org_id = ?
     ORDER BY d.title
     LIMIT 400`,
    orgId,
  );
  return rows
    .filter((r) => {
      if (!ownerBmn) return true;
      return r.owner_bmn === ownerBmn || r.parent_bmn === ownerBmn;
    })
    .map((r) => ({
      remoteId: r.remote_id,
      title: r.title,
      filename: r.filename,
      category: r.category,
      ownerKind: r.owner_kind,
      ownerBmn: r.owner_bmn,
      ownerName: r.building_name ?? r.unit_name,
      importedDocumentId: r.imported_document_id,
      error: r.error,
    }));
}

interface CacheBuilding {
  bmn: string;
  building_number: string | null;
  name: string;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  municipality: string | null;
  gnr: string | null;
  bnr: string | null;
  building_type: string | null;
  year_built: number | null;
  area_m2: number | null;
  estate_key: string;
}

async function ensureProperty(env: Env, orgId: string, building: CacheBuilding): Promise<string> {
  const existing = await first<{ id: string }>(env.DB, `SELECT id FROM properties WHERE org_id = ? AND boligmappa_key = ?`, orgId, building.estate_key);
  if (existing) return existing.id;
  const id = newId("prp");
  const t = now();
  const name = building.address || (building.gnr ? `gnr. ${building.gnr} / bnr. ${building.bnr ?? "–"}` : building.name);
  await insert(env.DB, "properties", {
    id,
    org_id: orgId,
    name: name.slice(0, 200),
    address: building.address,
    postal_code: building.postal_code,
    city: building.city,
    municipality: building.municipality,
    gnr: building.gnr,
    bnr: building.bnr,
    description: null,
    boligmappa_key: building.estate_key,
    created_at: t,
    updated_at: t,
  }).run();
  return id;
}

async function ensureBuilding(env: Env, orgId: string, propertyId: string, building: CacheBuilding): Promise<{ id: string; created: boolean; skipped: string | null }> {
  const realBmn = building.bmn.startsWith("unit:") ? null : building.bmn;
  if (realBmn) {
    const existing = await first<{ id: string }>(env.DB, `SELECT id FROM buildings WHERE org_id = ? AND boligmappa_number = ?`, orgId, realBmn);
    if (existing) return { id: existing.id, created: false, skipped: null };
  }
  try {
    await assertCanAddBuilding(env, orgId);
  } catch (err) {
    return { id: "", created: false, skipped: err instanceof Error ? err.message : "Kvoten er nådd" };
  }
  const id = newId("bld");
  const t = now();
  await insert(env.DB, "buildings", {
    id,
    org_id: orgId,
    property_id: propertyId,
    name: building.name,
    building_number: building.building_number,
    building_type: building.building_type,
    year_built: building.year_built,
    gross_area: building.area_m2,
    description: null,
    ifc_guid: null,
    boligmappa_number: realBmn,
    created_at: t,
    updated_at: t,
  }).run();
  return { id, created: true, skipped: null };
}

async function downloadToPlank(
  env: Env,
  orgId: string,
  actor: BmActor,
  doc: { remote_id: string; title: string; filename: string | null; category: string | null; download_url: string | null },
  loc: { property_id: string; building_id: string | null },
): Promise<void> {
  if (!doc.download_url) throw new Error("Dokumentet har ingen nedlastingslenke");
  const already = await first<{ imported_document_id: string | null }>(env.DB, `SELECT imported_document_id FROM bm_documents WHERE org_id = ? AND remote_id = ?`, orgId, doc.remote_id);
  if (already?.imported_document_id) return;
  const url = doc.download_url;
  const opts = { ...BM, timeoutMs: CALL_MS, budgetMs: STEP_MS };
  let res = await fetchRetry(url, { redirect: "follow" }, opts);
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => undefined);
    res = await fetchRetry(url, { headers: { Authorization: `Bearer ${await accessToken(env)}` }, redirect: "follow" }, opts);
  }
  if (!res.ok) throw new Error(`Klarte ikke å laste ned dokumentet (${res.status})`);
  const filename = (doc.filename || doc.title || "dokument").replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 180);
  const id = newId("doc");
  const key = `orgs/${orgId}/documents/${id}/${filename}`;
  const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || guessMime(filename);
  const length = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(length) && length === 0) throw new Error("Dokumentet var tomt");
  if (Number.isFinite(length) && length > MAX_DOC_BYTES) throw new Error("Dokumentet er for stort");
  if (!res.body) throw new Error("Dokumentet var tomt");
  // Strøm til R2 med tak. Hele filen i minnet (særlig flere samtidig) gjør at workeren dør med Feil 503.
  let size = 0;
  const capped = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > MAX_DOC_BYTES) throw new Error("Dokumentet er for stort");
      controller.enqueue(chunk);
    },
  });
  try {
    const piping = res.body.pipeTo(capped.writable);
    await env.FILES.put(key, capped.readable, { httpMetadata: { contentType: mime } });
    await piping;
    if (size === 0) throw new Error("Dokumentet var tomt");
  } catch (err) {
    await env.FILES.delete(key).catch(() => undefined);
    if (err instanceof Error && /tomt|for stort/.test(err.message)) throw err;
    throw new TransientError("Nedlastingen fra Boligmappa ble avbrutt");
  }
  const t = now();
  await insert(env.DB, "documents", {
    id,
    org_id: orgId,
    property_id: loc.property_id,
    building_id: loc.building_id,
    floor_id: null,
    room_id: null,
    component_id: null,
    title: doc.title.slice(0, 200),
    filename,
    mime,
    size,
    r2_key: key,
    kind: kindOf(doc.category, filename),
    ns3451: null,
    status: "processing",
    uploaded_by: actor.type === "user" ? actor.id : null,
    boligmappa_id: doc.remote_id,
    created_at: t,
    updated_at: t,
  }).run();
  await env.DB.prepare(`UPDATE bm_documents SET imported_document_id = ?, error = NULL WHERE org_id = ? AND remote_id = ?`).bind(id, orgId, doc.remote_id).run();
}

async function byIds<T>(env: Env, orgId: string, ids: string[], sqlPrefix: string): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 40) {
    const slice = ids.slice(i, i + 40);
    out.push(...(await all<T>(env.DB, `${sqlPrefix}(${slice.map(() => "?").join(", ")})`, orgId, ...slice)));
  }
  return out;
}

interface PendingDoc {
  remote_id: string;
  owner_kind: string;
  owner_bmn: string;
  title: string;
  filename: string | null;
  category: string | null;
  download_url: string | null;
}

async function pendingDocuments(env: Env, orgId: string, owners: { kind: string; bmn: string }[], limit: number): Promise<PendingDoc[]> {
  const found: PendingDoc[] = [];
  for (let i = 0; i < owners.length && found.length < limit; i += 30) {
    const slice = owners.slice(i, i + 30);
    const clause = slice.map(() => `(owner_kind = ? AND owner_bmn = ?)`).join(" OR ");
    const params = slice.flatMap((o) => [o.kind, o.bmn]);
    const rows = await all<PendingDoc>(
      env.DB,
      `SELECT remote_id, owner_kind, owner_bmn, title, filename, category, download_url FROM bm_documents
       WHERE org_id = ? AND imported_document_id IS NULL AND error IS NULL AND (${clause}) ORDER BY attempts, remote_id LIMIT ?`,
      orgId,
      ...params,
      limit - found.length,
    );
    found.push(...rows);
  }
  return found;
}

async function countPending(env: Env, orgId: string, owners: { kind: string; bmn: string }[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < owners.length; i += 30) {
    const slice = owners.slice(i, i + 30);
    const clause = slice.map(() => `(owner_kind = ? AND owner_bmn = ?)`).join(" OR ");
    const params = slice.flatMap((o) => [o.kind, o.bmn]);
    const row = await first<{ n: number }>(
      env.DB,
      `SELECT COUNT(*) AS n FROM bm_documents WHERE org_id = ? AND imported_document_id IS NULL AND error IS NULL AND (${clause})`,
      orgId,
      ...params,
    );
    n += row?.n ?? 0;
  }
  return n;
}

export interface ImportProgress {
  createdProperties: number;
  createdBuildings: number;
  importedDocuments: number;
  remainingDocuments: number;
  message: string | null;
  done: boolean;
}

interface ImportCtx {
  waitUntil(promise: Promise<unknown>): void;
  /** Agenten skal ikke tolke PDF-er i samtalen. Køen gjør det etterpå. */
  deferProcessing?: boolean;
}

/** Legger valgte bygg inn i porteføljen og henter noen dokumenter av gangen. */
export async function importSelection(env: Env, orgId: string, actor: BmActor, bmns: string[], ctx: ImportCtx): Promise<ImportProgress> {
  const wanted = [...new Set(bmns.map((b) => b.trim()).filter(Boolean))].slice(0, 200);
  if (wanted.length === 0) throw new ApiError(400, "Velg minst ett bygg");
  const real = wanted.filter((b) => !b.startsWith("unit:"));
  const unitIds = wanted.filter((b) => b.startsWith("unit:")).map((b) => b.slice(5));

  const buildings = await byIds<CacheBuilding>(
    env,
    orgId,
    real,
    `SELECT bmn, building_number, name, address, postal_code, city, municipality, gnr, bnr, building_type, year_built, area_m2, estate_key FROM bm_buildings WHERE org_id = ? AND bmn IN `,
  );
  const units = await byIds<CacheBuilding>(
    env,
    orgId,
    unitIds,
    `SELECT bmn, NULL AS building_number, name, address, postal_code, city, NULL AS municipality, NULL AS gnr, NULL AS bnr, 'Boenhet' AS building_type, NULL AS year_built, NULL AS area_m2, estate_key FROM bm_units WHERE org_id = ? AND bmn IN `,
  );

  let createdProperties = 0;
  let createdBuildings = 0;
  let message: string | null = null;
  const placed: { propertyId: string; buildingId: string | null; owners: { kind: string; bmn: string }[] }[] = [];

  for (const building of buildings) {
    const before = await first<{ id: string }>(env.DB, `SELECT id FROM properties WHERE org_id = ? AND boligmappa_key = ?`, orgId, building.estate_key);
    const propertyId = await ensureProperty(env, orgId, building);
    if (!before) createdProperties++;
    const result = await ensureBuilding(env, orgId, propertyId, building);
    if (result.skipped) {
      message = result.skipped;
      break;
    }
    if (result.created) createdBuildings++;
    const children = await all<{ bmn: string }>(
      env.DB,
      `SELECT bmn FROM bm_units WHERE org_id = ? AND (building_bmn = ? OR (building_number IS NOT NULL AND building_number = ?))`,
      orgId,
      building.bmn,
      building.building_number,
    );
    placed.push({
      propertyId,
      buildingId: result.id,
      owners: [{ kind: "building", bmn: building.bmn }, ...children.map((c) => ({ kind: "unit", bmn: c.bmn }))],
    });
  }

  for (const unit of units) {
    const asBuilding = { ...unit, bmn: `unit:${unit.bmn}` };
    const before = await first<{ id: string }>(env.DB, `SELECT id FROM properties WHERE org_id = ? AND boligmappa_key = ?`, orgId, unit.estate_key);
    const propertyId = await ensureProperty(env, orgId, asBuilding);
    if (!before) createdProperties++;
    placed.push({ propertyId, buildingId: null, owners: [{ kind: "unit", bmn: unit.bmn }] });
  }

  const owners = placed.flatMap((p) => p.owners);
  const pending = await pendingDocuments(env, orgId, owners, DOCS_PER_STEP);
  const importedIds: string[] = [];
  // Ett dokument av gangen, så tre store filer ikke ligger i minnet samtidig.
  for (const doc of pending) {
    const home = placed.find((p) => p.owners.some((o) => o.kind === doc.owner_kind && o.bmn === doc.owner_bmn));
    if (!home) continue;
    try {
      await downloadToPlank(env, orgId, actor, doc, { property_id: home.propertyId, building_id: home.buildingId });
      const id = await first<{ imported_document_id: string }>(env.DB, `SELECT imported_document_id FROM bm_documents WHERE org_id = ? AND remote_id = ?`, orgId, doc.remote_id);
      if (id?.imported_document_id) importedIds.push(id.imported_document_id);
    } catch (err) {
      // Forbigående feil gir nye forsøk senere. Først etter MAX_DOC_ATTEMPTS (eller ved varig feil) merkes dokumentet.
      const permanent = !isTransient(err);
      await env.DB.prepare(
        `UPDATE bm_documents SET attempts = attempts + 1, error = CASE WHEN ? OR attempts + 1 >= ? THEN ? ELSE NULL END WHERE org_id = ? AND remote_id = ?`,
      )
        .bind(permanent ? 1 : 0, MAX_DOC_ATTEMPTS, err instanceof Error ? err.message : "Nedlasting feilet", orgId, doc.remote_id)
        .run();
    }
  }
  if (!ctx.deferProcessing) await scheduleProcessing(env, ctx, orgId, importedIds);
  const importedDocuments = importedIds.length;
  const remaining = await countPending(env, orgId, owners);

  if (createdBuildings > 0 || (importedDocuments > 0 && remaining === 0)) {
    await activityStatement(env, {
      orgId,
      actor,
      action: "boligmappa.imported",
      summary: createdBuildings > 0 ? `Hentet ${createdBuildings} bygg fra Boligmappa` : `Hentet dokumenter fra Boligmappa`,
    }).run();
  }

  return {
    createdProperties,
    createdBuildings,
    importedDocuments,
    remainingDocuments: remaining,
    message,
    done: remaining === 0,
  };
}

async function importedCounts(env: Env, orgId: string): Promise<{ buildings: number; documents: number }> {
  const [b, d] = await Promise.all([
    first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM buildings WHERE org_id = ? AND boligmappa_number IS NOT NULL`, orgId),
    first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM documents WHERE org_id = ? AND boligmappa_id IS NOT NULL`, orgId),
  ]);
  return { buildings: b?.n ?? 0, documents: d?.n ?? 0 };
}

/** Bygg og løse boenheter som kan tas inn, med det som allerede ligger i porteføljen først */
async function importableBmns(env: Env, orgId: string): Promise<{ picks: string[]; overQuota: number; limit: number }> {
  const buildings = await all<{ bmn: string; imported: number }>(
    env.DB,
    `SELECT b.bmn, EXISTS (SELECT 1 FROM buildings x WHERE x.org_id = b.org_id AND x.boligmappa_number = b.bmn) AS imported
     FROM bm_buildings b WHERE b.org_id = ? ORDER BY b.name`,
    orgId,
  );
  const looseUnits = await all<{ bmn: string }>(
    env.DB,
    `SELECT u.bmn FROM bm_units u WHERE u.org_id = ? AND NOT EXISTS (
       SELECT 1 FROM bm_buildings b WHERE b.org_id = u.org_id AND (b.bmn = u.building_bmn OR (u.building_number IS NOT NULL AND b.building_number = u.building_number))
     ) ORDER BY u.name`,
    orgId,
  );
  const used = await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM buildings WHERE org_id = ?`, orgId);
  const limit = await buildingLimit(env, orgId);
  const free = Math.max(0, limit - (used?.n ?? 0));
  const done = buildings.filter((b) => b.imported).map((b) => b.bmn);
  const fresh = buildings.filter((b) => !b.imported).map((b) => b.bmn);
  return {
    picks: [...done, ...fresh.slice(0, free), ...looseUnits.map((u) => `unit:${u.bmn}`)].slice(0, 200),
    overQuota: Math.max(0, fresh.length - free),
    limit,
  };
}

/** Ett steg i automatisk henting: først listene fra Boligmappa, så bygg og dokumenter inn i porteføljen. */
export async function autoImportStep(
  env: Env,
  orgId: string,
  actor: BmActor,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  opts: { force?: boolean } = {},
): Promise<AutoImportStep> {
  const source = await first<SourceRow & { auto_import: number }>(env.DB, `SELECT * FROM bm_sources WHERE org_id = ?`, orgId);
  const counts = await importedCounts(env, orgId);
  const base = {
    phase: source?.phase ?? "buildings",
    buildingCount: source?.building_count ?? 0,
    documentCount: source?.document_count ?? 0,
    importedBuildings: counts.buildings,
    importedDocuments: counts.documents,
    remainingDocuments: null,
    message: null,
    waited: false,
    retryInMs: null,
  };
  if (!source || !boligmappaConfigured(env)) return { ...base, stage: "off" };
  if (!source.auto_import && source.status === "ready") return { ...base, stage: "done" };

  if (source.status !== "ready") {
    // Dokumenter fra listene som alt er hentet, tas inn før neste (kanskje trege) liste, så kunden ser noe med en gang
    if (source.phase === "documents" && (await hasImportableNow(env, orgId))) {
      const step = await importStep(env, orgId, actor, ctx, base, false);
      // Ligger det som venter utenfor kvoten, går vi videre med listene i stedet for å gå i ring
      if (step.importedDocuments > base.importedDocuments || (step.remainingDocuments ?? 0) > 0) return step;
    }
    const step = await syncChunk(env, orgId, false, opts);
    if (step.status === "error" && step.fail_count >= AUTO_OFF_AFTER) {
      await env.DB.prepare(`UPDATE bm_sources SET auto_import = 0 WHERE org_id = ?`).bind(orgId).run();
    }
    return {
      ...base,
      stage: step.status === "error" ? "error" : "sync",
      phase: step.phase,
      buildingCount: step.building_count,
      documentCount: step.document_count,
      message: step.error,
      waited: step.waited,
      retryInMs: step.retryInMs,
    };
  }

  return importStep(env, orgId, actor, ctx, base, true);
}

/** Finnes det dokumenter i cachen som venter på å bli tatt inn? */
async function hasImportableNow(env: Env, orgId: string): Promise<boolean> {
  const row = await first<{ x: number }>(env.DB, `SELECT 1 AS x FROM bm_documents WHERE org_id = ? AND imported_document_id IS NULL AND error IS NULL LIMIT 1`, orgId);
  return Boolean(row);
}

async function importStep(
  env: Env,
  orgId: string,
  actor: BmActor,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  base: Omit<AutoImportStep, "stage">,
  listsReady: boolean,
): Promise<AutoImportStep> {
  const { picks, overQuota, limit } = await importableBmns(env, orgId);
  const quotaNote = overQuota > 0 ? `${overQuota} bygg venter fordi abonnementet dekker ${limit} bygg. Ta kontakt for flere.` : null;
  if (picks.length === 0) {
    if (listsReady) await env.DB.prepare(`UPDATE bm_sources SET auto_import = 0 WHERE org_id = ?`).bind(orgId).run();
    return { ...base, stage: listsReady ? "done" : "import", remainingDocuments: 0, message: quotaNote };
  }
  const result = await importSelection(env, orgId, actor, picks, ctx);
  const after = await importedCounts(env, orgId);
  const done = listsReady && result.done;
  if (done) await env.DB.prepare(`UPDATE bm_sources SET auto_import = 0 WHERE org_id = ?`).bind(orgId).run();
  return {
    ...base,
    stage: done ? "done" : "import",
    importedBuildings: after.buildings,
    importedDocuments: after.documents,
    remainingDocuments: result.remainingDocuments,
    message: result.message ?? quotaNote,
  };
}

/** Cron-kjøringen holder seg godt under grensen på 15 minutter */
const CRON_BUDGET_MS = 9 * 60_000;
const CRON_STEPS_PER_ORG = 40;

/** Cron: fortsetter automatisk henting for organisasjoner som har forlatt trakten før den var ferdig */
export async function runAutoImports(env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
  if (!boligmappaConfigured(env)) return;
  const deadline = Date.now() + CRON_BUDGET_MS;
  const rows = await all<{ org_id: string; user_id: string | null; name: string | null; email: string | null }>(
    env.DB,
    `SELECT s.org_id, u.id AS user_id, u.name, u.email FROM bm_sources s
     LEFT JOIN memberships m ON m.org_id = s.org_id AND m.role = 'owner'
     LEFT JOIN users u ON u.id = m.user_id
     WHERE s.auto_import = 1 AND (s.retry_at IS NULL OR s.retry_at <= ?) GROUP BY s.org_id ORDER BY s.updated_at LIMIT 5`,
    now(),
  );
  for (const row of rows) {
    const actor: BmActor = row.user_id ? { type: "user", id: row.user_id, name: row.name ?? row.email ?? "Bruker" } : { type: "agent", id: "boligmappa", name: "Boligmappa-henting" };
    for (let i = 0; i < CRON_STEPS_PER_ORG && Date.now() < deadline; i++) {
      try {
        const step = await autoImportStep(env, row.org_id, actor, ctx);
        if (step.stage === "done" || step.stage === "off" || step.stage === "error") break;
        if (step.waited) {
          // Lange pauser tar neste cron-kjøring. Korte venter vi ut her.
          const wait = step.retryInMs ?? 2_000;
          if (wait > 60_000 || Date.now() + wait > deadline) break;
          await sleep(wait);
        }
      } catch (err) {
        console.error("Automatisk Boligmappa-henting feilet", row.org_id, err);
        break;
      }
    }
  }
}

const MAX_CHAIN = 500;

export type BoligmappaJob =
  | { kind: "sync"; orgId: string; steps: number }
  | { kind: "import"; orgId: string; actor: BmActor; bmns: string[]; steps: number; refresh: boolean }
  | { kind: "drain"; orgId: string; steps: number };

/** Dokumentlistene merkes ferdige selv om en kort side skjulte resten. Gå gjennom dem på nytt uten å slette det som er lagret. */
async function reopenDocumentLists(env: Env, orgId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE bm_buildings SET docs_fetched_at = NULL, docs_page = 0, docs_attempts = 0, docs_error = NULL WHERE org_id = ?`).bind(orgId),
    env.DB.prepare(`UPDATE bm_units SET docs_fetched_at = NULL, docs_page = 0, docs_attempts = 0, docs_error = NULL WHERE org_id = ?`).bind(orgId),
    env.DB.prepare(`UPDATE bm_sources SET status = 'syncing', phase = 'documents', page = 1, error = NULL, fail_count = 0, retry_at = NULL, updated_at = ? WHERE org_id = ?`).bind(now(), orgId),
  ]);
}

function delaySeconds(ms: number | null | undefined): number {
  if (!ms || ms <= 0) return 0;
  return Math.min(900, Math.ceil(ms / 1000));
}

async function enqueue(env: Env, job: BoligmappaJob, delayMs = 0): Promise<boolean> {
  if (!env.BOLIGMAPPA_QUEUE) return false;
  const delay = delaySeconds(delayMs);
  try {
    await env.BOLIGMAPPA_QUEUE.send(job, delay > 0 ? { delaySeconds: delay } : undefined);
    return true;
  } catch (err) {
    console.error("Klarte ikke å legge Boligmappa i kø", err);
    return false;
  }
}

/** Tolking av PDF skjer i køen. Uten kø gjør HTTP-kallet det i waitUntil, mens agenten lar være. */
async function scheduleProcessing(env: Env, ctx: ImportCtx, orgId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (await enqueue(env, { kind: "drain", orgId, steps: 0 })) return;
  for (const id of ids) ctx.waitUntil(processDocument(env, id));
}

async function enableAutoImport(env: Env, orgId: string): Promise<void> {
  await env.DB.prepare(`UPDATE bm_sources SET auto_import = 1, retry_at = NULL WHERE org_id = ?`).bind(orgId).run();
}

/** Listene er ikke ferdige. Ett steg er kjørt; resten går i kø eller tas av cron. */
export async function continueBoligmappaSync(env: Env, orgId: string, actor: BmActor, delayMs: number | null): Promise<boolean> {
  const queued = await enqueue(env, { kind: "sync", orgId, steps: 0 }, delayMs ?? 0);
  if (!queued) await enableAutoImport(env, orgId);
  await logActivity(env, { orgId, actor, action: "boligmappa.continue", summary: "Fortsetter å hente lister fra Boligmappa" });
  return true;
}

/**
 * Ett importsteg er kjørt. Er det flere dokumenter eller lister igjen, fortsetter køen.
 * Returnerer false når det ikke er mer å hente (eller kvoten stoppet oss).
 */
export async function continueBoligmappaImport(env: Env, orgId: string, actor: BmActor, bmns: string[], res: ImportProgress): Promise<boolean> {
  if (res.message) return false;
  const needsDocs = res.remainingDocuments > 0;
  // refresh går gjennom dokumentlistene på nytt. En kort side kan ha blitt lagret som om den var den siste.
  const queued = await enqueue(env, { kind: "import", orgId, actor, bmns: bmns.slice(0, 200), steps: 0, refresh: true });
  if (!queued) {
    if (needsDocs) await enableAutoImport(env, orgId);
    return needsDocs;
  }
  const summary = needsDocs
    ? `Fortsetter å hente dokumenter fra Boligmappa (${res.remainingDocuments} igjen)`
    : "Sjekker dokumentlistene i Boligmappa på nytt";
  await logActivity(env, { orgId, actor, action: "boligmappa.continue", summary });
  return true;
}

async function runSyncJob(env: Env, job: Extract<BoligmappaJob, { kind: "sync" }>): Promise<void> {
  if (job.steps >= MAX_CHAIN) return;
  const source = await sourceOf(env, job.orgId);
  if (!source || source.status === "ready") return;
  const step = await syncChunk(env, job.orgId, false);
  if (step.status === "ready" || (step.status === "error" && !step.waited)) return;
  await enqueue(env, { ...job, steps: job.steps + 1 }, step.waited ? (step.retryInMs ?? 0) : 0);
}

async function runImportJob(env: Env, job: Extract<BoligmappaJob, { kind: "import" }>, ctx: ExecutionContext): Promise<void> {
  if (job.steps >= MAX_CHAIN) {
    console.warn("Stopper Boligmappa-import, for mange steg", job.orgId);
    return;
  }
  const source = await sourceOf(env, job.orgId);
  if (!source) return;
  if (source.status !== "ready") {
    const step = await syncChunk(env, job.orgId, false);
    if (step.status === "error" && !step.waited) return;
    await enqueue(env, { ...job, steps: job.steps + 1 }, step.waited ? (step.retryInMs ?? 0) : 0);
    return;
  }
  let bmns = job.bmns;
  if (bmns.length === 0) bmns = (await importableBmns(env, job.orgId)).picks;
  if (bmns.length === 0) {
    await enqueue(env, { kind: "drain", orgId: job.orgId, steps: 0 });
    return;
  }
  const res = await importSelection(env, job.orgId, job.actor, bmns, { waitUntil: (p) => ctx.waitUntil(p), deferProcessing: true });
  if (res.message) return;
  if (res.remainingDocuments > 0) {
    await enqueue(env, { ...job, bmns, steps: job.steps + 1 }, res.importedDocuments > 0 ? 0 : 20_000);
    return;
  }
  // Alt som var listet er inne. Gå gjennom listene én gang til, i tilfelle en kort side skjulte resten.
  if (job.refresh) {
    await reopenDocumentLists(env, job.orgId);
    await enqueue(env, { ...job, bmns, refresh: false, steps: job.steps + 1 });
    return;
  }
  await enqueue(env, { kind: "drain", orgId: job.orgId, steps: 0 });
}

async function runDrainJob(env: Env, job: Extract<BoligmappaJob, { kind: "drain" }>): Promise<void> {
  if (job.steps >= MAX_CHAIN) return;
  const row = await first<{ id: string }>(
    env.DB,
    `SELECT id FROM documents WHERE org_id = ? AND status = 'processing' AND boligmappa_id IS NOT NULL ORDER BY created_at LIMIT 1`,
    job.orgId,
  );
  if (!row) return;
  await processDocument(env, row.id);
  await enqueue(env, { ...job, steps: job.steps + 1 });
}

function asJob(value: unknown): BoligmappaJob | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { kind?: string; orgId?: string; steps?: number; actor?: BmActor; bmns?: unknown; refresh?: boolean };
  if (typeof row.orgId !== "string" || typeof row.steps !== "number") return null;
  if (row.kind === "sync" || row.kind === "drain") return { kind: row.kind, orgId: row.orgId, steps: row.steps };
  if (
    row.kind === "import" &&
    row.actor &&
    (row.actor.type === "user" || row.actor.type === "agent") &&
    typeof row.actor.id === "string" &&
    typeof row.actor.name === "string" &&
    Array.isArray(row.bmns)
  ) {
    return {
      kind: "import",
      orgId: row.orgId,
      steps: row.steps,
      actor: { type: row.actor.type, id: row.actor.id, name: row.actor.name },
      bmns: row.bmns.map(String).slice(0, 200),
      refresh: row.refresh === true,
    };
  }
  return null;
}

export async function handleBoligmappaQueue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
  for (const msg of batch.messages) {
    const job = asJob(msg.body);
    if (!job || !boligmappaConfigured(env)) {
      msg.ack();
      continue;
    }
    try {
      if (job.kind === "sync") await runSyncJob(env, job);
      else if (job.kind === "import") await runImportJob(env, job, ctx);
      else await runDrainJob(env, job);
      msg.ack();
    } catch (err) {
      console.error("Boligmappa-kø feilet", job.orgId, err);
      if (err instanceof ApiError && err.status < 500) msg.ack();
      else msg.retry();
    }
  }
}
