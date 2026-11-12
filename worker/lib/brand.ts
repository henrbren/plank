import type { Context } from "hono";
import { BRANDS, brandFromHost, isLaftHost, resolveBrand, type Brand } from "../../shared/brand";
import type { AppEnv, Env } from "../env";

export function brandOf(c: Context<AppEnv>): Brand {
  return resolveBrand(new URL(c.req.url).hostname, c.req.header("x-plank-brand"));
}

/** Kom forespørselen inn via et LAFT-domene (mappa.laft.io, sameie.laft.io …)? */
export function laftHost(c: Context<AppEnv>): boolean {
  return isLaftHost(new URL(c.req.url).hostname);
}

/** Leie-workeren har APP_URL på leie.vixon.no. Lokal utvikling og Plank blir plank. */
export function productOfApp(appUrl: string | undefined): "leie" | "plank" {
  try {
    return brandFromHost(new URL(appUrl ?? "http://localhost").hostname).id === "leie" ? "leie" : "plank";
  } catch {
    return "plank";
  }
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

/** E-postlenker må åpne samme vert som innloggingen. Økten gjelder ikke på tvers av domener. */
export function brandOrigin(env: Env, brandId: string | null | undefined): string {
  if (brandId === "naeringsmappa") return "https://mappa2.laft.io";
  if (brandId === "sameie") return "https://sameie.laft.io";
  return (env.APP_URL || "").replace(/\/$/, "");
}

export function emailFrom(env: Env, brand: Brand): string {
  const raw = env.EMAIL_FROM || "Plank <hei@plank.vixon.no>";
  return raw.replace(/^[^<]+/, `${brand.emailFromName} `);
}

export { BRANDS, brandFromHost };
