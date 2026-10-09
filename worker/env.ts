export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  AI?: Ai;
  ASSETS: Fetcher;

  APP_URL: string;
  EMAIL_FROM: string;
  DEFAULT_MODEL: string;
  ALLOWED_EMAIL_DOMAINS?: string;
  DEV_MODE?: string;

  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  RESEND_API_KEY?: string;
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
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };
