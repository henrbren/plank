import type { Env } from "../env";
import { activityStatement } from "../lib/activity";
import { addUsage } from "../lib/anthropic";
import { all, first } from "../lib/db";
import { emailConfigured, emailLayout, sendEmail } from "../lib/email";
import { escapeHtml, newId, now, parseJson, truncate } from "../lib/util";
import { runTurn } from "./runtime";
import { nextRunAt } from "./schedule";
import { renderEmailMarkdown, type AgentRow } from "./tools";

/** Kalles av cron-trigger: kjører agenter som har forfalt tidsplan */
export async function runDueAgents(env: Env): Promise<void> {
  if (!env.ANTHROPIC_API_KEY) return;
  const t = now();
  const due = await all<AgentRow & { schedule: string; next_run_at: number }>(
    env.DB,
    `SELECT * FROM agents WHERE archived = 0 AND schedule IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 3`,
    t,
  );
  for (const agent of due) {
    // Optimistisk lås: bare én kjøring vinner
    const claim = await env.DB.prepare(`UPDATE agents SET next_run_at = ?, last_run_at = ? WHERE id = ? AND next_run_at = ?`)
      .bind(nextRunAt(agent.schedule, t), t, agent.id, agent.next_run_at)
      .run();
    if (!claim.meta.changes) continue;
    await runScheduledAgent(env, agent, "schedule");
  }
}

export async function runScheduledAgent(env: Env, agent: AgentRow & { schedule?: string | null }, trigger: "schedule" | "manual"): Promise<string> {
  const t = now();
  const date = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(t));
  const conversationId = newId("cnv");
  const runId = newId("run");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO conversations (id, org_id, agent_id, user_id, title, model, source, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, 'schedule', ?, ?)`).bind(
      conversationId,
      agent.org_id,
      agent.id,
      `Planlagt kjøring ${date}`,
      agent.model,
      t,
      t,
    ),
    env.DB.prepare(`INSERT INTO agent_runs (id, org_id, agent_id, conversation_id, trigger, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)`).bind(
      runId,
      agent.org_id,
      agent.id,
      conversationId,
      trigger,
      t,
    ),
  ]);

  const prompt = agent.schedule_prompt?.trim() || "Gå gjennom ansvarsområdet ditt og rapporter kort hva som bør følges opp.";
  try {
    const result = await runTurn({
      env,
      orgId: agent.org_id,
      agent,
      conversationId,
      user: null,
      text: prompt,
      scheduled: true,
      emit: () => undefined,
    });
    const summary = result.finalText || "(Ingen oppsummering)";
    await env.DB.batch([
      env.DB.prepare(`UPDATE agent_runs SET status = 'done', summary = ?, usage = ?, finished_at = ? WHERE id = ?`).bind(
        truncate(summary, 8000),
        JSON.stringify(addUsage({}, result.usage)),
        now(),
        runId,
      ),
      activityStatement(env, {
        orgId: agent.org_id,
        actor: { type: "agent", id: agent.id, name: agent.name },
        action: "agent.run",
        entityType: "conversation",
        entityId: conversationId,
        summary: `Planlagt kjøring fullført (${result.toolCalls} verktøykall)`,
      }),
    ]);

    const recipients = parseJson<string[]>(agent.notify_emails, []);
    if (recipients.length && emailConfigured(env)) {
      const base = env.APP_URL.replace(/\/$/, "");
      await sendEmail(env, {
        to: recipients,
        subject: `${agent.name}: rapport ${date}`,
        html: emailLayout({
          title: `${escapeHtml(agent.name)} – rapport`,
          bodyHtml: await renderEmailMarkdown(env, agent.org_id, summary),
          cta: { label: "Åpne i Plank", url: `${base}/o/${agent.org_id}/conversations/${conversationId}` },
          footer: "Du får denne e-posten fordi du står på varslingslisten til agenten i Plank.",
        }),
        idempotencyKey: runId,
      });
    }
  } catch (err) {
    console.error("Planlagt kjøring feilet", agent.id, err);
    await env.DB.prepare(`UPDATE agent_runs SET status = 'error', error = ?, finished_at = ? WHERE id = ?`)
      .bind(String((err as Error)?.message ?? err).slice(0, 1000), now(), runId)
      .run();
  }
  return runId;
}

export async function getRun(env: Env, orgId: string, runId: string) {
  return first(env.DB, `SELECT * FROM agent_runs WHERE id = ? AND org_id = ?`, runId, orgId);
}
