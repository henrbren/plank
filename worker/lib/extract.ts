import { DOCUMENT_KINDS, type DocumentExtract, type DocumentKind, type DocumentParty } from "../../shared/types";

const ROLES = new Set<DocumentParty["role"]>(["leverandør", "produsent", "entreprenør", "service"]);

/** Navn som beskriver dokumenttypen, ikke et anlegg. Slike blir ikke en rad i registeret. */
const GENERIC_COMPONENT = new Set([
  "fdv",
  "fdv-dokumentasjon",
  "fdv dokumentasjon",
  "dokumentasjon",
  "dokument",
  "rapport",
  "tegning",
  "avtale",
  "kontrakt",
  "manual",
  "brukermanual",
  "bruksanvisning",
  "vedlikeholdsanvisning",
  "produktdatablad",
  "datablad",
  "vedlegg",
  "samsvarserklæring",
  "sertifikat",
  "kontroll",
  "service",
  "servicerapport",
  "bilde",
  "diverse",
  "ukjent",
  "annet",
  "anlegg",
  "utstyr",
  "komponent",
]);

const GENERIC_COMPANY = new Set(["ukjent", "leverandør", "produsent", "ikke oppgitt", "n/a", "div", "diverse", "-"]);

const REGISTER_KINDS = new Set<DocumentKind>(["fdv", "produktdatablad", "brukermanual", "sertifikat", "kontroll", "avtale", "rapport"]);

export function normName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("nb");
}

function clip(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.slice(0, max);
}

function company(value: unknown): string | null {
  const text = clip(value, 120);
  if (!text || text.length < 2) return null;
  if (GENERIC_COMPANY.has(normName(text))) return null;
  return text;
}

function orgNr(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const digits = String(value).replace(/\D/g, "");
  if (!/^\d{9}$/.test(digits) || /^0+$/.test(digits)) return null;
  return digits;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const month = /^(\d{4})-(\d{2})$/.exec(text);
  if (month) return `${month[1]}-${month[2]}-01`;
  const no = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
  if (!no) return null;
  const day = no[1]!.padStart(2, "0");
  const mon = no[2]!.padStart(2, "0");
  if (Number(day) < 1 || Number(day) > 31 || Number(mon) < 1 || Number(mon) > 12) return null;
  return `${no[3]}-${mon}-${day}`;
}

function months(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,3}$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 1 || n > 120) return null;
  return Math.round(n);
}

function componentName(value: unknown): string | null {
  const text = clip(value, 120);
  if (!text || text.length < 3 || /\.[a-z0-9]{2,5}$/i.test(text)) return null;
  if (GENERIC_COMPONENT.has(normName(text))) return null;
  return text;
}

function tfmOf(value: unknown): string | null {
  const text = clip(value, 40);
  if (!text || !/^[=+]?\d{2,3}([.\-][0-9A-Za-z]+)*$/.test(text)) return null;
  return text;
}

function partiesOf(value: unknown): DocumentParty[] {
  if (!Array.isArray(value)) return [];
  const out: DocumentParty[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const role = typeof rec.role === "string" ? rec.role.trim().toLocaleLowerCase("nb") : "";
    if (!ROLES.has(role as DocumentParty["role"])) continue;
    const name = company(rec.name);
    if (!name) continue;
    out.push({ role: role as DocumentParty["role"], name, org_nr: orgNr(rec.org_nr) });
    if (out.length >= 6) break;
  }
  return out;
}

function emptyExtract(): DocumentExtract {
  return {
    title: null,
    kind: null,
    ns3451: null,
    summary: null,
    component: null,
    component_id: null,
    manufacturer: null,
    model: null,
    serial_number: null,
    tfm: null,
    supplier: null,
    supplier_org_nr: null,
    installed_at: null,
    warranty_until: null,
    last_service_at: null,
    service_interval_months: null,
    parties: [],
  };
}

/** Leser JSON-svaret fra modellen. Ukjente felt og oppdiktede formater blir forkastet. */
export function parseModelExtract(raw: string): DocumentExtract | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as Record<string, unknown>;
  const parties = partiesOf(row.parties);
  const supplier = company(row.supplier) ?? parties.find((p) => p.role === "leverandør")?.name ?? parties.find((p) => p.role === "service")?.name ?? null;
  const supplierParty = parties.find((p) => p.name === supplier);
  const manufacturer = company(row.manufacturer) ?? parties.find((p) => p.role === "produsent")?.name ?? null;
  const kind = typeof row.kind === "string" && row.kind in DOCUMENT_KINDS ? (row.kind as DocumentKind) : null;
  const ns = typeof row.ns3451 === "string" && /^\d{1,4}(\.\d+)?$/.test(row.ns3451.trim()) ? row.ns3451.trim() : null;
  const extract: DocumentExtract = {
    title: clip(row.title, 200),
    kind,
    ns3451: ns,
    summary: clip(row.summary, 600),
    component: componentName(row.component),
    component_id: null,
    manufacturer,
    model: clip(row.model, 120),
    serial_number: clip(row.serial_number, 120),
    tfm: tfmOf(row.tfm),
    supplier,
    supplier_org_nr: orgNr(row.supplier_org_nr) ?? supplierParty?.org_nr ?? null,
    installed_at: isoDate(row.installed_at),
    warranty_until: isoDate(row.warranty_until),
    last_service_at: isoDate(row.last_service_at),
    service_interval_months: months(row.service_interval_months),
    parties,
  };
  const hasFact = extract.component || extract.supplier || extract.manufacturer || extract.model || extract.tfm || extract.parties.length > 0;
  if (!extract.title && !extract.kind && !extract.summary && !extract.ns3451 && !hasFact) return null;
  return extract;
}

/** Gjør lagret JSON om til et uttrekk. Tåler eldre eller ufullstendige rader. */
export function parseStoredExtract(raw: string | null | undefined): DocumentExtract | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DocumentExtract> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const parties = partiesOf(parsed.parties);
    const supplier = company(parsed.supplier);
    return {
      ...emptyExtract(),
      title: clip(parsed.title, 200),
      kind: parsed.kind && parsed.kind in DOCUMENT_KINDS ? parsed.kind : null,
      ns3451: typeof parsed.ns3451 === "string" && /^\d{1,4}(\.\d+)?$/.test(parsed.ns3451) ? parsed.ns3451 : null,
      summary: clip(parsed.summary, 600),
      component: componentName(parsed.component),
      component_id: typeof parsed.component_id === "string" ? parsed.component_id : null,
      manufacturer: company(parsed.manufacturer),
      model: clip(parsed.model, 120),
      serial_number: clip(parsed.serial_number, 120),
      tfm: tfmOf(parsed.tfm),
      supplier,
      supplier_org_nr: orgNr(parsed.supplier_org_nr),
      installed_at: isoDate(parsed.installed_at),
      warranty_until: isoDate(parsed.warranty_until),
      last_service_at: isoDate(parsed.last_service_at),
      service_interval_months: months(parsed.service_interval_months),
      parties,
    };
  } catch {
    return null;
  }
}

/** Beholder et felt når noen har endret det etter forrige uttrekk. Tomme felt og våre egne verdier kan oppdateres. */
export function fillField<T>(current: T | null | undefined, previous: T | null | undefined, next: T | null | undefined): T | null {
  if (next == null || next === "") return current ?? null;
  if (current == null || current === "" || current === previous) return next;
  return current;
}

export interface ComponentMatch {
  id: string;
  name: string;
  tfm: string | null;
  manufacturer: string | null;
  model: string | null;
}

/** Velger eksisterende komponent: TFM først, deretter navn, deretter ett unikt produsent+modell-treff. */
export function pickComponent<T extends ComponentMatch>(rows: T[], extract: DocumentExtract): T | null {
  if (extract.tfm) {
    const tfm = normName(extract.tfm);
    const hits = rows.filter((r) => r.tfm && normName(r.tfm) === tfm);
    if (hits.length === 1) return hits[0]!;
  }
  if (extract.component) {
    const name = normName(extract.component);
    const hit = rows.find((r) => normName(r.name) === name);
    if (hit) return hit;
  }
  if (extract.manufacturer && extract.model) {
    const maker = normName(extract.manufacturer);
    const model = normName(extract.model);
    const hits = rows.filter((r) => r.manufacturer && r.model && normName(r.manufacturer) === maker && normName(r.model) === model);
    if (hits.length === 1) return hits[0]!;
  }
  return null;
}

/** Tegninger og bilder blir ikke egne rader. Et navngitt anlegg fra FDV-papirer blir det. */
export function shouldRegister(kind: DocumentKind | string | null, extract: DocumentExtract): boolean {
  if (!extract.component) return false;
  if (kind === "tegning" || kind === "bilde" || kind === "ifc") return false;
  if (kind && REGISTER_KINDS.has(kind as DocumentKind)) return true;
  return Boolean(extract.supplier || extract.manufacturer);
}
