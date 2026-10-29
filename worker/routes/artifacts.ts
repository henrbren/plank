import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { assertCanEdit, assertCanEditEntity } from "../lib/access";
import { logActivity } from "../lib/activity";
import { first } from "../lib/db";
import { body, notFound } from "../lib/http";
import { optId, optStr } from "../lib/schemas";
import { now } from "../lib/util";
import { createArtifact, getArtifact, getArtifactHtml, listArtifacts, listVersions, moveSidebar, saveArtifactVersion, setSidebar, sidebarPages } from "../services/artifacts";
import { SIDEBAR_ICONS } from "../../shared/types";

export const artifacts = new Hono<AppEnv>();

const STARTER = `<!doctype html>
<html lang="no"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  main { max-width: 720px; margin: 0 auto; padding: 40px 24px; }
  h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; letter-spacing: -0.015em; }
  .hint { margin: 0; color: var(--muted); font-size: 13.5px; }
</style></head>
<body><main>
  <h1>Ny side</h1>
  <p class="hint">Beskriv i chatten hva siden skal vise, så bygger agenten den for deg – med levende data fra Plank.</p>
</main></body></html>`;

artifacts.get("/", async (c) => c.json(await listArtifacts(c.env, c.get("orgId"), { building_id: c.req.query("building_id"), property_id: c.req.query("property_id") })));

artifacts.post("/", async (c) => {
  const input = await body(
    c,
    z.object({ title: z.string().trim().min(1).max(200), description: optStr(1000), html: z.string().max(600_000).optional(), building_id: optId(), property_id: optId() }),
  );
  const u = c.get("user");
  const a = await createArtifact(c.env, c.get("orgId"), { ...input, html: input.html || STARTER }, { userId: u.id });
  await logActivity(c.env, { orgId: c.get("orgId"), actor: { type: "user", id: u.id, name: u.name ?? u.email }, action: "artifact.created", entityType: "artifact", entityId: a.id, summary: a.title });
  return c.json(a, 201);
});

artifacts.get("/sidebar", async (c) => c.json(await sidebarPages(c.env, c.get("orgId"))));

artifacts.post("/:id/sidebar", async (c) => {
  const input = await body(c, z.object({ show: z.boolean().optional(), icon: z.enum(SIDEBAR_ICONS).optional(), move: z.union([z.literal(-1), z.literal(1)]).optional() }));
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  if (input.move) await moveSidebar(c.env, orgId, id, input.move);
  else {
    const a = await setSidebar(c.env, orgId, id, { show: input.show ?? true, icon: input.icon });
    const u = c.get("user");
    await logActivity(c.env, {
      orgId,
      actor: { type: "user", id: u.id, name: u.name ?? u.email },
      action: a.sidebar_order == null ? "artifact.sidebar_removed" : "artifact.sidebar_added",
      entityType: "artifact",
      entityId: a.id,
      summary: a.title,
    });
  }
  return c.json(await sidebarPages(c.env, orgId));
});

artifacts.get("/:id", async (c) => {
  const a = await getArtifact(c.env, c.get("orgId"), c.req.param("id"));
  const versions = await listVersions(c.env, c.get("orgId"), a.id);
  return c.json({ ...a, versions });
});

artifacts.get("/:id/html", async (c) => {
  const v = c.req.query("version");
  return c.json(await getArtifactHtml(c.env, c.get("orgId"), c.req.param("id"), v ? Number(v) : undefined));
});

artifacts.post("/:id/versions", async (c) => {
  const input = await body(c, z.object({ html: z.string().min(1).max(600_000), note: optStr(500) }));
  return c.json(await saveArtifactVersion(c.env, c.get("orgId"), c.req.param("id"), input, { userId: c.get("user").id }));
});

artifacts.post("/:id/restore", async (c) => {
  const { version } = await body(c, z.object({ version: z.number().int().min(1) }));
  const { html } = await getArtifactHtml(c.env, c.get("orgId"), c.req.param("id"), version);
  return c.json(await saveArtifactVersion(c.env, c.get("orgId"), c.req.param("id"), { html, note: `Gjenopprettet versjon ${version}` }, { userId: c.get("user").id }));
});

artifacts.patch("/:id", async (c) => {
  const input = await body(
    c,
    z.object({ title: z.string().trim().min(1).max(200).optional(), description: optStr(1000).optional(), pinned: z.boolean().optional(), building_id: optId().optional() }),
  );
  const orgId = c.get("orgId");
  const a = await getArtifact(c.env, orgId, c.req.param("id"));
  assertCanEdit(a);
  if (input.building_id) {
    const b = await first(c.env.DB, `SELECT id FROM buildings WHERE id = ? AND org_id = ?`, input.building_id, orgId);
    if (!b) throw notFound("Bygget");
    assertCanEdit({ building_id: input.building_id });
  } else if (input.building_id === null) {
    assertCanEdit({ property_id: a.property_id });
  }
  await c.env.DB.prepare(
    `UPDATE artifacts SET title = ?, description = ?, pinned = ?, building_id = ?, property_id = COALESCE((SELECT property_id FROM buildings WHERE id = ? AND org_id = ?), property_id), updated_at = ? WHERE id = ?`,
  )
    .bind(
      input.title ?? a.title,
      input.description !== undefined ? input.description : a.description,
      input.pinned !== undefined ? (input.pinned ? 1 : 0) : a.pinned,
      input.building_id !== undefined ? input.building_id : a.building_id,
      input.building_id ?? a.building_id,
      orgId,
      now(),
      a.id,
    )
    .run();
  return c.json(await getArtifact(c.env, orgId, a.id));
});

artifacts.delete("/:id", async (c) => {
  await assertCanEditEntity(c.env, c.get("orgId"), "artifact", c.req.param("id"), "Siden");
  const res = await c.env.DB.prepare(`DELETE FROM artifacts WHERE id = ? AND org_id = ?`).bind(c.req.param("id"), c.get("orgId")).run();
  if (!res.meta.changes) throw notFound("Siden");
  return c.json({ ok: true });
});
