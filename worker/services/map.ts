import type { PropertyMap, PropertyMapPoint } from "../../shared/types";
import type { Env } from "../env";
import { scopeSql } from "../lib/access";
import { all } from "../lib/db";
import { now } from "../lib/util";

const GEO_URL = "https://ws.geonorge.no/adresser/v1/sok";
/** Nye oppslag per forespørsel, så kartet svarer selv om porteføljen er stor. */
const LOOKUP_LIMIT = 6;
const WALL_MS = 12_000;
const CALL_MS = 6_000;

interface MapRow {
  id: string;
  name: string;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  building_count: number;
  geo_query: string | null;
  geo_lat: number | null;
  geo_lon: number | null;
}

interface BuildingAddress {
  property_id: string;
  address: string | null;
  postal_code: string | null;
  city: string | null;
}

interface GeoHit {
  adressetekst?: string;
  postnummer?: string;
  nummer?: number | string | null;
  bokstav?: string | null;
  representasjonspunkt?: { lat?: number; lon?: number };
}

interface AddressQuery {
  street: string;
  postal: string;
  city: string;
  key: string;
}

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function addressQuery(street: string, postal: string, city: string): AddressQuery {
  return { street, postal, city, key: `${street.toLowerCase()}|${postal}|${city.toLowerCase()}` };
}

/** Husnummer på slutten av adresselinjen, f.eks. «Karl Johans gate 1B». */
function houseNumber(street: string): { number: string; letter: string } | null {
  const match = street.match(/(\d+)\s*([A-Za-zÆØÅæøå])?$/);
  if (!match) return null;
  return { number: match[1]!, letter: (match[2] ?? "").toUpperCase() };
}

function inNorway(lat: number, lon: number): boolean {
  return lat >= 57 && lat <= 82 && lon >= -10 && lon <= 35;
}

function pickHit(query: AddressQuery, hits: GeoHit[]): { lat: number; lon: number } | null {
  const wantedPostal = query.postal.replace(/\s/g, "");
  const number = houseNumber(query.street);
  const matches = hits.filter((hit) => {
    const lat = hit.representasjonspunkt?.lat;
    const lon = hit.representasjonspunkt?.lon;
    if (typeof lat !== "number" || typeof lon !== "number" || !inNorway(lat, lon)) return false;
    if (wantedPostal && hit.postnummer && hit.postnummer.replace(/\s/g, "") !== wantedPostal) return false;
    if (number) {
      if (hit.nummer == null || String(hit.nummer) !== number.number) return false;
      const letter = (hit.bokstav ?? "").trim().toUpperCase();
      if (number.letter && letter && letter !== number.letter) return false;
    }
    return true;
  });
  // Uten postnummer og husnummer er «Storgata 1» tvetydig. Da krever vi ett treff.
  if (!wantedPostal && !number && matches.length !== 1) return null;
  const hit = matches[0];
  if (!hit?.representasjonspunkt) return null;
  return { lat: hit.representasjonspunkt.lat!, lon: hit.representasjonspunkt.lon! };
}

async function lookup(query: AddressQuery): Promise<{ lat: number; lon: number } | null> {
  const url = new URL(GEO_URL);
  url.searchParams.set("adressetekst", query.street);
  if (query.postal) url.searchParams.set("postnummer", query.postal);
  url.searchParams.set("treffPerSide", "5");
  url.searchParams.set("fuzzy", "false");
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "Plank (plank.vixon.no)" },
    signal: AbortSignal.timeout(CALL_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Geonorge ${res.status}`);
  const body = (await res.json()) as { adresser?: GeoHit[] };
  return pickHit(query, body.adresser ?? []);
}

async function remember(env: Env, orgId: string, propertyId: string, query: string, point: { lat: number; lon: number } | null) {
  await env.DB.prepare(
    `INSERT INTO property_geocodes (property_id, org_id, query, lat, lon, looked_up_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(property_id) DO UPDATE SET
       query = excluded.query,
       lat = excluded.lat,
       lon = excluded.lon,
       looked_up_at = excluded.looked_up_at
     WHERE property_geocodes.org_id = excluded.org_id`,
  )
    .bind(propertyId, orgId, query, point?.lat ?? null, point?.lon ?? null, now())
    .run();
}

/**
 * Eiendommer med koordinater. Adressen slås opp hos Kartverket første gang,
 * og på nytt bare når adressen er endret. Mangler eiendommen adresse, brukes
 * adressen fra Boligmappa-cachen på det første bygget.
 */
export async function propertyMap(env: Env, orgId: string): Promise<PropertyMap> {
  const props = scopeSql({ property: "p.id" });
  const blds = scopeSql({ building: "b.id" });
  const rows = await all<MapRow>(
    env.DB,
    `SELECT p.id, p.name, p.address, p.postal_code, p.city,
       (SELECT COUNT(*) FROM buildings b WHERE b.property_id = p.id AND ${blds.sql}) AS building_count,
       g.query AS geo_query, g.lat AS geo_lat, g.lon AS geo_lon
     FROM properties p
     LEFT JOIN property_geocodes g ON g.property_id = p.id AND g.org_id = p.org_id
     WHERE p.org_id = ? AND ${props.sql}
     ORDER BY p.name`,
    ...blds.params,
    orgId,
    ...props.params,
  );
  // Bygg har ikke egen adresse. Boligmappa-cachen har den, koblet via bygningsnummeret.
  const buildings = await all<BuildingAddress>(
    env.DB,
    `SELECT b.property_id, bm.address, bm.postal_code, bm.city
     FROM buildings b
     JOIN bm_buildings bm ON bm.org_id = b.org_id AND bm.bmn = b.boligmappa_number
     WHERE b.org_id = ? AND bm.address IS NOT NULL AND trim(bm.address) != '' AND ${blds.sql}
     ORDER BY b.name`,
    orgId,
    ...blds.params,
  );
  const buildingAddress = new Map<string, BuildingAddress>();
  for (const building of buildings) {
    if (!buildingAddress.has(building.property_id)) buildingAddress.set(building.property_id, building);
  }

  const points: PropertyMapPoint[] = [];
  const todo: { id: string; query: AddressQuery }[] = [];
  for (const row of rows) {
    const ownStreet = norm(row.address);
    const fallback = ownStreet ? null : buildingAddress.get(row.id);
    const street = ownStreet || norm(fallback?.address);
    const postal = ownStreet ? norm(row.postal_code) : norm(fallback?.postal_code);
    const city = ownStreet ? norm(row.city) : norm(fallback?.city);
    const from = street ? (ownStreet ? "property" : "building") : null;
    const base = {
      id: row.id,
      name: row.name,
      address: street || null,
      postal_code: postal || null,
      city: city || null,
      address_from: from as PropertyMapPoint["address_from"],
      building_count: row.building_count,
    };
    if (!street) {
      points.push({ ...base, lat: null, lon: null, geo: "none" });
      continue;
    }
    const query = addressQuery(street, postal, city);
    if (row.geo_query === query.key) {
      const placed = row.geo_lat != null && row.geo_lon != null;
      points.push({
        ...base,
        lat: placed ? row.geo_lat : null,
        lon: placed ? row.geo_lon : null,
        geo: placed ? "ok" : "miss",
      });
      continue;
    }
    points.push({ ...base, lat: null, lon: null, geo: "pending" });
    todo.push({ id: row.id, query });
  }

  const started = Date.now();
  let looked = 0;
  let failed = false;
  for (const item of todo) {
    if (looked >= LOOKUP_LIMIT || Date.now() - started > WALL_MS) break;
    try {
      const point = await lookup(item.query);
      await remember(env, orgId, item.id, item.query.key, point);
      const target = points.find((p) => p.id === item.id);
      if (target) {
        target.lat = point?.lat ?? null;
        target.lon = point?.lon ?? null;
        target.geo = point ? "ok" : "miss";
      }
      looked += 1;
    } catch (err) {
      failed = true;
      console.error("Adressesøk feilet", err instanceof Error ? err.message : err);
      break;
    }
  }

  const pending = !failed && todo.length > looked;
  return {
    points,
    pending,
    warning: failed ? "Adressesøket svarte ikke. Last siden på nytt for å prøve igjen." : null,
  };
}
