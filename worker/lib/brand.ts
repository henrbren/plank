import type { Context } from "hono";
import { BRANDS, brandFromHost, resolveBrand, type Brand } from "../../shared/brand";
import type { AppEnv, Env } from "../env";

export function brandOf(c: Context<AppEnv>): Brand {
  return resolveBrand(new URL(c.req.url).hostname, c.req.header("x-plank-brand"));
}

/** Kom forespørselen inn via et LAFT-domene (mappa.laft.io, sameie.laft.io …)? */
export function laftHost(c: Context<AppEnv>): boolean {
  return brandFromHost(new URL(c.req.url).hostname).id !== "plank";
}

export function publicOrigin(c: Context<AppEnv>): string {
  const url = new URL(c.req.url);
  const brand = brandFromHost(url.hostname);
  if (brand.id !== "plank") return `${url.protocol}//${url.host}`;
  const forwarded = c.req.header("x-forwarded-host");
  if (forwarded && brandFromHost(forwarded).id !== "plank") {
    const proto = c.req.header("x-forwarded-proto") || url.protocol.replace(":", "");
    return `${proto}://${forwarded}`;
  }
  return (c.env.APP_URL || `${url.protocol}//${url.host}`).replace(/\/$/, "");
}

export function emailFrom(env: Env, brand: Brand): string {
  const raw = env.EMAIL_FROM || "Plank <hei@plank.vixon.no>";
  return raw.replace(/^[^<]+/, `${brand.emailFromName} `);
}

export { BRANDS, brandFromHost };
