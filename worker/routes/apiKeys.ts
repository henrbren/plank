import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { activityStatement } from "../lib/activity";
import { createApiKey, listApiKeys, revokeApiKey } from "../lib/apiKeys";
import { assertSession } from "../lib/auth";
import { body, forbidden } from "../lib/http";
import { now } from "../lib/util";

/** API-nøkler for integrasjoner og MCP. Lages bare fra appen – en nøkkel kan ikke lage nye nøkler. */
export const apiKeys = new Hono<AppEnv>();

const viewer = (c: Context<AppEnv>) => {
  const role = c.get("role");
  return { userId: c.get("user").id, admin: role === "owner" || role === "admin" };
};

apiKeys.get("/", async (c) => {
  assertSession(c, "Å se API-nøkler");
  return c.json(await listApiKeys(c.env, c.get("orgId"), viewer(c)));
});

apiKeys.post("/", async (c) => {
  assertSession(c, "Å lage API-nøkler");
  const input = await body(
    c,
    z.object({
      name: z.string().trim().min(1, "Gi nøkkelen et navn").max(80),
      can_write: z.boolean(),
      expires_in_days: z.number().int().min(1).max(3650).nullable().optional(),
    }),
  );
  const access = c.get("access");
  if (input.can_write && !access.canEdit) throw forbidden("Du har lesetilgang og kan bare lage lesenøkler");
  const user = c.get("user");
  const key = await createApiKey(c.env, {
    orgId: c.get("orgId"),
    userId: user.id,
    name: input.name,
    canWrite: input.can_write,
    expiresAt: input.expires_in_days ? now() + input.expires_in_days * 24 * 60 * 60 * 1000 : null,
  });
  await activityStatement(c.env, {
    orgId: c.get("orgId"),
    actor: { type: "user", id: user.id, name: user.name ?? user.email },
    action: "api_key.created",
    summary: `Laget API-nøkkelen «${input.name}» (${input.can_write ? "lese og skrive" : "lese"})`,
  })
    .run()
    .catch(() => undefined);
  return c.json({ id: key.id, token: key.token }, 201);
});

apiKeys.delete("/:id", async (c) => {
  assertSession(c, "Å trekke tilbake API-nøkler");
  await revokeApiKey(c.env, c.get("orgId"), c.req.param("id"), viewer(c));
  return c.json({ ok: true });
});
