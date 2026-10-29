import { creditPack } from "../../shared/types";
import type { Env } from "../env";
import { logActivity } from "./activity";
import { all, first } from "./db";
import { newId, now } from "./util";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export function creditExpiry(purchasedAt: number): number {
  return purchasedAt + YEAR_MS;
}

export interface CreditSnapshot {
  remainingOre: number;
  expiresAt: number | null;
  drawnOre: number;
}

export async function creditSnapshot(env: Env, orgId: string, periodStart: number): Promise<CreditSnapshot> {
  const at = now();
  const [balance, drawn] = await env.DB.batch<{ remaining: number; expires_at: number | null } | { drawn: number }>([
    env.DB.prepare(
      `SELECT COALESCE(SUM(remaining_ore), 0) AS remaining, MIN(expires_at) AS expires_at
       FROM credit_grants WHERE org_id = ? AND expires_at > ? AND remaining_ore > 0`,
    ).bind(orgId, at),
    env.DB.prepare(`SELECT COALESCE(SUM(billed_ore), 0) AS drawn FROM credit_draws WHERE org_id = ? AND period_start = ?`).bind(orgId, periodStart),
  ]);
  const row = balance?.results?.[0] as { remaining?: number; expires_at?: number | null } | undefined;
  const drawnRow = drawn?.results?.[0] as { drawn?: number } | undefined;
  return {
    remainingOre: row?.remaining ?? 0,
    expiresAt: row?.expires_at ?? null,
    drawnOre: drawnRow?.drawn ?? 0,
  };
}

/** Trekker fra de kredittene som utløper først. Returnerer hvor mye som ble dekket. */
export async function drawCredits(env: Env, orgId: string, periodStart: number, amountOre: number): Promise<number> {
  if (amountOre <= 0) return 0;
  const grants = await all<{ id: string; remaining_ore: number }>(
    env.DB,
    `SELECT id, remaining_ore FROM credit_grants
     WHERE org_id = ? AND expires_at > ? AND remaining_ore > 0
     ORDER BY expires_at, purchased_at`,
    orgId,
    now(),
  );
  let left = amountOre;
  let covered = 0;
  for (const grant of grants) {
    if (left <= 0) break;
    const take = Math.min(grant.remaining_ore, left);
    const updated = await env.DB.prepare(`UPDATE credit_grants SET remaining_ore = remaining_ore - ? WHERE id = ? AND org_id = ? AND remaining_ore >= ?`)
      .bind(take, grant.id, orgId, take)
      .run();
    if (!updated.meta.changes) continue;
    await env.DB.prepare(`INSERT INTO credit_draws (id, grant_id, org_id, billed_ore, period_start, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(newId("cdr"), grant.id, orgId, take, periodStart, now())
      .run();
    left -= take;
    covered += take;
  }
  return covered;
}

/** Legger inn kreditter når Stripe har bekreftet betalingen. Trygt å kalle flere ganger for samme økt. */
export async function grantCreditPack(
  env: Env,
  opts: { orgId: string; packId: string; sessionId: string; paymentIntentId: string | null },
): Promise<void> {
  const pack = creditPack(opts.packId);
  if (!pack || !opts.orgId || !opts.sessionId) return;
  const org = await first<{ id: string }>(env.DB, `SELECT id FROM orgs WHERE id = ?`, opts.orgId);
  if (!org) return;
  const existing = await first<{ id: string }>(env.DB, `SELECT id FROM credit_grants WHERE stripe_session_id = ?`, opts.sessionId);
  if (existing) return;
  const purchasedAt = now();
  const id = newId("crd");
  try {
    await env.DB.prepare(
      `INSERT INTO credit_grants (id, org_id, pack_id, credit_ore, price_ore, remaining_ore, stripe_session_id, stripe_payment_intent, purchased_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, opts.orgId, pack.id, pack.creditNok * 100, pack.priceNok * 100, pack.creditNok * 100, opts.sessionId, opts.paymentIntentId, purchasedAt, creditExpiry(purchasedAt))
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE/i.test(message)) return;
    throw err;
  }
  await logActivity(env, {
    orgId: opts.orgId,
    actor: { type: "system", name: "Stripe" },
    action: "credits.purchased",
    entityType: "credit_grant",
    entityId: id,
    summary: `Kjøpte ${pack.creditNok.toLocaleString("nb-NO")} kr i AI-kreditter, gyldig i ett år`,
  });
}

/** Fjerner ubrukte kreditter når betalingen refunderes. Returnerer organisasjonen hvis det var et kredittkjøp. */
export async function revokeCreditPayment(env: Env, paymentIntentId: string, amount: number, amountRefunded: number): Promise<string | null> {
  const grant = await first<{ id: string; org_id: string; credit_ore: number; remaining_ore: number }>(
    env.DB,
    `SELECT id, org_id, credit_ore, remaining_ore FROM credit_grants WHERE stripe_payment_intent = ?`,
    paymentIntentId,
  );
  if (!grant) return null;
  const fraction = amount > 0 ? Math.min(1, amountRefunded / amount) : 1;
  const remaining = fraction >= 1 ? 0 : Math.max(0, grant.remaining_ore - Math.round(grant.credit_ore * fraction));
  await env.DB.prepare(`UPDATE credit_grants SET remaining_ore = ? WHERE id = ?`).bind(remaining, grant.id).run();
  await logActivity(env, {
    orgId: grant.org_id,
    actor: { type: "system", name: "Stripe" },
    action: "credits.revoked",
    entityType: "credit_grant",
    entityId: grant.id,
    summary: "Ubrukte AI-kreditter er fjernet etter refundering",
  });
  return grant.org_id;
}
