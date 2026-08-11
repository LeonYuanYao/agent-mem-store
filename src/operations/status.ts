import { access } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { MemStoreCommandError } from "../contracts/envelope.js";

async function databasePath(runtimeRoot: string): Promise<string> {
  const path = join(runtimeRoot, "state", "memstore.sqlite");
  try {
    await access(path);
    return path;
  } catch {
    throw new MemStoreCommandError("runtime_uninitialized", "MemStore Runtime is not initialized.");
  }
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
      : rawState === "blocked"
        ? "failed"
        : rawState;
    return {
      operation_id: operationId,
      kind: z.string().parse(luna.operation_kind),
      state,
      phase: rawState,
      attempt_count: z.number().int().nonnegative().parse(luna.attempt_count),
      project_id: typeof luna.project_id === "string" ? luna.project_id : null,
      session_id: typeof luna.session_id === "string" ? luna.session_id : null,
      next_retry_at: typeof luna.next_retry_at === "string" ? luna.next_retry_at : null,
      last_error_category: typeof luna.last_error_category === "string" ? luna.last_error_category : null,
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
  const database = new DatabaseSync(await databasePath(request.runtimeRoot), { readOnly: true });
  try {
    const health = database.prepare("SELECT * FROM luna_health_state WHERE singleton = 1").get();
    const backlog = database.prepare(
      `SELECT COUNT(*) AS count FROM luna_operations
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
    return {
      mode: "read_only_inspection",
      runtime_root: request.runtimeRoot,
      vault_root: request.vaultRoot,
      luna: health === undefined ? null : {
        state: health.state,
        reason_category: health.reason_category,
        pending_operation_count: z.number().int().nonnegative().parse(backlog?.count)
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
        updated_at: null
      } : {
        capture_paused: worker.capture_paused === 1,
        worker_paused: worker.worker_paused === 1,
        reason: typeof worker.reason === "string" ? worker.reason : null,
        updated_at: worker.updated_at
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
      candidates: {
        waiting_count: z.number().int().nonnegative().parse(candidates?.waiting_count),
        unevaluated_count: z.number().int().nonnegative().parse(candidates?.unevaluated_count ?? 0),
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
    "failed"
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
