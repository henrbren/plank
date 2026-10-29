import { z } from "zod";
import type { Env } from "../env";
import { all } from "../lib/db";
import { badRequest } from "../lib/http";
import { now, osloDateLong, osloDay, osloDayEnd } from "../lib/util";
import type { Member, MemberPlace, Role } from "../../shared/types";

const ids = z.array(z.string().min(1).max(64)).max(1000);
const expiresOn = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato").nullable();

export const inviteSchema = z.object({
  email: z.string().trim().email("Ugyldig e-post").max(200),
  role: z.enum(["admin", "member"]).default("member"),
  can_edit: z.boolean().default(true),
  scope: z.enum(["all", "limited"]).default("all"),
  property_ids: ids.default([]),
  building_ids: ids.default([]),
  expires_on: expiresOn.default(null),
  message: z.string().trim().max(1000).optional(),
});

/** NB: uten standardverdier – zod 4 bruker ellers default også i .partial() */
export const memberPatchSchema = z
  .object({
    role: z.enum(["owner", "admin", "member"]),
    can_edit: z.boolean(),
    scope: z.enum(["all", "limited"]),
    property_ids: ids,
    building_ids: ids,
    expires_on: expiresOn,
  })
  .partial();

export interface MemberAccess {
  role: Role;
  canEdit: boolean;
  scope: "all" | "limited";
  places: MemberPlace[];
  expiresAt: number | null;
}

/** Validerer tilgangen mot organisasjonen. Eiere og administratorer har alltid full tilgang uten sluttdato. */
export async function resolveMemberAccess(
  env: Env,
  orgId: string,
  input: { role: Role; can_edit: boolean; scope: "all" | "limited"; property_ids: string[]; building_ids: string[]; expires_on: string | null },
): Promise<MemberAccess> {
  if (input.role !== "member") return { role: input.role, canEdit: true, scope: "all", places: [], expiresAt: null };
  let expiresAt: number | null = null;
  if (input.expires_on) {
    if (input.expires_on < osloDay(now())) throw badRequest("Sluttdatoen har allerede vært");
    expiresAt = osloDayEnd(input.expires_on);
  }
  if (input.scope === "all") return { role: "member", canEdit: input.can_edit, scope: "all", places: [], expiresAt };

  const propIds = [...new Set(input.property_ids)];
  const bldIds = [...new Set(input.building_ids)];
  const [props, blds] = await Promise.all([
    all<{ id: string; name: string }>(env.DB, `SELECT id, name FROM properties WHERE org_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY name`, orgId, JSON.stringify(propIds)),
    all<{ id: string; name: string; property_id: string; property_name: string }>(
      env.DB,
      `SELECT b.id, b.name, b.property_id, p.name AS property_name FROM buildings b JOIN properties p ON p.id = b.property_id
       WHERE b.org_id = ? AND b.id IN (SELECT value FROM json_each(?)) ORDER BY p.name, b.name`,
      orgId,
      JSON.stringify(bldIds),
    ),
  ]);
  if (props.length !== propIds.length || blds.length !== bldIds.length) throw badRequest("Noen av eiendommene eller byggene finnes ikke lenger");
  // Bygg på en eiendom som allerede er valgt i sin helhet, er dekket av eiendommen
  const whole = new Set(props.map((p) => p.id));
  const places: MemberPlace[] = [
    ...props.map((p) => ({ type: "property" as const, id: p.id, name: p.name, property_name: null })),
    ...blds.filter((b) => !whole.has(b.property_id)).map((b) => ({ type: "building" as const, id: b.id, name: b.name, property_name: b.property_name })),
  ];
  if (places.length === 0) throw badRequest("Velg minst én eiendom eller ett bygg");
  return { role: "member", canEdit: input.can_edit, scope: "limited", places, expiresAt };
}

/** Erstatter eiendommene og byggene medlemmet har tilgang til */
export function scopeStatements(env: Env, orgId: string, userId: string, access: MemberAccess): D1PreparedStatement[] {
  const ofType = (type: MemberPlace["type"]) => JSON.stringify(access.places.filter((p) => p.type === type).map((p) => p.id));
  return [
    env.DB.prepare(`DELETE FROM membership_scope WHERE org_id = ? AND user_id = ?`).bind(orgId, userId),
    env.DB.prepare(`INSERT INTO membership_scope (org_id, user_id, entity_type, entity_id) SELECT ?, ?, 'property', value FROM json_each(?)`).bind(orgId, userId, ofType("property")),
    env.DB.prepare(`INSERT INTO membership_scope (org_id, user_id, entity_type, entity_id) SELECT ?, ?, 'building', value FROM json_each(?)`).bind(orgId, userId, ofType("building")),
  ];
}

const LEVEL: Record<Role, string> = { owner: "Eier", admin: "Administrator", member: "" };

/** Lesbar beskrivelse til e-post og aktivitetslogg */
export function describeAccess(access: MemberAccess) {
  const level = access.role !== "member" ? `${LEVEL[access.role]} – full tilgang` : access.canEdit ? "Kan se og redigere" : "Kan se (lesetilgang)";
  const places = access.scope === "limited" ? access.places.map((p) => (p.type === "building" && p.property_name ? `${p.name} (${p.property_name})` : p.name)) : null;
  const expires = access.expiresAt ? osloDateLong(access.expiresAt - 1) : null;
  const props = access.places.filter((p) => p.type === "property").length;
  const blds = access.places.length - props;
  const scopeShort =
    access.scope === "all"
      ? "hele porteføljen"
      : [props ? `${props} ${props === 1 ? "eiendom" : "eiendommer"}` : "", blds ? `${blds} bygg` : ""].filter(Boolean).join(" og ");
  const short = access.role !== "member" ? LEVEL[access.role].toLowerCase() : `${access.canEdit ? "redigere" : "lese"}, ${scopeShort}${expires ? `, til ${expires}` : ""}`;
  return { level, places, expires, short };
}

/** Administratorer ser alles omfang, andre bare sitt eget */
export async function listMembers(env: Env, orgId: string, viewer: { userId: string; admin: boolean }): Promise<Member[]> {
  const rows = await all<{
    user_id: string;
    email: string;
    name: string | null;
    role: Role;
    created_at: number;
    can_edit: number;
    scope: "all" | "limited";
    expires_at: number | null;
    invited_by: string | null;
  }>(
    env.DB,
    `SELECT m.user_id, u.email, u.name, m.role, m.created_at, m.can_edit, m.scope, m.expires_at, COALESCE(iu.name, iu.email) AS invited_by
     FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN users iu ON iu.id = m.invited_by
     WHERE m.org_id = ?
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, COALESCE(u.name, u.email)`,
    orgId,
  );
  const places = await all<{ user_id: string; entity_type: "property" | "building"; entity_id: string; name: string | null; property_name: string | null }>(
    env.DB,
    `SELECT s.user_id, s.entity_type, s.entity_id, COALESCE(p.name, b.name) AS name, bp.name AS property_name
     FROM membership_scope s
     LEFT JOIN properties p ON s.entity_type = 'property' AND p.id = s.entity_id
     LEFT JOIN buildings b ON s.entity_type = 'building' AND b.id = s.entity_id
     LEFT JOIN properties bp ON bp.id = b.property_id
     WHERE s.org_id = ? AND (? = 1 OR s.user_id = ?)
     ORDER BY s.entity_type DESC, COALESCE(bp.name, p.name), b.name`,
    orgId,
    viewer.admin ? 1 : 0,
    viewer.userId,
  );
  const t = now();
  return rows.map((r) => {
    const member = r.role === "member";
    return {
      user_id: r.user_id,
      email: r.email,
      name: r.name,
      role: r.role,
      created_at: r.created_at,
      can_edit: !member || r.can_edit === 1,
      scope: member ? r.scope : "all",
      places: member
        ? places.filter((p) => p.user_id === r.user_id && p.name).map((p) => ({ type: p.entity_type, id: p.entity_id, name: p.name!, property_name: p.property_name }))
        : [],
      expires_on: member && r.expires_at ? osloDay(r.expires_at - 1) : null,
      expired: member && r.expires_at != null && r.expires_at <= t,
      invited_by: r.invited_by,
    };
  });
}
