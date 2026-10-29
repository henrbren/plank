import type { Access } from "./lib/access";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  AI?: Ai;
  ASSETS: Fetcher;

  APP_URL: string;
  EMAIL_FROM: string;
  DEFAULT_MODEL: string;
  ALLOWED_EMAIL_DOMAINS?: string;
  ADMIN_EMAILS?: string;
  DEV_MODE?: string;

  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  RESEND_API_KEY?: string;

  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Månedspris for Standard */
  STRIPE_PRICE_ID?: string;
  /** Månedspris for Pro */
  STRIPE_PRICE_ID_PRO?: string;

  BOLIGMAPPA_CLIENT_ID?: string;
  BOLIGMAPPA_CLIENT_SECRET?: string;
  BOLIGMAPPA_TOKEN_HOST?: string;
  BOLIGMAPPA_API_BASE_URL?: string;

  /** 32 byte base64 – krypterer LAFT-tokens i D1 */
  LAFT_TOKEN_KEY?: string;
  LAFT_ID_URL?: string;

  /** boligmappa-ms: kommunekø og tilgangsforespørsler som LAFT godkjenner */
  BOLIGMAPPA_MS_URL?: string;
  /** Delt nøkkel begge veier (PLANK_KEY i boligmappa-ms) */
  BOLIGMAPPA_MS_KEY?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

export interface AppVariables {
  user: SessionUser;
  orgId: string;
  role: "owner" | "admin" | "member";
  access: Access;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };
