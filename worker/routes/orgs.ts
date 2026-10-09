import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { DEFAULT_TEMPLATE_KEYS, AGENT_TEMPLATES } from "../agent/templates";
import { requireAdmin } from "../lib/auth";
import { all, first, insert } from "../lib/db";
import { emailConfigured, emailLayout, sendEmail } from "../lib/email";
import { badRequest, body, forbidden, notFound } from "../lib/http";
import { escapeHtml, newId, normalizeEmail, now, todayIso } from "../lib/util";
import { seedDemo } from "../lib/demo";
import { logActivity } from "../lib/activity";
import type { ActivityItem, Component, Document, Member, OrgOverview, Task } from "../../shared/types";
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
        schedule: null,
        schedule_prompt: tpl.schedule_prompt ?? null,
        notify_emails: [],
        template: tpl.key,
        created_by: ownerId,
        created_at: t,
        updated_at: t,
      }),
    );
  }
  await env.DB.batch(stmts);
  return { id, name, role: "owner" as const };
}

export const orgs = new Hono<AppEnv>();

orgs.patch("/", async (c) => {
  requireAdmin(c);
  const input = await body(c, z.object({ name: z.string().trim().min(2).max(100) }));
  await c.env.DB.prepare(`UPDATE orgs SET name = ? WHERE id = ?`).bind(input.name, c.get("orgId")).run();
  return c.json({ ok: true });
});

orgs.get("/overview", async (c) => {
  const orgId = c.get("orgId");
  const db = c.env.DB;
  const count = (sql: string) => db.prepare(sql).bind(orgId);
  const [p, b, d, comp, t, a, art] = await db.batch<{ n: number }>([
    count(`SELECT COUNT(*) AS n FROM properties WHERE org_id = ?`),
    count(`SELECT COUNT(*) AS n FROM buildings WHERE org_id = ?`),
    count(`SELECT COUNT(*) AS n FROM documents WHERE org_id = ?`),
    count(`SELECT COUNT(*) AS n FROM components WHERE org_id = ?`),
    count(`SELECT COUNT(*) AS n FROM tasks WHERE org_id = ? AND status IN ('open','in_progress')`),
    count(`SELECT COUNT(*) AS n FROM agents WHERE org_id = ? AND archived = 0`),
    count(`SELECT COUNT(*) AS n FROM artifacts WHERE org_id = ?`),
  ]);
  const n = (r: D1Result<{ n: number }> | undefined) => r?.results?.[0]?.n ?? 0;

  const upcoming = await all<Task>(
    db,
    `SELECT t.*, b.name AS building_name, c.name AS component_name, a.name AS agent_name
     FROM tasks t LEFT JOIN buildings b ON b.id = t.building_id LEFT JOIN components c ON c.id = t.component_id LEFT JOIN agents a ON a.id = t.created_by_agent
     WHERE t.org_id = ? AND t.status IN ('open','in_progress')
     ORDER BY CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date,
       CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END
     LIMIT 8`,
    orgId,
  );
  const horizon = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
  const serviceDue = await all<Component>(
    db,
    `SELECT c.*, b.name AS building_name FROM components c LEFT JOIN buildings b ON b.id = c.building_id
     WHERE c.org_id = ? AND c.next_service_at IS NOT NULL AND c.next_service_at <= ? ORDER BY c.next_service_at LIMIT 8`,
    orgId,
    horizon,
  );
  const recentDocs = await all<Document>(
    db,
    `SELECT d.id, d.title, d.filename, d.kind, d.status, d.mime, d.size, d.created_at, d.updated_at, d.building_id, b.name AS building_name
     FROM documents d LEFT JOIN buildings b ON b.id = d.building_id WHERE d.org_id = ? ORDER BY d.created_at DESC LIMIT 6`,
    orgId,
  );
  const activity = await all<ActivityItem>(db, `SELECT * FROM activity WHERE org_id = ? ORDER BY created_at DESC LIMIT 12`, orgId);

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
  const rows = await all<ActivityItem>(c.env.DB, `SELECT * FROM activity WHERE org_id = ? ORDER BY created_at DESC LIMIT ?`, c.get("orgId"), limit);
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
  const rows = await all<Member>(
    c.env.DB,
    `SELECT m.user_id, u.email, u.name, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.email`,
    c.get("orgId"),
  );
  return c.json(rows);
});

orgs.post("/members", async (c) => {
  requireAdmin(c);
  const input = await body(c, z.object({ email: z.string().trim().email("Ugyldig e-post"), role: z.enum(["admin", "member"]).default("member") }));
  const email = normalizeEmail(input.email);
  const orgId = c.get("orgId");
  let user = await first<{ id: string }>(c.env.DB, `SELECT id FROM users WHERE email = ?`, email);
  if (!user) {
    user = { id: newId("usr") };
    await c.env.DB.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`).bind(user.id, email, now()).run();
  }
  const exists = await first(c.env.DB, `SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, user.id);
  if (exists) throw badRequest("Personen er allerede medlem");
  await c.env.DB.prepare(`INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`).bind(orgId, user.id, input.role, now()).run();

  const org = await first<{ name: string }>(c.env.DB, `SELECT name FROM orgs WHERE id = ?`, orgId);
  const link = await createLoginLink(c.env, email, "/", INVITE_TTL_MS);
  const inviter = c.get("user").name ?? c.get("user").email;
  let devLink: string | undefined;
  if (emailConfigured(c.env)) {
    await sendEmail(c.env, {
      to: email,
      subject: `${inviter} har invitert deg til ${org?.name ?? "Plank"}`,
      html: emailLayout({
        title: `Bli med i ${org?.name ?? "Plank"}`,
        bodyHtml: `<p>${escapeHtml(inviter)} har invitert deg til organisasjonen <b>${escapeHtml(org?.name ?? "")}</b> i Plank – arbeidsflaten for FDV med AI-agenter.</p>`,
        cta: { label: "Godta invitasjonen", url: link },
        footer: "Lenken er gyldig i 7 dager.",
      }),
    });
  } else if (c.env.DEV_MODE === "true") {
    devLink = link;
  }
  await logActivity(c.env, { orgId, actor: { type: "user", id: c.get("user").id, name: inviter }, action: "member.invited", summary: `Inviterte ${email}` });
  return c.json({ ok: true, user_id: user.id, devLink }, 201);
});

orgs.patch("/members/:userId", async (c) => {
  requireAdmin(c);
  const input = await body(c, z.object({ role: z.enum(["owner", "admin", "member"]) }));
  const orgId = c.get("orgId");
  const userId = c.req.param("userId");
  const target = await first<{ role: string }>(c.env.DB, `SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, userId);
  if (!target) throw notFound("Medlemmet");
  if ((input.role === "owner" || target.role === "owner") && c.get("role") !== "owner") throw forbidden("Bare eiere kan endre eierskap");
  if (target.role === "owner" && input.role !== "owner") {
    const owners = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner'`, orgId);
    if ((owners?.n ?? 0) <= 1) throw badRequest("Organisasjonen må ha minst én eier");
  }
  await c.env.DB.prepare(`UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?`).bind(input.role, orgId, userId).run();
  return c.json({ ok: true });
});

orgs.delete("/members/:userId", async (c) => {
  requireAdmin(c);
  const orgId = c.get("orgId");
  const userId = c.req.param("userId");
  const target = await first<{ role: string }>(c.env.DB, `SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, userId);
  if (!target) throw notFound("Medlemmet");
  if (target.role === "owner" && c.get("role") !== "owner") throw forbidden("Bare eiere kan fjerne eiere");
  if (target.role === "owner") {
    const owners = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner'`, orgId);
    if ((owners?.n ?? 0) <= 1) throw badRequest("Organisasjonen må ha minst én eier");
  }
  await c.env.DB.prepare(`DELETE FROM memberships WHERE org_id = ? AND user_id = ?`).bind(orgId, userId).run();
  return c.json({ ok: true });
});
