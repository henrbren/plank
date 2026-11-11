import { z } from "zod";
import type { Env } from "../env";
import type { DeskAct, DeskCase, DeskEditor, DeskHome, DeskLetter, DeskPlace, DeskRecord, DeskRow, DeskSaved, LeaseKind } from "../../shared/types";
import { activityStatement } from "../lib/activity";
import { assertCanEdit, currentAccess, sees } from "../lib/access";
import { all, first, insert, update } from "../lib/db";
import { badRequest, notFound } from "../lib/http";
import { newId, now, todayIso } from "../lib/util";
import { createTask, taskSchema } from "./tasks";
import {
  buildDesk,
  factsFor,
  formatKr,
  letterFor,
  matchesFor,
  offersFor,
  type DeskWork,
  type LeaseRow,
  type LeaseStage,
  type UnitRow,
  type UnitStatus,
} from "./deskModel";

interface Actor {
  userId?: string | null;
  agentId?: string | null;
  name: string;
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function visibleBuilding(buildingId: string | null): boolean {
  if (!buildingId) return !currentAccess().scope;
  return sees({ building_id: buildingId });
}

async function loadRows(env: Env, orgId: string): Promise<{ units: UnitRow[]; leases: LeaseRow[] }> {
  const unitRows = await all<Record<string, unknown>>(
    env.DB,
    `SELECT id, building_id, name, address, kind, area_sqm, rooms, status, market_rent_year, vacant_since FROM lease_units WHERE org_id = ?`,
    orgId,
  );
  const units: UnitRow[] = unitRows
    .map((r) => ({
      id: String(r.id),
      building_id: (r.building_id as string | null) ?? null,
      name: String(r.name),
      address: (r.address as string | null) ?? null,
      kind: r.kind as LeaseKind,
      area_sqm: r.area_sqm == null ? null : num(r.area_sqm),
      rooms: r.rooms == null ? null : num(r.rooms),
      status: r.status as UnitStatus,
      market_rent_year: num(r.market_rent_year),
      vacant_since: (r.vacant_since as string | null) ?? null,
    }))
    .filter((u) => visibleBuilding(u.building_id));
  const seen = new Set(units.map((u) => u.id));
  const full = !currentAccess().scope;
  const leaseRows = await all<Record<string, unknown>>(
    env.DB,
    `SELECT id, unit_id, kind, tenant_name, stage, rent_year, start_on, end_on, break_on, signed_on, listed_on, arrears_nok, arrears_days, index_on, move_out_on, keys_on, vedtak_on, need, household FROM leases WHERE org_id = ?`,
    orgId,
  );
  const leases: LeaseRow[] = leaseRows
    .map((r) => ({
      id: String(r.id),
      unit_id: (r.unit_id as string | null) ?? null,
      kind: r.kind as LeaseKind,
      tenant_name: String(r.tenant_name),
      stage: r.stage as LeaseStage,
      rent_year: num(r.rent_year),
      start_on: (r.start_on as string | null) ?? null,
      end_on: (r.end_on as string | null) ?? null,
      break_on: (r.break_on as string | null) ?? null,
      signed_on: (r.signed_on as string | null) ?? null,
      listed_on: (r.listed_on as string | null) ?? null,
      arrears_nok: num(r.arrears_nok),
      arrears_days: num(r.arrears_days),
      index_on: (r.index_on as string | null) ?? null,
      move_out_on: (r.move_out_on as string | null) ?? null,
      keys_on: (r.keys_on as string | null) ?? null,
      vedtak_on: (r.vedtak_on as string | null) ?? null,
      need: (r.need as string | null) ?? null,
      household: (r.household as string | null) ?? null,
    }))
    .filter((l) => (l.unit_id ? seen.has(l.unit_id) : full));
  return { units, leases };
}

function toRow(w: DeskWork): DeskRow {
  return {
    id: w.id,
    kind: w.kind,
    lane: w.lane,
    laneLabel: w.laneLabel,
    tall: w.tall,
    title: w.title,
    place: w.place,
    moneyText: w.moneyText,
    when: w.when,
    actionLabel: w.actionLabel,
    action: w.action,
    dueSoon: w.dueSoon,
    why: w.why,
    buildingId: w.buildingId,
  };
}

async function book(env: Env, orgId: string) {
  const { units, leases } = await loadRows(env, orgId);
  const built = buildDesk(units, leases, todayIso());
  return { ...built, units, leases };
}

async function orgName(env: Env, orgId: string): Promise<string> {
  const org = await first<{ name: string }>(env.DB, `SELECT name FROM orgs WHERE id = ?`, orgId);
  return org?.name ?? "Utleier";
}

async function openTask(env: Env, orgId: string, caseId: string): Promise<string | null> {
  const row = await first<{ id: string }>(
    env.DB,
    `SELECT id FROM tasks WHERE org_id = ? AND status IN ('open','in_progress') AND instr(description, ?) > 0 ORDER BY created_at DESC LIMIT 1`,
    orgId,
    `sak:${caseId}`,
  );
  return row?.id ?? null;
}

async function letters(env: Env, orgId: string, caseId: string): Promise<DeskLetter[]> {
  return all<DeskLetter>(
    env.DB,
    `SELECT id, title, body, created_at FROM lease_letters WHERE org_id = ? AND case_id = ? ORDER BY created_at DESC`,
    orgId,
    caseId,
  );
}

async function present(env: Env, orgId: string, work: DeskWork, units: UnitRow[], leases: LeaseRow[]): Promise<DeskCase> {
  const unit = work.unitId ? (units.find((u) => u.id === work.unitId) ?? null) : null;
  const lease = work.leaseId ? (leases.find((l) => l.id === work.leaseId) ?? null) : null;
  return {
    ...toRow(work),
    facts: factsFor(work, unit, lease),
    letters: await letters(env, orgId, work.id),
    offers: offersFor(work, units, lease),
    matches: matchesFor(work, unit, leases, todayIso()),
    taskId: await openTask(env, orgId, work.id),
    record: recordFrom(unit, lease),
  };
}

export async function deskHome(env: Env, orgId: string): Promise<DeskHome> {
  const b = await book(env, orgId);
  return { today: b.today, empty: b.empty, kpis: b.kpis, rows: b.works.map(toRow), aside: placesAside(b.units, b.leases, b.works) };
}

export async function deskCase(env: Env, orgId: string, caseId: string): Promise<DeskCase> {
  const b = await book(env, orgId);
  const work = b.works.find((w) => w.id === caseId);
  if (!work) throw notFound("Saken");
  return present(env, orgId, work, b.units, b.leases);
}

async function saveLetter(env: Env, orgId: string, caseId: string, leaseId: string | null, unitId: string | null, kind: string, title: string, body: string, actor: Actor) {
  const id = newId("ltr");
  await insert(env.DB, "lease_letters", {
    id,
    org_id: orgId,
    lease_id: leaseId,
    unit_id: unitId,
    case_id: caseId,
    kind,
    title,
    body,
    created_by: actor.userId ?? (actor.agentId ? `agent:${actor.agentId}` : null),
    created_at: now(),
  }).run();
  return id;
}

export async function actOnCase(env: Env, orgId: string, caseId: string, input: { unit_id?: string; lease_id?: string }, actor: Actor): Promise<DeskAct> {
  const b = await book(env, orgId);
  const work = b.works.find((w) => w.id === caseId);
  if (!work) throw notFound("Saken");
  assertCanEdit(work.buildingId ? { building_id: work.buildingId } : undefined);
  const name = await orgName(env, orgId);
  const today = todayIso();

  if (work.action === "letter") {
    const unit = work.unitId ? (b.units.find((u) => u.id === work.unitId) ?? null) : null;
    const lease = work.leaseId ? (b.leases.find((l) => l.id === work.leaseId) ?? null) : null;
    const draft = letterFor(work, unit, lease, name, today);
    await saveLetter(env, orgId, work.id, work.leaseId, work.unitId, draft.kind, draft.title, draft.body, actor);
    await activityStatement(env, {
      orgId,
      actor: actor.agentId ? { type: "agent", id: actor.agentId, name: actor.name } : { type: "user", id: actor.userId, name: actor.name },
      action: "lease.letter",
      entityType: "lease",
      entityId: work.leaseId ?? work.unitId ?? work.id,
      summary: draft.title,
    }).run();
    return { item: await present(env, orgId, work, b.units, b.leases), notice: "Brevet ligger på saken" };
  }

  if (work.action === "task") {
    const existing = await openTask(env, orgId, work.id);
    if (!existing) {
      const task = await createTask(
        env,
        orgId,
        taskSchema.parse({
          title: (work.taskTitle ?? work.actionLabel).slice(0, 200),
          description: `${work.why}\n\nsak:${work.id}`,
          type: work.lane === "klargjoring" ? "vedlikehold" : "kontroll",
          priority: work.dueSoon ? "high" : "normal",
          due_date: work.taskDue,
          building_id: work.buildingId,
        }),
        { userId: actor.userId, agentId: actor.agentId },
      );
      await activityStatement(env, {
        orgId,
        actor: actor.agentId ? { type: "agent", id: actor.agentId, name: actor.name } : { type: "user", id: actor.userId, name: actor.name },
        action: "task.created",
        entityType: "task",
        entityId: task.id,
        summary: task.title,
      }).run();
    }
    return { item: await present(env, orgId, work, b.units, b.leases), notice: existing ? "Befaringen ligger allerede som oppgave" : "Oppgaven er lagt inn" };
  }

  const leaseId = work.action === "match" ? input.lease_id : work.leaseId;
  const unitId = work.action === "offer" ? input.unit_id : work.unitId;
  if (!leaseId) throw badRequest("Velg hvem som skal ha boligen");
  if (!unitId) throw badRequest("Velg en bolig");
  const lease = b.leases.find((l) => l.id === leaseId);
  const unit = b.units.find((u) => u.id === unitId);
  if (!lease || lease.stage !== "vedtak" || lease.unit_id) throw badRequest("Vedtaket er allerede knyttet til en bolig");
  if (!unit || unit.kind !== "bolig" || unit.status !== "vacant") throw badRequest("Den boligen er ikke ledig");
  assertCanEdit(unit.building_id ? { building_id: unit.building_id } : undefined);

  const t = now();
  const listed = lease.listed_on ?? unit.vacant_since ?? today;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE leases SET unit_id = ?, stage = 'offer', kind = 'bolig', rent_year = ?, listed_on = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
    ).bind(unit.id, unit.market_rent_year, listed, t, lease.id, orgId),
    env.DB.prepare(`UPDATE lease_units SET status = 'reserved', updated_at = ? WHERE id = ? AND org_id = ?`).bind(t, unit.id, orgId),
  ]);

  const nextLease: LeaseRow = { ...lease, unit_id: unit.id, stage: "offer", kind: "bolig", rent_year: unit.market_rent_year, listed_on: listed };
  const nextUnit: UnitRow = { ...unit, status: "reserved" };
  const draftWork: DeskWork = { ...work, kind: "bolig", letterKind: "tilbud", leaseId: lease.id, unitId: unit.id, title: lease.tenant_name };
  const draft = letterFor(draftWork, nextUnit, nextLease, name, today);
  const nextId = `tilbud.${lease.id}`;
  await saveLetter(env, orgId, nextId, lease.id, unit.id, draft.kind, draft.title, draft.body, actor);
  await activityStatement(env, {
    orgId,
    actor: actor.agentId ? { type: "agent", id: actor.agentId, name: actor.name } : { type: "user", id: actor.userId, name: actor.name },
    action: "lease.offer",
    entityType: "lease",
    entityId: lease.id,
    summary: `${lease.tenant_name} fikk tilbud om ${unit.name}`,
  }).run();

  const fresh = await book(env, orgId);
  const moved = fresh.works.find((w) => w.id === nextId) ?? fresh.works.find((w) => w.leaseId === lease.id);
  if (!moved) throw notFound("Saken");
  return { item: await present(env, orgId, moved, fresh.units, fresh.leases), notice: `${lease.tenant_name} har fått tilbud om ${unit.name}` };
}

const text = (max: number) =>
  z
    .union([z.string().max(max), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const t = v.trim();
      return t === "" ? null : t;
    });

const money = z.number().int().min(0).max(2_000_000_000).nullable().optional();
const date = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datoen må være på formen åååå-mm-dd"), z.null()]).optional();

export const deskPatchSchema = z.object({
  kind: z.enum(["bolig", "naering"]).optional(),
  unit_name: text(120),
  address: text(200),
  building_id: z.union([z.string().trim().min(1).max(64), z.null()]).optional(),
  area_sqm: z.number().min(0).max(10_000_000).nullable().optional(),
  rooms: z.number().int().min(0).max(40).nullable().optional(),
  market_rent_year: money,
  vacant_since: date,
  status: z.enum(["vacant", "make_ready", "occupied", "reserved"]).optional(),
  tenant_name: text(160),
  rent_year: money,
  start_on: date,
  end_on: date,
  break_on: date,
  index_on: date,
  arrears_nok: money,
  arrears_days: z.number().int().min(0).max(20_000).nullable().optional(),
  move_out_on: date,
  keys_on: date,
  vedtak_on: date,
  need: text(160),
  household: text(160),
});

export const deskCreateSchema = deskPatchSchema
  .pick({
    kind: true,
    tenant_name: true,
    unit_name: true,
    building_id: true,
    address: true,
    area_sqm: true,
    rooms: true,
    market_rent_year: true,
    rent_year: true,
    start_on: true,
    end_on: true,
    vacant_since: true,
    vedtak_on: true,
    need: true,
    household: true,
    arrears_nok: true,
    arrears_days: true,
  })
  .extend({
    shape: z.enum(["ledig", "leie", "vedtak"]),
    kind: z.enum(["bolig", "naering"]),
  });

type DeskPatch = z.infer<typeof deskPatchSchema>;

function given<T extends object>(patch: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key);
}

function recordFrom(unit: UnitRow | null, lease: LeaseRow | null): DeskRecord {
  return {
    leaseId: lease?.id ?? null,
    unitId: unit?.id ?? null,
    kind: unit?.kind ?? lease?.kind ?? "bolig",
    unitName: unit?.name ?? null,
    address: unit?.address ?? null,
    buildingId: unit?.building_id ?? null,
    areaSqm: unit?.area_sqm ?? null,
    rooms: unit?.rooms ?? null,
    marketRentYear: unit?.market_rent_year ?? null,
    vacantSince: unit?.vacant_since ?? null,
    status: unit?.status ?? null,
    tenantName: lease?.tenant_name ?? null,
    stage: lease?.stage ?? null,
    rentYear: lease?.rent_year ?? null,
    startOn: lease?.start_on ?? null,
    endOn: lease?.end_on ?? null,
    breakOn: lease?.break_on ?? null,
    indexOn: lease?.index_on ?? null,
    arrearsNok: lease?.arrears_nok ?? null,
    arrearsDays: lease?.arrears_days ?? null,
    moveOutOn: lease?.move_out_on ?? null,
    keysOn: lease?.keys_on ?? null,
    vedtakOn: lease?.vedtak_on ?? null,
    need: lease?.need ?? null,
    household: lease?.household ?? null,
  };
}

function caseFor(works: DeskWork[], leaseId: string | null, unitId: string | null): string | null {
  if (leaseId) return works.find((w) => w.leaseId === leaseId)?.id ?? null;
  if (unitId) return works.find((w) => w.unitId === unitId && !w.leaseId)?.id ?? null;
  return null;
}

function placeLine(unit: UnitRow | null, lease: LeaseRow | null): string {
  if (lease && lease.rent_year > 0) return `${formatKr(lease.rent_year)} / år`;
  if (lease?.stage === "vedtak") return "I kø";
  if (!lease) {
    if (unit?.status === "make_ready") return "Klargjøres";
    if (unit?.status === "reserved") return "Holdt av";
    if (unit?.status === "occupied") return "Utleid";
    return "Ledig";
  }
  return "Leie ikke satt";
}

function toPlace(unit: UnitRow | null, lease: LeaseRow | null, works: DeskWork[]): DeskPlace {
  const kind = unit?.kind ?? lease?.kind ?? "bolig";
  return {
    unitId: unit?.id ?? null,
    leaseId: lease?.id ?? null,
    caseId: caseFor(works, lease?.id ?? null, lease ? null : (unit?.id ?? null)),
    kind,
    title: lease?.tenant_name ?? (kind === "bolig" ? "Ledig bolig" : "Ledig lokale"),
    place: unit ? (unit.address ? `${unit.name} · ${unit.address}` : unit.name) : lease?.need?.trim() || "Ingen bolig",
    line: placeLine(unit, lease),
  };
}

function placesAside(units: UnitRow[], leases: LeaseRow[], works: DeskWork[]): DeskPlace[] {
  const seenLease = new Set(works.flatMap((w) => (w.leaseId ? [w.leaseId] : [])));
  const seenUnit = new Set(works.flatMap((w) => (w.unitId ? [w.unitId] : [])));
  const out: DeskPlace[] = [];
  for (const lease of leases) {
    if (lease.stage === "ended" || seenLease.has(lease.id)) continue;
    const unit = lease.unit_id ? (units.find((u) => u.id === lease.unit_id) ?? null) : null;
    out.push(toPlace(unit, lease, works));
  }
  for (const unit of units) {
    if (seenUnit.has(unit.id)) continue;
    if (leases.some((l) => l.unit_id === unit.id && l.stage !== "ended")) continue;
    out.push(toPlace(unit, null, works));
  }
  out.sort((a, b) => a.title.localeCompare(b.title, "nb"));
  return out;
}

function placesOnBuilding(units: UnitRow[], leases: LeaseRow[], works: DeskWork[], buildingId: string): DeskPlace[] {
  const mine = units.filter((u) => u.building_id === buildingId);
  const ids = new Set(mine.map((u) => u.id));
  const out: DeskPlace[] = [];
  for (const lease of leases) {
    if (lease.stage === "ended" || !lease.unit_id || !ids.has(lease.unit_id)) continue;
    out.push(toPlace(mine.find((u) => u.id === lease.unit_id) ?? null, lease, works));
  }
  for (const unit of mine) {
    if (leases.some((l) => l.unit_id === unit.id && l.stage !== "ended")) continue;
    out.push(toPlace(unit, null, works));
  }
  out.sort((a, b) => a.title.localeCompare(b.title, "nb"));
  return out;
}

function pairOf(b: { units: UnitRow[]; leases: LeaseRow[]; works: DeskWork[] }, ref: { caseId?: string; leaseId?: string; unitId?: string }) {
  if (ref.caseId) {
    const work = b.works.find((w) => w.id === ref.caseId);
    if (!work) throw notFound("Saken");
    return {
      title: work.title,
      caseId: work.id,
      unit: work.unitId ? (b.units.find((u) => u.id === work.unitId) ?? null) : null,
      lease: work.leaseId ? (b.leases.find((l) => l.id === work.leaseId) ?? null) : null,
    };
  }
  if (ref.leaseId) {
    const lease = b.leases.find((l) => l.id === ref.leaseId);
    if (!lease) throw notFound("Leieforholdet");
    const unit = lease.unit_id ? (b.units.find((u) => u.id === lease.unit_id) ?? null) : null;
    const work = b.works.find((w) => w.leaseId === lease.id);
    return { title: lease.tenant_name, caseId: work?.id ?? null, unit, lease };
  }
  if (ref.unitId) {
    const unit = b.units.find((u) => u.id === ref.unitId);
    if (!unit) throw notFound("Objektet");
    const work = b.works.find((w) => w.unitId === unit.id && !w.leaseId) ?? b.works.find((w) => w.unitId === unit.id);
    const lease = work?.leaseId ? (b.leases.find((l) => l.id === work.leaseId) ?? null) : (b.leases.find((l) => l.unit_id === unit.id && l.stage !== "ended") ?? null);
    return { title: lease?.tenant_name ?? unit.name, caseId: work?.id ?? null, unit, lease };
  }
  throw badRequest("Mangler hva som skal endres");
}

async function ownBuilding(env: Env, orgId: string, buildingId: string | null) {
  if (!buildingId) return;
  const row = await first<{ id: string }>(env.DB, `SELECT id FROM buildings WHERE id = ? AND org_id = ?`, buildingId, orgId);
  if (!row) throw badRequest("Ukjent bygg");
  assertCanEdit({ building_id: buildingId });
}

async function propertyAddress(env: Env, orgId: string, buildingId: string): Promise<string | null> {
  const row = await first<{ address: string | null }>(
    env.DB,
    `SELECT p.address AS address FROM buildings b JOIN properties p ON p.id = b.property_id WHERE b.id = ? AND b.org_id = ?`,
    buildingId,
    orgId,
  );
  const address = row?.address?.trim();
  return address || null;
}

function actorOf(actor: Actor) {
  return actor.agentId ? { type: "agent" as const, id: actor.agentId, name: actor.name } : { type: "user" as const, id: actor.userId, name: actor.name };
}

async function finishSave(env: Env, orgId: string, leaseId: string | null, unitId: string | null, notice: string): Promise<DeskSaved> {
  const b = await book(env, orgId);
  const hit = leaseId ? (b.works.find((w) => w.leaseId === leaseId) ?? null) : unitId ? (b.works.find((w) => w.unitId === unitId) ?? null) : null;
  if (!hit) return { item: null, notice: `${notice}. Den har ingen frist, så den ligger under køen.` };
  return { item: await present(env, orgId, hit, b.units, b.leases), notice };
}

export async function deskBuilding(env: Env, orgId: string, buildingId: string): Promise<DeskPlace[]> {
  const row = await first<{ id: string }>(env.DB, `SELECT id FROM buildings WHERE id = ? AND org_id = ?`, buildingId, orgId);
  if (!row || !visibleBuilding(buildingId)) throw notFound("Bygget");
  const b = await book(env, orgId);
  return placesOnBuilding(b.units, b.leases, b.works, buildingId);
}

export async function deskEditor(env: Env, orgId: string, ref: { caseId?: string; leaseId?: string; unitId?: string }): Promise<DeskEditor> {
  const b = await book(env, orgId);
  const pair = pairOf(b, ref);
  return { title: pair.title, caseId: pair.caseId, record: recordFrom(pair.unit, pair.lease) };
}

export async function createDeskItem(env: Env, orgId: string, input: z.infer<typeof deskCreateSchema>, actor: Actor): Promise<DeskSaved> {
  if (input.shape === "vedtak" && input.kind !== "bolig") throw badRequest("Vedtak uten bolig gjelder bolig");
  const tenant = input.tenant_name ?? null;
  const unitName = input.unit_name ?? null;
  if (input.shape !== "ledig" && !tenant) throw badRequest("Skriv hvem det gjelder");
  if (input.shape !== "vedtak" && !unitName) throw badRequest("Objektet må ha et navn");
  const buildingId = input.building_id ?? null;
  if (currentAccess().scope && (input.shape === "vedtak" || !buildingId)) {
    throw badRequest(input.shape === "vedtak" ? "Vedtak uten bolig krever tilgang til hele porteføljen" : "Velg bygget objektet ligger i");
  }
  if (buildingId) await ownBuilding(env, orgId, buildingId);
  else assertCanEdit();

  const t = now();
  const today = todayIso();
  let leaseId: string | null = null;
  let unitId: string | null = null;
  const address = input.address ?? (buildingId ? await propertyAddress(env, orgId, buildingId) : null);
  const kind: LeaseKind = input.shape === "vedtak" ? "bolig" : input.kind;

  if (input.shape !== "vedtak" && unitName) {
    unitId = newId("unt");
    await insert(env.DB, "lease_units", {
      id: unitId,
      org_id: orgId,
      building_id: buildingId,
      name: unitName,
      address,
      kind,
      area_sqm: input.area_sqm ?? null,
      rooms: input.rooms ?? null,
      status: input.shape === "ledig" ? "vacant" : "occupied",
      market_rent_year: input.market_rent_year ?? 0,
      vacant_since: input.shape === "ledig" ? (input.vacant_since ?? today) : null,
      created_at: t,
      updated_at: t,
    }).run();
  }

  if (input.shape !== "ledig" && tenant) {
    leaseId = newId("lse");
    await insert(env.DB, "leases", {
      id: leaseId,
      org_id: orgId,
      unit_id: unitId,
      kind,
      tenant_name: tenant,
      stage: input.shape === "vedtak" ? "vedtak" : "active",
      rent_year: input.rent_year ?? 0,
      start_on: input.start_on ?? null,
      end_on: input.end_on ?? null,
      break_on: null,
      signed_on: null,
      listed_on: null,
      arrears_nok: input.arrears_nok ?? 0,
      arrears_days: input.arrears_days ?? 0,
      index_on: null,
      move_out_on: null,
      keys_on: null,
      vedtak_on: input.shape === "vedtak" ? (input.vedtak_on ?? today) : null,
      need: input.need ?? null,
      household: input.household ?? null,
      created_at: t,
      updated_at: t,
    }).run();
  }

  const label = tenant ?? unitName ?? "saken";
  await activityStatement(env, {
    orgId,
    actor: actorOf(actor),
    action: "lease.created",
    entityType: "lease",
    entityId: leaseId ?? unitId ?? orgId,
    summary: `La inn ${label}`,
  }).run();
  return finishSave(env, orgId, leaseId, unitId, `La inn ${label}`);
}

const LEASE_WRITE = [
  "kind",
  "tenant_name",
  "rent_year",
  "start_on",
  "end_on",
  "break_on",
  "index_on",
  "arrears_nok",
  "arrears_days",
  "move_out_on",
  "keys_on",
  "vedtak_on",
  "need",
  "household",
  "updated_at",
] as const;

const UNIT_WRITE = ["name", "address", "kind", "building_id", "area_sqm", "rooms", "status", "market_rent_year", "vacant_since", "updated_at"] as const;

export async function saveDesk(env: Env, orgId: string, ref: { caseId?: string; leaseId?: string; unitId?: string }, patch: DeskPatch, actor: Actor): Promise<DeskSaved> {
  const b = await book(env, orgId);
  const pair = pairOf(b, ref);
  assertCanEdit(pair.unit?.building_id ? { building_id: pair.unit.building_id } : undefined);
  if (given(patch, "building_id")) await ownBuilding(env, orgId, patch.building_id ?? null);

  const t = now();
  let lease = pair.lease;
  const unit = pair.unit;

  if (!lease && !patch.tenant_name) {
    const wroteLease = (["rent_year", "start_on", "end_on", "break_on", "index_on", "move_out_on", "keys_on", "vedtak_on", "arrears_nok", "arrears_days"] as const).some(
      (key) => given(patch, key) && patch[key] != null,
    );
    if (wroteLease) throw badRequest("Skriv hvem leieforholdet gjelder");
  }

  if (!unit && given(patch, "unit_name") && patch.unit_name) throw badRequest("Saken har ikke et objekt");

  if (!lease && patch.tenant_name) {
    if (!unit) throw badRequest("Saken har ikke et objekt å knytte leietakeren til");
    const id = newId("lse");
    const kind = patch.kind ?? unit?.kind ?? "bolig";
    await insert(env.DB, "leases", {
      id,
      org_id: orgId,
      unit_id: unit?.id ?? null,
      kind,
      tenant_name: patch.tenant_name,
      stage: "active",
      rent_year: patch.rent_year ?? 0,
      start_on: patch.start_on ?? null,
      end_on: patch.end_on ?? null,
      break_on: patch.break_on ?? null,
      signed_on: null,
      listed_on: null,
      arrears_nok: patch.arrears_nok ?? 0,
      arrears_days: patch.arrears_days ?? 0,
      index_on: patch.index_on ?? null,
      move_out_on: patch.move_out_on ?? null,
      keys_on: patch.keys_on ?? null,
      vedtak_on: null,
      need: patch.need ?? null,
      household: patch.household ?? null,
      created_at: t,
      updated_at: t,
    }).run();
    lease = {
      id,
      unit_id: unit?.id ?? null,
      kind,
      tenant_name: patch.tenant_name,
      stage: "active",
      rent_year: patch.rent_year ?? 0,
      start_on: patch.start_on ?? null,
      end_on: patch.end_on ?? null,
      break_on: patch.break_on ?? null,
      signed_on: null,
      listed_on: null,
      arrears_nok: patch.arrears_nok ?? 0,
      arrears_days: patch.arrears_days ?? 0,
      index_on: patch.index_on ?? null,
      move_out_on: patch.move_out_on ?? null,
      keys_on: patch.keys_on ?? null,
      vedtak_on: null,
      need: patch.need ?? null,
      household: patch.household ?? null,
    };
  } else if (lease) {
    if (given(patch, "tenant_name") && !patch.tenant_name) throw badRequest("Leietakeren må ha et navn");
    const next: Record<string, unknown> = {};
    if (patch.kind) next.kind = patch.kind;
    if (given(patch, "tenant_name") && patch.tenant_name) next.tenant_name = patch.tenant_name;
    if (given(patch, "rent_year")) next.rent_year = patch.rent_year ?? 0;
    for (const key of ["start_on", "end_on", "break_on", "index_on", "move_out_on", "keys_on", "vedtak_on", "need", "household"] as const) {
      if (given(patch, key)) next[key] = patch[key] ?? null;
    }
    if (given(patch, "arrears_nok")) next.arrears_nok = patch.arrears_nok ?? 0;
    if (given(patch, "arrears_days")) next.arrears_days = patch.arrears_days ?? 0;
    if (Object.keys(next).length) {
      next.updated_at = t;
      const stmt = update(env.DB, "leases", next, LEASE_WRITE, { sql: "id = ? AND org_id = ?", params: [lease.id, orgId] });
      if (stmt) await stmt.run();
    }
  }

  if (unit) {
    const next: Record<string, unknown> = {};
    if (given(patch, "unit_name")) {
      if (!patch.unit_name) throw badRequest("Objektet må ha et navn");
      next.name = patch.unit_name;
    }
    if (given(patch, "address")) next.address = patch.address ?? null;
    if (patch.kind) next.kind = patch.kind;
    if (given(patch, "building_id")) next.building_id = patch.building_id ?? null;
    if (given(patch, "area_sqm")) next.area_sqm = patch.area_sqm ?? null;
    if (given(patch, "rooms")) next.rooms = patch.rooms ?? null;
    const addingTenant = !pair.lease && Boolean(patch.tenant_name);
    const status = addingTenant && (!patch.status || patch.status === "vacant" || patch.status === "make_ready") ? "occupied" : patch.status;
    if (status) next.status = status;
    if (given(patch, "market_rent_year")) next.market_rent_year = patch.market_rent_year ?? 0;
    if (given(patch, "vacant_since")) next.vacant_since = patch.vacant_since ?? null;
    if (Object.keys(next).length) {
      next.updated_at = t;
      const stmt = update(env.DB, "lease_units", next, UNIT_WRITE, { sql: "id = ? AND org_id = ?", params: [unit.id, orgId] });
      if (stmt) await stmt.run();
    }
  }

  const label = (given(patch, "tenant_name") ? patch.tenant_name : null) ?? lease?.tenant_name ?? unit?.name ?? pair.title;
  await activityStatement(env, {
    orgId,
    actor: actorOf(actor),
    action: "lease.updated",
    entityType: "lease",
    entityId: lease?.id ?? unit?.id ?? pair.caseId ?? orgId,
    summary: `Endret ${label}`,
  }).run();
  return finishSave(env, orgId, lease?.id ?? null, unit?.id ?? null, `Lagret ${label}`);
}

export async function removeDesk(env: Env, orgId: string, ref: { caseId?: string; leaseId?: string; unitId?: string }, actor: Actor): Promise<{ notice: string }> {
  const b = await book(env, orgId);
  const pair = pairOf(b, ref);
  assertCanEdit(pair.unit?.building_id ? { building_id: pair.unit.building_id } : undefined);
  const leaseId = pair.lease?.id ?? null;
  const unitId = pair.unit?.id ?? null;
  const others = unitId ? b.leases.filter((l) => l.unit_id === unitId && l.id !== leaseId && l.stage !== "ended") : [];
  const dropUnit = Boolean(unitId) && others.length === 0;
  const label = pair.lease?.tenant_name ?? pair.unit?.name ?? pair.title;
  const stmts: D1PreparedStatement[] = [];
  if (leaseId) stmts.push(env.DB.prepare(`DELETE FROM lease_letters WHERE org_id = ? AND lease_id = ?`).bind(orgId, leaseId));
  if (pair.caseId) stmts.push(env.DB.prepare(`DELETE FROM lease_letters WHERE org_id = ? AND case_id = ?`).bind(orgId, pair.caseId));
  if (leaseId) stmts.push(env.DB.prepare(`DELETE FROM leases WHERE id = ? AND org_id = ?`).bind(leaseId, orgId));
  if (dropUnit && unitId) {
    stmts.push(env.DB.prepare(`DELETE FROM leases WHERE org_id = ? AND unit_id = ?`).bind(orgId, unitId));
    stmts.push(env.DB.prepare(`DELETE FROM lease_letters WHERE org_id = ? AND unit_id = ?`).bind(orgId, unitId));
    stmts.push(env.DB.prepare(`DELETE FROM lease_units WHERE id = ? AND org_id = ?`).bind(unitId, orgId));
  }
  if (stmts.length === 0) throw badRequest("Ingenting å fjerne");
  await env.DB.batch(stmts);
  await activityStatement(env, {
    orgId,
    actor: actorOf(actor),
    action: "lease.deleted",
    entityType: "lease",
    entityId: leaseId ?? unitId ?? orgId,
    summary: `Fjernet ${label}`,
  }).run();
  if (leaseId && !dropUnit && others.length > 0) return { notice: `Fjernet leieforholdet ${label}. Objektet ligger fortsatt.` };
  return { notice: `Fjernet ${label}` };
}

export async function clearLeasesForPlace(env: Env, orgId: string, kind: "property" | "building", id: string): Promise<void> {
  const units =
    kind === "building"
      ? await all<{ id: string }>(env.DB, `SELECT id FROM lease_units WHERE org_id = ? AND building_id = ?`, orgId, id)
      : await all<{ id: string }>(
          env.DB,
          `SELECT u.id AS id FROM lease_units u JOIN buildings b ON b.id = u.building_id WHERE u.org_id = ? AND b.org_id = ? AND b.property_id = ?`,
          orgId,
          orgId,
          id,
        );
  for (let i = 0; i < units.length; i += 80) {
    const chunk = units.slice(i, i + 80).map((u) => u.id);
    const marks = chunk.map(() => "?").join(", ");
    const leases = await all<{ id: string }>(env.DB, `SELECT id FROM leases WHERE org_id = ? AND unit_id IN (${marks})`, orgId, ...chunk);
    const stmts: D1PreparedStatement[] = [env.DB.prepare(`DELETE FROM lease_letters WHERE org_id = ? AND unit_id IN (${marks})`).bind(orgId, ...chunk)];
    if (leases.length) {
      const lm = leases.map(() => "?").join(", ");
      stmts.push(env.DB.prepare(`DELETE FROM lease_letters WHERE org_id = ? AND lease_id IN (${lm})`).bind(orgId, ...leases.map((l) => l.id)));
    }
    stmts.push(env.DB.prepare(`DELETE FROM leases WHERE org_id = ? AND unit_id IN (${marks})`).bind(orgId, ...chunk));
    stmts.push(env.DB.prepare(`DELETE FROM lease_units WHERE org_id = ? AND id IN (${marks})`).bind(orgId, ...chunk));
    await env.DB.batch(stmts);
  }
}
