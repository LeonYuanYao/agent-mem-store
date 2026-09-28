import { createHash } from "node:crypto";

export const connectionRecoveryCooldownMilliseconds = 6 * 60 * 60 * 1_000;
export const maximumConnectionRecoveryAttempts = 2;

export type ModelWorkTable = "luna_operations" | "memory_quality_items" | "memory_duplicate_clusters" | "governance_runs";

export function recoveryEvidenceSql(table: ModelWorkTable): string {
  return `EXISTS (
  SELECT 1 FROM luna_health_state AS health
  WHERE health.singleton = 1 AND health.state = 'healthy'
    AND health.last_success_at > ${table}.updated_at
)`;
}
export const modelRecoveryEvidenceSql = recoveryEvidenceSql("luna_operations");

// Shared by the queue and doctor; this is static SQL, never user input.
export function recoveryCandidateSql(table: ModelWorkTable): string {
  const attempts = table === "governance_runs" ? "consecutive_failure_count" : "epoch_attempt_count";
  return `
  ${table}.state = 'blocked'
  AND (
    (${table}.last_error_category = 'authentication' AND ${table}.${attempts} >= 1)
    OR (${table}.last_error_category IN ('timeout', 'unavailable', 'rate_limited')
        AND (${table}.${attempts} >= 7 OR ${table}.connection_recovery_count > 0))
  )
  AND ${table}.connection_recovery_count < ${String(maximumConnectionRecoveryAttempts)}
`;
}
export const connectionRecoveryCandidateSql = recoveryCandidateSql("luna_operations");

export function dueRecoverySql(table: ModelWorkTable): string {
  return `(${recoveryCandidateSql(table)} AND ${table}.updated_at <= ? AND ${recoveryEvidenceSql(table)})`;
}

export function recoveryBefore(now: string): string {
  return new Date(Date.parse(now) - connectionRecoveryCooldownMilliseconds).toISOString();
}

const retrySeconds = [30, 60, 120, 240, 480, 900];
export function modelRetryDecision(request: {
  readonly workId: string;
  readonly attemptCount: number;
  readonly recoveryCount?: number;
  readonly failedAt: string;
  readonly retryable: boolean;
}): { readonly state: "retrying" | "blocked"; readonly nextRetryAt: string | null } {
  if (!request.retryable || (request.recoveryCount ?? 0) > 0 || request.attemptCount > retrySeconds.length) {
    return { state: "blocked", nextRetryAt: null };
  }
  const base = retrySeconds[Math.max(0, request.attemptCount - 1)] ?? 900;
  const digest = createHash("sha256").update(`${request.workId}:${String(request.attemptCount)}`).digest();
  const jitter = 0.9 + (digest[0] ?? 128) / 2550;
  return { state: "retrying", nextRetryAt: new Date(Date.parse(request.failedAt) + Math.round(base * jitter) * 1000).toISOString() };
}
