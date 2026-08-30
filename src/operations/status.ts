import { access } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import {
  inspectMemoryWorkingSetGeneration,
  inspectMemoryCapacity,
  loadMemoryCapacityPolicy
} from "../capacity/index.js";
import { MemStoreCommandError } from "../contracts/envelope.js";
import { inspectHookSqliteBusyDiagnostics } from "../capture/index.js";
import { inspectCaptureInbox } from "../capture/inbox.js";
import { inspectForegroundAttempts } from "../retrieval/foreground-attempts.js";
import { inspectRetrievalCatalogGeneration } from "../retrieval/index-coordinator.js";
import { foregroundRetrievalSocketPath } from "../retrieval/foreground-protocol.js";
import { loadArchiveRetentionMonths } from "../lifecycle/archive-retention.js";

async function databasePath(runtimeRoot: string): Promise<string> {
  const path = join(runtimeRoot, "state", "memstore.sqlite");
  try {
    await access(path);
    return path;
  } catch {
    throw new MemStoreCommandError("runtime_uninitialized", "MemStore Runtime is not initialized.");
  }
}

async function foregroundEndpointAcceptsConnections(runtimeRoot: string): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    const socket = createConnection(foregroundRetrievalSocketPath(runtimeRoot));
    const finish = (available: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(available);
    };
    const timer = setTimeout(() => { finish(false); }, 50);
    socket.once("connect", () => { finish(true); });
    socket.once("error", () => { finish(false); });
  });
}

export async function inspectOperation(runtimeRoot: string, operationId: string) {
  const database = new DatabaseSync(await databasePath(runtimeRoot), { readOnly: true });
  try {
    const human = database.prepare(
      "SELECT * FROM human_memory_operations WHERE operation_id = ?"
    ).get(operationId);
    if (human !== undefined) {
      const rawState = z.string().parse(human.state);
      return {
        operation_id: operationId,
        kind: z.string().parse(human.operation_kind),
        state: rawState === "pending" ? "queued" : rawState,
        phase: rawState,
        memory_id: typeof human.memory_id === "string" ? human.memory_id : null,
        conflict_id: typeof human.conflict_id === "string" ? human.conflict_id : null,
        created_at: z.string().parse(human.created_at),
        completed_at: typeof human.completed_at === "string" ? human.completed_at : null
      };
    }
    const luna = database.prepare(
      "SELECT * FROM luna_operations WHERE operation_id = ?"
    ).get(operationId);
    if (luna === undefined) {
      throw new MemStoreCommandError("operation_not_found", "Operation does not exist.");
    }
    const rawState = z.string().parse(luna.state);
    const state = rawState === "pending" || rawState === "processing"
      ? "queued"
      : rawState;
    return {
      operation_id: operationId,
      kind: z.string().parse(luna.operation_kind),
      state,
      phase: rawState,
      attempt_count: z.number().int().nonnegative().parse(luna.attempt_count),
      retry_epoch: z.number().int().nonnegative().parse(luna.retry_epoch),
      epoch_attempt_count: z.number().int().nonnegative().parse(luna.epoch_attempt_count),
      project_id: typeof luna.project_id === "string" ? luna.project_id : null,
      session_id: typeof luna.session_id === "string" ? luna.session_id : null,
      next_retry_at: typeof luna.next_retry_at === "string" ? luna.next_retry_at : null,
      last_error_category: typeof luna.last_error_category === "string" ? luna.last_error_category : null,
      last_error_diagnostic: typeof luna.last_error_diagnostic_json === "string"
        ? JSON.parse(luna.last_error_diagnostic_json) as unknown
        : null,
      created_at: z.string().parse(luna.created_at),
      completed_at: typeof luna.completed_at === "string" ? luna.completed_at : null
    };
  } finally {
    database.close();
  }
}

export async function inspectStatus(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
}) {
  const memoryCapacityPolicy = await loadMemoryCapacityPolicy(request);
  const archiveRetentionMonths = await loadArchiveRetentionMonths(request);
  const hookSqliteBusy = await inspectHookSqliteBusyDiagnostics(request.runtimeRoot);
  const captureInbox = await inspectCaptureInbox(request.runtimeRoot);
  const [foregroundAttempts, catalogGeneration, foregroundSocketAvailable] = await Promise.all([
    inspectForegroundAttempts(request.runtimeRoot),
    inspectRetrievalCatalogGeneration(request.runtimeRoot),
    foregroundEndpointAcceptsConnections(request.runtimeRoot)
  ]);
  const workingSetGeneration = await inspectMemoryWorkingSetGeneration(request.runtimeRoot);
  const database = new DatabaseSync(await databasePath(request.runtimeRoot), { readOnly: true });
  try {
    const health = database.prepare("SELECT * FROM luna_health_state WHERE singleton = 1").get();
    const backlog = database.prepare(
      `SELECT COUNT(*) AS count,
              SUM(CASE WHEN state = 'blocked' THEN 1 ELSE 0 END) AS blocked_count
       FROM luna_operations
       WHERE state IN ('pending', 'processing', 'retrying', 'blocked')`
    ).get();
    const activeIndex = database.prepare(
      `SELECT r.index_revision_id, r.document_count, r.model_identity, r.adapter_version
       FROM active_retrieval_index a JOIN retrieval_index_revisions r
         ON r.index_revision_id = a.index_revision_id WHERE a.singleton = 1`
    ).get();
    const worker = database.prepare(
      "SELECT capture_paused, worker_paused, reason, updated_at FROM worker_control WHERE singleton = 1"
    ).get();
    const workerIncident = database.prepare(
      `SELECT started_at, occurrence_count, last_error_code
       FROM capture_health_incidents
       WHERE category = 'worker_loop' AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`
    ).get();
    const reminderCount = database.prepare(
      `SELECT COUNT(*) AS count FROM reminder_obligations
       WHERE state IN ('pending', 'delivering', 'failed', 'fallback', 'snoozed')`
    ).get();
    const reviewInbox = database.prepare(
      "SELECT generated_at, item_counts_json, path FROM review_inbox_state WHERE singleton = 1"
    ).get();
    const governance = database.prepare(
      `SELECT run_id, run_kind, state, current_phase, coverage_through
       FROM governance_runs
       WHERE state IN ('pending', 'processing', 'retrying', 'blocked')
       ORDER BY created_at LIMIT 1`
    ).get();
    const candidates = database.prepare(
      `SELECT COUNT(*) AS waiting_count,
              SUM(CASE WHEN successful_evaluation_at IS NULL THEN 1 ELSE 0 END)
                AS unevaluated_count,
              MIN(created_at) AS oldest_waiting_at
       FROM memory_candidates WHERE state = 'waiting'`
    ).get();
    const semanticAssessments = database.prepare(
      `SELECT COUNT(*) AS count FROM luna_operations
       WHERE operation_kind = 'semantic_assessment'
         AND state IN ('pending', 'processing', 'retrying', 'blocked')`
    ).get();
    const unbatchedCapture = database.prepare(
      `SELECT COUNT(*) AS count, MIN(capture.occurred_at) AS oldest_at
       FROM capture_events AS capture
       WHERE capture.state = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM distillation_batch_events AS assigned
           WHERE assigned.event_id = capture.event_id
         )`
    ).get();
    const activeOperationRows = database.prepare(
      `SELECT operation_kind, COUNT(*) AS active_count,
              SUM(CASE WHEN state = 'blocked' THEN 1 ELSE 0 END) AS blocked_count
       FROM luna_operations
       WHERE state IN ('pending', 'processing', 'retrying', 'blocked')
       GROUP BY operation_kind`
    ).all();
    const candidateBackfill = database.prepare(
      `SELECT state, scanned_candidate_count, reopened_candidate_count, updated_at
       FROM candidate_reevaluation_backfill WHERE singleton = 1`
    ).get();
    const archiveRetention = database.prepare(
      `SELECT next_check_at, last_checked_at, last_completed_at, last_error_code,
              consecutive_failure_count, backfill_completed_at
       FROM archive_retention_maintenance WHERE singleton = 1`
    ).get();
    const archiveCounts = database.prepare(
      `SELECT
         SUM(CASE WHEN lifecycle = 'archived' THEN 1 ELSE 0 END) AS archived_count,
         SUM(CASE WHEN lifecycle = 'tombstone' THEN 1 ELSE 0 END) AS tombstone_count
       FROM memory_catalog`
    ).get();
    const purgeRun = database.prepare(
      `SELECT run_id, state, started_at, completed_at, next_eligible_at,
              purged_count, removed_bytes, last_error_code
       FROM archive_purge_runs ORDER BY started_at DESC LIMIT 1`
    ).get();
    const operationCounts = new Map(activeOperationRows.map((row) => [
      z.string().parse(row.operation_kind),
      {
        active: z.number().int().nonnegative().parse(row.active_count),
        blocked: z.number().int().nonnegative().parse(row.blocked_count ?? 0)
      }
    ]));
    const pipeline = (kind: string) => ({
      active_operation_count: operationCounts.get(kind)?.active ?? 0,
      blocked_operation_count: operationCounts.get(kind)?.blocked ?? 0
    });
    const memoryCapacity = inspectMemoryCapacity({
      runtimeRoot: request.runtimeRoot,
      policy: memoryCapacityPolicy
    });
    return {
      mode: "read_only_inspection",
      runtime_root: request.runtimeRoot,
      vault_root: request.vaultRoot,
      luna: health === undefined ? null : {
        state: health.state,
        reason_category: health.reason_category,
        pending_operation_count: z.number().int().nonnegative().parse(backlog?.count),
        blocked_operation_count: z.number().int().nonnegative().parse(backlog?.blocked_count ?? 0)
      },
      active_index: activeIndex === undefined ? null : {
        index_revision_id: activeIndex.index_revision_id,
        document_count: activeIndex.document_count,
        model_identity: activeIndex.model_identity,
        adapter_version: activeIndex.adapter_version
      },
      worker: worker === undefined ? {
        capture_paused: false,
        worker_paused: false,
        reason: null,
        updated_at: null,
        health_incident: workerIncident === undefined ? null : {
          started_at: workerIncident.started_at,
          occurrence_count: workerIncident.occurrence_count,
          last_error_code: workerIncident.last_error_code
        }
      } : {
        capture_paused: worker.capture_paused === 1,
        worker_paused: worker.worker_paused === 1,
        reason: typeof worker.reason === "string" ? worker.reason : null,
        updated_at: worker.updated_at,
        health_incident: workerIncident === undefined ? null : {
          started_at: workerIncident.started_at,
          occurrence_count: workerIncident.occurrence_count,
          last_error_code: workerIncident.last_error_code
        }
      },
      review: {
        pending_reminder_count: z.number().int().nonnegative().parse(reminderCount?.count),
        inbox: reviewInbox === undefined ? null : {
          generated_at: reviewInbox.generated_at,
          item_counts: JSON.parse(z.string().parse(reviewInbox.item_counts_json)) as unknown,
          path: reviewInbox.path
        }
      },
      governance: governance === undefined ? null : {
        run_id: governance.run_id,
        kind: governance.run_kind,
        state: governance.state,
        phase: governance.current_phase,
        coverage_through: governance.coverage_through
      },
      archive_retention: archiveRetention === undefined ? null : {
        archive_months: archiveRetentionMonths,
        archived_count: z.number().int().nonnegative().parse(archiveCounts?.archived_count ?? 0),
        tombstone_count: z.number().int().nonnegative().parse(archiveCounts?.tombstone_count ?? 0),
        next_check_at: archiveRetention.next_check_at,
        last_checked_at: archiveRetention.last_checked_at,
        last_completed_at: archiveRetention.last_completed_at,
        last_error_code: archiveRetention.last_error_code,
        consecutive_failure_count: z.number().int().nonnegative().parse(
          archiveRetention.consecutive_failure_count
        ),
        backfill_completed_at: archiveRetention.backfill_completed_at,
        latest_purge: purgeRun === undefined ? null : {
          run_id: purgeRun.run_id,
          state: purgeRun.state,
          started_at: purgeRun.started_at,
          completed_at: purgeRun.completed_at,
          next_eligible_at: purgeRun.next_eligible_at,
          purged_count: purgeRun.purged_count,
          removed_bytes: purgeRun.removed_bytes,
          last_error_code: purgeRun.last_error_code
        }
      },
      memory_capacity: {
        ...memoryCapacity,
        working_set: {
          dirty_generation: workingSetGeneration.dirtyGeneration,
          published_generation: workingSetGeneration.publishedGeneration,
          dirty_at: workingSetGeneration.dirtyAt,
          last_rebalanced_at: workingSetGeneration.lastRebalancedAt,
          last_published_at: workingSetGeneration.lastPublishedAt,
          last_error: workingSetGeneration.lastError,
          publication_next_retry_at: workingSetGeneration.publicationNextRetryAt,
          publication_failure_count: workingSetGeneration.publicationFailureCount
        }
      },
      pipelines: {
        capture: {
          unbatched_event_count: z.number().int().nonnegative().parse(unbatchedCapture?.count),
          oldest_unbatched_at: typeof unbatchedCapture?.oldest_at === "string"
            ? unbatchedCapture.oldest_at
            : null,
          sqlite_busy_count: hookSqliteBusy.count,
          sqlite_busy_recovered_count: hookSqliteBusy.recoveredCount,
          sqlite_busy_lost_count: hookSqliteBusy.lostCount,
          last_sqlite_busy_at: hookSqliteBusy.lastOccurredAt,
          last_sqlite_busy_event_kind: hookSqliteBusy.lastEventKind,
          last_sqlite_busy_outcome: hookSqliteBusy.lastOutcome,
          capture_inbox: {
            pending_count: captureInbox.pendingCount,
            normal_event_count: captureInbox.normalEventCount,
            disposition_count: captureInbox.dispositionCount,
            maximum_pending_count: captureInbox.maximumPendingCount,
            maximum_pending_bytes: captureInbox.maximumPendingBytes,
            capacity_state: captureInbox.capacityState,
            pending_bytes: captureInbox.pendingBytes,
            oldest_pending_at: captureInbox.oldestPendingAt,
            quarantine_count: captureInbox.quarantineCount,
            total_bytes: captureInbox.totalBytes
          }
        },
        foreground_retrieval: {
          socket_state: foregroundSocketAvailable ? "available" : "unavailable",
          attempt_count: foregroundAttempts.totalCount,
          outcomes: foregroundAttempts.outcomes,
          deadline_count: foregroundAttempts.deadlineCount,
          cancellation_count: foregroundAttempts.cancellationCount,
          post_deadline_count: foregroundAttempts.postDeadlineCount,
          maximum_post_deadline_work_ms: foregroundAttempts.maximumPostDeadlineWorkMs,
          active_snapshot_id: activeIndex?.index_revision_id ?? null
        },
        retrieval_index: {
          dirty_generation: catalogGeneration.dirtyGeneration,
          published_generation: catalogGeneration.publishedGeneration,
          building_generation: catalogGeneration.buildingGeneration,
          quiet_period_ms: catalogGeneration.quietPeriodMilliseconds,
          maximum_staleness_ms: catalogGeneration.maximumStalenessMilliseconds,
          dirty_at: catalogGeneration.dirtyAt,
          force_due_at: catalogGeneration.forceDueAt,
          last_completed_at: catalogGeneration.lastCompletedAt,
          last_failed_at: catalogGeneration.lastFailedAt
        },
        distillation: pipeline("distill_batch"),
        session_consolidation: pipeline("consolidate_session"),
        semantic_assessment: pipeline("semantic_assessment"),
        conflict_assessment: pipeline("conflict_assessment"),
        candidate_reevaluation_backfill: candidateBackfill === undefined ? null : {
          state: candidateBackfill.state,
          scanned_candidate_count: candidateBackfill.scanned_candidate_count,
          reopened_candidate_count: candidateBackfill.reopened_candidate_count,
          updated_at: candidateBackfill.updated_at
        }
      },
      candidates: {
        waiting_count: z.number().int().nonnegative().parse(candidates?.waiting_count),
        unevaluated_count: z.number().int().nonnegative().parse(candidates?.unevaluated_count ?? 0),
        evaluated_waiting_count:
          z.number().int().nonnegative().parse(candidates?.waiting_count) -
          z.number().int().nonnegative().parse(candidates?.unevaluated_count ?? 0),
        pending_semantic_assessment_count: z.number().int().nonnegative().parse(
          semanticAssessments?.count
        ),
        oldest_waiting_at: typeof candidates?.oldest_waiting_at === "string"
          ? candidates.oldest_waiting_at
          : null
      }
    };
  } finally {
    database.close();
  }
}

export async function waitForOperation(request: {
  readonly runtimeRoot: string;
  readonly operationId: string;
  readonly timeoutSeconds: number;
}): Promise<{ readonly timed_out: boolean; readonly operation: unknown }> {
  const deadline = Date.now() + request.timeoutSeconds * 1000;
  const terminalStates = new Set([
    "completed",
    "dead_letter",
    "conflict",
    "failed",
    "blocked"
  ]);
  for (;;) {
    const operation = await inspectOperation(request.runtimeRoot, request.operationId);
    if (terminalStates.has(operation.state)) {
      return { timed_out: false, operation };
    }
    if (Date.now() >= deadline) {
      return { timed_out: true, operation };
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
  }
}
