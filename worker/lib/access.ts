import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Env } from "../env";
import { all, first } from "./db";
import { forbidden, notFound } from "./http";

/**
 * Hva innlogget bruker får se og gjøre i organisasjonen.
 * Settes av requireOrg for hver forespørsel og leses av tjenestene, slik at ruter og agentverktøy
 * håndheves likt. Uten forespørsel (cron, bakgrunnsjobber) gjelder full tilgang.
 */
export interface Access {
  userId: string | null;
  admin: boolean;
  canEdit: boolean;
  /** null = hele porteføljen */
  scope: AccessScope | null;
  expiresAt: number | null;
}

export interface AccessScope {
  /** Eiendommer med full tilgang (alle bygg, også nye) */
  properties: string[];
  /** Alle bygg brukeren ser */
  buildings: string[];
  /** Eiendommer som vises fordi brukeren ser minst ett bygg der */
  visibleProperties: string[];
}

export interface Place {
  property_id?: string | null;
  building_id?: string | null;
}

export interface MembershipAccessRow {
  role: "owner" | "admin" | "member";
  can_edit: number;
  scope: "all" | "limited";
  expires_at: number | null;
}

export const FULL_ACCESS: Access = { userId: null, admin: true, canEdit: true, scope: null, expiresAt: null };

const store = new AsyncLocalStorage<Access>();

export function runWithAccess<T>(access: Access, fn: () => T): T {
  return store.run(access, fn);
}

export function currentAccess(): Access {
  return store.getStore() ?? FULL_ACCESS;
}

export async function loadAccess(env: Env, orgId: string, userId: string, m: MembershipAccessRow): Promise<Access> {
  const admin = m.role === "owner" || m.role === "admin";
  if (admin) return { userId, admin, canEdit: true, scope: null, expiresAt: null };
  const base = { userId, admin, canEdit: m.can_edit === 1, expiresAt: m.expires_at };
  if (m.scope !== "limited") return { ...base, scope: null };
  const rows = await all<{ entity_type: "property" | "building"; entity_id: string }>(
    env.DB,
    `SELECT entity_type, entity_id FROM membership_scope WHERE org_id = ? AND user_id = ?`,
    orgId,
    userId,
  );
  const props = rows.filter((r) => r.entity_type === "property").map((r) => r.entity_id);
  const blds = rows.filter((r) => r.entity_type === "building").map((r) => r.entity_id);
  const buildings = await all<{ id: string; property_id: string }>(
    env.DB,
    `SELECT id, property_id FROM buildings WHERE org_id = ? AND (property_id IN (SELECT value FROM json_each(?)) OR id IN (SELECT value FROM json_each(?)))`,
    orgId,
    JSON.stringify(props),
    JSON.stringify(blds),
  );
  return {
    ...base,
    scope: {
      properties: props,
      buildings: buildings.map((b) => b.id),
      visibleProperties: [...new Set([...props, ...buildings.map((b) => b.property_id)])],
    },
  };
}

export const isLimited = (a = currentAccess()) => a.scope !== null;

/** Ser brukeren noe som ligger på dette stedet? Uten bygg kreves full tilgang til eiendommen. */
export function sees(place: Place, a = currentAccess()): boolean {
  if (!a.scope) return true;
  if (place.building_id) return a.scope.buildings.includes(place.building_id);
  if (place.property_id) return a.scope.properties.includes(place.property_id);
  return false;
}

/** Eiendommen vises (men kan være delvis) */
export function seesProperty(id: string, a = currentAccess()): boolean {
  return !a.scope || a.scope.visibleProperties.includes(id);
}

export function assertSees(place: Place, what: string) {
  if (!sees(place)) throw notFound(what);
}

export const READ_ONLY_MESSAGE = "Du har lesetilgang og kan ikke endre noe her. Be en administrator om redigeringstilgang.";

/** Krever redigeringstilgang, og at stedet (hvis oppgitt) er innenfor tilgangen */
export function assertCanEdit(place?: Place) {
  const a = currentAccess();
  if (!a.canEdit) throw forbidden(READ_ONLY_MESSAGE);
  if (place && !sees(place, a)) {
    throw forbidden(a.scope && !place.building_id && !place.property_id ? "Velg et bygg eller en eiendom du har tilgang til" : "Du har ikke tilgang til dette bygget eller denne eiendommen");
  }
}

export function assertFullScope(what = "Dette") {
  if (currentAccess().scope) throw forbidden(`${what} krever tilgang til hele porteføljen`);
}

/**
 * SQL-ledd som begrenser til brukerens tilgang. `building` og `property` er kolonnenavn.
 * Med begge: rader med bygg må ha bygget i tilgangen, rader med bare eiendom krever full eiendomstilgang.
 * Med bare `property` (eiendomstabellen): eiendommer som vises.
 */
export function scopeSql(cols: { building?: string; property?: string }, a = currentAccess()): { sql: string; params: string[] } {
  if (!a.scope) return { sql: "1 = 1", params: [] };
  const parts: string[] = [];
  const params: string[] = [];
  if (cols.building) {
    parts.push(`${cols.building} IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(a.scope.buildings));
  }
  if (cols.property) {
    parts.push(cols.building ? `(${cols.building} IS NULL AND ${cols.property} IN (SELECT value FROM json_each(?)))` : `${cols.property} IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(cols.building ? a.scope.properties : a.scope.visibleProperties));
  }
  return { sql: `(${parts.join(" OR ")})`, params };
}

/** Filtrerer aktivitetsloggen på hva brukeren ser (alias for activity-tabellen er a) */
export function activityScopeSql(alias = "a", a = currentAccess()): { sql: string; params: string[] } {
  if (!a.scope) return { sql: "1 = 1", params: [] };
  const b = JSON.stringify(a.scope.buildings);
  const fullProps = JSON.stringify(a.scope.properties);
  const visibleProps = JSON.stringify(a.scope.visibleProperties);
  const inB = `IN (SELECT value FROM json_each(?))`;
  const placed = (table: string) =>
    `(${alias}.entity_type = '${table.slice(0, -1)}' AND ${alias}.entity_id IN (SELECT id FROM ${table} WHERE building_id ${inB} OR (building_id IS NULL AND property_id ${inB})))`;
  return {
    sql: `(
      (${alias}.entity_type = 'property' AND ${alias}.entity_id ${inB})
      OR (${alias}.entity_type = 'building' AND ${alias}.entity_id ${inB})
      OR (${alias}.entity_type = 'floor' AND ${alias}.entity_id IN (SELECT id FROM floors WHERE building_id ${inB}))
      OR (${alias}.entity_type = 'room' AND ${alias}.entity_id IN (SELECT id FROM rooms WHERE building_id ${inB}))
      OR (${alias}.entity_type = 'component' AND ${alias}.entity_id IN (SELECT id FROM components WHERE building_id ${inB}))
      OR ${placed("documents")}
      OR ${placed("tasks")}
      OR ${placed("artifacts")}
    )`,
    params: [visibleProps, b, b, b, b, b, fullProps, b, fullProps, b, fullProps],
  };
}

export type PlaceKind = "property" | "building" | "floor" | "room" | "component" | "document" | "task" | "artifact";

const LOCATE: Record<PlaceKind, string> = {
  property: `SELECT id AS property_id, NULL AS building_id FROM properties WHERE id = ? AND org_id = ?`,
  building: `SELECT property_id, id AS building_id FROM buildings WHERE id = ? AND org_id = ?`,
  floor: `SELECT NULL AS property_id, building_id FROM floors WHERE id = ? AND org_id = ?`,
  room: `SELECT NULL AS property_id, building_id FROM rooms WHERE id = ? AND org_id = ?`,
  component: `SELECT NULL AS property_id, building_id FROM components WHERE id = ? AND org_id = ?`,
  document: `SELECT property_id, building_id FROM documents WHERE id = ? AND org_id = ?`,
  task: `SELECT property_id, building_id FROM tasks WHERE id = ? AND org_id = ?`,
  artifact: `SELECT property_id, building_id FROM artifacts WHERE id = ? AND org_id = ?`,
};

/** Hvor en ting ligger (eiendom/bygg), eller null om den ikke finnes */
export async function locate(env: Env, orgId: string, kind: PlaceKind, id: string): Promise<Place | null> {
  return first<Place>(env.DB, LOCATE[kind], id, orgId);
}

/** Kan brukeren endre denne tingen? Eiendommer krever full eiendomstilgang. */
export async function assertCanEditEntity(env: Env, orgId: string, kind: PlaceKind, id: string, what: string) {
  const a = currentAccess();
  if (!a.canEdit) throw forbidden(READ_ONLY_MESSAGE);
  if (!a.scope) return;
  const place = await locate(env, orgId, kind, id);
  if (!place) throw notFound(what);
  if (!sees(place, a)) throw notFound(what);
}

const READ_ONLY_ALLOWED = [
  { method: "POST", path: /^\/api\/orgs\/[^/]+\/conversations\/?$/ },
  { method: "POST", path: /^\/api\/orgs\/[^/]+\/conversations\/[^/]+\/messages$/ },
  { method: "PATCH", path: /^\/api\/orgs\/[^/]+\/conversations\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/orgs\/[^/]+\/conversations\/[^/]+$/ },
];

/** Lesetilgang: stopper alle endringer, men brukeren kan fortsatt snakke med agentene */
export const readOnlyGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD" && !currentAccess().canEdit) {
    const path = c.req.path;
    if (!READ_ONLY_ALLOWED.some((r) => r.method === m && r.path.test(path))) throw forbidden(READ_ONLY_MESSAGE);
  }
  await next();
};
