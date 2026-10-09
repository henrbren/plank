import { z } from "zod";
import type { Env } from "../env";
import { all, first, insert, update } from "../lib/db";
import { notFound } from "../lib/http";
import { optDate, optId, optInt, optStr, reqStr } from "../lib/schemas";
import { addMonths, newId, now } from "../lib/util";
import type { Component } from "../../shared/types";
import { resolveLocation } from "./portfolio";

export const componentSchema = z.object({
  building_id: optId(),
  floor_id: optId(),
  room_id: optId(),
  name: reqStr(),
  ns3451: optStr(20),
  tfm: optStr(80),
  category: optStr(100),
  manufacturer: optStr(120),
  model: optStr(120),
  serial_number: optStr(120),
  supplier: optStr(120),
  installed_at: optDate(),
  warranty_until: optDate(),
  service_interval_months: optInt(),
  last_service_at: optDate(),
  condition: z
    .enum(["TG0", "TG1", "TG2", "TG3", "TGIU"])
    .nullish()
    .or(z.literal("").transform(() => null)),
  ifc_guid: optStr(64),
  notes: optStr(8000),
});
export const COMPONENT_FIELDS = [
  "building_id",
  "floor_id",
  "room_id",
  "name",
  "ns3451",
  "tfm",
  "category",
  "manufacturer",
  "model",
  "serial_number",
  "supplier",
  "installed_at",
  "warranty_until",
  "service_interval_months",
  "last_service_at",
  "next_service_at",
  "condition",
  "ifc_guid",
  "notes",
  "updated_at",
] as const;

export interface ComponentFilter {
  property_id?: string | null;
  building_id?: string | null;
  floor_id?: string | null;
  room_id?: string | null;
  ns3451?: string | null;
  q?: string | null;
  service_due_before?: string | null;
  limit?: number;
}

const SELECT = `SELECT c.*, b.name AS building_name, f.name AS floor_name, r.name AS room_name
  FROM components c
  LEFT JOIN buildings b ON b.id = c.building_id
  LEFT JOIN floors f ON f.id = c.floor_id
  LEFT JOIN rooms r ON r.id = c.room_id`;

export async function listComponents(env: Env, orgId: string, f: ComponentFilter = {}): Promise<Component[]> {
  const where = ["c.org_id = ?"];
  const params: unknown[] = [orgId];
  if (f.property_id) where.push("b.property_id = ?"), params.push(f.property_id);
  if (f.building_id) where.push("c.building_id = ?"), params.push(f.building_id);
  if (f.floor_id) where.push("c.floor_id = ?"), params.push(f.floor_id);
  if (f.room_id) where.push("c.room_id = ?"), params.push(f.room_id);
  if (f.ns3451) where.push("c.ns3451 LIKE ?"), params.push(`${f.ns3451}%`);
  if (f.service_due_before) where.push("c.next_service_at IS NOT NULL AND c.next_service_at <= ?"), params.push(f.service_due_before);
  if (f.q) {
    where.push("(c.name LIKE ? OR c.manufacturer LIKE ? OR c.model LIKE ? OR c.tfm LIKE ? OR c.category LIKE ?)");
    const like = `%${f.q}%`;
    params.push(like, like, like, like, like);
  }
  const limit = Math.min(Math.max(f.limit ?? 500, 1), 1000);
  return all<Component>(env.DB, `${SELECT} WHERE ${where.join(" AND ")} ORDER BY c.ns3451, c.name LIMIT ${limit}`, ...params);
}

export async function getComponent(env: Env, orgId: string, id: string): Promise<Component> {
  const c = await first<Component>(env.DB, `${SELECT} WHERE c.id = ? AND c.org_id = ?`, id, orgId);
  if (!c) throw notFound("Komponenten");
  return c;
}

function computeNext(last: string | null | undefined, interval: number | null | undefined): string | null {
  if (!last || !interval || interval <= 0) return null;
  return addMonths(last, interval);
}

export async function createComponent(env: Env, orgId: string, input: z.infer<typeof componentSchema>): Promise<Component> {
  const loc = await resolveLocation(env, orgId, input);
  const id = newId("cmp");
  const t = now();
  await insert(env.DB, "components", {
    id,
    org_id: orgId,
    ...input,
    building_id: loc.building_id,
    floor_id: loc.floor_id,
    room_id: loc.room_id,
    next_service_at: computeNext(input.last_service_at, input.service_interval_months),
    created_at: t,
    updated_at: t,
  }).run();
  return getComponent(env, orgId, id);
}

export async function updateComponent(env: Env, orgId: string, id: string, patch: Partial<z.infer<typeof componentSchema>>): Promise<Component> {
  const existing = await getComponent(env, orgId, id);
  const next: Record<string, unknown> = { ...patch, updated_at: now() };
  if ("room_id" in patch || "floor_id" in patch || "building_id" in patch) {
    const loc = await resolveLocation(env, orgId, {
      building_id: "building_id" in patch ? patch.building_id : existing.building_id,
      floor_id: "floor_id" in patch ? patch.floor_id : "building_id" in patch ? null : existing.floor_id,
      room_id: "room_id" in patch ? patch.room_id : "floor_id" in patch || "building_id" in patch ? null : existing.room_id,
    });
    next.building_id = loc.building_id;
    next.floor_id = loc.floor_id;
    next.room_id = loc.room_id;
  }
  const last = "last_service_at" in patch ? patch.last_service_at : existing.last_service_at;
  const interval = "service_interval_months" in patch ? patch.service_interval_months : existing.service_interval_months;
  next.next_service_at = computeNext(last, interval);
  const stmt = update(env.DB, "components", next, COMPONENT_FIELDS, { sql: "id = ? AND org_id = ?", params: [id, orgId] });
  if (stmt) await stmt.run();
  return getComponent(env, orgId, id);
}
