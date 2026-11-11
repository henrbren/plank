import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Env } from "./env";
import { assertFullScope, readOnlyGuard } from "./lib/access";
import { csrfGuard, requireOrg, requireUser } from "./lib/auth";
import { stripeReady } from "./lib/billing";
import { auth, me } from "./routes/auth";
import { orgs } from "./routes/orgs";
import { portfolio } from "./routes/portfolio";
import { components } from "./routes/components";
import { tasks } from "./routes/tasks";
import { documents, search } from "./routes/documents";
import { artifacts } from "./routes/artifacts";
import { ifc } from "./routes/ifc";
import { agents } from "./routes/agents";
import { conversations } from "./routes/conversations";
import { runDueAgents } from "./agent/scheduler";
import { flushUsageInvoices, notifySpendLimits } from "./lib/usage";
import { admin } from "./routes/admin";
import { stripeWebhook } from "./routes/stripe";
import { boligmappa } from "./routes/boligmappa";
import { laft } from "./routes/laft";
import { keepLaftAlive } from "./lib/laft";
import { handleBoligmappaQueue, runAutoImports, runBoligmappaWatches } from "./lib/boligmappa";
import { claudeConfigured } from "./lib/anthropic";
import { emailConfigured } from "./lib/email";
import { brandOf } from "./lib/brand";
import { hooks } from "./routes/hooks";
import { syncAccessRequests } from "./services/accessRequests";
import { help } from "./routes/help";
import { share } from "./routes/share";
import { fillStreetNumbers } from "./lib/resolvar";
import { maintainHelp } from "./services/help";
import { publishSupplierPages } from "./services/suppliers";
import { desk } from "./routes/desk";

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error(err);
  return c.json({ error: "Noe gikk galt på serveren" }, 500);
});

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/stripe/webhook" || c.req.path.startsWith("/api/hooks/")) return next();
  return csrfGuard(c, next);
});

app.post("/api/stripe/webhook", stripeWebhook);
app.route("/api/hooks", hooks);

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    claude: claudeConfigured(c.env),
    email: emailConfigured(c.env),
    ai: Boolean(c.env.AI),
    billing: stripeReady(c.env),
    dev: c.env.DEV_MODE === "true",
  }),
);

app.get("/api/brand", (c) => c.json(brandOf(c)));

app.route("/api/auth", auth);
app.route("/api/share", share);
app.route("/api/me", me);

const platform = new Hono<AppEnv>();
platform.use("*", requireUser);
platform.route("/", admin);
app.route("/api/admin", platform);

const org = new Hono<AppEnv>();
org.use("*", requireUser, requireOrg, readOnlyGuard);
// Integrasjonene speiler hele porteføljen og er derfor ikke for brukere med begrenset tilgang
const fullScopeOnly: MiddlewareHandler<AppEnv> = async (_c, next) => {
  assertFullScope("Integrasjonen");
  await next();
};
for (const path of ["/boligmappa", "/boligmappa/*", "/laft", "/laft/*"]) org.use(path, fullScopeOnly);
org.route("/", orgs);
org.route("/portfolio", portfolio);
org.route("/components", components);
org.route("/tasks", tasks);
org.route("/desk", desk);
org.route("/documents", documents);
org.route("/search", search);
org.route("/artifacts", artifacts);
org.route("/ifc", ifc);
org.route("/agents", agents);
org.route("/conversations", conversations);
org.route("/boligmappa", boligmappa);
org.route("/laft", laft);
org.route("/help", help);
app.route("/api/orgs/:orgId", org);

app.all("/api/*", (c) => c.json({ error: "Ukjent API-endepunkt" }, 404));

const STATIC_ASSET = /\.(?:js|mjs|css|map|woff2?|png|jpe?g|gif|webp|svg|ico)$/i;

// Alt annet serveres av React-appen. En manglende skriptfil skal ikke bli index.html,
// for da prøver nettleseren å kjøre siden som modul etter en deploy.
app.all("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const path = new URL(c.req.url).pathname;
  const html = (res.headers.get("content-type") ?? "").includes("text/html");
  if (STATIC_ASSET.test(path) && (res.status === 404 || html)) {
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  }
  return res;
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await maintainHelp(env).catch((err) => console.error("Hjelpesenter feilet", err));
        await runDueAgents(env);
        await flushUsageInvoices(env);
        await notifySpendLimits(env).catch((err) => console.error("Varsel om AI-grense feilet", err));
        await keepLaftAlive(env).catch((err) => console.error("LAFT-fornyelse feilet", err));
        await syncAccessRequests(env).catch((err) => console.error("Synk av tilgangsforespørsler feilet", err));
        await runAutoImports(env, ctx).catch((err) => console.error("Automatisk Boligmappa-henting feilet", err));
        await runBoligmappaWatches(env, ctx).catch((err) => console.error("Sjekk etter nye Boligmappa-dokumenter feilet", err));
        await fillStreetNumbers(env).catch((err) => console.error("Husnummer fra bygningsnummer feilet", err));
        await publishSupplierPages(env).catch((err) => console.error("Leverandørside feilet", err));
      })(),
    );
  },
  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext) {
    await handleBoligmappaQueue(batch, env, ctx);
  },
} satisfies ExportedHandler<Env>;
