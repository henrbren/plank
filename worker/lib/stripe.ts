import { PLANS, planOf, type CreditPack, type PlanId } from "../../shared/types";
import type { Env } from "../env";
import { logActivity } from "./activity";
import { planForPrice, setPlan, stripePriceFor } from "./billing";
import { grantCreditPack, revokeCreditPayment } from "./credits";
import { first } from "./db";
import { emailConfigured, sendEmail, subscriptionStartedEmail } from "./email";
import { ApiError } from "./http";

const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_VERSION = "2026-09-30.endive";
const INTEGRATION_ID = "plank_sub_m4kdqwzr";
const CREDITS_INTEGRATION_ID = "plank_credits_wqxnmkpd";

type StripeObject = Record<string, unknown>;

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: StripeObject };
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

export async function stripeForm(env: Env, path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<StripeObject> {
  if (!env.STRIPE_SECRET_KEY) throw new ApiError(503, "Stripe er ikke konfigurert");
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_VERSION,
      ...headers,
    },
    body: form(fields),
  });
  const data = (await res.json()) as StripeObject & { error?: { message?: string } };
  if (!res.ok) throw new ApiError(502, data.error?.message || "Stripe svarte med en feil");
  return data;
}

async function stripeGet(env: Env, path: string): Promise<StripeObject> {
  if (!env.STRIPE_SECRET_KEY) throw new ApiError(503, "Stripe er ikke konfigurert");
  const res = await fetch(`${STRIPE_API}${path}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Stripe-Version": STRIPE_VERSION },
  });
  const data = (await res.json()) as StripeObject & { error?: { message?: string } };
  if (!res.ok) throw new ApiError(502, data.error?.message || "Stripe svarte med en feil");
  return data;
}

function idOf(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && "id" in value && typeof (value as { id: unknown }).id === "string") return (value as { id: string }).id;
  return null;
}

export async function ensureStripeCustomer(env: Env, orgId: string, email: string, name: string): Promise<string> {
  const existing = await first<{ stripe_customer_id: string | null }>(env.DB, `SELECT stripe_customer_id FROM orgs WHERE id = ?`, orgId);
  if (existing?.stripe_customer_id) return existing.stripe_customer_id;
  const customer = await stripeForm(env, "/customers", {
    email,
    name,
    "metadata[org_id]": orgId,
  });
  const customerId = String(customer.id);
  await env.DB.prepare(`UPDATE orgs SET stripe_customer_id = ? WHERE id = ?`).bind(customerId, orgId).run();
  return customerId;
}

export async function createSubscriptionCheckout(
  env: Env,
  opts: { orgId: string; customerId: string; plan: PlanId; successUrl: string; cancelUrl: string },
): Promise<string> {
  const price = stripePriceFor(env, opts.plan);
  if (!price) throw new ApiError(503, `${PLANS[opts.plan].name} har ingen pris i Stripe ennå`);
  const session = await stripeForm(env, "/checkout/sessions", {
    mode: "subscription",
    customer: opts.customerId,
    client_reference_id: opts.orgId,
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    locale: "nb",
    allow_promotion_codes: "true",
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    "metadata[org_id]": opts.orgId,
    "metadata[plan]": opts.plan,
    "subscription_data[metadata][org_id]": opts.orgId,
    integration_identifier: INTEGRATION_ID,
  });
  const url = session.url;
  if (typeof url !== "string" || !url) throw new ApiError(502, "Stripe returnerte ingen betalingslenke");
  return url;
}

function priceOfSubscription(sub: StripeObject): string | null {
  const items = sub.items as { data?: { price?: unknown }[] } | undefined;
  return idOf(items?.data?.[0]?.price);
}

/**
 * Bytter pris på abonnementet. Stripe fakturerer mellomlegget med en gang (eller gir tilgode ved nedgradering).
 * Krever betalingen handling, blir byttet stående til fakturaen er betalt, og payUrl peker dit.
 */
export async function changeSubscriptionPlan(env: Env, subscriptionId: string, plan: PlanId): Promise<{ applied: boolean; payUrl: string | null }> {
  const price = stripePriceFor(env, plan);
  if (!price) throw new ApiError(503, `${PLANS[plan].name} har ingen pris i Stripe ennå`);
  const sub = await stripeGet(env, `/subscriptions/${subscriptionId}`);
  const item = (sub.items as { data?: { id: string }[] } | undefined)?.data?.[0];
  if (!item) throw new ApiError(502, "Fant ikke abonnementet i Stripe");
  if (priceOfSubscription(sub) === price) return { applied: true, payUrl: null };
  const updated = await stripeForm(env, `/subscriptions/${subscriptionId}`, {
    "items[0][id]": item.id,
    "items[0][price]": price,
    proration_behavior: "always_invoice",
    payment_behavior: "pending_if_incomplete",
    "expand[0]": "latest_invoice",
  });
  if (!updated.pending_update) return { applied: true, payUrl: null };
  const invoice = updated.latest_invoice as StripeObject | null;
  return { applied: false, payUrl: typeof invoice?.hosted_invoice_url === "string" ? invoice.hosted_invoice_url : null };
}

export async function createCreditCheckout(env: Env, opts: { orgId: string; customerId: string; pack: CreditPack; successUrl: string; cancelUrl: string }): Promise<string> {
  const credit = opts.pack.creditNok.toLocaleString("nb-NO");
  const session = await stripeForm(env, "/checkout/sessions", {
    mode: "payment",
    customer: opts.customerId,
    client_reference_id: opts.orgId,
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    locale: "nb",
    "line_items[0][price_data][currency]": "nok",
    "line_items[0][price_data][unit_amount]": String(opts.pack.priceNok * 100),
    "line_items[0][price_data][product_data][name]": `AI-kreditter, ${credit} kr`,
    "line_items[0][price_data][product_data][description]": "Gyldig i ett år fra kjøp. Inkludert mva.",
    "line_items[0][quantity]": "1",
    "metadata[org_id]": opts.orgId,
    "metadata[kind]": "credits",
    "metadata[pack_id]": opts.pack.id,
    "payment_intent_data[metadata][org_id]": opts.orgId,
    "payment_intent_data[metadata][kind]": "credits",
    "payment_intent_data[metadata][pack_id]": opts.pack.id,
    integration_identifier: CREDITS_INTEGRATION_ID,
  });
  const url = session.url;
  if (typeof url !== "string" || !url) throw new ApiError(502, "Stripe returnerte ingen betalingslenke");
  return url;
}

export async function createPortalSession(env: Env, customerId: string, returnUrl: string): Promise<string> {
  const session = await stripeForm(env, "/billing_portal/sessions", { customer: customerId, return_url: returnUrl });
  const url = session.url;
  if (typeof url !== "string" || !url) throw new ApiError(502, "Stripe returnerte ingen portal-lenke");
  return url;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export async function verifyStripeSignature(payload: string, header: string | undefined, secret: string): Promise<boolean> {
  if (!header) return false;
  const timestamp = header.match(/(?:^|,)t=(\d+)/)?.[1];
  const signatures = [...header.matchAll(/(?:^|,)v1=([a-f0-9]+)/g)].map((m) => m[1]!);
  if (!timestamp || signatures.length === 0) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return signatures.some((sig) => timingSafeEqual(sig, hex));
}

async function findOrgId(env: Env, customerId: string | null, subscriptionId: string | null, hintedOrgId?: string | null): Promise<string | null> {
  if (subscriptionId) {
    const bySub = await first<{ id: string }>(env.DB, `SELECT id FROM orgs WHERE stripe_subscription_id = ?`, subscriptionId);
    if (bySub) return bySub.id;
  }
  if (customerId) {
    const byCustomer = await first<{ id: string }>(env.DB, `SELECT id FROM orgs WHERE stripe_customer_id = ?`, customerId);
    if (byCustomer) return byCustomer.id;
  }
  if (hintedOrgId) {
    const org = await first<{ id: string }>(env.DB, `SELECT id FROM orgs WHERE id = ?`, hintedOrgId);
    if (org) return org.id;
  }
  return null;
}

async function setBilling(env: Env, orgId: string, patch: { status?: string; customerId?: string | null; subscriptionId?: string | null; note?: string | null }) {
  await env.DB.prepare(
    `UPDATE orgs SET billing_status = COALESCE(?, billing_status), stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = COALESCE(?, stripe_subscription_id), billing_note = COALESCE(?, billing_note) WHERE id = ?`,
  )
    .bind(patch.status ?? null, patch.customerId ?? null, patch.subscriptionId ?? null, patch.note ?? null, orgId)
    .run();
}

/** Planen kan byttes i Plank eller i Stripe-portalen. Endringer som kommer via Stripe, logges her. */
async function syncPlan(env: Env, orgId: string, plan: PlanId | null): Promise<void> {
  if (!plan) return;
  const previous = await setPlan(env, orgId, plan);
  if (!previous) return;
  await logActivity(env, {
    orgId,
    actor: { type: "system", name: "Stripe" },
    action: "billing.plan_changed",
    entityType: "org",
    entityId: orgId,
    summary: `Planen er endret fra ${PLANS[previous].name} til ${PLANS[plan].name}`,
  });
}

async function activateSubscription(env: Env, orgId: string, customerId: string | null, subscriptionId: string | null, plan: PlanId | null): Promise<void> {
  const prev = await first<{ billing_status: string; name: string; plan: string }>(env.DB, `SELECT billing_status, name, plan FROM orgs WHERE id = ?`, orgId);
  await setBilling(env, orgId, { status: "active", customerId, subscriptionId, note: null });
  await syncPlan(env, orgId, plan);
  if (!prev || prev.billing_status === "active" || !emailConfigured(env)) return;
  const owner = await first<{ email: string }>(
    env.DB,
    `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.role = 'owner' LIMIT 1`,
    orgId,
  );
  if (!owner?.email) return;
  const base = env.APP_URL.replace(/\/$/, "");
  const mail = subscriptionStartedEmail(prev.name, planOf(plan ?? prev.plan), `${base}/o/${orgId}/abonnement`);
  try {
    await sendEmail(env, { to: owner.email, ...mail, idempotencyKey: `plank-sub-started-${orgId}` });
  } catch (err) {
    console.warn("Kunne ikke sende abonnementsbekreftelse", err);
  }
}

function metadataOf(obj: StripeObject): Record<string, string> {
  const meta = obj.metadata;
  if (!meta || typeof meta !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) if (typeof value === "string") out[key] = value;
  return out;
}

async function paymentIntentOfCharge(env: Env, charge: unknown): Promise<string | null> {
  if (charge && typeof charge === "object" && "payment_intent" in charge) return idOf((charge as StripeObject).payment_intent);
  const chargeId = idOf(charge);
  if (!chargeId) return null;
  const fetched = await stripeGet(env, `/charges/${chargeId}`);
  return idOf(fetched.payment_intent);
}

function mapSubscriptionStatus(status: unknown): string {
  if (status === "active" || status === "trialing") return "active";
  if (status === "past_due" || status === "unpaid") return "past_due";
  if (status === "canceled" || status === "incomplete_expired") return "canceled";
  return "none";
}

async function customerFromCharge(env: Env, charge: unknown): Promise<string | null> {
  const direct = idOf(typeof charge === "object" && charge ? (charge as StripeObject).customer : null);
  if (direct) return direct;
  const chargeId = idOf(charge);
  if (!chargeId) return null;
  const fetched = await stripeGet(env, `/charges/${chargeId}`);
  return idOf(fetched.customer);
}

/** Oppdaterer abonnementet ut fra Stripe-hendelser. Oppslag går via kunde- og abonnements-ID. */
export async function applyStripeEvent(env: Env, event: StripeEvent): Promise<void> {
  const obj = event.data.object;
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const paid = obj.payment_status === "paid" || obj.payment_status === "no_payment_required" || event.type === "checkout.session.async_payment_succeeded";
    if (!paid) return;
    const meta = metadataOf(obj);
    if (meta.kind === "credits") {
      await grantCreditPack(env, {
        orgId: meta.org_id ?? "",
        packId: meta.pack_id ?? "",
        sessionId: typeof obj.id === "string" ? obj.id : "",
        paymentIntentId: idOf(obj.payment_intent),
      });
      return;
    }
    const customerId = idOf(obj.customer);
    const subscriptionId = idOf(obj.subscription);
    const orgId = await findOrgId(env, customerId, subscriptionId, typeof obj.client_reference_id === "string" ? obj.client_reference_id : null);
    if (!orgId) return;
    const plan = meta.plan && meta.plan in PLANS ? (meta.plan as PlanId) : null;
    await activateSubscription(env, orgId, customerId, subscriptionId, plan);
    return;
  }

  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const customerId = idOf(obj.customer);
    const subscriptionId = idOf(obj.id);
    const orgId = await findOrgId(env, customerId, subscriptionId, typeof obj.metadata === "object" && obj.metadata ? (obj.metadata as StripeObject).org_id as string : null);
    if (!orgId) return;
    const status = event.type === "customer.subscription.deleted" ? "canceled" : mapSubscriptionStatus(obj.status);
    const plan = planForPrice(env, priceOfSubscription(obj));
    if (status === "active") {
      await activateSubscription(env, orgId, customerId, subscriptionId, plan);
    } else {
      await setBilling(env, orgId, { status, customerId, subscriptionId });
      if (status !== "canceled") await syncPlan(env, orgId, plan);
    }
    return;
  }

  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    const customerId = idOf(obj.customer);
    const parent = obj.parent as StripeObject | undefined;
    const details = parent?.subscription_details as StripeObject | undefined;
    const subscriptionId = idOf(obj.subscription) ?? idOf(details?.subscription);
    const orgId = await findOrgId(env, customerId, subscriptionId);
    if (!orgId) return;
    if (event.type === "invoice.paid") await activateSubscription(env, orgId, customerId, subscriptionId, null);
    else await setBilling(env, orgId, { status: "past_due", customerId, subscriptionId });
    return;
  }

  if (event.type === "charge.dispute.created" || event.type === "radar.early_fraud_warning.created" || event.type === "charge.refunded") {
    const charge = event.type === "charge.refunded" ? obj : obj.charge;
    const paymentIntentId = await paymentIntentOfCharge(env, charge);
    if (paymentIntentId && (event.type === "charge.refunded" || event.type === "charge.dispute.created")) {
      const amount = typeof obj.amount === "number" ? obj.amount : 0;
      const refunded = event.type === "charge.dispute.created" ? amount : typeof obj.amount_refunded === "number" ? obj.amount_refunded : amount;
      await revokeCreditPayment(env, paymentIntentId, amount || refunded, refunded || amount);
    }
    const customerId = await customerFromCharge(env, charge);
    const orgId = await findOrgId(env, customerId, null);
    if (!orgId) return;
    const note =
      event.type === "charge.dispute.created"
        ? "Korttvist er åpnet i Stripe. Sjekk saken der."
        : event.type === "charge.refunded"
          ? "En betaling er refundert i Stripe."
          : "Stripe har varslet om mulig svindel på et kort.";
    const status = event.type === "charge.refunded" ? undefined : "past_due";
    await setBilling(env, orgId, { status, customerId, note });
  }
}
