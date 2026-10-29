import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireAdmin } from "../lib/auth";
import { first } from "../lib/db";
import { ApiError, badRequest, body } from "../lib/http";
import { laftIdLogin, laftServer, laftWhoAmI, upsertAccount, type LaftAccountRow } from "../lib/laft";
import {
  commentWorkOrder,
  connectOrg,
  createWorkOrder,
  disconnectOrg,
  getBuildingStructure,
  getWorkOrder,
  grantAgents,
  importBuildings,
  importDocuments,
  laftStatus,
  listBuildings,
  listDocuments,
  listWorkOrders,
  rawQuery,
  resolveLaftBuildingId,
  searchLaft,
  updateWorkOrder,
  workOrderCalendar,
  workOrderDashboard,
  type Actor,
} from "../services/laft";
import { instanceName, laftLoginSchema, throttle } from "./auth";

export const laft = new Hono<AppEnv>();

function actorOf(c: { get(key: "user"): { id: string; name: string | null; email: string } }): Actor {
  const u = c.get("user");
  return { type: "user", id: u.id, name: u.name ?? u.email };
}

laft.get("/", async (c) => c.json(await laftStatus(c.env, c.get("orgId"), c.get("user").id)));

/** Kobler organisasjonen til LAFT med brukerens egen LAFT-innlogging. */
laft.post("/connect", async (c) => {
  requireAdmin(c);
  const input = await body(c, laftLoginSchema);
  const server = laftServer(input.url);
  if (!server) throw badRequest("Ukjent LAFT-instans");
  const user = c.get("user");
  await throttle(c.env, `laft-connect:${user.id}`, 10, 15 * 60 * 1000, "For mange forsøk. Vent et kvarter og prøv igjen.");
  const tokens = await laftIdLogin(c.env, { email: input.email, password: input.password, otp: input.otp, url: server.url });
  const who = await laftWhoAmI(server.url, tokens.jwt);
  let account = await upsertAccount(c.env, { url: server.url, name: instanceName(server.host, input.name) }, who, tokens);
  if (account.user_id && account.user_id !== user.id) {
    throw new ApiError(409, "Denne LAFT-brukeren er allerede koblet til en annen Plank-bruker. Logg inn med din egen LAFT-bruker, eller be den andre brukeren koble til.");
  }
  if (!account.user_id) {
    await c.env.DB.prepare(`UPDATE laft_accounts SET user_id = ? WHERE id = ? AND user_id IS NULL`).bind(user.id, account.id).run();
    account = { ...account, user_id: user.id };
  }
  const { agentsGranted } = await connectOrg(c.env, c.get("orgId"), account, actorOf(c));
  return c.json({ ...(await laftStatus(c.env, c.get("orgId"), user.id)), agentsGranted });
});

/** Bruker en LAFT-innlogging brukeren allerede har (f.eks. fra «Logg inn med LAFT»). */
laft.post("/adopt", async (c) => {
  requireAdmin(c);
  const { accountId } = await body(c, z.object({ accountId: z.string().min(1).max(60) }));
  const account = await first<LaftAccountRow>(
    c.env.DB,
    `SELECT * FROM laft_accounts WHERE id = ? AND user_id = ? AND refresh_enc IS NOT NULL AND status = 'ok'`,
    accountId,
    c.get("user").id,
  );
  if (!account) throw new ApiError(404, "Fant ikke LAFT-innloggingen din. Logg inn med LAFT på nytt.");
  const { agentsGranted } = await connectOrg(c.env, c.get("orgId"), account, actorOf(c));
  return c.json({ ...(await laftStatus(c.env, c.get("orgId"), c.get("user").id)), agentsGranted });
});

laft.delete("/", async (c) => {
  requireAdmin(c);
  await disconnectOrg(c.env, c.get("orgId"), actorOf(c));
  return c.json(await laftStatus(c.env, c.get("orgId"), c.get("user").id));
});

/** Gir alle agentene tilgang til LAFT-verktøyene (skriving er et eget valg). */
laft.post("/grant", async (c) => {
  requireAdmin(c);
  const { write } = await body(c, z.object({ write: z.boolean().optional() }));
  const changed = await grantAgents(c.env, c.get("orgId"), write ? ["laft", "laft_import", "laft_write"] : ["laft", "laft_import"]);
  return c.json({ changed });
});

laft.get("/buildings", async (c) => c.json(await listBuildings(c.env, c.get("orgId"))));

laft.get("/buildings/:id", async (c) => {
  const id = await resolveLaftBuildingId(c.env, c.get("orgId"), c.req.param("id"));
  if (!id) throw new ApiError(404, "Bygget er ikke koblet til LAFT");
  return c.json(await getBuildingStructure(c.env, c.get("orgId"), id));
});

laft.post("/import", async (c) => {
  requireAdmin(c);
  const { ids } = await body(c, z.object({ ids: z.array(z.union([z.string(), z.number()])).min(1).max(2000) }));
  return c.json(await importBuildings(c.env, c.get("orgId"), actorOf(c), ids.map(String)));
});

laft.get("/dashboard", async (c) => c.json(await workOrderDashboard(c.env, c.get("orgId"))));

const listQuery = z.object({
  building: z.string().max(60).optional(),
  status: z.enum(["open", "closed", "all"]).optional(),
  type: z.enum(["work_orders", "routines", "fire_safety_routines"]).optional(),
  past_due: z.enum(["1", "true"]).optional(),
  deviations: z.enum(["1", "true"]).optional(),
  q: z.string().max(200).optional(),
  order: z.enum(["deadline", "created", "changed", "priority"]).optional(),
  first: z.coerce.number().int().min(1).max(200).optional(),
  after: z.string().max(200).optional(),
});

laft.get("/work-orders", async (c) => {
  const parsed = listQuery.safeParse(c.req.query());
  if (!parsed.success) throw badRequest("Ugyldig filter");
  const q = parsed.data;
  const buildingId = q.building ? await resolveLaftBuildingId(c.env, c.get("orgId"), q.building) : null;
  if (q.building && !buildingId) return c.json({ total: 0, hasMore: false, cursor: null, items: [], states: [] });
  return c.json(
    await listWorkOrders(c.env, c.get("orgId"), {
      buildingId,
      status: q.status,
      type: q.type ?? null,
      pastDue: Boolean(q.past_due),
      deviationsOnly: Boolean(q.deviations),
      query: q.q ?? null,
      order: q.order,
      first: q.first,
      after: q.after ?? null,
    }),
  );
});

laft.get("/work-orders/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) throw badRequest("Ugyldig arbeidsordre");
  return c.json(await getWorkOrder(c.env, c.get("orgId"), id));
});

laft.post("/work-orders", async (c) => {
  const input = await body(
    c,
    z.object({
      building: z.union([z.string(), z.number()]),
      floor: z.union([z.string(), z.number()]).optional(),
      room: z.union([z.string(), z.number()]).optional(),
      description: z.string().min(3).max(4000),
      deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      priority: z.enum(["high", "medium", "low"]).optional(),
    }),
  );
  const buildingId = await resolveLaftBuildingId(c.env, c.get("orgId"), String(input.building));
  if (!buildingId) throw badRequest("Bygget er ikke koblet til LAFT");
  return c.json(
    await createWorkOrder(c.env, c.get("orgId"), actorOf(c), {
      buildingId,
      floorId: input.floor != null ? String(input.floor) : null,
      roomId: input.room != null ? String(input.room) : null,
      description: input.description,
      deadline: input.deadline ?? null,
      priority: input.priority ?? null,
    }),
    201,
  );
});

laft.post("/work-orders/:id/comment", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) throw badRequest("Ugyldig arbeidsordre");
  const { comment } = await body(c, z.object({ comment: z.string().min(1).max(4000) }));
  return c.json(await commentWorkOrder(c.env, c.get("orgId"), actorOf(c), id, comment), 201);
});

laft.patch("/work-orders/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) throw badRequest("Ugyldig arbeidsordre");
  const patch = await body(c, z.object({ stateId: z.number().int().positive().optional(), deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), priority: z.enum(["high", "medium", "low"]).optional() }));
  return c.json(await updateWorkOrder(c.env, c.get("orgId"), actorOf(c), id, patch));
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Bruk ÅÅÅÅ-MM-DD");

laft.get("/calendar", async (c) => {
  const parsed = z
    .object({ from: isoDate, to: isoDate, building: z.string().max(60).optional(), scope: z.enum(["ALL", "ASSIGNED_TO_ME", "MY_TEAMS", "OTHER_TEAMS"]).optional() })
    .safeParse(c.req.query());
  if (!parsed.success) throw badRequest("Oppgi from og to som ÅÅÅÅ-MM-DD");
  const buildingId = parsed.data.building ? await resolveLaftBuildingId(c.env, c.get("orgId"), parsed.data.building) : null;
  return c.json(await workOrderCalendar(c.env, c.get("orgId"), { from: parsed.data.from, to: parsed.data.to, scope: parsed.data.scope, buildingId }));
});

laft.get("/documents", async (c) => {
  const building = c.req.query("building");
  const parent = c.req.query("parent");
  const id = await resolveLaftBuildingId(c.env, c.get("orgId"), building);
  if (!id) throw new ApiError(404, "Bygget er ikke koblet til LAFT");
  const parentId = parent ? Number(parent) : null;
  if (parentId !== null && (!Number.isInteger(parentId) || parentId <= 0)) throw badRequest("Ugyldig mappe");
  return c.json(await listDocuments(c.env, c.get("orgId"), id, parentId));
});

laft.post("/documents/import", async (c) => {
  const input = await body(c, z.object({ ids: z.array(z.number().int().positive()).min(1).max(200), building_id: z.string().max(60).optional() }));
  return c.json(
    await importDocuments(c.env, c.get("orgId"), actorOf(c), input.ids, {
      buildingId: input.building_id ?? null,
      waitUntil: (p) => c.executionCtx.waitUntil(p),
    }),
  );
});

laft.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) throw badRequest("Skriv minst to tegn");
  const building = c.req.query("building");
  const buildingId = building ? await resolveLaftBuildingId(c.env, c.get("orgId"), building) : null;
  return c.json(await searchLaft(c.env, c.get("orgId"), q.slice(0, 200), { buildingId }));
});

/** Skrivebeskyttet GraphQL – brukes av agent-sider via window.plank */
laft.post("/graphql", async (c) => {
  const input = await body(c, z.object({ query: z.string().min(1).max(20_000), variables: z.record(z.string(), z.unknown()).optional() }));
  await throttle(c.env, `laft-gql:${c.get("orgId")}`, 600, 5 * 60 * 1000, "For mange LAFT-spørringer. Vent litt.");
  return c.json(await rawQuery(c.env, c.get("orgId"), input.query, input.variables));
});
