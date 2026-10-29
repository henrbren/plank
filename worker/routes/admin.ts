import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { effectiveBuildingLimit, includedOre, isPlatformAdmin, setPlan } from "../lib/billing";
import { all, first } from "../lib/db";
import { body, forbidden, notFound } from "../lib/http";
import { forgetAiPause } from "../lib/usage";
import { osloMonthStart } from "../lib/util";
import { PLAN_IDS, type BillingStatus, type PlanId } from "../../shared/types";

export const admin = new Hono<AppEnv>();

admin.use("*", async (c, next) => {
  const email = c.get("user").email;
  if (!isPlatformAdmin(c.env, email)) throw forbidden("Bare plattformadministrator har tilgang");
  await next();
});

export interface AdminOrgRow {
  id: string;
  name: string;
  created_at: number;
  billing_status: BillingStatus;
  plan: PlanId;
  plan_peak: PlanId | null;
  plan_peak_month: number | null;
  building_limit: number;
  billing_note: string | null;
  stripe_subscription_id: string | null;
  spend_limit_ore: number | null;
  members: number;
  properties: number;
  buildings: number;
  owner_email: string | null;
  owner_name: string | null;
  month_cost_ore: number;
  month_billed_ore: number;
  month_trial_ore: number;
  credit_ore: number;
  credit_drawn_ore: number;
  included_ore: number;
  effective_limit: number;
}

const withPlan = (row: Omit<AdminOrgRow, "included_ore" | "effective_limit">): AdminOrgRow => ({
  ...row,
  included_ore: includedOre(row),
  effective_limit: effectiveBuildingLimit(row),
});

const ORG_SELECT = `
  SELECT o.id, o.name, o.created_at, o.billing_status, o.plan, o.plan_peak, o.plan_peak_month, o.building_limit, o.billing_note,
    o.stripe_subscription_id, o.spend_limit_ore,
    (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id) AS members,
    (SELECT COUNT(*) FROM properties p WHERE p.org_id = o.id) AS properties,
    (SELECT COUNT(*) FROM buildings b WHERE b.org_id = o.id) AS buildings,
    (SELECT COALESCE(SUM(cost_ore), 0) FROM usage_ledger u WHERE u.org_id = o.id AND u.created_at >= ?) AS month_cost_ore,
    (SELECT COALESCE(SUM(CASE WHEN billable = 1 THEN billed_ore ELSE 0 END), 0) FROM usage_ledger u WHERE u.org_id = o.id AND u.created_at >= ?) AS month_billed_ore,
    (SELECT COALESCE(SUM(CASE WHEN billable = 0 THEN billed_ore ELSE 0 END), 0) FROM usage_ledger u WHERE u.org_id = o.id AND u.created_at >= ?) AS month_trial_ore,
    (SELECT COALESCE(SUM(remaining_ore), 0) FROM credit_grants g WHERE g.org_id = o.id AND g.expires_at > ?) AS credit_ore,
    (SELECT COALESCE(SUM(billed_ore), 0) FROM credit_draws d WHERE d.org_id = o.id AND d.period_start = ?) AS credit_drawn_ore,
    (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND m.role = 'owner' LIMIT 1) AS owner_email,
    (SELECT u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND m.role = 'owner' LIMIT 1) AS owner_name
  FROM orgs o`;

admin.get("/signups", async (c) => {
  const rows = await all<{
    id: string;
    org_nr: string;
    org_name: string | null;
    org_form: string | null;
    brand: string;
    status: string;
    email: string;
    name: string | null;
    created_at: number;
  }>(c.env.DB, `SELECT id, org_nr, org_name, org_form, brand, status, email, name, created_at FROM brand_signups ORDER BY created_at DESC LIMIT 100`);
  return c.json({ signups: rows });
});

admin.get("/", async (c) => {
  const since = osloMonthStart();
  const rows = await all<Omit<AdminOrgRow, "included_ore" | "effective_limit">>(c.env.DB, `${ORG_SELECT} ORDER BY o.created_at DESC`, since, since, since, Date.now(), since);
  const orgs = rows.map(withPlan);
  const totals = await first<{ orgs: number; users: number; buildings: number; properties: number; paying: number; cost_ore: number; billed_ore: number }>(
    c.env.DB,
    `SELECT
       (SELECT COUNT(*) FROM orgs) AS orgs,
       (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM buildings) AS buildings,
       (SELECT COUNT(*) FROM properties) AS properties,
       (SELECT COUNT(*) FROM orgs WHERE billing_status = 'active') AS paying,
       (SELECT COALESCE(SUM(cost_ore), 0) FROM usage_ledger WHERE created_at >= ?) AS cost_ore,
       (SELECT COALESCE(SUM(CASE WHEN billable = 1 THEN billed_ore ELSE 0 END), 0) FROM usage_ledger WHERE created_at >= ?) AS billed_ore`,
    since,
    since,
  );
  return c.json({ orgs, totals });
});

admin.get("/:orgId", async (c) => {
  const orgId = c.req.param("orgId");
  const since = osloMonthStart();
  const row = await first<Omit<AdminOrgRow, "included_ore" | "effective_limit">>(c.env.DB, `${ORG_SELECT} WHERE o.id = ?`, since, since, since, Date.now(), since, orgId);
  if (!row) throw notFound("Organisasjonen");
  const org = withPlan(row);
  const members = await all<{ email: string; name: string | null; role: string; created_at: number }>(
    c.env.DB,
    `SELECT u.email, u.name, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.role, u.email`,
    orgId,
  );
  const properties = await all<{ id: string; name: string; city: string | null; address: string | null; buildings: number }>(
    c.env.DB,
    `SELECT p.id, p.name, p.city, p.address, (SELECT COUNT(*) FROM buildings b WHERE b.property_id = p.id) AS buildings FROM properties p WHERE p.org_id = ? ORDER BY p.name`,
    orgId,
  );
  const buildings = await all<{ id: string; name: string; building_type: string | null; gross_area: number | null; year_built: number | null; property_name: string; city: string | null }>(
    c.env.DB,
    `SELECT b.id, b.name, b.building_type, b.gross_area, b.year_built, p.name AS property_name, p.city
     FROM buildings b JOIN properties p ON p.id = b.property_id WHERE b.org_id = ? ORDER BY p.name, b.name`,
    orgId,
  );
  return c.json({ org, members, properties, buildings });
});

admin.patch("/:orgId", async (c) => {
  const orgId = c.req.param("orgId");
  const input = await body(
    c,
    z.object({
      building_limit: z.number().int().min(0).max(10000),
      billing_note: z.string().trim().max(500).nullable().optional(),
      plan: z.enum(PLAN_IDS as [PlanId, ...PlanId[]]).optional(),
    }),
  );
  const org = await first<{ stripe_subscription_id: string | null }>(c.env.DB, `SELECT stripe_subscription_id FROM orgs WHERE id = ?`, orgId);
  if (!org) throw notFound("Organisasjonen");
  await c.env.DB.prepare(`UPDATE orgs SET building_limit = ?, billing_note = ? WHERE id = ?`).bind(input.building_limit, input.billing_note ?? null, orgId).run();
  // Med Stripe-abonnement styres planen av prisen i Stripe, ellers settes den her.
  if (input.plan && !org.stripe_subscription_id) {
    await setPlan(c.env, orgId, input.plan);
    forgetAiPause(orgId);
  }
  return c.json({ ok: true });
});
