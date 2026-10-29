import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { nextRunAt } from "../agent/schedule";
import { DEFAULT_TEMPLATE_KEYS, AGENT_TEMPLATES } from "../agent/templates";
import { seedHelp } from "../services/help";
import { activityScopeSql, scopeSql } from "../lib/access";
import { requireAdmin } from "../lib/auth";
import { brandOf, emailFrom, publicOrigin } from "../lib/brand";
import { all, first, insert } from "../lib/db";
import { emailConfigured, memberInviteEmail, sendEmail } from "../lib/email";
import { badRequest, body, forbidden, notFound } from "../lib/http";
import { newId, normalizeEmail, now, osloDay, osloNextMonthStart, todayIso } from "../lib/util";
import { describeAccess, inviteSchema, listMembers, memberPatchSchema, resolveMemberAccess, scopeStatements } from "../services/members";
import { availablePlans, buildingCount, effectiveBuildingLimit, setPlan, stripeReady } from "../lib/billing";
import { boligmappaConfigured } from "../lib/boligmappa";
import { forgetAiPause, usageByDay, usageThisMonth } from "../lib/usage";
import { seedDemo } from "../lib/demo";
import { changeSubscriptionPlan, createCreditCheckout, createPortalSession, createSubscriptionCheckout, ensureStripeCustomer } from "../lib/stripe";
import { logActivity } from "../lib/activity";
import {
  creditPack,
  PLAN_IDS,
  PLANS,
  planOf,
  type Activation,
  type ActivityItem,
  type BillingInfo,
  type BillingStatus,
  type Component,
  type Document,
  type OrgOverview,
  type Role,
  type PlanId,
  type Task,
  type UsageDay,
} from "../../shared/types";
import { createLoginLink, INVITE_TTL_MS } from "./auth";

export async function createOrg(env: Env, name: string, ownerId: string) {
  const id = newId("org");
  const t = now();
  const stmts = [
    env.DB.prepare(`INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)`).bind(id, name, t),
    env.DB.prepare(`INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`).bind(id, ownerId, t),
  ];
  for (const key of DEFAULT_TEMPLATE_KEYS) {
    const tpl = AGENT_TEMPLATES.find((a) => a.key === key)!;
    const schedule = tpl.key === "hjelp" ? (tpl.schedule ?? null) : null;
    stmts.push(
      insert(env.DB, "agents", {
        id: newId("agt"),
        org_id: id,
        name: tpl.name,
        icon: tpl.icon,
        color: tpl.color,
        description: tpl.description,
        instructions: tpl.instructions,
        model: env.DEFAULT_MODEL || "claude-sonnet-5-5",
        effort: tpl.effort,
        tools: tpl.tools,
        scope_type: "org",
        schedule,
        schedule_prompt: tpl.schedule_prompt ?? null,
        notify_emails: [],
        next_run_at: schedule ? (nextRunAt(schedule, t) ?? undefined) : undefined,
        template: tpl.key,
        created_by: ownerId,
        created_at: t,
        updated_at: t,
      }),
    );
  }
  await env.DB.batch(stmts);
  await seedHelp(env, id);
  return { id, name, role: "owner" as const, can_edit: true, limited: false, expires_on: null };
}

export const orgs = new Hono<AppEnv>();

const planSchema = z.enum(PLAN_IDS as [PlanId, ...PlanId[]]);

orgs.get("/billing", async (c) => {
  const orgId = c.get("orgId");
  const org = await first<{
    billing_status: BillingInfo["status"];
    plan: string;
    building_limit: number;
    billing_note: string | null;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    spend_limit_ore: number | null;
  }>(
    c.env.DB,
    `SELECT billing_status, plan, building_limit, billing_note, stripe_customer_id, stripe_subscription_id, spend_limit_ore FROM orgs WHERE id = ?`,
    orgId,
  );
  const [count, usage] = await Promise.all([buildingCount(c.env, orgId), usageThisMonth(c.env, orgId)]);
  const info: BillingInfo = {
    status: org?.billing_status ?? "none",
    plan: planOf(org?.plan).id,
    managed: org?.billing_status === "active" && !org.stripe_subscription_id,
    portal: Boolean(org?.stripe_customer_id),
    building_limit: org ? effectiveBuildingLimit(org) : PLANS.standard.buildings,
    building_count: count,
    stripe_ready: stripeReady(c.env),
    plans_available: availablePlans(c.env),
    note: org?.billing_note ?? null,
    spend_limit_ore: org?.spend_limit_ore ?? null,
    resets_at: osloNextMonthStart(),
    usage,
  };
  return c.json(info);
});

orgs.get("/billing/daily", async (c) => {
  const days: UsageDay[] = await usageByDay(c.env, c.get("orgId"));
  return c.json(days);
});

orgs.post("/billing/checkout", async (c) => {
  requireAdmin(c);
  const input = await body(c, z.object({ plan: planSchema.optional() }));
  const orgId = c.get("orgId");
  const org = await first<{ name: string; billing_status: string; stripe_subscription_id: string | null }>(
    c.env.DB,
    `SELECT name, billing_status, stripe_subscription_id FROM orgs WHERE id = ?`,
    orgId,
  );
  if (org?.billing_status === "active" && org.stripe_subscription_id) throw badRequest("Abonnementet er allerede aktivt. Bytt plan i stedet.");
  const owner = await first<{ email: string }>(
    c.env.DB,
    `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.role = 'owner' LIMIT 1`,
    orgId,
  );
  const email = owner?.email ?? c.get("user").email;
  const customerId = await ensureStripeCustomer(c.env, orgId, email, org?.name ?? "Plank");
  const base = c.env.APP_URL.replace(/\/$/, "");
  const url = await createSubscriptionCheckout(c.env, {
    orgId,
    customerId,
    plan: input.plan ?? "standard",
    successUrl: `${base}/o/${orgId}/abonnement?abonnement=ok`,
    cancelUrl: `${base}/o/${orgId}/abonnement`,
  });
  return c.json({ url });
});

orgs.post("/billing/plan", async (c) => {
  requireAdmin(c);
  const { plan } = await body(c, z.object({ plan: planSchema }));
  const orgId = c.get("orgId");
  const org = await first<{ billing_status: string; stripe_subscription_id: string | null; plan: string }>(
    c.env.DB,
    `SELECT billing_status, stripe_subscription_id, plan FROM orgs WHERE id = ?`,
    orgId,
  );
  if (org?.billing_status !== "active" || !org.stripe_subscription_id) throw badRequest("Start abonnementet først.");
  if (org.plan === plan) return c.json({ ok: true, plan, payUrl: null });
  const result = await changeSubscriptionPlan(c.env, org.stripe_subscription_id, plan);
  if (!result.applied) return c.json({ ok: false, plan: planOf(org.plan).id, payUrl: result.payUrl });
  const previous = await setPlan(c.env, orgId, plan);
  forgetAiPause(orgId);
  if (previous) {
    await logActivity(c.env, {
      orgId,
      actor: { type: "user", id: c.get("user").id, name: c.get("user").name ?? c.get("user").email },
      action: "billing.plan_changed",
      entityType: "org",
      entityId: orgId,
      summary: `Byttet plan fra ${PLANS[previous].name} til ${PLANS[plan].name}`,
    });
  }
  return c.json({ ok: true, plan, payUrl: null });
});

orgs.patch("/billing/limit", async (c) => {
  requireAdmin(c);
  const { limitNok } = await body(c, z.object({ limitNok: z.number().int("Skriv et helt antall kroner").min(0, "Grensen kan ikke være negativ").max(1_000_000).nullable() }));
  const orgId = c.get("orgId");
  const limitOre = limitNok === null ? null : limitNok * 100;
  await c.env.DB.prepare(`UPDATE orgs SET spend_limit_ore = ?, limit_warned_month = NULL, limit_reached_month = NULL WHERE id = ?`).bind(limitOre, orgId).run();
  forgetAiPause(orgId);
  await logActivity(c.env, {
    orgId,
    actor: { type: "user", id: c.get("user").id, name: c.get("user").name ?? c.get("user").email },
    action: "billing.limit_changed",
    entityType: "org",
    entityId: orgId,
    summary: limitNok === null ? "Fjernet grensen for ekstra AI-bruk" : `Satte grensen for ekstra AI-bruk til ${limitNok.toLocaleString("nb-NO")} kr per måned`,
  });
  return c.json({ ok: true, spend_limit_ore: limitOre, usage: await usageThisMonth(c.env, orgId) });
});

orgs.post("/billing/credits", async (c) => {
  requireAdmin(c);
  const input = await body(c, z.object({ packId: z.string() }));
  const pack = creditPack(input.packId);
  if (!pack) throw badRequest("Ukjent kreditpakke");
  const orgId = c.get("orgId");
  const org = await first<{ name: string; billing_status: string; stripe_subscription_id: string | null }>(
    c.env.DB,
    `SELECT name, billing_status, stripe_subscription_id FROM orgs WHERE id = ?`,
    orgId,
  );
  if (org?.billing_status !== "active" || !org.stripe_subscription_id) throw badRequest("Kreditter kan kjøpes når abonnementet er aktivt.");
  const owner = await first<{ email: string }>(
    c.env.DB,
    `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.role = 'owner' LIMIT 1`,
    orgId,
  );
  const customerId = await ensureStripeCustomer(c.env, orgId, owner?.email ?? c.get("user").email, org.name);
  const base = c.env.APP_URL.replace(/\/$/, "");
  const url = await createCreditCheckout(c.env, {
    orgId,
    customerId,
    pack,
    successUrl: `${base}/o/${orgId}/abonnement?kreditter=ok`,
    cancelUrl: `${base}/o/${orgId}/abonnement`,
  });
  return c.json({ url });
});

orgs.post("/billing/portal", async (c) => {
  requireAdmin(c);
  const org = await first<{ stripe_customer_id: string | null }>(c.env.DB, `SELECT stripe_customer_id FROM orgs WHERE id = ?`, c.get("orgId"));
  if (!org?.stripe_customer_id) throw badRequest("Abonnementet er ikke startet ennå");
  const base = c.env.APP_URL.replace(/\/$/, "");
  const url = await createPortalSession(c.env, org.stripe_customer_id, `${base}/o/${c.get("orgId")}/abonnement`);
  return c.json({ url });
});

orgs.patch("/", async (c) => {
  requireAdmin(c);
  const input = await body(c, z.object({ name: z.string().trim().min(2).max(100) }));
  await c.env.DB.prepare(`UPDATE orgs SET name = ? WHERE id = ?`).bind(input.name, c.get("orgId")).run();
  return c.json({ ok: true });
});

orgs.get("/activation", async (c) => {
  const orgId = c.get("orgId");
  const db = c.env.DB;
  const count = (sql: string, ...extra: string[]) => db.prepare(sql).bind(orgId, ...extra);
  const props = scopeSql({ property: "id" });
  const blds = scopeSql({ building: "id" });
  const placed = scopeSql({ building: "building_id", property: "property_id" });
  const comps = scopeSql({ building: "building_id" });
  const [propCount, firstProperty, buildings, docs, talked, overdue, overdueOne, org, source, pending] = await db.batch<{ n: number } | { id: string } | { billing_status: string } | { org_nr: string; status: string; building_count: number }>([
    count(`SELECT COUNT(*) AS n FROM properties WHERE org_id = ? AND ${props.sql}`, ...props.params),
    count(`SELECT id FROM properties WHERE org_id = ? AND ${props.sql} ORDER BY created_at LIMIT 1`, ...props.params),
    count(`SELECT COUNT(*) AS n FROM buildings WHERE org_id = ? AND ${blds.sql}`, ...blds.params),
    count(`SELECT COUNT(*) AS n FROM documents WHERE org_id = ? AND ${placed.sql}`, ...placed.params),
    count(`SELECT COUNT(*) AS n FROM messages WHERE org_id = ? AND role = 'user'`),
    count(`SELECT COUNT(*) AS n FROM components WHERE org_id = ? AND next_service_at IS NOT NULL AND next_service_at < ? AND ${comps.sql}`, todayIso(), ...comps.params),
    count(`SELECT id FROM components WHERE org_id = ? AND next_service_at IS NOT NULL AND next_service_at < ? AND ${comps.sql} ORDER BY next_service_at LIMIT 1`, todayIso(), ...comps.params),
    count(`SELECT billing_status FROM orgs WHERE id = ?`),
    count(`SELECT org_nr, status, building_count FROM bm_sources WHERE org_id = ?`),
    count(
      `SELECT COUNT(*) AS n FROM bm_buildings WHERE org_id = ? AND bmn NOT IN (SELECT boligmappa_number FROM buildings WHERE org_id = ? AND boligmappa_number IS NOT NULL)`,
      orgId,
    ),
  ]);
  const month = await usageThisMonth(c.env, orgId);
  const n = (r: D1Result<{ n: number }> | undefined) => (r?.results?.[0] as { n?: number } | undefined)?.n ?? 0;
  const billingRow = org?.results?.[0] as { billing_status?: string } | undefined;
  const sourceRow = source?.results?.[0] as { status?: string; building_count?: number } | undefined;
  const result: Activation = {
    properties: n(propCount as D1Result<{ n: number }>),
    firstPropertyId: (firstProperty?.results?.[0] as { id?: string } | undefined)?.id ?? null,
    buildings: n(buildings as D1Result<{ n: number }>),
    documents: n(docs as D1Result<{ n: number }>),
    talked: n(talked as D1Result<{ n: number }>) > 0,
    serviceOverdue: n(overdue as D1Result<{ n: number }>),
    serviceComponentId: (overdueOne?.results?.[0] as { id?: string } | undefined)?.id ?? null,
    billing: (billingRow?.billing_status as BillingStatus) || "none",
    stripeReady: stripeReady(c.env),
    monthUsageOre: month.trialOre,
    monthInvoiceOre: month.invoiceOre,
    boligmappa: {
      configured: boligmappaConfigured(c.env),
      connected: Boolean(sourceRow),
      status: sourceRow?.status ?? "idle",
      cachedBuildings: sourceRow?.building_count ?? 0,
      pendingImport: n(pending as D1Result<{ n: number }>),
    },
  };
  return c.json(result);
});

orgs.get("/overview", async (c) => {
  const orgId = c.get("orgId");
  const db = c.env.DB;
  const count = (sql: string, scope: { sql: string; params: string[] } = { sql: "1 = 1", params: [] }) =>
    db.prepare(sql.replace("{scope}", scope.sql)).bind(orgId, ...scope.params);
  const placed = scopeSql({ building: "building_id", property: "property_id" });
  const [p, b, d, comp, t, a, art] = await db.batch<{ n: number }>([
    count(`SELECT COUNT(*) AS n FROM properties WHERE org_id = ? AND {scope}`, scopeSql({ property: "id" })),
    count(`SELECT COUNT(*) AS n FROM buildings WHERE org_id = ? AND {scope}`, scopeSql({ building: "id" })),
    count(`SELECT COUNT(*) AS n FROM documents WHERE org_id = ? AND {scope}`, placed),
    count(`SELECT COUNT(*) AS n FROM components WHERE org_id = ? AND {scope}`, scopeSql({ building: "building_id" })),
    count(`SELECT COUNT(*) AS n FROM tasks WHERE org_id = ? AND status IN ('open','in_progress') AND {scope}`, placed),
    count(`SELECT COUNT(*) AS n FROM agents WHERE org_id = ? AND archived = 0`),
    count(`SELECT COUNT(*) AS n FROM artifacts WHERE org_id = ? AND {scope}`, placed),
  ]);
  const n = (r: D1Result<{ n: number }> | undefined) => r?.results?.[0]?.n ?? 0;

  const taskScope = scopeSql({ building: "t.building_id", property: "t.property_id" });
  const upcoming = await all<Task>(
    db,
    `SELECT t.*, b.name AS building_name, c.name AS component_name, a.name AS agent_name
     FROM tasks t LEFT JOIN buildings b ON b.id = t.building_id LEFT JOIN components c ON c.id = t.component_id LEFT JOIN agents a ON a.id = t.created_by_agent
     WHERE t.org_id = ? AND t.status IN ('open','in_progress') AND ${taskScope.sql}
     ORDER BY CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date,
       CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END
     LIMIT 8`,
    orgId,
    ...taskScope.params,
  );
  const horizon = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
  const compScope = scopeSql({ building: "c.building_id" });
  const serviceDue = await all<Component>(
    db,
    `SELECT c.*, b.name AS building_name FROM components c LEFT JOIN buildings b ON b.id = c.building_id
     WHERE c.org_id = ? AND c.next_service_at IS NOT NULL AND c.next_service_at <= ? AND ${compScope.sql} ORDER BY c.next_service_at LIMIT 8`,
    orgId,
    horizon,
    ...compScope.params,
  );
  const docScope = scopeSql({ building: "d.building_id", property: "d.property_id" });
  const recentDocs = await all<Document>(
    db,
    `SELECT d.id, d.title, d.filename, d.kind, d.status, d.mime, d.size, d.created_at, d.updated_at, d.building_id, b.name AS building_name
     FROM documents d LEFT JOIN buildings b ON b.id = d.building_id WHERE d.org_id = ? AND ${docScope.sql} ORDER BY d.created_at DESC LIMIT 6`,
    orgId,
    ...docScope.params,
  );
  const act = activityScopeSql();
  const activity = await all<ActivityItem>(db, `SELECT * FROM activity a WHERE a.org_id = ? AND ${act.sql} ORDER BY a.created_at DESC LIMIT 12`, orgId, ...act.params);

  const result: OrgOverview = {
    counts: { properties: n(p), buildings: n(b), documents: n(d), components: n(comp), open_tasks: n(t), agents: n(a), artifacts: n(art) },
    upcoming_tasks: upcoming,
    service_due: serviceDue,
    recent_documents: recentDocs,
    activity,
  };
  return c.json({ ...result, today: todayIso() });
});

orgs.get("/activity", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const act = activityScopeSql();
  const rows = await all<ActivityItem>(c.env.DB, `SELECT * FROM activity a WHERE a.org_id = ? AND ${act.sql} ORDER BY a.created_at DESC LIMIT ?`, c.get("orgId"), ...act.params, limit);
  return c.json(rows);
});

orgs.post("/demo", async (c) => {
  requireAdmin(c);
  const result = await seedDemo(c.env, c.get("orgId"), c.get("user").id);
  await logActivity(c.env, {
    orgId: c.get("orgId"),
    actor: { type: "user", id: c.get("user").id, name: c.get("user").name ?? c.get("user").email },
    action: "demo.seeded",
    summary: "Lastet inn demodata",
  });
  return c.json(result, 201);
});

// ─── Medlemmer ──────────────────────────────────────────────────────────────

orgs.get("/members", async (c) => {
  const admin = c.get("role") === "owner" || c.get("role") === "admin";
  return c.json(await listMembers(c.env, c.get("orgId"), { userId: c.get("user").id, admin }));
});

const userActor = (c: { get: (k: "user") => { id: string; name: string | null; email: string } }) => {
  const u = c.get("user");
  return { type: "user" as const, id: u.id, name: u.name ?? u.email };
};

orgs.post("/members", async (c) => {
  requireAdmin(c);
  const input = await body(c, inviteSchema);
  const email = normalizeEmail(input.email);
  const orgId = c.get("orgId");
  const access = await resolveMemberAccess(c.env, orgId, input);
  let user = await first<{ id: string }>(c.env.DB, `SELECT id FROM users WHERE email = ?`, email);
  if (!user) {
    user = { id: newId("usr") };
    await c.env.DB.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`).bind(user.id, email, now()).run();
  }
  const exists = await first(c.env.DB, `SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, user.id);
  if (exists) throw badRequest("Personen har allerede tilgang. Endre tilgangen i listen i stedet.");
  const t = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO memberships (org_id, user_id, role, can_edit, scope, expires_at, invited_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(orgId, user.id, access.role, access.canEdit ? 1 : 0, access.scope, access.expiresAt, c.get("user").id, t, t),
    ...scopeStatements(c.env, orgId, user.id, access),
  ]);

  const org = await first<{ name: string }>(c.env.DB, `SELECT name FROM orgs WHERE id = ?`, orgId);
  const brand = brandOf(c);
  const link = await createLoginLink(c.env, email, `/o/${orgId}`, INVITE_TTL_MS, "login", null, publicOrigin(c));
  const inviter = c.get("user").name ?? c.get("user").email;
  const described = describeAccess(access);
  let devLink: string | undefined;
  if (emailConfigured(c.env)) {
    const mail = memberInviteEmail({
      inviter,
      orgName: org?.name ?? brand.name,
      brand: brand.name,
      level: described.level,
      places: described.places,
      expires: described.expires,
      message: input.message,
      url: link,
    });
    await sendEmail(c.env, { to: email, from: emailFrom(c.env, brand), replyTo: c.get("user").email, ...mail });
  } else if (c.env.DEV_MODE === "true") {
    devLink = link;
  }
  await logActivity(c.env, { orgId, actor: userActor(c), action: "member.invited", summary: `Inviterte ${email} (${described.short})` });
  return c.json({ ok: true, user_id: user.id, devLink }, 201);
});

orgs.patch("/members/:userId", async (c) => {
  requireAdmin(c);
  const input = await body(c, memberPatchSchema);
  const orgId = c.get("orgId");
  const userId = c.req.param("userId");
  const target = await first<{ role: Role; can_edit: number; scope: "all" | "limited"; expires_at: number | null; email: string }>(
    c.env.DB,
    `SELECT m.role, m.can_edit, m.scope, m.expires_at, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.user_id = ?`,
    orgId,
    userId,
  );
  if (!target) throw notFound("Medlemmet");
  const role = input.role ?? target.role;
  if ((role === "owner" || target.role === "owner") && role !== target.role && c.get("role") !== "owner") throw forbidden("Bare eiere kan endre eierskap");
  if (target.role === "owner" && role !== "owner") {
    const owners = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner'`, orgId);
    if ((owners?.n ?? 0) <= 1) throw badRequest("Organisasjonen må ha minst én eier");
  }
  if (userId === c.get("user").id && role === "member") throw badRequest("Du kan ikke ta fra deg selv administratortilgangen. Be en annen administrator om å gjøre det.");

  const current = await all<{ entity_type: "property" | "building"; entity_id: string }>(
    c.env.DB,
    `SELECT entity_type, entity_id FROM membership_scope WHERE org_id = ? AND user_id = ?`,
    orgId,
    userId,
  );
  const access = await resolveMemberAccess(c.env, orgId, {
    role,
    can_edit: input.can_edit ?? target.can_edit === 1,
    scope: input.scope ?? target.scope,
    property_ids: input.property_ids ?? current.filter((r) => r.entity_type === "property").map((r) => r.entity_id),
    building_ids: input.building_ids ?? current.filter((r) => r.entity_type === "building").map((r) => r.entity_id),
    expires_on: input.expires_on !== undefined ? input.expires_on : target.expires_at && target.expires_at > now() ? osloDay(target.expires_at - 1) : null,
  });
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE memberships SET role = ?, can_edit = ?, scope = ?, expires_at = ?, updated_at = ? WHERE org_id = ? AND user_id = ?`).bind(
      access.role,
      access.canEdit ? 1 : 0,
      access.scope,
      access.expiresAt,
      now(),
      orgId,
      userId,
    ),
    ...scopeStatements(c.env, orgId, userId, access),
  ]);
  await logActivity(c.env, { orgId, actor: userActor(c), action: "member.updated", summary: `Endret tilgangen til ${target.email} (${describeAccess(access).short})` });
  return c.json({ ok: true });
});

orgs.delete("/members/:userId", async (c) => {
  requireAdmin(c);
  const orgId = c.get("orgId");
  const userId = c.req.param("userId");
  const target = await first<{ role: string; email: string }>(
    c.env.DB,
    `SELECT m.role, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.user_id = ?`,
    orgId,
    userId,
  );
  if (!target) throw notFound("Medlemmet");
  if (target.role === "owner" && c.get("role") !== "owner") throw forbidden("Bare eiere kan fjerne eiere");
  if (target.role === "owner") {
    const owners = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner'`, orgId);
    if ((owners?.n ?? 0) <= 1) throw badRequest("Organisasjonen må ha minst én eier");
  }
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM membership_scope WHERE org_id = ? AND user_id = ?`).bind(orgId, userId),
    c.env.DB.prepare(`DELETE FROM memberships WHERE org_id = ? AND user_id = ?`).bind(orgId, userId),
  ]);
  await logActivity(c.env, { orgId, actor: userActor(c), action: "member.removed", summary: `Fjernet tilgangen til ${target.email}` });
  return c.json({ ok: true });
});
