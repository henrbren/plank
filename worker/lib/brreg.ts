import { ApiError } from "./http";
import { fetchRetry, TransientError } from "./retry";

const BRREG = "https://data.brreg.no/enhetsregisteret/api/enheter";

async function brregFetch(url: string): Promise<Response> {
  try {
    return await fetchRetry(url, { headers: { Accept: "application/json" } }, { label: "Brønnøysundregistrene", timeoutMs: 10_000, budgetMs: 25_000 });
  } catch (err) {
    if (err instanceof TransientError) throw new ApiError(503, "Brønnøysundregistrene svarer ikke akkurat nå. Prøv igjen om litt.");
    throw err;
  }
}

export interface BrregCompany {
  orgNr: string;
  name: string;
  orgForm: string | null;
  orgFormKode: string | null;
  municipal: boolean;
}

function norm(s: string | null | undefined): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

export function isMunicipalOrg(orgForm: string | null, orgFormKode: string | null, name: string): boolean {
  const form = norm(orgForm);
  const kode = String(orgFormKode || "").toUpperCase();
  const n = norm(name);
  if (kode === "KOMM" || kode === "FYLK" || kode === "KF" || kode === "IKS") return true;
  if (form === "kommune" || form.includes("fylkeskommune") || form.includes("kommunalt") || form.includes("interkommunalt")) return true;
  if (/\bkommune\b/.test(n) && !form.includes("as")) return true;
  return false;
}

export function normalizeOrgNr(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 9) throw new ApiError(400, "Organisasjonsnummeret må ha 9 siffer");
  return digits;
}

export interface BrregRole {
  title: string;
  name: string;
}

function personName(navn: unknown): string {
  if (!navn) return "";
  if (typeof navn === "string") return navn;
  const n = navn as { sammensattNavn?: string; fornavn?: string; mellomnavn?: string; etternavn?: string };
  return n.sammensattNavn || [n.fornavn, n.mellomnavn, n.etternavn].filter(Boolean).join(" ");
}

/** Personroller (styreleder, daglig leder osv.) fra Brønnøysund */
export async function brregRoles(orgNr: string): Promise<BrregRole[]> {
  const res = await brregFetch(`${BRREG}/${normalizeOrgNr(orgNr)}/roller`);
  if (res.status === 404) return [];
  if (!res.ok) throw new ApiError(502, "Kunne ikke hente roller fra Brønnøysundregistrene.");
  const json = (await res.json()) as {
    rollegrupper?: { type?: { beskrivelse?: string }; roller?: { type?: { beskrivelse?: string }; person?: { navn?: unknown }; fratraadt?: boolean }[] }[];
  };
  const roles: BrregRole[] = [];
  for (const group of json.rollegrupper ?? []) {
    for (const role of group.roller ?? []) {
      if (!role.person || role.fratraadt) continue;
      const name = personName(role.person.navn);
      if (name) roles.push({ title: role.type?.beskrivelse || group.type?.beskrivelse || "Rolle", name });
    }
  }
  return roles;
}

/** Fornavn og etternavn må finnes i rollen, i hvilken som helst rekkefølge */
export function nameMatches(verified: string, roleName: string): boolean {
  const a = norm(verified).replace(/\s+/g, " ");
  const b = norm(roleName).replace(/\s+/g, " ");
  if (!a || !b) return false;
  return a.split(" ").every((p) => b.includes(p)) || b.split(" ").every((p) => a.includes(p));
}

export async function lookupBrreg(orgNr: string): Promise<BrregCompany> {
  const nr = normalizeOrgNr(orgNr);
  const res = await brregFetch(`${BRREG}/${nr}`);
  if (res.status === 404) throw new ApiError(404, "Organisasjonsnummeret finnes ikke i Brønnøysundregistrene.");
  if (!res.ok) throw new ApiError(502, "Kunne ikke slå opp i Brønnøysundregistrene.");
  const json = (await res.json()) as {
    navn?: string;
    organisasjonsform?: { beskrivelse?: string; kode?: string };
  };
  const name = (json.navn || "").trim();
  if (!name) throw new ApiError(502, "Brønnøysund svarte uten navn.");
  const orgForm = json.organisasjonsform?.beskrivelse ?? null;
  const orgFormKode = json.organisasjonsform?.kode ?? null;
  return {
    orgNr: nr,
    name,
    orgForm,
    orgFormKode,
    municipal: isMunicipalOrg(orgForm, orgFormKode, name),
  };
}
