import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireAdmin } from "../lib/auth";
import { autoImportStep, boligmappaTree, connectBoligmappa, disconnectBoligmappa, importSelection, listBmDocuments, normalizeOrgNr, syncChunk } from "../lib/boligmappa";
import { grantAgents } from "../services/laft";
import { body } from "../lib/http";

export const boligmappa = new Hono<AppEnv>();

boligmappa.get("/", async (c) => c.json(await boligmappaTree(c.env, c.get("orgId"))));

boligmappa.get("/documents", async (c) => {
  const owner = c.req.query("building")?.trim() || undefined;
  return c.json(await listBmDocuments(c.env, c.get("orgId"), owner));
});

boligmappa.put("/", async (c) => {
  requireAdmin(c);
  const input = await body(c, z.object({ orgNr: z.string().trim().min(9).max(20) }));
  await connectBoligmappa(c.env, c.get("orgId"), normalizeOrgNr(input.orgNr));
  const agentsGranted = await grantAgents(c.env, c.get("orgId"), ["boligmappa"]);
  return c.json({ ok: true, agentsGranted });
});

boligmappa.post("/grant", async (c) => {
  requireAdmin(c);
  const changed = await grantAgents(c.env, c.get("orgId"), ["boligmappa"]);
  return c.json({ changed });
});

boligmappa.delete("/", async (c) => {
  requireAdmin(c);
  const u = c.get("user");
  await disconnectBoligmappa(c.env, c.get("orgId"), { type: "user", id: u.id, name: u.name ?? u.email });
  return c.json({ ok: true });
});

boligmappa.post("/sync", async (c) => {
  requireAdmin(c);
  const input = await body(c, z.object({ restart: z.boolean().optional() }));
  const source = await syncChunk(c.env, c.get("orgId"), Boolean(input.restart), { force: true });
  return c.json({
    status: source.status,
    phase: source.phase,
    page: source.page,
    buildingCount: source.building_count,
    unitCount: source.unit_count,
    documentCount: source.document_count,
    error: source.error,
    waited: source.waited,
    retryInMs: source.retryInMs,
  });
});

boligmappa.post("/auto", async (c) => {
  requireAdmin(c);
  const u = c.get("user");
  const force = c.req.query("force") === "1";
  return c.json(await autoImportStep(c.env, c.get("orgId"), { type: "user", id: u.id, name: u.name ?? u.email }, c.executionCtx, { force }));
});

boligmappa.post("/import", async (c) => {
  requireAdmin(c);
  const input = await body(c, z.object({ bmns: z.array(z.string().min(1).max(80)).min(1).max(200) }));
  const u = c.get("user");
  return c.json(await importSelection(c.env, c.get("orgId"), { type: "user", id: u.id, name: u.name ?? u.email }, input.bmns, c.executionCtx));
});
