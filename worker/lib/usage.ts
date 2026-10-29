import { PLANS, type UsageDay, type UsageMonth } from "../../shared/types";
import type { Env } from "../env";
import type { ClaudeUsage } from "./anthropic";
import { includedOre, type PlanRow } from "./billing";
import { creditSnapshot, drawCredits } from "./credits";
import { all, first } from "./db";
import { emailConfigured, sendEmail, spendLimitEmail } from "./email";
import { ApiError } from "./http";
import { newId, now, osloDay, osloMonthStart, osloNextMonthStart } from "./util";
import { stripeForm } from "./stripe";

/** USD per million tokens. Cache-lesing er 10 % av inngang, cache-skriving 125 %. */
const RATES: { match: RegExp; input: number; output: number }[] = [
  { match: /haiku/i, input: 1, output: 5 },
  { match: /opus/i, input: 15, output: 75 },
  { match: /.*/, input: 3, output: 15 },
];

/** Fast kurs så fakturalinjen ikke hopper med dollarkursen. */
const USD_NOK = 11;
/** Påslag oppå API-kostnaden, før mva. 1 = 100 %. */
export const USAGE_MARKUP = 1;
const MVA = 0.25;
/** Ikke lag en fakturalinje før beløpet er minst dette, i øre. */
const MIN_INVOICE_ORE = 100;
/** Varsel når ekstra bruk passerer denne andelen av grensen */
const WARN_SHARE = 0.8;

export interface UsageQuote {
  costOre: number;
  billedOre: number;
}

export function quoteUsage(model: string, usage: ClaudeUsage): UsageQuote {
  const rate = RATES.find((r) => r.match.test(model)) ?? RATES[RATES.length - 1]!;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const usd = (input * rate.input + output * rate.output + cacheRead * rate.input * 0.1 + cacheWrite * rate.input * 1.25) / 1_000_000;
  const costOre = Math.round(usd * USD_NOK * 100);
  const netOre = Math.round(costOre * (1 + USAGE_MARKUP));
  return { costOre, billedOre: Math.round(netOre * (1 + MVA)) };
}

/** Lagrer kostnaden. Feil her skal ikke stoppe samtalen eller dokumentbehandlingen. */
export async function recordUsage(env: Env, opts: { orgId: string; model: string; usage: ClaudeUsage; source: "chat" | "schedule" | "document" }): Promise<void> {
  const tokens = (opts.usage.input_tokens ?? 0) + (opts.usage.output_tokens ?? 0) + (opts.usage.cache_read_input_tokens ?? 0) + (opts.usage.cache_creation_input_tokens ?? 0);
  if (tokens <= 0) return;
  try {
    const quote = quoteUsage(opts.model, opts.usage);
    const org = await first<{ billing_status: string; stripe_subscription_id: string | null }>(
      env.DB,
      `SELECT billing_status, stripe_subscription_id FROM orgs WHERE id = ?`,
      opts.orgId,
    );
    await env.DB.prepare(
      `INSERT INTO usage_ledger (id, org_id, source, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_ore, billed_ore, billable, batch_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
      .bind(
        newId("use"),
        opts.orgId,
        opts.source,
        opts.model.slice(0, 80),
        opts.usage.input_tokens ?? 0,
        opts.usage.output_tokens ?? 0,
        opts.usage.cache_read_input_tokens ?? 0,
        opts.usage.cache_creation_input_tokens ?? 0,
        quote.costOre,
        quote.billedOre,
        org?.billing_status === "active" && org.stripe_subscription_id ? 1 : 0,
        now(),
      )
      .run();
  } catch (err) {
    console.warn("Kunne ikke føre AI-kostnad", err);
  }
}

interface OrgSpendRow extends Pick<PlanRow, "plan" | "plan_peak" | "plan_peak_month"> {
  billing_status: string;
  stripe_subscription_id: string | null;
  spend_limit_ore: number | null;
}

const ORG_SPEND_SQL = `SELECT billing_status, stripe_subscription_id, plan, plan_peak, plan_peak_month, spend_limit_ore FROM orgs WHERE id = ?`;

function invoicing(org: OrgSpendRow | null): boolean {
  return org?.billing_status === "active" && Boolean(org.stripe_subscription_id);
}

export async function usageThisMonth(env: Env, orgId: string): Promise<UsageMonth> {
  const since = osloMonthStart();
  const [org, row, charged, credits] = await Promise.all([
    first<OrgSpendRow>(env.DB, ORG_SPEND_SQL, orgId),
    first<{ cost: number; billed: number; pending: number; trial: number }>(
      env.DB,
      `SELECT
         COALESCE(SUM(cost_ore), 0) AS cost,
         COALESCE(SUM(CASE WHEN billable = 1 THEN billed_ore ELSE 0 END), 0) AS billed,
         COALESCE(SUM(CASE WHEN billable = 1 AND batch_id IS NULL THEN billed_ore ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN billable = 0 THEN billed_ore ELSE 0 END), 0) AS trial
       FROM usage_ledger WHERE org_id = ? AND created_at >= ?`,
      orgId,
      since,
    ),
    first<{ billed: number }>(
      env.DB,
      `SELECT COALESCE(SUM(billed_ore), 0) AS billed FROM usage_batches WHERE org_id = ? AND created_at >= ? AND status IN ('pending', 'invoiced', 'failed')`,
      orgId,
      since,
    ),
    creditSnapshot(env, orgId, since),
  ]);
  const billedOre = row?.billed ?? 0;
  const included = org ? includedOre(org, since) : PLANS.standard.includedAiNok * 100;
  const overage = Math.max(0, billedOre - included);
  const invoiced = charged?.billed ?? 0;
  // Det som verken er fakturert eller trukket ennå, dekkes av kreditter før det går på fakturaen.
  const uncovered = Math.max(0, overage - invoiced - credits.drawnOre);
  const fromCredits = Math.min(uncovered, credits.remainingOre);
  const extra = invoiced + uncovered - fromCredits;
  const limitOre = org?.spend_limit_ore ?? null;
  return {
    costOre: row?.cost ?? 0,
    billedOre,
    includedOre: included,
    invoiceOre: limitOre === null ? extra : Math.min(extra, limitOre),
    extraOre: extra,
    creditUsedOre: credits.drawnOre + fromCredits,
    limitOre,
    paused: invoicing(org) && limitOre !== null && extra > 0 && extra >= limitOre,
    pendingOre: row?.pending ?? 0,
    trialOre: row?.trial ?? 0,
    markupPercent: USAGE_MARKUP * 100,
    creditOre: credits.remainingOre - fromCredits,
    creditExpiresAt: credits.expiresAt,
  };
}

/** Bruk per dag denne måneden, også dager uten bruk */
export async function usageByDay(env: Env, orgId: string): Promise<UsageDay[]> {
  const since = osloMonthStart();
  const rows = await all<{ hour: number; source: string; billed: number }>(
    env.DB,
    `SELECT created_at / 3600000 AS hour, source, SUM(billed_ore) AS billed FROM usage_ledger WHERE org_id = ? AND created_at >= ? GROUP BY hour, source`,
    orgId,
    since,
  );
  const firstDay = osloDay(since);
  const [year, month] = firstDay.split("-").map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days = new Map<string, UsageDay>();
  for (let d = 1; d <= daysInMonth; d++) {
    const day = `${firstDay.slice(0, 8)}${String(d).padStart(2, "0")}`;
    days.set(day, { day, chat: 0, schedule: 0, document: 0 });
  }
  for (const r of rows) {
    const entry = days.get(osloDay(r.hour * 3_600_000));
    if (!entry) continue;
    if (r.source === "chat" || r.source === "schedule" || r.source === "document") entry[r.source] += r.billed;
  }
  return [...days.values()];
}

export interface AiPause {
  limitOre: number;
  resumesAt: number;
}

const pauseCache = new Map<string, { at: number; pause: AiPause | null }>();

/** Om AI er satt på pause fordi månedsgrensen er nådd. Mellomlagres litt, så dokumentimport ikke spør for hver fil. */
export async function aiPause(env: Env, orgId: string, fresh = false): Promise<AiPause | null> {
  const hit = pauseCache.get(orgId);
  if (!fresh && hit && Date.now() - hit.at < 30_000) return hit.pause;
  const usage = await usageThisMonth(env, orgId);
  const pause = usage.paused && usage.limitOre !== null ? { limitOre: usage.limitOre, resumesAt: osloNextMonthStart() } : null;
  pauseCache.set(orgId, { at: Date.now(), pause });
  return pause;
}

export function forgetAiPause(orgId: string): void {
  pauseCache.delete(orgId);
}

function kr(ore: number): string {
  return `${Math.round(ore / 100).toLocaleString("nb-NO")} kr`;
}

function osloDate(at: number): string {
  return new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", day: "numeric", month: "long" }).format(new Date(at));
}

export function aiPauseMessage(pause: AiPause): string {
  const reason =
    pause.limitOre > 0 ? `Månedsgrensen for ekstra AI-bruk (${kr(pause.limitOre)}) er nådd.` : "AI-bruken som følger med måneden, er brukt opp, og grensen for ekstra bruk er 0 kr.";
  return `${reason} Agentene er på pause til ${osloDate(pause.resumesAt)}, eller til en administrator hever grensen under Abonnement.`;
}

export async function assertAiAvailable(env: Env, orgId: string): Promise<void> {
  const pause = await aiPause(env, orgId, true);
  if (pause) throw new ApiError(402, aiPauseMessage(pause));
}

interface BatchRow {
  id: string;
  org_id: string;
  cost_ore: number;
  billed_ore: number;
  status: string;
}

/** Legger betalende AI-bruk over det inkluderte beløpet på neste Stripe-faktura, aldri mer enn månedsgrensen. */
export async function flushUsageInvoices(env: Env): Promise<void> {
  if (!env.STRIPE_SECRET_KEY) return;
  const pending = await all<BatchRow>(env.DB, `SELECT id, org_id, cost_ore, billed_ore, status FROM usage_batches WHERE status = 'pending'`);
  for (const batch of pending) await pushBatch(env, batch);

  const monthStart = osloMonthStart();
  const closedAt = now();
  const orgs = await all<{ org_id: string }>(
    env.DB,
    `SELECT u.org_id
     FROM usage_ledger u
     JOIN orgs o ON o.id = u.org_id
     WHERE u.billable = 1 AND u.batch_id IS NULL AND u.created_at >= ?
       AND o.billing_status = 'active'
       AND o.stripe_customer_id IS NOT NULL AND o.stripe_subscription_id IS NOT NULL
     GROUP BY u.org_id`,
    monthStart,
  );
  for (const org of orgs) {
    const billing = await first<OrgSpendRow>(env.DB, ORG_SPEND_SQL, org.org_id);
    if (!billing) continue;
    const used = await first<{ billed: number }>(
      env.DB,
      `SELECT COALESCE(SUM(billed_ore), 0) AS billed FROM usage_ledger WHERE org_id = ? AND billable = 1 AND created_at >= ?`,
      org.org_id,
      monthStart,
    );
    const charged = await first<{ billed: number }>(
      env.DB,
      `SELECT COALESCE(SUM(billed_ore), 0) AS billed FROM usage_batches WHERE org_id = ? AND created_at >= ? AND status IN ('pending', 'invoiced', 'failed')`,
      org.org_id,
      monthStart,
    );
    const credits = await creditSnapshot(env, org.org_id, monthStart);
    const overage = Math.max(0, (used?.billed ?? 0) - includedOre(billing, monthStart));
    const delta = overage - (charged?.billed ?? 0) - credits.drawnOre;
    const id = newId("uib");
    await env.DB.prepare(
      `UPDATE usage_ledger SET batch_id = ? WHERE org_id = ? AND billable = 1 AND batch_id IS NULL AND created_at >= ? AND created_at <= ?`,
    )
      .bind(id, org.org_id, monthStart, closedAt)
      .run();
    const sum = await first<{ cost: number; billed: number }>(
      env.DB,
      `SELECT COALESCE(SUM(cost_ore), 0) AS cost, COALESCE(SUM(billed_ore), 0) AS billed FROM usage_ledger WHERE batch_id = ?`,
      id,
    );
    if (!sum || sum.billed <= 0) {
      await env.DB.prepare(`UPDATE usage_ledger SET batch_id = NULL WHERE batch_id = ?`).bind(id).run();
      continue;
    }
    const covered = delta > 0 ? await drawCredits(env, org.org_id, monthStart, delta) : 0;
    let invoice = delta - covered;
    if (billing.spend_limit_ore !== null) invoice = Math.min(invoice, Math.max(0, billing.spend_limit_ore - (charged?.billed ?? 0)));
    if (invoice < MIN_INVOICE_ORE) {
      if (invoice <= 0) {
        await env.DB.prepare(
          `INSERT INTO usage_batches (id, org_id, cost_ore, billed_ore, stripe_invoice_item_id, status, error, created_at) VALUES (?, ?, ?, 0, NULL, 'included', NULL, ?)`,
        )
          .bind(id, org.org_id, sum.cost, now())
          .run();
      } else {
        await env.DB.prepare(`UPDATE usage_ledger SET batch_id = NULL WHERE batch_id = ?`).bind(id).run();
      }
      continue;
    }
    await env.DB.prepare(
      `INSERT INTO usage_batches (id, org_id, cost_ore, billed_ore, stripe_invoice_item_id, status, error, created_at) VALUES (?, ?, ?, ?, NULL, 'pending', NULL, ?)`,
    )
      .bind(id, org.org_id, sum.cost, invoice, now())
      .run();
    await pushBatch(env, { id, org_id: org.org_id, cost_ore: sum.cost, billed_ore: invoice, status: "pending" });
  }
}

async function pushBatch(env: Env, batch: BatchRow): Promise<void> {
  const org = await first<{ stripe_customer_id: string | null; stripe_subscription_id: string | null }>(
    env.DB,
    `SELECT stripe_customer_id, stripe_subscription_id FROM orgs WHERE id = ?`,
    batch.org_id,
  );
  if (!org?.stripe_customer_id || !org.stripe_subscription_id) {
    await env.DB.prepare(`UPDATE usage_batches SET status = 'failed', error = ? WHERE id = ?`).bind("Mangler Stripe-kunde eller abonnement", batch.id).run();
    return;
  }
  const period = new Intl.DateTimeFormat("nb-NO", { month: "long", year: "numeric", timeZone: "Europe/Oslo" }).format(new Date());
  try {
    const item = await stripeForm(
      env,
      "/invoiceitems",
      {
        customer: org.stripe_customer_id,
        subscription: org.stripe_subscription_id,
        amount: String(batch.billed_ore),
        currency: "nok",
        description: `AI-bruk utover det som er inkludert i abonnementet, ${period}, inkl. mva`,
        "metadata[org_id]": batch.org_id,
        "metadata[batch_id]": batch.id,
        "metadata[cost_ore]": String(batch.cost_ore),
      },
      { "Idempotency-Key": batch.id },
    );
    await env.DB.prepare(`UPDATE usage_batches SET status = 'invoiced', stripe_invoice_item_id = ?, error = NULL WHERE id = ?`).bind(String(item.id), batch.id).run();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Kunne ikke legge på fakturaen";
    const fatal = /no such|invoice_upcoming_none|canceled|not found/i.test(message);
    await env.DB.prepare(`UPDATE usage_batches SET status = ?, error = ? WHERE id = ?`).bind(fatal ? "failed" : "pending", message.slice(0, 300), batch.id).run();
  }
}

/** Cron: e-post til eiere og administratorer ved 80 % av grensen, og når agentene settes på pause */
export async function notifySpendLimits(env: Env): Promise<void> {
  if (!emailConfigured(env)) return;
  const month = osloMonthStart();
  const orgs = await all<{ id: string; name: string; spend_limit_ore: number; limit_warned_month: number | null }>(
    env.DB,
    `SELECT id, name, spend_limit_ore, limit_warned_month FROM orgs
     WHERE billing_status = 'active' AND stripe_subscription_id IS NOT NULL AND spend_limit_ore IS NOT NULL
       AND (limit_reached_month IS NULL OR limit_reached_month <> ?)`,
    month,
  );
  const base = env.APP_URL.replace(/\/$/, "");
  for (const org of orgs) {
    const usage = await usageThisMonth(env, org.id);
    const reached = usage.paused;
    const warn = !reached && org.spend_limit_ore > 0 && org.limit_warned_month !== month && usage.invoiceOre >= org.spend_limit_ore * WARN_SHARE;
    if (!reached && !warn) continue;
    await env.DB.prepare(reached ? `UPDATE orgs SET limit_reached_month = ?, limit_warned_month = ? WHERE id = ?` : `UPDATE orgs SET limit_warned_month = ? WHERE id = ?`)
      .bind(...(reached ? [month, month, org.id] : [month, org.id]))
      .run();
    const admins = await all<{ email: string }>(
      env.DB,
      `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.role IN ('owner', 'admin')`,
      org.id,
    );
    if (!admins.length) continue;
    const mail = spendLimitEmail({
      kind: reached ? "reached" : "warn",
      orgName: org.name,
      limitOre: org.spend_limit_ore,
      extraOre: usage.invoiceOre,
      resumesAt: osloNextMonthStart(),
      url: `${base}/o/${org.id}/abonnement`,
    });
    await sendEmail(env, { to: admins.map((a) => a.email), ...mail, idempotencyKey: `spend-${reached ? "reached" : "warn"}-${org.id}-${month}` }).catch((err) =>
      console.warn("Kunne ikke varsle om månedsgrensen", org.id, err),
    );
  }
}
