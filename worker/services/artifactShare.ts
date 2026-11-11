import type { Env } from "../env";
import { scopeSql, runWithAccess, type Access } from "../lib/access";
import { boligmappaTree, listBmDocuments } from "../lib/boligmappa";
import { all } from "../lib/db";
import { ApiError, badRequest, notFound } from "../lib/http";
import { parseJson } from "../lib/util";
import { queryIfcElements } from "../routes/ifc";
import { listComponents } from "./components";
import { listDocumentTexts, listDocuments, searchDocuments } from "./documents";
import { getBuildingStructure, laftStatus, listBuildings, listDocuments as listLaftDocuments, listWorkOrders, resolveLaftBuildingId, searchLaft, workOrderDashboard } from "./laft";
import { getBuilding, getTree, listProperties } from "./portfolio";
import { listTasks } from "./tasks";

/** Lesing av det siden kan hente. Ingen redigering, og ikke resten av API-et. */
const SHARE_READ: Access = { userId: null, admin: false, canEdit: false, scope: null, expiresAt: null };

function str(params: Record<string, unknown>, key: string, max = 80): string | undefined {
  const value = params[key];
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  return text ? text.slice(0, max) : undefined;
}

function flag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

async function listIfcModels(env: Env, orgId: string, buildingId?: string) {
  const scope = scopeSql({ building: "d.building_id", property: "d.property_id" });
  const rows = await all<{ id: string; title: string; filename: string; size: number; building_id: string | null; created_at: number; schema: string | null; stats: string | null; indexed_at: number | null }>(
    env.DB,
    `SELECT d.id, d.title, d.filename, d.size, d.building_id, d.created_at, m.schema, m.stats, m.indexed_at
     FROM documents d LEFT JOIN ifc_models m ON m.document_id = d.id
     WHERE d.org_id = ? AND d.kind = 'ifc' ${buildingId ? "AND d.building_id = ?" : ""} AND ${scope.sql} ORDER BY d.created_at DESC`,
    ...(buildingId ? [orgId, buildingId] : [orgId]),
    ...scope.params,
  );
  return rows.map((row) => ({ ...row, stats: parseJson(row.stats, null) }));
}

/** Samme lesekall som window.plank i appen. Handlinger finnes ikke her. */
export function runShareQuery(env: Env, orgId: string, name: string, params: Record<string, unknown>): Promise<unknown> {
  return runWithAccess(SHARE_READ, () => readShare(env, orgId, name, params));
}

async function readShare(env: Env, orgId: string, name: string, params: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "portfolio.tree":
      return getTree(env, orgId);
    case "properties.list":
      return listProperties(env, orgId);
    case "buildings.get": {
      const id = str(params, "id");
      if (!id) throw badRequest("Mangler bygg");
      return getBuilding(env, orgId, id);
    }
    case "components.list":
      return listComponents(env, orgId, {
        building_id: str(params, "building_id"),
        floor_id: str(params, "floor_id"),
        room_id: str(params, "room_id"),
        ns3451: str(params, "ns3451", 20),
        q: str(params, "q", 200),
        service_due_before: str(params, "service_due_before", 40),
        property_id: str(params, "property_id"),
      });
    case "tasks.list":
      return listTasks(env, orgId, {
        status: str(params, "status", 20),
        type: str(params, "type", 40),
        building_id: str(params, "building_id"),
        property_id: str(params, "property_id"),
        component_id: str(params, "component_id"),
        due_before: str(params, "due_before", 40),
        q: str(params, "q", 200),
      });
    case "documents.list":
      return listDocuments(env, orgId, {
        building_id: str(params, "building_id"),
        property_id: str(params, "property_id"),
        kind: str(params, "kind", 40),
        component_id: str(params, "component_id"),
        q: str(params, "q", 200),
      });
    case "documents.search":
      return searchDocuments(env, orgId, str(params, "q", 200) ?? "", { building_id: str(params, "building_id"), limit: 20 });
    case "documents.texts":
      return listDocumentTexts(env, orgId);
    case "ifc.models":
      return listIfcModels(env, orgId, str(params, "building_id"));
    case "ifc.elements":
      return queryIfcElements(env, orgId, {
        building_id: str(params, "building_id"),
        document_id: str(params, "document_id"),
        ifc_type: str(params, "type", 80),
        storey: str(params, "storey", 80),
        q: str(params, "q", 200),
        limit: Number(params.limit) || 200,
      });
    case "laft.status":
      return laftStatus(env, orgId, "");
    case "laft.buildings":
      return listBuildings(env, orgId);
    case "laft.building": {
      const id = await resolveLaftBuildingId(env, orgId, str(params, "id"));
      if (!id) throw new ApiError(404, "Bygget er ikke koblet til LAFT");
      return getBuildingStructure(env, orgId, id);
    }
    case "laft.dashboard":
      return workOrderDashboard(env, orgId);
    case "laft.work_orders": {
      const building = str(params, "building");
      const buildingId = building ? await resolveLaftBuildingId(env, orgId, building) : null;
      if (building && !buildingId) return { total: 0, hasMore: false, cursor: null, items: [], states: [] };
      return listWorkOrders(env, orgId, {
        buildingId,
        status: oneOf(str(params, "status", 20), ["open", "closed", "all"] as const),
        type: oneOf(str(params, "type", 40), ["work_orders", "routines", "fire_safety_routines"] as const) ?? null,
        pastDue: flag(params.past_due),
        deviationsOnly: flag(params.deviations),
        query: str(params, "q", 200) ?? null,
        first: Number(params.first) || undefined,
      });
    }
    case "laft.documents": {
      const id = await resolveLaftBuildingId(env, orgId, str(params, "building"));
      if (!id) throw new ApiError(404, "Bygget er ikke koblet til LAFT");
      const parent = str(params, "parent", 20);
      const parentId = parent ? Number(parent) : null;
      if (parentId !== null && (!Number.isInteger(parentId) || parentId <= 0)) throw badRequest("Ugyldig mappe");
      return listLaftDocuments(env, orgId, id, parentId);
    }
    case "laft.search": {
      const q = str(params, "q", 200) ?? "";
      if (q.length < 2) throw badRequest("Skriv minst to tegn");
      const building = str(params, "building");
      const buildingId = building ? await resolveLaftBuildingId(env, orgId, building) : null;
      return searchLaft(env, orgId, q, { buildingId });
    }
    case "boligmappa.tree":
      return boligmappaTree(env, orgId);
    case "boligmappa.documents":
      return listBmDocuments(env, orgId, str(params, "building"));
    default:
      throw notFound("Ressursen");
  }
}
