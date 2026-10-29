import type { Env } from "../env";
import { activityStatement, logActivity } from "../lib/activity";
import { all, first, insert } from "../lib/db";
import { assertCanAddBuilding } from "../lib/billing";
import { kindOf } from "../lib/boligmappa";
import { guessMime, processDocument } from "../lib/documents";
import { ApiError, badRequest, notFound } from "../lib/http";
import {
  assertReadOnly,
  forgetTokens,
  hostOf,
  laftDownload,
  laftGraphql,
  laftLink,
  laftRef,
  orgAccount,
  requireOrgAccount,
  type LaftAccountRow,
} from "../lib/laft";
import { newId, now, parseJson, truncate } from "../lib/util";
import type {
  LaftAccountInfo,
  LaftBuilding,
  LaftDashboard,
  LaftDocumentNode,
  LaftImportStep,
  LaftStatus,
  LaftWorkOrder,
  LaftWorkOrderList,
  ToolGroup,
} from "../../shared/types";

export interface Actor {
  type: "user" | "agent";
  id: string;
  name: string;
}

type WaitUntil = (p: Promise<unknown>) => void;

// ─── Status og tilkobling ────────────────────────────────────────────────────

export function laftConfigured(env: Env): boolean {
  return Boolean(env.LAFT_TOKEN_KEY) || env.DEV_MODE === "true";
}

export function accountInfo(a: LaftAccountRow): LaftAccountInfo {
  return {
    id: a.id,
    serverName: a.server_name,
    serverUrl: a.server_url,
    host: hostOf(a.server_url),
    name: a.name,
    email: a.email,
    role: a.role,
    areaName: a.area_name,
    status: a.refresh_enc ? a.status : "expired",
    error: a.error,
    refreshedAt: a.refreshed_at,
  };
}

export async function laftStatus(env: Env, orgId: string, userId: string): Promise<LaftStatus> {
  const account = await orgAccount(env, orgId);
  const [owner, mine, agents, buildings, documents] = await Promise.all([
    account?.user_id ? first<{ name: string | null; email: string }>(env.DB, `SELECT name, email FROM users WHERE id = ?`, account.user_id) : Promise.resolve(null),
    all<LaftAccountRow>(env.DB, `SELECT * FROM laft_accounts WHERE user_id = ? AND refresh_enc IS NOT NULL AND status = 'ok' ORDER BY updated_at DESC LIMIT 10`, userId),
    all<{ tools: string }>(env.DB, `SELECT tools FROM agents WHERE org_id = ?`, orgId),
    first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM buildings WHERE org_id = ? AND laft_ref IS NOT NULL`, orgId),
    first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM documents WHERE org_id = ? AND laft_ref IS NOT NULL`, orgId),
  ]);
  const tools = agents.map((a) => parseJson<string[]>(a.tools, []));
  return {
    configured: laftConfigured(env),
    account: account ? { ...accountInfo(account), connectedBy: owner ? owner.name || owner.email : null, mine: account.user_id === userId } : null,
    available: mine.filter((a) => a.id !== account?.id).map(accountInfo),
    agents: { total: agents.length, read: tools.filter((t) => t.includes("laft")).length, write: tools.filter((t) => t.includes("laft_write")).length },
    imported: { buildings: buildings?.n ?? 0, documents: documents?.n ?? 0 },
  };
}

/** Gir alle agentene i organisasjonen verktøygruppene (de som mangler). */
export async function grantAgents(env: Env, orgId: string, groups: ToolGroup[]): Promise<number> {
  const rows = await all<{ id: string; tools: string }>(env.DB, `SELECT id, tools FROM agents WHERE org_id = ?`, orgId);
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    const tools = parseJson<string[]>(r.tools, []);
    const missing = groups.filter((g) => !tools.includes(g));
    if (missing.length === 0) continue;
    stmts.push(env.DB.prepare(`UPDATE agents SET tools = ?, updated_at = ? WHERE id = ? AND org_id = ?`).bind(JSON.stringify([...tools, ...missing]), t, r.id, orgId));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

export async function connectOrg(env: Env, orgId: string, account: LaftAccountRow, actor: Actor): Promise<{ agentsGranted: number }> {
  await env.DB.prepare(`UPDATE orgs SET laft_account_id = ? WHERE id = ?`).bind(account.id, orgId).run();
  const agentsGranted = await grantAgents(env, orgId, ["laft", "laft_import"]);
  await logActivity(env, {
    orgId,
    actor,
    action: "laft.connected",
    summary: `Koblet til LAFT${account.area_name ? ` – ${account.area_name}` : ""} (${hostOf(account.server_url)})`,
  });
  return { agentsGranted };
}

export async function disconnectOrg(env: Env, orgId: string, actor: Actor): Promise<void> {
  const account = await orgAccount(env, orgId);
  if (!account) return;
  await env.DB.prepare(`UPDATE orgs SET laft_account_id = NULL WHERE id = ?`).bind(orgId).run();
  const others = await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM orgs WHERE laft_account_id = ?`, account.id);
  if (!others?.n) await forgetTokens(env, account.id);
  buildingCache.delete(`${account.id}:list`);
  buildingCache.delete(`${account.id}:full`);
  await logActivity(env, { orgId, actor, action: "laft.disconnected", summary: "Koblet fra LAFT" });
}

// ─── Bygg ────────────────────────────────────────────────────────────────────

interface RawRoom {
  id: string;
  name?: string | null;
  roomNumber?: string | null;
  usableArea?: number | null;
}
interface RawFloor {
  id: string;
  name?: string | null;
  floorNumber?: number | null;
  rooms?: RawRoom[] | null;
}
interface RawBuilding {
  id: string;
  name: string;
  addressStreet: string | null;
  addressCity: string | null;
  zipCode: string | null;
  lat: number | null;
  lon: number | null;
  displayImageUrl: string | null;
  buildingtype: { name: string } | null;
  floors: RawFloor[] | null;
}

const BUILDING_FIELDS = `id name addressStreet addressCity zipCode lat lon displayImageUrl buildingtype { name }`;
const BUILDINGS_LIST = `query PlankBuildings($first: Int, $after: String) {
  buildings(first: $first, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${BUILDING_FIELDS} floors { id rooms { id } } } }
}`;
const BUILDINGS_FULL = `query PlankBuildingsFull($first: Int, $after: String) {
  buildings(first: $first, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${BUILDING_FIELDS} floors { id name floorNumber rooms { id name roomNumber usableArea } } } }
}`;

/** LAFT-byggene endres sjelden – vi holder dem et par minutter i minnet per isolat. */
const buildingCache = new Map<string, { at: number; data: RawBuilding[] }>();
const CACHE_MS = 2 * 60 * 1000;

async function fetchBuildings(env: Env, account: LaftAccountRow, full: boolean): Promise<RawBuilding[]> {
  const key = `${account.id}:${full ? "full" : "list"}`;
  const hit = buildingCache.get(key) ?? (full ? null : buildingCache.get(`${account.id}:full`));
  if (hit && now() - hit.at < CACHE_MS) return hit.data;
  const out: RawBuilding[] = [];
  let after: string | null = null;
  for (let page = 0; page < 80; page++) {
    const pageData: { buildings: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: (RawBuilding | null)[] } } = (
      await laftGraphql<{ buildings: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: (RawBuilding | null)[] } }>(
        env,
        account,
        full ? BUILDINGS_FULL : BUILDINGS_LIST,
        { first: full ? 40 : 100, after },
      )
    ).data;
    out.push(...(pageData.buildings.nodes ?? []).filter((b): b is RawBuilding => Boolean(b)));
    if (!pageData.buildings.pageInfo?.hasNextPage || !pageData.buildings.pageInfo.endCursor) break;
    after = pageData.buildings.pageInfo.endCursor;
  }
  buildingCache.set(key, { at: now(), data: out });
  return out;
}

function absoluteImage(serverUrl: string, url: string | null): string | null {
  if (!url) return null;
  if (/^https:\/\//.test(url)) return url;
  if (url.startsWith("/")) return laftLink(serverUrl, url);
  return null;
}

async function linkedBuildings(env: Env, orgId: string): Promise<Map<string, string>> {
  const rows = await all<{ id: string; laft_ref: string }>(env.DB, `SELECT id, laft_ref FROM buildings WHERE org_id = ? AND laft_ref IS NOT NULL`, orgId);
  return new Map(rows.map((r) => [r.laft_ref, r.id]));
}

export async function listBuildings(env: Env, orgId: string): Promise<LaftBuilding[]> {
  const account = await requireOrgAccount(env, orgId);
  const [raw, linked] = await Promise.all([fetchBuildings(env, account, false), linkedBuildings(env, orgId)]);
  return raw
    .map((b) => ({
      id: String(b.id),
      name: b.name,
      address: b.addressStreet?.trim() || null,
      zip: b.zipCode?.trim() || null,
      city: b.addressCity?.trim() || null,
      type: b.buildingtype?.name ?? null,
      lat: b.lat ?? null,
      lon: b.lon ?? null,
      floors: b.floors?.length ?? 0,
      rooms: (b.floors ?? []).reduce((n, f) => n + (f.rooms?.length ?? 0), 0),
      imageUrl: absoluteImage(account.server_url, b.displayImageUrl),
      plankBuildingId: linked.get(laftRef(account.server_url, b.id)) ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "nb"));
}

/** Etasjer og rom i ett LAFT-bygg */
export async function getBuildingStructure(env: Env, orgId: string, laftBuildingId: string) {
  const account = await requireOrgAccount(env, orgId);
  const b = (await fetchBuildings(env, account, true)).find((x) => String(x.id) === String(laftBuildingId));
  if (!b) throw notFound("Bygget i LAFT");
  const plankId = (await linkedBuildings(env, orgId)).get(laftRef(account.server_url, b.id)) ?? null;
  return {
    id: String(b.id),
    name: b.name,
    address: [b.addressStreet, [b.zipCode, b.addressCity].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null,
    type: b.buildingtype?.name ?? null,
    plank_building_id: plankId,
    laft_url: laftLink(account.server_url, `buildings/${b.id}`),
    floors: (b.floors ?? []).map((f) => ({
      id: String(f.id),
      name: f.name,
      floor_number: f.floorNumber ?? null,
      rooms: (f.rooms ?? []).map((r) => ({ id: String(r.id), name: r.name, number: r.roomNumber || null, area: r.usableArea ?? null })),
    })),
  };
}

/** Plank-bygg → LAFT-bygg-ID (eller LAFT-ID rett igjennom) */
export async function resolveLaftBuildingId(env: Env, orgId: string, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const s = String(id).trim();
  if (/^\d+$/.test(s)) return s;
  const row = await first<{ laft_ref: string | null }>(env.DB, `SELECT laft_ref FROM buildings WHERE id = ? AND org_id = ?`, s, orgId);
  if (!row) throw notFound("Bygget");
  if (!row.laft_ref) throw badRequest("Bygget er ikke hentet fra LAFT. Bruk LAFT-ID-en fra laft_buildings.");
  return row.laft_ref.slice(row.laft_ref.lastIndexOf(":") + 1);
}

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const norm = (s: string) => clean(s).toLowerCase();

function levelMapper(floors: RawFloor[]): (n: number | null | undefined) => number {
  const nums = floors.map((f) => f.floorNumber ?? 0);
  const hasZero = nums.includes(0);
  return (n) => {
    const v = n ?? 0;
    if (v >= 1) return v - 1;
    return hasZero ? v - 1 : v;
  };
}

async function importOne(env: Env, orgId: string, account: LaftAccountRow, b: RawBuilding, step: LaftImportStep): Promise<string | null> {
  const t = now();
  const host = hostOf(account.server_url);
  const ref = laftRef(account.server_url, b.id);
  let building = await first<{ id: string; name: string; building_type: string | null }>(env.DB, `SELECT id, name, building_type FROM buildings WHERE org_id = ? AND laft_ref = ?`, orgId, ref);
  if (!building) {
    try {
      await assertCanAddBuilding(env, orgId);
    } catch (err) {
      return err instanceof Error ? err.message : "Kvoten for bygg er nådd";
    }
    const street = clean(b.addressStreet);
    const city = clean(b.addressCity);
    const key = street ? `${host}:adr:${norm(street)}|${norm(city || b.zipCode || "")}` : `${host}:bld:${b.id}`;
    let prop = await first<{ id: string }>(env.DB, `SELECT id FROM properties WHERE org_id = ? AND laft_key = ?`, orgId, key);
    if (!prop) {
      prop = { id: newId("prp") };
      await insert(env.DB, "properties", {
        id: prop.id,
        org_id: orgId,
        name: (street || clean(b.name) || "Eiendom").slice(0, 200),
        address: street || null,
        postal_code: clean(b.zipCode) || null,
        city: city || null,
        laft_key: key,
        created_at: t,
        updated_at: t,
      }).run();
      step.createdProperties++;
    }
    building = { id: newId("bld"), name: clean(b.name) || "Bygg", building_type: b.buildingtype?.name ?? null };
    await insert(env.DB, "buildings", {
      id: building.id,
      org_id: orgId,
      property_id: prop.id,
      name: building.name.slice(0, 200),
      building_type: building.building_type,
      laft_ref: ref,
      created_at: t,
      updated_at: t,
    }).run();
    step.createdBuildings++;
  } else if (building.name !== clean(b.name) || (b.buildingtype?.name && building.building_type !== b.buildingtype.name)) {
    await env.DB.prepare(`UPDATE buildings SET name = ?, building_type = COALESCE(?, building_type), updated_at = ? WHERE id = ?`)
      .bind(clean(b.name) || building.name, b.buildingtype?.name ?? null, t, building.id)
      .run();
    step.updatedBuildings++;
  }

  // Etasjer
  const floors = b.floors ?? [];
  const levelOf = levelMapper(floors);
  const existingFloors = await all<{ id: string; laft_ref: string | null; name: string; level: number }>(env.DB, `SELECT id, laft_ref, name, level FROM floors WHERE org_id = ? AND building_id = ?`, orgId, building.id);
  const floorByRef = new Map(existingFloors.filter((f) => f.laft_ref).map((f) => [f.laft_ref!, f]));
  const floorIds = new Map<string, string>();
  const floorStmts: D1PreparedStatement[] = [];
  for (const f of floors) {
    const fref = laftRef(account.server_url, f.id);
    const name = (clean(f.name) || `${(f.floorNumber ?? 1)}. etasje`).slice(0, 200);
    const level = levelOf(f.floorNumber);
    const found = floorByRef.get(fref);
    if (found) {
      floorIds.set(String(f.id), found.id);
      if (found.name !== name || found.level !== level) floorStmts.push(env.DB.prepare(`UPDATE floors SET name = ?, level = ?, updated_at = ? WHERE id = ?`).bind(name, level, t, found.id));
    } else {
      const id = newId("flr");
      floorIds.set(String(f.id), id);
      floorStmts.push(insert(env.DB, "floors", { id, org_id: orgId, building_id: building.id, name, level, laft_ref: fref, created_at: t, updated_at: t }));
      step.createdFloors++;
    }
  }
  for (let i = 0; i < floorStmts.length; i += 50) await env.DB.batch(floorStmts.slice(i, i + 50));

  // Rom
  const existingRooms = await all<{ id: string; laft_ref: string | null; name: string; number: string | null; area: number | null; floor_id: string }>(
    env.DB,
    `SELECT id, laft_ref, name, number, area, floor_id FROM rooms WHERE org_id = ? AND building_id = ?`,
    orgId,
    building.id,
  );
  const roomByRef = new Map(existingRooms.filter((r) => r.laft_ref).map((r) => [r.laft_ref!, r]));
  const fresh: { i: string; f: string; n: string; u: string | null; a: number | null; r: string }[] = [];
  const roomStmts: D1PreparedStatement[] = [];
  for (const f of floors) {
    const floorId = floorIds.get(String(f.id));
    if (!floorId) continue;
    for (const r of f.rooms ?? []) {
      const rref = laftRef(account.server_url, r.id);
      const number = clean(r.roomNumber) || null;
      const name = (clean(r.name) || number || "Rom").slice(0, 200);
      const area = typeof r.usableArea === "number" && r.usableArea > 0 ? r.usableArea : null;
      const found = roomByRef.get(rref);
      if (found) {
        if (found.name !== name || found.number !== number || found.floor_id !== floorId || (area != null && found.area !== area)) {
          if (roomStmts.length < 400)
            roomStmts.push(env.DB.prepare(`UPDATE rooms SET name = ?, number = ?, area = COALESCE(?, area), floor_id = ?, updated_at = ? WHERE id = ?`).bind(name, number, area, floorId, t, found.id));
        }
      } else {
        fresh.push({ i: newId("rom"), f: floorId, n: name, u: number, a: area, r: rref });
      }
    }
  }
  for (let i = 0; i < roomStmts.length; i += 50) await env.DB.batch(roomStmts.slice(i, i + 50));
  for (let i = 0; i < fresh.length; i += 400) {
    const slice = fresh.slice(i, i + 400);
    await env.DB.prepare(
      `INSERT INTO rooms (id, org_id, building_id, floor_id, name, number, area, laft_ref, created_at, updated_at)
       SELECT json_extract(value, '$.i'), ?1, ?2, json_extract(value, '$.f'), json_extract(value, '$.n'), json_extract(value, '$.u'), json_extract(value, '$.a'), json_extract(value, '$.r'), ?3, ?3
       FROM json_each(?4)`,
    )
      .bind(orgId, building.id, t, JSON.stringify(slice))
      .run();
    step.createdRooms += slice.length;
  }
  return null;
}

const IMPORT_CHUNK = 12;

/** Tar LAFT-bygg inn i Plank (eller oppdaterer dem). Gjør litt av gangen – kall igjen med `remaining`. */
export async function importBuildings(env: Env, orgId: string, actor: Actor, ids: string[]): Promise<LaftImportStep> {
  const account = await requireOrgAccount(env, orgId);
  const wanted = [...new Set(ids.map((i) => String(i).trim()).filter(Boolean))];
  const chunk = wanted.slice(0, IMPORT_CHUNK);
  const step: LaftImportStep = { processed: 0, createdProperties: 0, createdBuildings: 0, updatedBuildings: 0, createdFloors: 0, createdRooms: 0, remaining: wanted.slice(IMPORT_CHUNK), message: null };
  const byId = new Map((await fetchBuildings(env, account, true)).map((b) => [String(b.id), b]));
  for (const id of chunk) {
    const b = byId.get(id);
    step.processed++;
    if (!b) continue;
    const stop = await importOne(env, orgId, account, b, step);
    if (stop) {
      step.message = stop;
      step.remaining = [];
      break;
    }
  }
  if (step.createdBuildings || step.createdRooms || step.createdFloors) {
    const parts = [step.createdBuildings && `${step.createdBuildings} bygg`, step.createdFloors && `${step.createdFloors} etasjer`, step.createdRooms && `${step.createdRooms} rom`].filter(Boolean);
    await activityStatement(env, { orgId, actor, action: "laft.imported", summary: `Hentet ${parts.join(", ")} fra LAFT` }).run().catch(() => undefined);
  }
  return step;
}

// ─── Arbeidsordrer ───────────────────────────────────────────────────────────

const WO_FIELDS = `id questionFreetext location deadline pastDue isRoutine isPastDueRoutine createdAt performableType performableId workOrderPriorityId
  workOrderState { id name } workOrderCommentCount hasImages hasDocuments toplevelPerformable { name performableName } building { id name }
  responsibleUsers { name } user { name }`;

interface RawWorkOrder {
  id: number;
  questionFreetext: string | null;
  location: string | null;
  deadline: string | null;
  pastDue: string | null;
  isRoutine: boolean;
  isPastDueRoutine: boolean;
  createdAt: string | null;
  performableType: string | null;
  performableId: number | null;
  workOrderPriorityId: number | null;
  workOrderState: { id: number; name: string } | null;
  workOrderCommentCount: number;
  hasImages: boolean;
  hasDocuments: boolean;
  toplevelPerformable: { name: string; performableName: string } | null;
  building: { id: string; name: string } | null;
  responsibleUsers: { name: string }[] | null;
  user: { name: string } | null;
}

export const PRIORITIES: Record<string, number> = { high: 1, medium: 2, low: 3 };
export const PRIORITY_NAMES: Record<number, string> = { 1: "høy", 2: "middels", 3: "lav" };

function toWorkOrder(serverUrl: string, w: RawWorkOrder): LaftWorkOrder {
  const place = w.toplevelPerformable ? clean(w.toplevelPerformable.performableName || w.toplevelPerformable.name) : null;
  return {
    id: w.id,
    title: clean(w.questionFreetext) || `Arbeidsordre ${w.id}`,
    location: clean(w.location) || null,
    deadline: w.deadline,
    pastDue: w.pastDue,
    isRoutine: Boolean(w.isRoutine),
    isPastDueRoutine: Boolean(w.isPastDueRoutine),
    createdAt: w.createdAt,
    state: w.workOrderState ? { id: Number(w.workOrderState.id), name: w.workOrderState.name } : null,
    priority: w.workOrderPriorityId ?? null,
    building: w.building ? { id: String(w.building.id), name: w.building.name } : null,
    place: place || null,
    responsible: (w.responsibleUsers ?? []).map((u) => u.name).filter(Boolean),
    createdBy: w.user?.name ?? null,
    comments: w.workOrderCommentCount ?? 0,
    hasImages: Boolean(w.hasImages),
    hasDocuments: Boolean(w.hasDocuments),
    url: laftLink(serverUrl, `v2/work_orders/${w.id}/edit`),
  };
}

export interface WorkOrderQuery {
  buildingId?: string | null;
  status?: "open" | "closed" | "all";
  stateIds?: number[] | null;
  pastDue?: boolean;
  type?: "work_orders" | "routines" | "fire_safety_routines" | null;
  deviationsOnly?: boolean;
  query?: string | null;
  deadlineFrom?: string | null;
  deadlineTo?: string | null;
  createdFrom?: string | null;
  createdTo?: string | null;
  order?: "deadline" | "created" | "changed" | "priority";
  first?: number;
  after?: string | null;
}

const ORDER_FIELDS = { deadline: "DEADLINE", created: "CREATED_AT", changed: "CHANGED_AT", priority: "PRIORITY" } as const;
const isoDay = (d: string, end: boolean) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T${end ? "23:59:59" : "00:00:00"}Z` : d);

export async function listWorkOrders(env: Env, orgId: string, q: WorkOrderQuery): Promise<LaftWorkOrderList & { states: { id: number; name: string }[] }> {
  const account = await requireOrgAccount(env, orgId);
  const filter: Record<string, unknown> = {};
  const states = q.stateIds?.length ? q.stateIds : q.status === "closed" ? [4, 5] : q.status === "all" ? null : [1, 2, 3];
  if (states) filter.workOrderStateId = states;
  if (q.pastDue) filter.pastDue = true;
  if (q.type) filter.taskType = q.type;
  if (q.deviationsOnly) filter.deviationsOnly = true;
  if (q.query?.trim()) filter.textSearch = { search: q.query.trim(), over: ["ID", "NAME", "QUESTION_FREETEXT", "LOCATION"] };
  if (q.deadlineFrom) filter.deadlineStart = isoDay(q.deadlineFrom, false);
  if (q.deadlineTo) filter.deadlineEnd = isoDay(q.deadlineTo, true);
  if (q.createdFrom) filter.createdAtStart = isoDay(q.createdFrom, false);
  if (q.createdTo) filter.createdAtEnd = isoDay(q.createdTo, true);
  const order = q.order ?? "deadline";
  filter.order = [{ field: ORDER_FIELDS[order], dir: order === "created" || order === "changed" ? "DESC" : "ASC" }];

  let inBuilding: ((w: RawWorkOrder) => boolean) | null = null;
  if (q.buildingId) {
    const b = (await fetchBuildings(env, account, false)).find((x) => String(x.id) === String(q.buildingId));
    if (!b) throw notFound("Bygget i LAFT");
    const ids = [Number(b.id), ...(b.floors ?? []).map((f) => Number(f.id)), ...(b.floors ?? []).flatMap((f) => (f.rooms ?? []).map((r) => Number(r.id)))];
    filter.performableTypes = ["Building", "Floor", "Room"];
    filter.performableId = ids;
    inBuilding = (w) => String(w.building?.id ?? "") === String(b.id) || (w.performableType === "Building" && String(w.performableId) === String(b.id));
  }

  const { data } = await laftGraphql<{
    workOrderPage: { totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: (RawWorkOrder | null)[] };
    workOrderStates: { id: number; name: string }[];
  }>(
    env,
    account,
    `query PlankWorkOrders($filter: WorkOrderFilter, $first: Int, $after: String) {
      workOrderPage(filter: $filter, first: $first, after: $after) { totalCount pageInfo { hasNextPage endCursor } nodes { ${WO_FIELDS} } }
      workOrderStates { id name }
    }`,
    { filter, first: Math.min(Math.max(q.first ?? 50, 1), 200), after: q.after ?? null },
  );
  const nodes = (data.workOrderPage.nodes ?? []).filter((w): w is RawWorkOrder => Boolean(w)).filter((w) => !inBuilding || inBuilding(w));
  return {
    total: data.workOrderPage.totalCount,
    hasMore: data.workOrderPage.pageInfo.hasNextPage,
    cursor: data.workOrderPage.pageInfo.endCursor,
    items: nodes.map((w) => toWorkOrder(account.server_url, w)),
    states: (data.workOrderStates ?? []).map((s) => ({ id: Number(s.id), name: s.name })),
  };
}

export async function getWorkOrder(env: Env, orgId: string, id: number) {
  const account = await requireOrgAccount(env, orgId);
  const { data } = await laftGraphql<{ workOrder: RawWorkOrder & Record<string, unknown> }>(
    env,
    account,
    `query PlankWorkOrder($id: Int!) {
      workOrder(id: $id) {
        ${WO_FIELDS}
        updatedAt
        schedule { name startDate endDate enabled }
        parentWorkOrder { id questionFreetext }
        children { id questionFreetext deadline workOrderState { id name } }
        workOrderComments { id comment createdAt user { name } }
        workOrderHourLogs { hours description performedAt userName }
        workOrderQuestion { questionText instruction { text } }
        workOrderChecklistDeviations { flexiQuestionAnswer { answer latestRevision { answer comment createdAt } flexiQuestionComponent { flexiQuestion { text } } } }
      }
    }`,
    { id },
  );
  const w = data.workOrder;
  if (!w?.id) throw notFound("Arbeidsordren");
  return { ...toWorkOrder(account.server_url, w), description: w.questionFreetext, details: w };
}

export async function workOrderDashboard(env: Env, orgId: string): Promise<LaftDashboard> {
  const { workOrderDashboardStatistics: s } = await laftQuery<{
    workOrderDashboardStatistics: { dueThisWeekCount: number; pastDueCount: number; pastDueRoutinesCount: number; performedThisWeekCount: number; unassignedCount: number };
  }>(env, orgId, `query PlankDashboard { workOrderDashboardStatistics { dueThisWeekCount pastDueCount pastDueRoutinesCount performedThisWeekCount unassignedCount } }`);
  return { pastDue: s.pastDueCount, pastDueRoutines: s.pastDueRoutinesCount, dueThisWeek: s.dueThisWeekCount, performedThisWeek: s.performedThisWeekCount, unassigned: s.unassignedCount };
}

async function laftQuery<T>(env: Env, orgId: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const account = await requireOrgAccount(env, orgId);
  return (await laftGraphql<T>(env, account, query, variables)).data;
}

export async function workOrderCalendar(
  env: Env,
  orgId: string,
  q: { from: string; to: string; scope?: "ALL" | "ASSIGNED_TO_ME" | "MY_TEAMS" | "OTHER_TEAMS"; overdue?: boolean; type?: "work_orders" | "routines" | null; buildingId?: string | null },
) {
  const account = await requireOrgAccount(env, orgId);
  const filter: Record<string, unknown> = {};
  if (q.overdue) filter.overdue = true;
  if (q.type) filter.taskType = q.type;
  if (q.buildingId) {
    filter.performableType = "Building";
    filter.performableIds = [String(q.buildingId)];
  }
  const { data } = await laftGraphql<{
    workOrderCalendar: { workOrderId: string; title: string | null; dates: string[]; statuses: string[]; isRoutine: boolean; categoryName: string | null; buildingName: string | null; performableName: string | null; responsibleUserName: string | null; workOrderStateId: number }[];
  }>(
    env,
    account,
    `query PlankCalendar($start: ISO8601Date!, $end: ISO8601Date!, $scope: WorkOrderCalendarScopeEnum, $filter: WorkOrderCalendarFilter) {
      workOrderCalendar(startDate: $start, endDate: $end, scope: $scope, filter: $filter) { workOrderId title dates statuses isRoutine categoryName buildingName performableName responsibleUserName workOrderStateId }
    }`,
    { start: q.from, end: q.to, scope: q.scope ?? "ALL", filter },
  );
  return (data.workOrderCalendar ?? []).map((c) => ({ ...c, url: laftLink(account.server_url, `v2/work_orders/${c.workOrderId}/edit`) }));
}

// ─── Skriving til LAFT ───────────────────────────────────────────────────────

export async function createWorkOrder(
  env: Env,
  orgId: string,
  actor: Actor,
  input: { buildingId: string; floorId?: string | null; roomId?: string | null; description: string; deadline?: string | null; priority?: "high" | "medium" | "low" | null },
): Promise<{ id: number; url: string }> {
  const account = await requireOrgAccount(env, orgId);
  const b = (await fetchBuildings(env, account, true)).find((x) => String(x.id) === String(input.buildingId));
  if (!b) throw notFound("Bygget i LAFT");
  let performableType = "Building";
  let performableId = Number(b.id);
  if (input.roomId) {
    const ok = (b.floors ?? []).some((f) => (f.rooms ?? []).some((r) => String(r.id) === String(input.roomId)));
    if (!ok) throw badRequest("Rommet ligger ikke i dette bygget i LAFT");
    performableType = "Room";
    performableId = Number(input.roomId);
  } else if (input.floorId) {
    if (!(b.floors ?? []).some((f) => String(f.id) === String(input.floorId))) throw badRequest("Etasjen ligger ikke i dette bygget i LAFT");
    performableType = "Floor";
    performableId = Number(input.floorId);
  }
  const description = input.description.trim();
  if (description.length < 3) throw badRequest("Beskrivelsen er for kort");
  const wo: Record<string, unknown> = {
    questionFreetext: description.slice(0, 4000),
    performableType,
    performableId,
    workOrderStateId: 1,
    workOrderAttributeValues: [],
  };
  if (input.deadline) wo.deadline = input.deadline;
  if (input.priority) wo.workOrderPriorityId = PRIORITIES[input.priority];
  const { data } = await laftGraphql<{ createWorkOrder: number }>(env, account, `mutation PlankCreateWorkOrder($wo: WorkOrderInput!) { createWorkOrder(workOrder: $wo) }`, { wo });
  const id = Number(data.createWorkOrder);
  if (!id) throw new ApiError(502, "LAFT opprettet ikke arbeidsordren");
  await logActivity(env, { orgId, actor, action: "laft.work_order.created", summary: `Opprettet arbeidsordre ${id} i LAFT: ${truncate(description, 80)}` });
  return { id, url: laftLink(account.server_url, `v2/work_orders/${id}/edit`) };
}

export async function commentWorkOrder(env: Env, orgId: string, actor: Actor, workOrderId: number, comment: string): Promise<{ id: number; url: string }> {
  const account = await requireOrgAccount(env, orgId);
  const text = comment.trim();
  if (!text) throw badRequest("Kommentaren er tom");
  const { data } = await laftGraphql<{ createComment: number }>(env, account, `mutation PlankComment($c: WorkOrderCommentInput!) { createComment(comment: $c) }`, {
    c: { workOrderId, comment: text.slice(0, 4000) },
  });
  await logActivity(env, { orgId, actor, action: "laft.work_order.commented", summary: `Kommenterte arbeidsordre ${workOrderId} i LAFT` });
  return { id: Number(data.createComment), url: laftLink(account.server_url, `v2/work_orders/${workOrderId}/edit`) };
}

export async function updateWorkOrder(
  env: Env,
  orgId: string,
  actor: Actor,
  id: number,
  patch: { stateId?: number | null; deadline?: string | null; priority?: "high" | "medium" | "low" | null },
) {
  const account = await requireOrgAccount(env, orgId);
  const args: string[] = ["id: $id"];
  const defs: string[] = ["$id: Int!"];
  const vars: Record<string, unknown> = { id };
  if (patch.stateId != null) defs.push("$state: Int"), args.push("workOrderStateId: $state"), (vars.state = patch.stateId);
  if (patch.deadline) defs.push("$deadline: ISO8601Date"), args.push("deadline: $deadline"), (vars.deadline = patch.deadline);
  if (patch.priority) defs.push("$priority: Int"), args.push("workOrderPriorityId: $priority"), (vars.priority = PRIORITIES[patch.priority]);
  if (args.length === 1) throw badRequest("Ingenting å endre");
  const { data } = await laftGraphql<{ updateWorkOrder: { id: number; deadline: string | null; workOrderState: { id: number; name: string } | null } }>(
    env,
    account,
    `mutation PlankUpdateWorkOrder(${defs.join(", ")}) { updateWorkOrder(${args.join(", ")}) { id deadline workOrderPriorityId workOrderState { id name } } }`,
    vars,
  );
  await logActivity(env, { orgId, actor, action: "laft.work_order.updated", summary: `Oppdaterte arbeidsordre ${id} i LAFT` });
  return { ...data.updateWorkOrder, url: laftLink(account.server_url, `v2/work_orders/${id}/edit`) };
}

// ─── Dokumenter ──────────────────────────────────────────────────────────────

interface RawNodeChild {
  id: number;
  displayname: string;
  isFolder: boolean;
  childrenCount: number;
  fileCount: number;
  contentType: string | null;
  fileSize: string | null;
  createdAt: string | null;
}

async function importedDocs(env: Env, orgId: string, refs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < refs.length; i += 80) {
    const slice = refs.slice(i, i + 80);
    const rows = await all<{ id: string; laft_ref: string }>(env.DB, `SELECT id, laft_ref FROM documents WHERE org_id = ? AND laft_ref IN (${slice.map(() => "?").join(", ")})`, orgId, ...slice);
    for (const r of rows) out.set(r.laft_ref, r.id);
  }
  return out;
}

const docRef = (serverUrl: string, id: number | string) => laftRef(serverUrl, `doc${id}`);

export async function listDocuments(env: Env, orgId: string, laftBuildingId: string, parentId: number | null): Promise<LaftDocumentNode[]> {
  const account = await requireOrgAccount(env, orgId);
  const { data } = await laftGraphql<{ documentNodeChildren: RawNodeChild[] }>(
    env,
    account,
    `query PlankDocuments($type: String!, $id: Int!, $parent: Int) {
      documentNodeChildren(documentableType: $type, documentableId: $id, parentId: $parent) { id displayname isFolder childrenCount fileCount contentType fileSize createdAt }
    }`,
    { type: "Building", id: Number(laftBuildingId), parent: parentId },
  );
  const nodes = data.documentNodeChildren ?? [];
  const imported = await importedDocs(env, orgId, nodes.filter((n) => !n.isFolder).map((n) => docRef(account.server_url, n.id)));
  return nodes
    .map((n) => ({
      id: n.id,
      name: n.displayname,
      isFolder: n.isFolder,
      childrenCount: n.childrenCount ?? 0,
      fileCount: n.fileCount ?? 0,
      contentType: n.contentType,
      size: n.fileSize,
      createdAt: n.createdAt,
      plankDocumentId: n.isFolder ? null : imported.get(docRef(account.server_url, n.id)) ?? null,
    }))
    .sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name, "nb"));
}

const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
};

interface RawNode {
  id: number;
  displayname: string;
  contentType: string | null;
  size: number | null;
  isFolder: boolean;
  documentableType: string | null;
  documentableId: number | null;
}

async function placeFor(env: Env, orgId: string, serverUrl: string, node: RawNode, buildingId: string | null) {
  if (buildingId) {
    const b = await first<{ id: string; property_id: string }>(env.DB, `SELECT id, property_id FROM buildings WHERE id = ? AND org_id = ?`, buildingId, orgId);
    if (!b) throw notFound("Bygget");
    return { property_id: b.property_id, building_id: b.id, floor_id: null, room_id: null };
  }
  if (!node.documentableId) return null;
  const ref = laftRef(serverUrl, node.documentableId);
  if (node.documentableType === "Building") {
    const b = await first<{ id: string; property_id: string }>(env.DB, `SELECT id, property_id FROM buildings WHERE org_id = ? AND laft_ref = ?`, orgId, ref);
    return b ? { property_id: b.property_id, building_id: b.id, floor_id: null, room_id: null } : null;
  }
  if (node.documentableType === "Floor") {
    const f = await first<{ id: string; building_id: string; property_id: string }>(env.DB, `SELECT f.id, f.building_id, b.property_id FROM floors f JOIN buildings b ON b.id = f.building_id WHERE f.org_id = ? AND f.laft_ref = ?`, orgId, ref);
    return f ? { property_id: f.property_id, building_id: f.building_id, floor_id: f.id, room_id: null } : null;
  }
  if (node.documentableType === "Room") {
    const r = await first<{ id: string; floor_id: string; building_id: string; property_id: string }>(
      env.DB,
      `SELECT r.id, r.floor_id, r.building_id, b.property_id FROM rooms r JOIN buildings b ON b.id = r.building_id WHERE r.org_id = ? AND r.laft_ref = ?`,
      orgId,
      ref,
    );
    return r ? { property_id: r.property_id, building_id: r.building_id, floor_id: r.floor_id, room_id: r.id } : null;
  }
  return null;
}

export interface DocImportResult {
  imported: { documentId: string; title: string; laftId: number; existing: boolean }[];
  failed: { laftId: number; title: string; error: string }[];
  remaining: number[];
}

const DOCS_PER_CALL = 6;

/** Henter filer (eller filene i mapper) fra LAFT-arkivet inn i Plank, der de blir søkbare for agentene. */
export async function importDocuments(
  env: Env,
  orgId: string,
  actor: Actor,
  nodeIds: number[],
  opts: { buildingId?: string | null; waitUntil?: WaitUntil } = {},
): Promise<DocImportResult> {
  const account = await requireOrgAccount(env, orgId);
  const ids = [...new Set(nodeIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
  if (ids.length === 0) throw badRequest("Velg minst én fil");
  const { data } = await laftGraphql<{ documentNode: RawNode[] }>(
    env,
    account,
    `query PlankNodes($ids: [Int!]!) { documentNode(ids: $ids) { id displayname contentType size isFolder documentableType documentableId } }`,
    { ids },
  );
  const nodes = data.documentNode ?? [];
  const files: RawNode[] = nodes.filter((n) => !n.isFolder);
  for (const folder of nodes.filter((n) => n.isFolder).slice(0, 3)) {
    if (!folder.documentableType || !folder.documentableId) continue;
    const children = await laftGraphql<{ documentNodeChildren: RawNodeChild[] }>(
      env,
      account,
      `query PlankFolder($type: String!, $id: Int!, $parent: Int) { documentNodeChildren(documentableType: $type, documentableId: $id, parentId: $parent) { id displayname isFolder contentType } }`,
      { type: folder.documentableType, id: folder.documentableId, parent: folder.id },
    );
    for (const c of children.data.documentNodeChildren ?? []) {
      if (c.isFolder || files.some((f) => f.id === c.id)) continue;
      files.push({ id: c.id, displayname: c.displayname, contentType: c.contentType, size: null, isFolder: false, documentableType: folder.documentableType, documentableId: folder.documentableId });
    }
  }

  const result: DocImportResult = { imported: [], failed: [], remaining: [] };
  const existing = await importedDocs(env, orgId, files.map((f) => docRef(account.server_url, f.id)));
  let downloads = 0;
  for (const file of files) {
    const ref = docRef(account.server_url, file.id);
    const already = existing.get(ref);
    if (already) {
      result.imported.push({ documentId: already, title: file.displayname, laftId: file.id, existing: true });
      continue;
    }
    if (downloads >= DOCS_PER_CALL) {
      result.remaining.push(file.id);
      continue;
    }
    downloads++;
    try {
      if (file.size && file.size > 60 * 1024 * 1024) throw badRequest("Filen er for stor (maks 60 MB)");
      const place = await placeFor(env, orgId, account.server_url, file, opts.buildingId ?? null);
      const dl = await laftDownload(env, account, file.id);
      if (dl.bytes.byteLength === 0) throw new Error("Filen var tom");
      let filename = (dl.filename || file.displayname || `laft-${file.id}`).replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 180);
      const mime = dl.mime && dl.mime !== "application/octet-stream" ? dl.mime : file.contentType || guessMime(filename);
      if (!/\.[a-z0-9]{2,5}$/i.test(filename) && EXT_BY_MIME[mime]) filename = `${filename}.${EXT_BY_MIME[mime]}`;
      const id = newId("doc");
      const key = `orgs/${orgId}/documents/${id}/${filename}`;
      await env.FILES.put(key, dl.bytes, { httpMetadata: { contentType: mime } });
      const t = now();
      await insert(env.DB, "documents", {
        id,
        org_id: orgId,
        property_id: place?.property_id ?? null,
        building_id: place?.building_id ?? null,
        floor_id: place?.floor_id ?? null,
        room_id: place?.room_id ?? null,
        component_id: null,
        title: (file.displayname || filename).replace(/\.[a-z0-9]{2,5}$/i, "").slice(0, 200) || filename,
        filename,
        mime,
        size: dl.bytes.byteLength,
        r2_key: key,
        kind: kindOf(null, `${file.displayname} ${filename}`),
        ns3451: null,
        status: "processing",
        uploaded_by: actor.type === "user" ? actor.id : null,
        laft_ref: ref,
        created_at: t,
        updated_at: t,
      }).run();
      const work = processDocument(env, id);
      if (opts.waitUntil) opts.waitUntil(work);
      else await work;
      result.imported.push({ documentId: id, title: file.displayname, laftId: file.id, existing: false });
    } catch (err) {
      result.failed.push({ laftId: file.id, title: file.displayname, error: err instanceof Error ? err.message : "Nedlasting feilet" });
    }
  }
  const fresh = result.imported.filter((d) => !d.existing).length;
  if (fresh) await logActivity(env, { orgId, actor, action: "laft.documents_imported", summary: `Hentet ${fresh} dokument${fresh === 1 ? "" : "er"} fra LAFT` });
  return result;
}

// ─── Søk og fritt oppslag ────────────────────────────────────────────────────

export async function searchLaft(env: Env, orgId: string, q: string, opts: { content?: boolean; buildingId?: string | null } = {}) {
  const account = await requireOrgAccount(env, orgId);
  const { data, errors } = await laftGraphql<{
    globalDocumentSearch: { id: number; title: string; matchType: string; documentableName: string | null; parentFolder: string | null; documentType: string | null; createdAt: string | null; highlight: unknown }[] | null;
    es: { metadata: { total: number } | null; hits: { id: number; title: string; modelName: string; link: string | null; timestamp: string; highlight: unknown }[] | null } | null;
  }>(
    env,
    account,
    `query PlankSearch($q: String!, $content: Boolean, $type: String, $id: Int) {
      globalDocumentSearch(keywords: $q, includeContent: $content, page: 1, perPage: 25, documentableType: $type, documentableId: $id) { id title matchType documentableName parentFolder documentType createdAt highlight }
      es(keywords: $q) { metadata { total } hits { id title modelName link timestamp highlight } }
    }`,
    { q, content: opts.content ?? true, type: opts.buildingId ? "Building" : null, id: opts.buildingId ? Number(opts.buildingId) : null },
    { allowPartial: true },
  );
  const flat = (h: unknown) => (h ? truncate(JSON.stringify(h).replace(/<\/?em>/g, "**"), 300) : null);
  return {
    documents: (data.globalDocumentSearch ?? []).map((d) => ({ ...d, highlight: flat(d.highlight) })),
    other: (data.es?.hits ?? []).map((h) => ({ id: h.id, title: h.title, type: h.modelName, date: h.timestamp, url: h.link ? (h.link.startsWith("http") ? h.link : laftLink(account.server_url, h.link)) : null, highlight: flat(h.highlight) })),
    total_other: data.es?.metadata?.total ?? null,
    warnings: errors.map((e) => e.message).filter(Boolean),
  };
}

/** Fri, skrivebeskyttet GraphQL mot LAFT – for agenter og sider. */
export async function rawQuery(env: Env, orgId: string, query: string, variables?: Record<string, unknown>) {
  if (query.length > 20_000) throw badRequest("Spørringen er for lang");
  assertReadOnly(query);
  const account = await requireOrgAccount(env, orgId);
  return laftGraphql(env, account, query, variables, { allowPartial: true });
}

const TYPE_REF = `fragment T on __Type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }`;
type TypeRef = { kind: string; name: string | null; ofType: TypeRef | null };
const fmtType = (t: TypeRef | null): string => (!t ? "?" : t.kind === "NON_NULL" ? `${fmtType(t.ofType)}!` : t.kind === "LIST" ? `[${fmtType(t.ofType)}]` : t.name ?? "?");

/** Slår opp i LAFT-skjemaet: én type, eller spørringer som matcher et søkeord. */
export async function describeSchema(env: Env, orgId: string, opts: { type?: string | null; search?: string | null }): Promise<string> {
  const account = await requireOrgAccount(env, orgId);
  type Field = { name: string; description: string | null; args?: { name: string; type: TypeRef }[]; type: TypeRef };
  const name = opts.type?.trim() || "Query";
  const { data } = await laftGraphql<{
    __type: { name: string; kind: string; description: string | null; fields: Field[] | null; inputFields: Field[] | null; enumValues: { name: string }[] | null; possibleTypes: { name: string }[] | null } | null;
  }>(
    env,
    account,
    `query PlankSchema($name: String!) { __type(name: $name) { name kind description fields { name description args { name type { ...T } } type { ...T } } inputFields { name description type { ...T } } enumValues { name } possibleTypes { name } } } ${TYPE_REF}`,
    { name },
  );
  const t = data.__type;
  if (!t) return `Fant ingen type som heter ${name}.`;
  const needle = opts.search?.trim().toLowerCase();
  const line = (f: Field) => `${f.name}${f.args?.length ? `(${f.args.map((a) => `${a.name}: ${fmtType(a.type)}`).join(", ")})` : ""}: ${fmtType(f.type)}${f.description ? ` – ${truncate(f.description.replace(/\s+/g, " "), 140)}` : ""}`;
  const fields = (t.fields ?? t.inputFields ?? []).filter((f) => !needle || f.name.toLowerCase().includes(needle) || (f.description ?? "").toLowerCase().includes(needle));
  const parts = [`${t.kind} ${t.name}${t.description ? ` – ${t.description}` : ""}`];
  if (fields.length) parts.push(fields.map(line).join("\n"));
  if (t.enumValues?.length) parts.push(`Verdier: ${t.enumValues.map((e) => e.name).join(" | ")}`);
  if (t.possibleTypes?.length) parts.push(`Typer: ${t.possibleTypes.map((e) => e.name).join(" | ")}`);
  if (needle && fields.length === 0) parts.push(`Ingen felt matcher «${opts.search}».`);
  return parts.join("\n\n");
}
