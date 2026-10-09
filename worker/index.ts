import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Env } from "./env";
import { csrfGuard, requireOrg, requireUser } from "./lib/auth";
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
import { claudeConfigured } from "./lib/anthropic";
import { emailConfigured } from "./lib/email";

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error(err);
  return c.json({ error: "Noe gikk galt på serveren" }, 500);
});

app.use("/api/*", csrfGuard);

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    claude: claudeConfigured(c.env),
    email: emailConfigured(c.env),
    ai: Boolean(c.env.AI),
    dev: c.env.DEV_MODE === "true",
  }),
);

app.route("/api/auth", auth);
app.route("/api/me", me);

const org = new Hono<AppEnv>();
org.use("*", requireUser, requireOrg);
org.route("/", orgs);
org.route("/portfolio", portfolio);
org.route("/components", components);
org.route("/tasks", tasks);
org.route("/documents", documents);
org.route("/search", search);
org.route("/artifacts", artifacts);
org.route("/ifc", ifc);
org.route("/agents", agents);
org.route("/conversations", conversations);
app.route("/api/orgs/:orgId", org);

app.all("/api/*", (c) => c.json({ error: "Ukjent API-endepunkt" }, 404));

// Alt annet serveres av React-appen (statiske filer)
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runDueAgents(env));
  },
} satisfies ExportedHandler<Env>;
