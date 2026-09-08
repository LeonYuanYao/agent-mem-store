import { openRuntimeDatabaseReadOnly } from "../runtime/database.js";

export const indexCooldownMilliseconds = 5 * 60_000;

/** Shared scheduler/health decision, with a fixed end to each waiting period. */
export async function inspectIndexWait(runtimeRoot: string, now: string) {
  const database = await openRuntimeDatabaseReadOnly(runtimeRoot);
  try {
    const activity = database.prepare("SELECT state, started_at, completed_at FROM retrieval_index_build_activity WHERE singleton = 1").get();
    let reason = "ready";
    let until: string | null = null;
    if (activity?.state === "building" && typeof activity.started_at === "string") {
      reason = "building";
      until = new Date(Date.parse(activity.started_at) + indexCooldownMilliseconds).toISOString();
    } else if (typeof activity?.completed_at === "string") {
      if (activity.state === "failed") reason = "failure_cooldown";
      if (activity.state === "complete") {
        const backlog = database.prepare(`SELECT
          EXISTS(SELECT 1 FROM luna_operations WHERE state IN ('pending','processing','retrying','blocked')) OR
          EXISTS(SELECT 1 FROM memory_candidates WHERE state = 'waiting' AND successful_evaluation_at IS NULL) OR
          EXISTS(SELECT 1 FROM capture_events WHERE state IN ('pending','processing','retrying')) AS present`).get();
        if (backlog?.present === 1) reason = "backlog_coalescing";
      }
      if (reason !== "ready") until = new Date(Date.parse(activity.completed_at) + indexCooldownMilliseconds).toISOString();
    }
    return { reason, until, waiting: until !== null && Date.parse(now) < Date.parse(until) };
  } finally { database.close(); }
}
