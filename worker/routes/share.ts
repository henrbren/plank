import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv } from "../env";
import type { SharedArtifact } from "../../shared/types";
import { getSessionUser, SESSION_COOKIE } from "../lib/auth";
import { first } from "../lib/db";
import { ApiError, body, notFound } from "../lib/http";
import { sha256 } from "../lib/util";
import { throttle } from "./auth";
import { runShareQuery } from "../services/artifactShare";
import { getArtifactHtml, shareModeOf } from "../services/artifacts";

export const share = new Hono<AppEnv>();

async function shared(env: AppEnv["Bindings"], token: string, userId: string | null): Promise<{ orgId: string; page: SharedArtifact }> {
  const row = await first<{ id: string; org_id: string; share_mode: string }>(
    env.DB,
    `SELECT id, org_id, share_mode FROM artifacts WHERE share_token = ?`,
    token,
  );
  const mode = shareModeOf(row?.share_mode);
  if (!row || mode === "off") throw notFound("Lenken");
  if (mode === "login" && !userId) throw new ApiError(401, "Du må logge inn for å se siden");
  const { artifact, html } = await getArtifactHtml(env, row.org_id, row.id);
  const org = await first<{ name: string }>(env.DB, `SELECT name FROM orgs WHERE id = ?`, row.org_id);
  return {
    orgId: row.org_id,
    page: {
      title: artifact.title,
      html,
      orgName: org?.name ?? "",
      artifactId: artifact.id,
      buildingId: artifact.building_id,
      propertyId: artifact.property_id,
      mode,
    },
  };
}

share.get("/:token", async (c) => {
  const user = await getSessionUser(c.env, getCookie(c, SESSION_COOKIE));
  const { page } = await shared(c.env, c.req.param("token"), user?.id ?? null);
  return c.json(page);
});

share.post("/:token/query", async (c) => {
  const token = c.req.param("token");
  const user = await getSessionUser(c.env, getCookie(c, SESSION_COOKIE));
  const { orgId } = await shared(c.env, token, user?.id ?? null);
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(40), params: z.record(z.string(), z.unknown()).optional() }));
  const ip = c.req.header("cf-connecting-ip") ?? "lokal";
  await throttle(c.env, `shareq:${await sha256(`${token}:${ip}`)}`, 120, 5 * 60 * 1000, "For mange oppslag mot siden. Vent litt.");
  return c.json(await runShareQuery(c.env, orgId, input.name, input.params ?? {}));
});
