import type { Env } from "../env";
import { first } from "./db";
import { badRequest } from "./http";
import { osloMonthStart } from "./util";
import { PLAN_IDS, PLANS, planOf, type BillingStatus, type Plan, type PlanId } from "../../shared/types";

export function isPlatformAdmin(env: Env, email: string): boolean {
  const list = (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.trim().toLowerCase());
}

export function stripeReady(env: Env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID);
}

export function stripePriceFor(env: Env, plan: PlanId): string | null {
  return (plan === "pro" ? env.STRIPE_PRICE_ID_PRO : env.STRIPE_PRICE_ID) || null;
}

export function planForPrice(env: Env, priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  return PLAN_IDS.find((id) => stripePriceFor(env, id) === priceId) ?? null;
}

/** Planer som har pris i Stripe og kan velges */
export function availablePlans(env: Env): PlanId[] {
  if (!env.STRIPE_SECRET_KEY) return [];
  return PLAN_IDS.filter((id) => stripePriceFor(env, id));
}

export interface PlanRow {
  plan: string;
  plan_peak: string | null;
  plan_peak_month: number | null;
  building_limit: number;
}

const rank = (plan: Plan) => PLAN_IDS.indexOf(plan.id);

/** Planen som avgjør inkludert bruk: den høyeste organisasjonen har hatt denne måneden */
export function monthPlan(org: Pick<PlanRow, "plan" | "plan_peak" | "plan_peak_month">, monthStart = osloMonthStart()): Plan {
  const current = planOf(org.plan);
  if (!org.plan_peak || org.plan_peak_month !== monthStart) return current;
  const peak = planOf(org.plan_peak);
  return rank(peak) > rank(current) ? peak : current;
}

export function includedOre(org: Pick<PlanRow, "plan" | "plan_peak" | "plan_peak_month">, monthStart = osloMonthStart()): number {
  return monthPlan(org, monthStart).includedAiNok * 100;
}

/** building_limit er en avtalt kvote. Planen gir minst sine egne bygg. */
export function effectiveBuildingLimit(org: Pick<PlanRow, "plan" | "building_limit">): number {
  return Math.max(org.building_limit, planOf(org.plan).buildings);
}

/** Bytter plan i databasen. Returnerer forrige plan, eller null hvis den var den samme. */
export async function setPlan(env: Env, orgId: string, plan: PlanId): Promise<PlanId | null> {
  const org = await first<PlanRow>(env.DB, `SELECT plan, plan_peak, plan_peak_month, building_limit FROM orgs WHERE id = ?`, orgId);
  if (!org || org.plan === plan) return null;
  const month = osloMonthStart();
  const peak = monthPlan(org, month);
  await env.DB.prepare(`UPDATE orgs SET plan = ?, plan_peak = ?, plan_peak_month = ? WHERE id = ?`).bind(plan, peak.id, month, orgId).run();
  return planOf(org.plan).id;
}

export async function buildingCount(env: Env, orgId: string): Promise<number> {
  const row = await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM buildings WHERE org_id = ?`, orgId);
  return row?.n ?? 0;
}

export async function buildingLimit(env: Env, orgId: string): Promise<number> {
  const org = await first<Pick<PlanRow, "plan" | "building_limit">>(env.DB, `SELECT plan, building_limit FROM orgs WHERE id = ?`, orgId);
  return org ? effectiveBuildingLimit(org) : PLANS.standard.buildings;
}

/** Stopper nye bygg når organisasjonen har fylt kvoten. Pro eller en avtalt kvote gir flere. */
export async function assertCanAddBuilding(env: Env, orgId: string): Promise<void> {
  const org = await first<Pick<PlanRow, "plan" | "building_limit">>(env.DB, `SELECT plan, building_limit FROM orgs WHERE id = ?`, orgId);
  const plan = planOf(org?.plan);
  const limit = org ? effectiveBuildingLimit(org) : plan.buildings;
  const count = await buildingCount(env, orgId);
  if (count < limit) return;
  if (limit > plan.buildings) throw badRequest(`Kvoten er ${limit} bygg, og de er i bruk.`);
  throw badRequest(
    plan.id === "standard"
      ? `Standard dekker ${limit} bygg, og alle er i bruk. Pro dekker ${PLANS.pro.buildings} bygg.`
      : `${plan.name} dekker ${limit} bygg, og alle er i bruk. Ta kontakt for flere bygg.`,
  );
}

export function billingLabel(status: BillingStatus): string {
  switch (status) {
    case "active":
      return "Betaler";
    case "past_due":
      return "Forfalt";
    case "canceled":
      return "Avsluttet";
    case "demo":
      return "Demo";
    default:
      return "Ikke startet";
  }
}
