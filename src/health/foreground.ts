import { z } from "zod";
import { openRuntimeDatabaseReadOnly } from "../runtime/database.js";

export const foregroundHealthPolicy = {
  failureWindowMilliseconds: 15 * 60_000,
  recoveryQuietMilliseconds: 10 * 60_000,
  recoverySuccessCount: 5
} as const;

/** Current health is independent of the six-hour/lifetime audit counters.
 * Collapse client/worker observations of one event conservatively; cancellation
 * is neutral and an empty short-circuit is not evidence of full-path recovery.
 */
export async function inspectForegroundHealth(runtimeRoot: string, now: string) {
  const nowMs = Date.parse(z.iso.datetime().parse(now));
  const database = await openRuntimeDatabaseReadOnly(runtimeRoot);
  try {
    const rows = z.array(z.object({ at: z.string(), failed: z.number(), succeeded: z.number() })).parse(database.prepare(`
      SELECT MAX(created_at) AS at,
        MAX(CASE WHEN outcome IN ('deadline_exceeded','failed','unavailable','busy')
          OR post_deadline_work_ms > 0 THEN 1 ELSE 0 END) AS failed,
        MAX(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) AS succeeded
      FROM foreground_attempts WHERE created_at <= ?
      GROUP BY COALESCE(event_kind || ':' || event_id, 'request:' || request_id)
      ORDER BY at
    `).all(now));
    const overflow = z.array(z.object({ at: z.string(), n: z.number() })).parse(database.prepare(`
      SELECT bucket_at AS at, SUM(occurrence_count) AS n FROM foreground_attempt_overflow
      WHERE outcome IN ('deadline_exceeded','failed','unavailable','busy') AND bucket_at <= ?
      GROUP BY bucket_at
    `).all(now));
    const failures = rows.filter(row => row.failed === 1);
    const lastFailureAt = [...failures.map(row => row.at), ...overflow.map(row => row.at)].sort().at(-1) ?? null;
    const recent = rows.filter(row => Date.parse(row.at) >= nowMs - foregroundHealthPolicy.failureWindowMilliseconds);
    const recentFailureCount = recent.filter(row => row.failed === 1).length + overflow
      .filter(row => Date.parse(row.at) >= nowMs - foregroundHealthPolicy.failureWindowMilliseconds)
      .reduce((sum, row) => sum + row.n, 0);
    const successSinceFailure = rows.filter(row => row.failed === 0 && row.succeeded === 1 &&
      (lastFailureAt === null || row.at > lastFailureAt)).length;
    const quietUntil = lastFailureAt === null ? null :
      new Date(Date.parse(lastFailureAt) + foregroundHealthPolicy.recoveryQuietMilliseconds).toISOString();
    const recovered = quietUntil !== null && now >= quietUntil &&
      successSinceFailure >= foregroundHealthPolicy.recoverySuccessCount;
    const sustained = recentFailureCount >= 3 ||
      (recent.length >= 20 && recentFailureCount / recent.length >= 0.02);
    const state = lastFailureAt === null ? "healthy" : recovered ? "recovered" :
      sustained ? "degraded" : quietUntil !== null && now < quietUntil ? "recovering" : "awaiting_verification";
    return {
      state, lastFailureAt, recentFailureCount, successSinceFailure, quietUntil,
      recoveryCondition: "No new failure for 10 minutes and at least 5 completed logical requests after the last failure. Empty/cancelled results do not prove recovery.",
      severity: state === "degraded" ? "warning" as const :
        state === "healthy" || state === "recovered" ? "ok" as const : "info" as const
    };
  } finally { database.close(); }
}
