import { Hono } from "hono";
import type { AppEnv } from "../env";
import { notFound } from "../lib/http";
import { helpDetail, helpIndex, helpShotKey, isHelpSlug } from "../services/help";

export const help = new Hono<AppEnv>();

help.get("/shots/:slug", async (c) => {
  if (c.get("access").scope) throw notFound("Skjermbilde");
  const slug = c.req.param("slug");
  if (!isHelpSlug(slug)) throw notFound("Skjermbilde");
  const obj = await c.env.FILES.get(helpShotKey(c.get("orgId"), slug));
  if (!obj) throw notFound("Skjermbilde");
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "image/jpeg",
      "cache-control": "private, max-age=3600",
    },
  });
});

help.get("/", async (c) => {
  const index = await helpIndex(c.env, c.get("orgId"), c.get("user").id);
  return c.json(index);
});

help.get("/:slug", async (c) => {
  const detail = await helpDetail(c.env, c.get("orgId"), c.req.param("slug"));
  if (!detail) throw notFound("Artikkelen");
  return c.json(detail);
});
