import type { Env } from "../env";
import { newId, now } from "./util";

const GUID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
const STOREY_HEIGHT = 3.2;

export interface BimRoomInput {
  number: string | null;
  name: string;
  area: number | null;
  x: number | null;
  y: number | null;
  w: number | null;
  d: number | null;
  guid?: string | null;
}

export interface BimFloorInput {
  name: string;
  level: number;
  guid?: string | null;
  rooms: BimRoomInput[];
}

export interface BimRoom {
  number: string | null;
  name: string;
  guid: string;
}

export interface BimFloor {
  name: string;
  level: number;
  guid: string;
  elevation: number;
  rooms: BimRoom[];
}

interface IndexedElement {
  express_id: number;
  guid: string;
  ifc_type: string;
  name: string;
  storey: string | null;
  props: Record<string, unknown> | null;
}

interface PlacedRoom extends BimRoomInput {
  guid: string;
  x: number;
  y: number;
  w: number;
  d: number;
}

/** 22-tegns IFC-globalid. */
export function ifcGuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  for (let i = 0; i < 22; i++) {
    out = GUID_CHARS[Number(n % 64n)] + out;
    n /= 64n;
  }
  return out;
}

function num(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return Number.isInteger(r) ? `${r}.` : String(r);
}

function step(value: string): string {
  const text = value.slice(0, 180);
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (ch === "'") out += "''";
    else if (c === 92) out += "\\\\";
    else if (c < 32 || c > 126) out += `\\X2\\${c.toString(16).toUpperCase().padStart(4, "0")}\\X0\\`;
    else out += ch;
  }
  return `'${out}'`;
}

const FLOOR_COLORS: [number, number, number][] = [
  [0.84, 0.78, 0.68],
  [0.75, 0.8, 0.74],
  [0.78, 0.74, 0.68],
  [0.73, 0.77, 0.82],
  [0.86, 0.82, 0.74],
  [0.8, 0.76, 0.7],
];

function hasBox(room: BimRoomInput): room is BimRoomInput & { x: number; y: number; w: number; d: number } {
  return (
    room.x != null &&
    room.y != null &&
    room.w != null &&
    room.d != null &&
    room.w > 0 &&
    room.d > 0 &&
    room.w <= 100 &&
    room.d <= 100 &&
    room.x >= -5 &&
    room.y >= -5 &&
    room.x <= 100 &&
    room.y <= 100
  );
}

function shelfSize(area: number | null): { w: number; d: number } {
  const a = area != null && area >= 2 ? Math.min(area, 400) : 16;
  const w = Math.min(18, Math.max(2.2, Math.sqrt(a * 1.35)));
  return { w, d: Math.min(14, Math.max(2.2, a / w)) };
}

function clusters(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  let group: number[] = [];
  for (const value of sorted) {
    if (group.length === 0 || value - group[group.length - 1]! <= tol) group.push(value);
    else {
      out.push(group.reduce((sum, n) => sum + n, 0) / group.length);
      group = [value];
    }
  }
  if (group.length) out.push(group.reduce((sum, n) => sum + n, 0) / group.length);
  return out;
}

function nearest(points: number[], value: number, tol: number): number {
  let best = value;
  let dist = tol;
  for (const point of points) {
    const d = Math.abs(point - value);
    if (d <= dist) {
      dist = d;
      best = point;
    }
  }
  return best;
}

/** x/y/w/d kan være prosent (0–100), andel (0–1) eller meter. Proposjonene fra tegningen beholdes. */
function layoutRooms(rooms: BimRoomInput[]): { placed: PlacedRoom[]; fromDrawing: boolean } {
  const drawn = rooms.filter(hasBox);
  const fromDrawing = rooms.length > 0 && drawn.length >= Math.ceil(rooms.length * 0.6);
  if (!fromDrawing) {
    const maxRow = 18;
    let x = 0;
    let y = 0;
    let rowDepth = 0;
    const placed = rooms.map((room) => {
      const { w, d } = shelfSize(room.area);
      if (x > 0 && x + w > maxRow) {
        y += rowDepth + 0.12;
        x = 0;
        rowDepth = 0;
      }
      const next = { ...room, guid: room.guid || ifcGuid(), x, y, w, d };
      x += w + 0.12;
      rowDepth = Math.max(rowDepth, d);
      return next;
    });
    return { placed, fromDrawing: false };
  }
  const maxV = Math.max(...drawn.flatMap((room) => [room.x, room.y, room.x + room.w, room.y + room.d, room.w, room.d]));
  const scale = maxV <= 1.5 ? 14 : maxV > 25 || drawn.some((room) => room.w > 18 || room.d > 18) ? 0.14 : 1;
  const tol = scale === 14 ? 0.03 : scale === 1 ? 0.35 : 3;
  const xs = clusters(drawn.flatMap((room) => [room.x, room.x + room.w]), tol);
  const ys = clusters(drawn.flatMap((room) => [room.y, room.y + room.d]), tol);
  const placed = drawn.map((room) => {
    const x1 = nearest(xs, room.x, tol);
    const x2 = nearest(xs, room.x + room.w, tol);
    const y1 = nearest(ys, room.y, tol);
    const y2 = nearest(ys, room.y + room.d, tol);
    return {
      ...room,
      guid: room.guid || ifcGuid(),
      x: Math.min(x1, x2) * scale,
      y: Math.min(y1, y2) * scale,
      w: Math.max(0.6, Math.abs(x2 - x1) * scale),
      d: Math.max(0.6, Math.abs(y2 - y1) * scale),
    };
  });
  return { placed, fromDrawing: true };
}

interface WallSeg {
  x: number;
  y: number;
  w: number;
  d: number;
  interior: boolean;
}

function subtractIntervals(base: { a: number; b: number }, cuts: { a: number; b: number }[]): { a: number; b: number }[] {
  let parts = [base];
  for (const cut of cuts) {
    const next: { a: number; b: number }[] = [];
    for (const part of parts) {
      if (cut.b <= part.a + 0.05 || cut.a >= part.b - 0.05) {
        next.push(part);
        continue;
      }
      if (cut.a > part.a + 0.05) next.push({ a: part.a, b: Math.min(cut.a, part.b) });
      if (cut.b < part.b - 0.05) next.push({ a: Math.max(cut.b, part.a), b: part.b });
    }
    parts = next;
  }
  return parts.filter((part) => part.b - part.a > 0.2);
}

function withDoor(a: number, b: number): { a: number; b: number }[] {
  if (b - a < 1.7) return [{ a, b }];
  const gap = 0.9;
  const mid = (a + b) / 2;
  const out: { a: number; b: number }[] = [];
  if (mid - gap / 2 - a > 0.15) out.push({ a, b: mid - gap / 2 });
  if (b - (mid + gap / 2) > 0.15) out.push({ a: mid + gap / 2, b });
  return out.length ? out : [{ a, b }];
}

/** Yttervegg der rommet møter friluft, innervegg der to rom deler en kant. */
function wallsBetween(rooms: PlacedRoom[]): WallSeg[] {
  const tExt = 0.16;
  const tInt = 0.1;
  const tol = 0.22;
  const walls: WallSeg[] = [];
  const horiz = rooms.flatMap((room) => [
    { y: room.y, x1: room.x, x2: room.x + room.w, side: "s" as const },
    { y: room.y + room.d, x1: room.x, x2: room.x + room.w, side: "n" as const },
  ]);
  const vert = rooms.flatMap((room) => [
    { x: room.x, y1: room.y, y2: room.y + room.d, side: "w" as const },
    { x: room.x + room.w, y1: room.y, y2: room.y + room.d, side: "e" as const },
  ]);
  const seen = new Set<string>();
  for (const edge of horiz) {
    const overlaps = horiz
      .filter((other) => other !== edge && Math.abs(other.y - edge.y) <= tol)
      .map((other) => ({ a: Math.max(edge.x1, other.x1), b: Math.min(edge.x2, other.x2) }))
      .filter((span) => span.b - span.a > 0.2);
    for (const span of subtractIntervals({ a: edge.x1, b: edge.x2 }, overlaps)) {
      walls.push({ x: span.a, y: edge.y + (edge.side === "s" ? -tExt : 0), w: span.b - span.a, d: tExt, interior: false });
    }
    for (const span of overlaps) {
      const key = `h${Math.round(edge.y * 10)}:${Math.round(span.a * 10)}:${Math.round(span.b * 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const part of withDoor(span.a, span.b)) walls.push({ x: part.a, y: edge.y - tInt / 2, w: part.b - part.a, d: tInt, interior: true });
    }
  }
  for (const edge of vert) {
    const overlaps = vert
      .filter((other) => other !== edge && Math.abs(other.x - edge.x) <= tol)
      .map((other) => ({ a: Math.max(edge.y1, other.y1), b: Math.min(edge.y2, other.y2) }))
      .filter((span) => span.b - span.a > 0.2);
    for (const span of subtractIntervals({ a: edge.y1, b: edge.y2 }, overlaps)) {
      walls.push({ x: edge.x + (edge.side === "w" ? -tExt : 0), y: span.a, w: tExt, d: span.b - span.a, interior: false });
    }
    for (const span of overlaps) {
      const key = `v${Math.round(edge.x * 10)}:${Math.round(span.a * 10)}:${Math.round(span.b * 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const part of withDoor(span.a, span.b)) walls.push({ x: edge.x - tInt / 2, y: part.a, w: tInt, d: part.b - part.a, interior: true });
    }
  }
  return walls;
}

class IfcFile {
  private lines: string[] = [];
  private n = 0;
  readonly up: number;
  readonly xdir: number;
  readonly body: number;

  constructor() {
    const origin = this.add(`IFCCARTESIANPOINT((0.,0.,0.))`);
    this.up = this.add(`IFCDIRECTION((0.,0.,1.))`);
    this.xdir = this.add(`IFCDIRECTION((1.,0.,0.))`);
    const axis = this.add(`IFCAXIS2PLACEMENT3D(#${origin},#${this.up},#${this.xdir})`);
    const ctx = this.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#${axis},$)`);
    this.body = this.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#${ctx},$,.MODEL_VIEW.,$)`);
    this.projectContext = ctx;
  }

  projectContext: number;

  add(body: string): number {
    const id = ++this.n;
    this.lines.push(`#${id}=${body};`);
    return id;
  }

  text(name: string): string {
    const stamp = new Date().toISOString().slice(0, 19);
    return [
      "ISO-10303-21;",
      "HEADER;",
      "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
      `FILE_NAME(${step(name)},'${stamp}',('Plank'),('Plank'),'Plank','Plank','');`,
      "FILE_SCHEMA(('IFC4'));",
      "ENDSEC;",
      "DATA;",
      ...this.lines,
      "ENDSEC;",
      "END-ISO-10303-21;",
      "",
    ].join("\n");
  }

  placement(parent: number | null, x: number, y: number, z: number): number {
    const pt = this.add(`IFCCARTESIANPOINT((${num(x)},${num(y)},${num(z)}))`);
    const ax = this.add(`IFCAXIS2PLACEMENT3D(#${pt},#${this.up},#${this.xdir})`);
    return this.add(`IFCLOCALPLACEMENT(${parent == null ? "$" : `#${parent}`},#${ax})`);
  }

  box(w: number, d: number, h: number, rgb: [number, number, number], transparency: number): number {
    const list = this.add(`IFCCARTESIANPOINTLIST2D(((0.,0.),(${num(w)},0.),(${num(w)},${num(d)}),(0.,${num(d)})))`);
    const curve = this.add(`IFCINDEXEDPOLYCURVE(#${list},(IFCLINEINDEX((1,2,3,4,1))),$)`);
    const profile = this.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#${curve})`);
    const pt = this.add(`IFCCARTESIANPOINT((0.,0.,0.))`);
    const ax = this.add(`IFCAXIS2PLACEMENT3D(#${pt},#${this.up},#${this.xdir})`);
    const solid = this.add(`IFCEXTRUDEDAREASOLID(#${profile},#${ax},#${this.up},${num(h)})`);
    const colour = this.add(`IFCCOLOURRGB($,${num(rgb[0])},${num(rgb[1])},${num(rgb[2])})`);
    const shade = this.add(`IFCSURFACESTYLESHADING(#${colour},${num(transparency)})`);
    const style = this.add(`IFCSURFACESTYLE($,.BOTH.,(#${shade}))`);
    this.add(`IFCSTYLEDITEM(#${solid},(#${style}),$)`);
    const rep = this.add(`IFCSHAPEREPRESENTATION(#${this.body},'Body','SweptSolid',(#${solid}))`);
    return this.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
  }
}

/** Forenklet IFC4. Rommene er synlige gulvflater, veggene følger omrisset på tegningen. */
export function buildBimModel(opts: { buildingName: string; siteName: string; floors: BimFloorInput[] }): { text: string; floors: BimFloor[]; elements: IndexedElement[]; fromDrawing: boolean } {
  const file = new IfcFile();
  const elements: IndexedElement[] = [];
  const metre = file.add(`IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)`);
  const area = file.add(`IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)`);
  const volume = file.add(`IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)`);
  const units = file.add(`IFCUNITASSIGNMENT((#${metre},#${area},#${volume}))`);
  const project = file.add(`IFCPROJECT('${ifcGuid()}',$,${step(opts.siteName)},$,$,$,$,(#${file.projectContext}),#${units})`);
  const site = file.add(`IFCSITE('${ifcGuid()}',$,${step(opts.siteName)},$,$,$,$,$,$,$,$,$,$,$)`);
  const building = file.add(`IFCBUILDING('${ifcGuid()}',$,${step(opts.buildingName)},$,$,$,$,$,$,$,$,$)`);
  file.add(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,#${project},(#${site}))`);
  file.add(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,#${site},(#${building}))`);

  const outFloors: BimFloor[] = [];
  const storeyIds: number[] = [];
  let fromDrawing = true;

  for (const floor of opts.floors) {
    const layout = layoutRooms(floor.rooms);
    const placed = layout.placed;
    if (floor.rooms.length > 0 && !layout.fromDrawing) fromDrawing = false;
    if (placed.length === 0) continue;
    const guid = floor.guid || ifcGuid();
    const elevation = floor.level * STOREY_HEIGHT;
    const placement = file.placement(null, 0, 0, elevation);
    const storeyId = file.add(`IFCBUILDINGSTOREY('${guid}',$,${step(floor.name)},$,$,#${placement},$,$,$,${num(elevation)})`);
    storeyIds.push(storeyId);
    elements.push({ express_id: storeyId, guid, ifc_type: "IfcBuildingStorey", name: floor.name, storey: floor.name, props: null });

    const contained: number[] = [];
    placed.forEach((room, index) => {
      const color = FLOOR_COLORS[index % FLOOR_COLORS.length]!;
      const slabPlace = file.placement(placement, room.x, room.y, 0.02);
      const slabShape = file.box(room.w, room.d, 0.04, color, 0);
      const slabGuid = ifcGuid();
      const label = room.number ? `${room.number} ${room.name}` : room.name;
      const slabId = file.add(`IFCSLAB('${slabGuid}',$,${step(label)},$,$,#${slabPlace},#${slabShape},$,.FLOOR.)`);
      contained.push(slabId);
      elements.push({ express_id: slabId, guid: slabGuid, ifc_type: "IfcSlab", name: label, storey: floor.name, props: { PredefinedType: "FLOOR" } });
    });

    for (const wall of wallsBetween(placed)) {
      const wallPlace = file.placement(placement, wall.x, wall.y, 0.06);
      const wallShape = file.box(wall.w, wall.d, 2.3, wall.interior ? [0.9, 0.88, 0.84] : [0.82, 0.8, 0.76], 0);
      const wallGuid = ifcGuid();
      const wallName = wall.interior ? "Innervegg" : "Yttervegg";
      const wallId = file.add(`IFCWALL('${wallGuid}',$,${step(wallName)},$,$,#${wallPlace},#${wallShape},$,.STANDARD.)`);
      contained.push(wallId);
      elements.push({ express_id: wallId, guid: wallGuid, ifc_type: "IfcWall", name: wallName, storey: floor.name, props: { PredefinedType: "STANDARD" } });
    }

    const spaceIds: number[] = [];
    const rooms: BimRoom[] = [];
    for (const room of placed) {
      const spacePlace = file.placement(placement, room.x + 0.05, room.y + 0.05, 0);
      const spaceShape = file.box(Math.max(0.4, room.w - 0.1), Math.max(0.4, room.d - 0.1), 2.7, [0.55, 0.7, 0.78], 0.45);
      const spaceName = room.number || room.name;
      const longName = room.number ? room.name : null;
      const spaceId = file.add(`IFCSPACE('${room.guid}',$,${step(spaceName)},$,$,#${spacePlace},#${spaceShape},${longName ? step(longName) : "$"},$,.INTERNAL.,$)`);
      spaceIds.push(spaceId);
      const net = Math.round(Math.max(0.4, room.w - 0.1) * Math.max(0.4, room.d - 0.1) * 10) / 10;
      const qty = file.add(`IFCQUANTITYAREA('NetFloorArea',$,$,${num(room.area && room.area > 0 ? room.area : net)},$)`);
      const qset = file.add(`IFCELEMENTQUANTITY('${ifcGuid()}',$,'Qto_SpaceBaseQuantities',$,'BaseQuantities',(#${qty}))`);
      file.add(`IFCRELDEFINESBYPROPERTIES('${ifcGuid()}',$,$,$,(#${spaceId}),#${qset})`);
      elements.push({
        express_id: spaceId,
        guid: room.guid,
        ifc_type: "IfcSpace",
        name: spaceName,
        storey: floor.name,
        props: longName ? { LongName: longName, PredefinedType: "INTERNAL" } : { PredefinedType: "INTERNAL" },
      });
      rooms.push({ number: room.number, name: room.name, guid: room.guid });
    }
    if (spaceIds.length) file.add(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,#${storeyId},(${spaceIds.map((id) => `#${id}`).join(",")}))`);
    if (contained.length) file.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${ifcGuid()}',$,$,$,(${contained.map((id) => `#${id}`).join(",")}),#${storeyId})`);
    outFloors.push({ name: floor.name, level: floor.level, guid, elevation, rooms });
  }

  if (storeyIds.length) file.add(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,#${building},(${storeyIds.map((id) => `#${id}`).join(",")}))`);
  return { text: file.text(`${opts.buildingName}.ifc`), floors: outFloors, elements, fromDrawing: fromDrawing && outFloors.length > 0 };
}

/** Lagrer IFC-filen og indeksen, så modellen vises under BIM uten å åpnes først. */
export async function storeBimModel(
  env: Env,
  opts: { orgId: string; propertyId: string; buildingId: string; buildingName: string; userId: string; text: string; elements: IndexedElement[] },
): Promise<string> {
  const previous = await env.DB.prepare(
    `SELECT id, r2_key FROM documents WHERE org_id = ? AND building_id = ? AND kind = 'ifc' AND summary LIKE 'Forenklet BIM-modell laget fra plantegning%'`,
  )
    .bind(opts.orgId, opts.buildingId)
    .all<{ id: string; r2_key: string }>();
  for (const old of previous.results ?? []) {
    await env.FILES.delete(old.r2_key);
    await env.DB.prepare(`DELETE FROM documents WHERE id = ? AND org_id = ?`).bind(old.id, opts.orgId).run();
  }

  const id = newId("doc");
  const filename = `bim-${opts.buildingName.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40) || "bygg"}.ifc`;
  const key = `orgs/${opts.orgId}/documents/${id}/${filename}`;
  const bytes = new TextEncoder().encode(opts.text);
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: "application/x-step" } });
  const t = now();
  await env.DB.prepare(
    `INSERT INTO documents (id, org_id, property_id, building_id, floor_id, room_id, component_id, title, filename, mime, size, r2_key, kind, ns3451, status, error, summary, text_chars, uploaded_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, 'application/x-step', ?, ?, 'ifc', NULL, 'stored', NULL, ?, NULL, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.orgId,
      opts.propertyId,
      opts.buildingId,
      `BIM – ${opts.buildingName}`.slice(0, 200),
      filename,
      bytes.byteLength,
      key,
      "Forenklet BIM-modell laget fra plantegning. Etasjer og rom er koblet til registeret.",
      opts.userId,
      t,
      t,
    )
    .run();

  const byType: Record<string, number> = {};
  const byStorey: Record<string, number> = {};
  const rows = opts.elements
    .filter((e) => e.ifc_type !== "IfcBuildingStorey")
    .map((e) => {
      byType[e.ifc_type] = (byType[e.ifc_type] ?? 0) + 1;
      if (e.storey) byStorey[e.storey] = (byStorey[e.storey] ?? 0) + 1;
      return { e: e.express_id, g: e.guid, t: e.ifc_type, n: e.name, s: e.storey, p: e.props ? JSON.stringify(e.props) : null };
    });
  for (let i = 0; i < rows.length; i += 40) {
    const batch = rows.slice(i, i + 40);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO ifc_elements (document_id, org_id, building_id, express_id, guid, ifc_type, name, storey, props)
       SELECT ?1, ?2, ?3, json_extract(value, '$.e'), json_extract(value, '$.g'), json_extract(value, '$.t'), json_extract(value, '$.n'), json_extract(value, '$.s'), json_extract(value, '$.p')
       FROM json_each(?4)`,
    )
      .bind(id, opts.orgId, opts.buildingId, JSON.stringify(batch))
      .run();
  }
  await env.DB.prepare(`INSERT OR REPLACE INTO ifc_models (document_id, org_id, building_id, schema, stats, indexed_at) VALUES (?, ?, ?, 'IFC4', ?, ?)`).bind(
    id,
    opts.orgId,
    opts.buildingId,
    JSON.stringify({ by_type: byType, by_storey: byStorey }),
    t,
  ).run();
  return id;
}
