import type { Env } from "../env";
import { newId, now } from "./util";

export interface ActivityInput {
  orgId: string;
  actor: { type: "user" | "agent" | "system"; id?: string | null; name?: string | null };
  action: string;
  entityType?: string;
  entityId?: string;
  summary?: string;
}

export function activityStatement(env: Env, a: ActivityInput): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO activity (id, org_id, actor_type, actor_id, actor_name, action, entity_type, entity_id, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    newId("act"),
    a.orgId,
    a.actor.type,
    a.actor.id ?? null,
    a.actor.name ?? null,
    a.action,
    a.entityType ?? null,
    a.entityId ?? null,
    a.summary ?? null,
    now(),
  );
}

export async function logActivity(env: Env, a: ActivityInput): Promise<void> {
  try {
    await activityStatement(env, a).run();
  } catch (err) {
    console.error("Kunne ikke logge aktivitet", err);
  }
}
