import type { Env } from "../env";
import { scopeSql } from "../lib/access";
import { all } from "../lib/db";
import { todayIso } from "../lib/util";

/**
 * FDV-analyse av porteføljen uten AI: forfalt service, tilstandsgrad, åpne avvik og dokumentasjonsdekning per bygg.
 * Brukes av agentverktøyet analyze_portfolio og av MCP/API, slik at eksterne klienter får tallene direkte.
 */

export interface BuildingAnalysis {
  id: string;
  name: string;
  property_id: string;
  property_name: string;
  year_built: number | null;
  /** Høyere = mer som bør følges opp */
  risk_score: number;
  components: {
    total: number;
    service_overdue: number;
    service_due_soon: number;
    without_interval: number;
    tg2: number;
    tg3: number;
    warranty_expiring: number;
    without_documents: number;
  };
  tasks: { open: number; open_deviations: number; overdue: number; urgent: number };
  documents: { total: number; by_kind: Record<string, number> };
  /** Dokumentasjonsdekning: andel komponenter med minst ett dokument (0–100), null uten komponenter */
  documentation_coverage: number | null;
  findings: string[];
}

export interface PortfolioAnalysis {
  generated_on: string;
  horizon_days: number;
  totals: {
    buildings: number;
    components: number;
    service_overdue: number;
    service_due_soon: number;
    tg3: number;
    open_tasks: number;
    open_deviations: number;
    documents: number;
  };
  buildings: BuildingAnalysis[];
  overdue_components: { id: string; name: string; building: string | null; ns3451: string | null; next_service_at: string; condition: string | null }[];
  urgent_tasks: { id: string; title: string; type: string; priority: string; due_date: string | null; building: string | null }[];
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const n = (v: unknown) => Number(v ?? 0);

export async function analyzePortfolio(
  env: Env,
  orgId: string,
  f: { property_id?: string | null; building_id?: string | null; horizon_days?: number } = {},
): Promise<PortfolioAnalysis> {
  const horizon = Math.min(Math.max(Math.round(f.horizon_days ?? 90), 1), 730);
  const today = todayIso();
  const until = addDays(today, horizon);
  const warrantyUntil = addDays(today, 180);

  const where = ["b.org_id = ?"];
  const params: unknown[] = [orgId];
  if (f.building_id) where.push("b.id = ?"), params.push(f.building_id);
  if (f.property_id) where.push("b.property_id = ?"), params.push(f.property_id);
  const scope = scopeSql({ building: "b.id" });
  where.push(scope.sql), params.push(...scope.params);
  const buildings = await all<{ id: string; name: string; property_id: string; property_name: string; year_built: number | null }>(
    env.DB,
    `SELECT b.id, b.name, b.property_id, p.name AS property_name, b.year_built FROM buildings b JOIN properties p ON p.id = b.property_id
     WHERE ${where.join(" AND ")} ORDER BY p.name, b.name LIMIT 500`,
    ...params,
  );
  const ids = JSON.stringify(buildings.map((b) => b.id));
  const inIds = `IN (SELECT value FROM json_each(?))`;

  const [compRows, taskRows, docRows, overdue, urgent] = await Promise.all([
    all<Record<string, unknown> & { building_id: string }>(
      env.DB,
      `SELECT c.building_id,
         COUNT(*) AS total,
         SUM(c.next_service_at IS NOT NULL AND c.next_service_at < ?) AS service_overdue,
         SUM(c.next_service_at >= ? AND c.next_service_at <= ?) AS service_due_soon,
         SUM(c.service_interval_months IS NULL) AS without_interval,
         SUM(c.condition = 'TG2') AS tg2,
         SUM(c.condition = 'TG3') AS tg3,
         SUM(c.warranty_until >= ? AND c.warranty_until <= ?) AS warranty_expiring,
         SUM(NOT EXISTS (SELECT 1 FROM documents d WHERE d.org_id = c.org_id AND d.component_id = c.id)) AS without_documents
       FROM components c WHERE c.org_id = ? AND c.building_id ${inIds} GROUP BY c.building_id`,
      today,
      today,
      until,
      today,
      warrantyUntil,
      orgId,
      ids,
    ),
    all<Record<string, unknown> & { building_id: string }>(
      env.DB,
      `SELECT building_id,
         SUM(status IN ('open', 'in_progress')) AS open,
         SUM(status IN ('open', 'in_progress') AND type = 'avvik') AS open_deviations,
         SUM(status IN ('open', 'in_progress') AND due_date IS NOT NULL AND due_date < ?) AS overdue,
         SUM(status IN ('open', 'in_progress') AND priority IN ('high', 'critical')) AS urgent
       FROM tasks WHERE org_id = ? AND building_id ${inIds} GROUP BY building_id`,
      today,
      orgId,
      ids,
    ),
    all<{ building_id: string; kind: string; n: number }>(
      env.DB,
      `SELECT building_id, kind, COUNT(*) AS n FROM documents WHERE org_id = ? AND building_id ${inIds} GROUP BY building_id, kind`,
      orgId,
      ids,
    ),
    all<PortfolioAnalysis["overdue_components"][number]>(
      env.DB,
      `SELECT c.id, c.name, b.name AS building, c.ns3451, c.next_service_at, c.condition FROM components c LEFT JOIN buildings b ON b.id = c.building_id
       WHERE c.org_id = ? AND c.building_id ${inIds} AND c.next_service_at IS NOT NULL AND c.next_service_at < ? ORDER BY c.next_service_at LIMIT 25`,
      orgId,
      ids,
      today,
    ),
    all<PortfolioAnalysis["urgent_tasks"][number]>(
      env.DB,
      `SELECT t.id, t.title, t.type, t.priority, t.due_date, b.name AS building FROM tasks t LEFT JOIN buildings b ON b.id = t.building_id
       WHERE t.org_id = ? AND t.building_id ${inIds} AND t.status IN ('open', 'in_progress')
         AND (t.priority IN ('high', 'critical') OR t.type = 'avvik' OR (t.due_date IS NOT NULL AND t.due_date < ?))
       ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, t.due_date IS NULL, t.due_date LIMIT 25`,
      orgId,
      ids,
      today,
    ),
  ]);

  const comps = new Map(compRows.map((r) => [r.building_id, r]));
  const tasks = new Map(taskRows.map((r) => [r.building_id, r]));
  const docs = new Map<string, Record<string, number>>();
  for (const d of docRows) {
    const m = docs.get(d.building_id) ?? {};
    m[d.kind] = d.n;
    docs.set(d.building_id, m);
  }

  const result: BuildingAnalysis[] = buildings.map((b) => {
    const c: Record<string, unknown> = comps.get(b.id) ?? {};
    const t: Record<string, unknown> = tasks.get(b.id) ?? {};
    const byKind = docs.get(b.id) ?? {};
    const components = {
      total: n(c.total),
      service_overdue: n(c.service_overdue),
      service_due_soon: n(c.service_due_soon),
      without_interval: n(c.without_interval),
      tg2: n(c.tg2),
      tg3: n(c.tg3),
      warranty_expiring: n(c.warranty_expiring),
      without_documents: n(c.without_documents),
    };
    const taskStats = { open: n(t.open), open_deviations: n(t.open_deviations), overdue: n(t.overdue), urgent: n(t.urgent) };
    const docTotal = Object.values(byKind).reduce((s, v) => s + v, 0);
    const coverage = components.total ? Math.round(((components.total - components.without_documents) / components.total) * 100) : null;

    const findings: string[] = [];
    if (components.service_overdue) findings.push(`${components.service_overdue} komponent${components.service_overdue === 1 ? "" : "er"} har forfalt service`);
    if (components.tg3) findings.push(`${components.tg3} komponent${components.tg3 === 1 ? "" : "er"} med TG3 (store eller alvorlige avvik)`);
    if (taskStats.open_deviations) findings.push(`${taskStats.open_deviations} ${taskStats.open_deviations === 1 ? "åpent" : "åpne"} avvik`);
    if (taskStats.overdue) findings.push(`${taskStats.overdue} oppgave${taskStats.overdue === 1 ? "" : "r"} over frist`);
    if (components.tg2) findings.push(`${components.tg2} komponent${components.tg2 === 1 ? "" : "er"} med TG2`);
    if (!byKind.fdv && docTotal === 0) findings.push("Ingen dokumenter er registrert på bygget");
    else if (!byKind.fdv) findings.push("Mangler FDV-dokumentasjon");
    if (components.total === 0) findings.push("FDV-registeret er tomt for dette bygget");
    else if (coverage != null && coverage < 50) findings.push(`Bare ${coverage} % av komponentene har dokumentasjon`);
    if (components.without_interval && components.total) findings.push(`${components.without_interval} komponent${components.without_interval === 1 ? "" : "er"} uten serviceintervall`);
    if (components.warranty_expiring) findings.push(`Garantien utløper innen et halvt år for ${components.warranty_expiring} komponent${components.warranty_expiring === 1 ? "" : "er"}`);

    const risk =
      components.service_overdue * 3 +
      components.tg3 * 5 +
      components.tg2 * 2 +
      taskStats.open_deviations * 3 +
      taskStats.overdue * 2 +
      taskStats.urgent * 2 +
      (byKind.fdv ? 0 : 4) +
      (coverage != null && coverage < 50 ? 3 : 0);

    return {
      id: b.id,
      name: b.name,
      property_id: b.property_id,
      property_name: b.property_name,
      year_built: b.year_built,
      risk_score: risk,
      components,
      tasks: taskStats,
      documents: { total: docTotal, by_kind: byKind },
      documentation_coverage: coverage,
      findings,
    };
  });
  result.sort((a, b) => b.risk_score - a.risk_score || a.name.localeCompare(b.name, "nb"));

  const sum = (fn: (b: BuildingAnalysis) => number) => result.reduce((s, b) => s + fn(b), 0);
  return {
    generated_on: today,
    horizon_days: horizon,
    totals: {
      buildings: result.length,
      components: sum((b) => b.components.total),
      service_overdue: sum((b) => b.components.service_overdue),
      service_due_soon: sum((b) => b.components.service_due_soon),
      tg3: sum((b) => b.components.tg3),
      open_tasks: sum((b) => b.tasks.open),
      open_deviations: sum((b) => b.tasks.open_deviations),
      documents: sum((b) => b.documents.total),
    },
    buildings: result,
    overdue_components: overdue,
    urgent_tasks: urgent,
  };
}
