import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";

export class ApiError extends HTTPException {
  constructor(status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503, message: string) {
    super(status, { message });
  }
}

export const notFound = (what = "Ressursen") => new ApiError(404, `${what} finnes ikke`);
export const forbidden = (msg = "Du har ikke tilgang til dette") => new ApiError(403, msg);
export const badRequest = (msg: string) => new ApiError(400, msg);

/** Leser og validerer JSON-body med et zod-skjema */
export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("Ugyldig JSON");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path?.join(".") || "body";
    throw badRequest(`Ugyldig felt «${path}»: ${first?.message ?? "ukjent feil"}`);
  }
  return result.data;
}
