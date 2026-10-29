import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { ApiError, body, notFound } from "../lib/http";
import { msKeyMatches } from "../lib/boligmappaMs";
import { decideAccessRequest } from "../services/accessRequests";

/** Kall fra andre tjenester. Autentiseres med delt nøkkel, ikke sesjon. */
export const hooks = new Hono<AppEnv>();

/** boligmappa-ms: LAFT har godkjent eller avslått en tilgangsforespørsel */
hooks.post("/access-requests", async (c) => {
  if (!(await msKeyMatches(c.env, c.req.header("authorization")))) throw new ApiError(401, "Ugyldig nøkkel");
  const input = await body(
    c,
    z.object({
      plankId: z.string().min(4).max(80),
      status: z.enum(["approved", "rejected"]),
      note: z.string().trim().max(2000).nullable().optional(),
      decidedBy: z.string().trim().max(200).nullable().optional(),
    }),
  );
  const result = await decideAccessRequest(c.env, input.plankId, { status: input.status, note: input.note || null, decidedBy: input.decidedBy || null });
  if (!result) throw notFound("Forespørselen");
  return c.json({ ok: true, ...result });
});
