import type { Context } from "hono";
import type { AppEnv } from "../env";
import { applyStripeEvent, verifyStripeSignature, type StripeEvent } from "../lib/stripe";

export async function stripeWebhook(c: Context<AppEnv>) {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "Webhook er ikke konfigurert" }, 503);
  const payload = await c.req.text();
  const ok = await verifyStripeSignature(payload, c.req.header("stripe-signature"), secret);
  if (!ok) return c.json({ error: "Ugyldig signatur" }, 400);
  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return c.json({ error: "Ugyldig JSON" }, 400);
  }
  try {
    await applyStripeEvent(c.env, event);
  } catch (err) {
    console.error("Stripe-hendelse feilet", event.type, event.id, err);
    return c.json({ error: "Kunne ikke behandle hendelsen" }, 500);
  }
  return c.json({ received: true });
}
