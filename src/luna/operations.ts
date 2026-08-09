import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { openRuntimeDatabase } from "../runtime/database.js";
import type {
  LunaInvocationError,
  LunaFailureCategory
} from "./index.js";

const operationKindSchema = z.enum([
  "distill_batch",
  "consolidate_session",
  "semantic_assessment",
  "conflict_assessment"
]);
const operationStateSchema = z.enum([
  "pending",
  "processing",
  "retrying",
  "blocked",
  "completed",
  "dead_letter"
]);
const healthStateSchema = z.enum(["healthy", "degraded", "unavailable"]);

export type LunaOperationKind = z.infer<typeof operationKindSchema>;

export interface EnqueueLunaOperationRequest {
  readonly runtimeRoot: string;
  readonly kind: LunaOperationKind;
  readonly idempotencyKey: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface LunaOperationView {
  readonly operationId: string;
  readonly kind: LunaOperationKind;
  readonly state:
    | "queued"
    | "processing"
    | "retrying"
    | "blocked"
    | "completed"
    | "dead_letter";
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly payload: unknown;
  readonly attemptCount: number;
  readonly createdAt: string;
}

function viewState(
  state: z.infer<typeof operationStateSchema>
): LunaOperationView["state"] {
  return state === "pending" ? "queued" : state;
}

function parseOperationRow(row: Record<string, unknown>): LunaOperationView {
  const operationId = z.string().min(1).parse(row.operation_id);
  const kind = operationKindSchema.parse(row.operation_kind);
  const state = operationStateSchema.parse(row.state);
  const projectId = z.string().nullable().parse(row.project_id);
  const sessionId = z.string().nullable().parse(row.session_id);
  const payloadSource = z.string().parse(row.payload_json);
  const payloadSha256 = z.string().regex(/^[0-9a-f]{64}$/u).parse(row.payload_sha256);
  if (createHash("sha256").update(payloadSource).digest("hex") !== payloadSha256) {
    throw new Error("Luna operation payload integrity check failed.");
  }
  return {
    operationId,
    kind,
    state: viewState(state),
    projectId,
    sessionId,
    payload: JSON.parse(payloadSource) as unknown,
    attemptCount: z.number().int().nonnegative().parse(row.attempt_count),
    createdAt: z.iso.datetime().parse(row.created_at)
  };
}

export async function enqueueLunaOperation(
  request: EnqueueLunaOperationRequest
): Promise<LunaOperationView> {
  const kind = operationKindSchema.parse(request.kind);
  const createdAt = z.iso.datetime().parse(request.createdAt);
  const idempotencyKey = z.string().min(1).max(512).parse(request.idempotencyKey);
  const payloadSource = JSON.stringify(request.payload);
  if (Buffer.byteLength(payloadSource) > 1024 * 1024) {
    throw new Error("Luna operation payload exceeds the one MiB limit.");
  }
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database
      .prepare(
        `INSERT OR IGNORE INTO luna_operations(
           operation_id, operation_kind, idempotency_key, project_id,
           session_id, payload_json, payload_sha256, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(
        `msop_${randomUUID()}`,
        kind,
        idempotencyKey,
        request.projectId ?? null,
        request.sessionId ?? null,
        payloadSource,
        createHash("sha256").update(payloadSource).digest("hex"),
        createdAt,
        createdAt
      );
    const row = database
      .prepare("SELECT * FROM luna_operations WHERE idempotency_key = ?")
      .get(idempotencyKey);
    if (row === undefined) throw new Error("Luna operation enqueue failed.");
    return parseOperationRow(row);
  } finally {
    database.close();
  }
}

export interface ClaimLunaOperationRequest {
  readonly runtimeRoot: string;
  readonly workerId: string;
  readonly now: string;
  readonly leaseSeconds: number;
  readonly kinds?: readonly LunaOperationKind[];
}

export type ClaimLunaOperationResult =
  | { readonly state: "empty" }
  | {
      readonly state: "claimed";
      readonly operation: LunaOperationView;
      readonly leaseToken: string;
    };

export async function claimLunaOperation(
  request: ClaimLunaOperationRequest
): Promise<ClaimLunaOperationResult> {
  const now = z.iso.datetime().parse(request.now);
  if (!Number.isInteger(request.leaseSeconds) || request.leaseSeconds <= 0) {
    throw new Error("leaseSeconds must be a positive integer.");
  }
  const leaseUntil = new Date(
    Date.parse(now) + request.leaseSeconds * 1000
  ).toISOString();
  const kinds = request.kinds?.map((kind) => operationKindSchema.parse(kind));
  if (kinds !== undefined && kinds.length === 0) {
    throw new Error("Operation kind filter cannot be empty.");
  }
  const kindFilter =
    kinds === undefined
      ? ""
      : ` AND operation_kind IN (${kinds.map(() => "?").join(", ")})`;
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = database
        .prepare(
          `SELECT * FROM luna_operations
           WHERE (
             state = 'pending'
             OR (state = 'retrying' AND next_retry_at <= ?)
             OR (state = 'processing' AND lease_until < ?)
           )${kindFilter}
           ORDER BY created_at ASC LIMIT 1`
        )
        .get(now, now, ...(kinds ?? []));
      if (row === undefined) {
        database.exec("COMMIT");
        return { state: "empty" };
      }
      const operation = parseOperationRow(row);
      const leaseToken = `mslease_${randomUUID()}`;
      database
        .prepare(
          `UPDATE luna_operations
           SET state = 'processing', attempt_count = attempt_count + 1,
               lease_token = ?, leased_by = ?, lease_until = ?, updated_at = ?
           WHERE operation_id = ?`
        )
        .run(
          leaseToken,
          request.workerId,
          leaseUntil,
          now,
          operation.operationId
        );
      database.exec("COMMIT");
      return {
        state: "claimed",
        operation: {
          ...operation,
          state: "processing",
          attemptCount: operation.attemptCount + 1
        },
        leaseToken
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

const retrySeconds = [30, 60, 120, 240, 480, 900] as const;

function calculateRetryAt(
  operationId: string,
  attemptCount: number,
  failedAt: string
): string {
  const base = retrySeconds[Math.min(attemptCount - 1, retrySeconds.length - 1)] ?? 1800;
  const digest = createHash("sha256")
    .update(`${operationId}:${String(attemptCount)}`)
    .digest();
  const jitter = 0.9 + (digest[0] ?? 128) / 2550;
  return new Date(Date.parse(failedAt) + Math.round(base * jitter) * 1000).toISOString();
}

function immediateUnavailable(category: LunaFailureCategory): boolean {
  return (
    category === "authentication" ||
    category === "invalid_model" ||
    category === "invalid_configuration"
  );
}

function updateHealthForFailure(
  database: Awaited<ReturnType<typeof openRuntimeDatabase>>,
  category: LunaFailureCategory,
  failedAt: string,
  nextRetryAt: string | null
): void {
  const row = database
    .prepare("SELECT * FROM luna_health_state WHERE singleton = 1")
    .get();
  if (row === undefined) throw new Error("Luna health state is missing.");
  const previousState = healthStateSchema.parse(row.state);
  const consecutiveFailures =
    z.number().int().nonnegative().parse(row.consecutive_failures) + 1;
  const schemaInvalidFailures =
    (category === "schema_invalid"
      ? z.number().int().nonnegative().parse(row.schema_invalid_failures) + 1
      : 0);
  const firstFailureAt =
    typeof row.first_failure_at === "string" ? row.first_failure_at : failedAt;
  const failureSpan = Date.parse(failedAt) - Date.parse(firstFailureAt);
  const nextState = immediateUnavailable(category) ||
    schemaInvalidFailures >= 5 ||
    failureSpan >= 30 * 60 * 1000
    ? "unavailable"
    : consecutiveFailures >= 3 && failureSpan >= 2 * 60 * 1000
      ? "degraded"
      : previousState;
  let activeIncidentId =
    typeof row.active_incident_id === "string" ? row.active_incident_id : null;
  if (nextState !== "healthy" && nextState !== previousState) {
    if (activeIncidentId === null) {
      activeIncidentId = `msmodelincident_${randomUUID()}`;
      database
        .prepare(
          `INSERT INTO model_health_incidents(
             incident_id, state, reason_category, started_at, last_failure_at
           ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(activeIncidentId, nextState, category, firstFailureAt, failedAt);
    } else {
      database
        .prepare(
          `UPDATE model_health_incidents
           SET state = ?, reason_category = ?, last_failure_at = ?,
               transition_count = transition_count + 1, notification_pending = 1
           WHERE incident_id = ?`
        )
        .run(nextState, category, failedAt, activeIncidentId);
    }
  } else if (activeIncidentId !== null) {
    database
      .prepare(
        `UPDATE model_health_incidents
         SET reason_category = ?, last_failure_at = ? WHERE incident_id = ?`
      )
      .run(category, failedAt, activeIncidentId);
  }
  database
    .prepare(
      `UPDATE luna_health_state
       SET state = ?, reason_category = ?, consecutive_failures = ?,
           schema_invalid_failures = ?, first_failure_at = ?,
           last_failure_at = ?, successful_probe_at = NULL,
           next_retry_at = ?, active_incident_id = ?
       WHERE singleton = 1`
    )
    .run(
      nextState,
      category,
      consecutiveFailures,
      schemaInvalidFailures,
      firstFailureAt,
      failedAt,
      nextRetryAt,
      activeIncidentId
    );
}

function updateHealthForSuccess(
  database: Awaited<ReturnType<typeof openRuntimeDatabase>>,
  completedAt: string
): void {
  const health = database
    .prepare("SELECT * FROM luna_health_state WHERE singleton = 1")
    .get();
  if (health === undefined) throw new Error("Luna health state is missing.");
  const currentState = healthStateSchema.parse(health.state);
  const lastFailureAt =
    typeof health.last_failure_at === "string" ? health.last_failure_at : null;
  const probeAt =
    typeof health.successful_probe_at === "string"
      ? health.successful_probe_at
      : null;
  const canRecover =
    currentState !== "healthy" &&
    probeAt !== null &&
    (lastFailureAt === null || Date.parse(probeAt) >= Date.parse(lastFailureAt));
  if (canRecover) {
    const incidentId =
      typeof health.active_incident_id === "string"
        ? health.active_incident_id
        : null;
    if (incidentId !== null) {
      database
        .prepare(
          `UPDATE model_health_incidents
           SET state = 'recovered', ended_at = ?, notification_pending = 1
           WHERE incident_id = ?`
        )
        .run(completedAt, incidentId);
    }
    database
      .prepare(
        `UPDATE luna_health_state
         SET state = 'healthy', reason_category = NULL,
             consecutive_failures = 0, schema_invalid_failures = 0,
             first_failure_at = NULL, last_success_at = ?,
             successful_probe_at = NULL, next_retry_at = NULL,
             active_incident_id = NULL WHERE singleton = 1`
      )
      .run(completedAt);
  } else {
    database
      .prepare("UPDATE luna_health_state SET last_success_at = ? WHERE singleton = 1")
      .run(completedAt);
  }
}

export async function recordLunaWorkFailure(request: {
  readonly runtimeRoot: string;
  readonly workId: string;
  readonly attemptCount: number;
  readonly failedAt: string;
  readonly error: LunaInvocationError;
}): Promise<{ readonly state: "retrying" | "blocked"; readonly nextRetryAt: string | null }> {
  const failedAt = z.iso.datetime().parse(request.failedAt);
  const attemptCount = z.number().int().positive().parse(request.attemptCount);
  const nextRetryAt = request.error.retryable
    ? calculateRetryAt(z.string().min(1).parse(request.workId), attemptCount, failedAt)
    : null;
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      updateHealthForFailure(database, request.error.category, failedAt, nextRetryAt);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
  return { state: request.error.retryable ? "retrying" : "blocked", nextRetryAt };
}

export async function recordLunaWorkSuccess(request: {
  readonly runtimeRoot: string;
  readonly completedAt: string;
}): Promise<void> {
  const completedAt = z.iso.datetime().parse(request.completedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      updateHealthForSuccess(database, completedAt);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export interface FailLunaOperationRequest {
  readonly runtimeRoot: string;
  readonly operationId: string;
  readonly leaseToken: string;
  readonly failedAt: string;
  readonly error: LunaInvocationError;
  readonly retryAfter?: string;
}

export interface FailLunaOperationResult {
  readonly state: "retrying" | "blocked";
  readonly operationId: string;
  readonly nextRetryAt: string | null;
}

export async function failLunaOperation(
  request: FailLunaOperationRequest
): Promise<FailLunaOperationResult> {
  const failedAt = z.iso.datetime().parse(request.failedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = database
        .prepare(
          `SELECT attempt_count FROM luna_operations
           WHERE operation_id = ? AND state = 'processing' AND lease_token = ?`
        )
        .get(request.operationId, request.leaseToken);
      if (row === undefined) throw new Error("Luna operation lease is not owned.");
      const attemptCount = z.number().int().positive().parse(row.attempt_count);
      const blocked = !request.error.retryable;
      const nextRetryAt = blocked
        ? null
        : request.retryAfter === undefined
          ? calculateRetryAt(request.operationId, attemptCount, failedAt)
          : z.iso.datetime().parse(request.retryAfter);
      database
        .prepare(
          `UPDATE luna_operations
           SET state = ?, lease_token = NULL, leased_by = NULL, lease_until = NULL,
               next_retry_at = ?, last_error_category = ?, updated_at = ?
           WHERE operation_id = ?`
        )
        .run(
          blocked ? "blocked" : "retrying",
          nextRetryAt,
          request.error.category,
          failedAt,
          request.operationId
        );
      updateHealthForFailure(
        database,
        request.error.category,
        failedAt,
        nextRetryAt
      );
      database.exec("COMMIT");
      return {
        state: blocked ? "blocked" : "retrying",
        operationId: request.operationId,
        nextRetryAt
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function failLunaOperationLocally(request: {
  readonly runtimeRoot: string;
  readonly operationId: string;
  readonly leaseToken: string;
  readonly failedAt: string;
  readonly retryable: boolean;
}): Promise<FailLunaOperationResult> {
  const failedAt = z.iso.datetime().parse(request.failedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    const row = database.prepare(
      `SELECT attempt_count FROM luna_operations
       WHERE operation_id = ? AND state = 'processing' AND lease_token = ?`
    ).get(request.operationId, request.leaseToken);
    if (row === undefined) throw new Error("Luna operation lease is not owned.");
    const attemptCount = z.number().int().positive().parse(row.attempt_count);
    const nextRetryAt = request.retryable
      ? calculateRetryAt(request.operationId, attemptCount, failedAt)
      : null;
    database.prepare(
      `UPDATE luna_operations
       SET state = ?, lease_token = NULL, leased_by = NULL, lease_until = NULL,
           next_retry_at = ?, last_error_category = 'local_processing',
           updated_at = ? WHERE operation_id = ?`
    ).run(
      request.retryable ? "retrying" : "blocked",
      nextRetryAt,
      failedAt,
      request.operationId
    );
    database.exec("COMMIT");
    return {
      state: request.retryable ? "retrying" : "blocked",
      operationId: request.operationId,
      nextRetryAt
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

export async function retryBlockedLunaOperations(request: {
  readonly runtimeRoot: string;
  readonly requestedAt: string;
}): Promise<{ readonly state: "queued"; readonly operationCount: number }> {
  const requestedAt = z.iso.datetime().parse(request.requestedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const result = database
      .prepare(
        `UPDATE luna_operations
         SET state = 'pending', next_retry_at = NULL, updated_at = ?
         WHERE state = 'blocked'`
      )
      .run(requestedAt);
    return { state: "queued", operationCount: Number(result.changes) };
  } finally {
    database.close();
  }
}

export async function recordLunaHealthProbe(request: {
  readonly runtimeRoot: string;
  readonly succeededAt: string;
}): Promise<void> {
  const succeededAt = z.iso.datetime().parse(request.succeededAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database
      .prepare(
        `UPDATE luna_health_state SET successful_probe_at = ? WHERE singleton = 1`
      )
      .run(succeededAt);
  } finally {
    database.close();
  }
}

export async function completeLunaOperation(request: {
  readonly runtimeRoot: string;
  readonly operationId: string;
  readonly leaseToken: string;
  readonly completedAt: string;
}): Promise<{ readonly state: "completed"; readonly operationId: string }> {
  const completedAt = z.iso.datetime().parse(request.completedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const operation = database
        .prepare(
          `SELECT operation_id FROM luna_operations
           WHERE operation_id = ? AND state = 'processing' AND lease_token = ?`
        )
        .get(request.operationId, request.leaseToken);
      if (operation === undefined) throw new Error("Luna operation lease is not owned.");
      database
        .prepare(
          `UPDATE luna_operations
           SET state = 'completed', lease_token = NULL, leased_by = NULL,
               lease_until = NULL, next_retry_at = NULL, completed_at = ?,
               updated_at = ? WHERE operation_id = ?`
        )
        .run(completedAt, completedAt, request.operationId);
      updateHealthForSuccess(database, completedAt);
      database.exec("COMMIT");
      return { state: "completed", operationId: request.operationId };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export interface LunaHealthView {
  readonly state: "healthy" | "degraded" | "unavailable";
  readonly reasonCategory: string | null;
  readonly consecutiveFailures: number;
  readonly lastFailureAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly nextRetryAt: string | null;
  readonly pendingOperationCount: number;
  readonly oldestBacklogAgeSeconds: number | null;
}

export async function inspectLunaHealth(request: {
  readonly runtimeRoot: string;
  readonly now: string;
}): Promise<LunaHealthView> {
  const now = z.iso.datetime().parse(request.now);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const health = database
      .prepare("SELECT * FROM luna_health_state WHERE singleton = 1")
      .get();
    const backlog = database
      .prepare(
        `SELECT COUNT(*) AS pending_count, MIN(created_at) AS oldest_at
         FROM luna_operations WHERE state IN ('pending', 'processing', 'retrying', 'blocked')`
      )
      .get();
    if (health === undefined || backlog === undefined) {
      throw new Error("Luna health state is unavailable.");
    }
    const oldestAt = typeof backlog.oldest_at === "string" ? backlog.oldest_at : null;
    return {
      state: healthStateSchema.parse(health.state),
      reasonCategory:
        typeof health.reason_category === "string" ? health.reason_category : null,
      consecutiveFailures: z
        .number()
        .int()
        .nonnegative()
        .parse(health.consecutive_failures),
      lastFailureAt:
        typeof health.last_failure_at === "string" ? health.last_failure_at : null,
      lastSuccessAt:
        typeof health.last_success_at === "string" ? health.last_success_at : null,
      nextRetryAt:
        typeof health.next_retry_at === "string" ? health.next_retry_at : null,
      pendingOperationCount: z
        .number()
        .int()
        .nonnegative()
        .parse(backlog.pending_count),
      oldestBacklogAgeSeconds:
        oldestAt === null
          ? null
          : Math.max(0, Math.floor((Date.parse(now) - Date.parse(oldestAt)) / 1000))
    };
  } finally {
    database.close();
  }
}
