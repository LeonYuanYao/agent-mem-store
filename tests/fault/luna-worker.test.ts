import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { listSessionCandidates } from "../../src/candidates/index.js";
import { captureEvent, inspectCaptureEventState } from "../../src/capture/index.js";
import { LunaInvocationError } from "../../src/luna/index.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";
import {
  prepareNextDistillationBatch,
  runNextLunaWork,
  type LunaWorkerAdapter
} from "../../src/worker/distillation.js";
import { makeLongTermCandidateDurability } from "../helpers/candidate-durability.js";
import { initializeMemStore } from "../../src/operations/initialize.js";
import { runWorkerOnce } from "../../src/worker/main.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("the normal Worker resumes an exhausted connection failure after healthy recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-worker-connection-recovery-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime"), vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  await captureEvent({ runtimeRoot, event: {
    schemaVersion: 1, eventId: "msevent-recovery", deduplicationKey: "recovery:stop", agent: "codex",
    eventKind: "Stop", occurredAt: "2026-08-07T00:00:00.000Z", sessionId: "recovery",
    turnId: "recovery-turn", payload: { assistantMessage: "No reusable knowledge in this task." }
  } });
  await prepareNextDistillationBatch({ runtimeRoot, maximumEvents: 8, preparedAt: "2026-08-07T01:00:00.000Z" });
  const db = await openRuntimeDatabase(runtimeRoot);
  db.prepare("UPDATE luna_operations SET state='blocked', epoch_attempt_count=7, attempt_count=7, last_error_category='timeout', updated_at='2026-08-07T01:00:00.000Z'").run();
  db.prepare("UPDATE distillation_batches SET state='blocked'").run();
  db.prepare("UPDATE luna_health_state SET state='healthy', last_success_at='2026-08-07T02:00:00.000Z'").run();
  db.close();
  const result = await runWorkerOnce({ runtimeRoot, vaultRoot, workerId: "worker",
    now: "2026-08-07T08:00:00.000Z", workerStartedAt: "2026-08-07T07:59:00.000Z",
    adapters: { luna: {
      distillBatch: () => Promise.resolve({ schemaVersion: 1, kind: "distillation", candidates: [],
        rejectionSummary: { schemaVersion: 1, coverage: "considered_memory_shaped_rejections_only",
          counts: { no_memory: 1, session_only: 0, uncertain: 0, source_echo: 0 }, samples: [] } }),
      consolidateSession: () => Promise.reject(new Error("No consolidation expected.")),
      assessCandidateSemantics: () => Promise.reject(new Error("No candidate expected.")),
      assessHumanConflict: () => Promise.reject(new Error("No conflict expected."))
    } }
  });
  expect(result.activities).toContain("luna:completed");
  await expect(inspectCaptureEventState(runtimeRoot, "msevent-recovery")).resolves.toMatchObject({ state: "completed" });
});

test("a transient Luna failure leaves evidence retryable and later produces one Candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-worker-retry-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const eventId = "msevent-retry-1";
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId,
      deduplicationKey: "retry-session:turn-1",
      agent: "codex",
      eventKind: "Stop",
      occurredAt: "2026-08-07T12:00:00.000Z",
      projectId: "msproj_123e4567-e89b-42d3-a456-426614174001",
      sessionId: "retry-session",
      turnId: "retry-turn",
      payload: { assistantMessage: "Remember the bounded rule." }
    }
  });
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent-retry-1-end",
      deduplicationKey: "retry-session:end",
      agent: "codex",
      eventKind: "SessionEnd",
      occurredAt: "2026-08-07T12:00:00.500Z",
      projectId: "msproj_123e4567-e89b-42d3-a456-426614174001",
      sessionId: "retry-session",
      payload: { reason: "other" }
    }
  });
  await prepareNextDistillationBatch({
    runtimeRoot,
    maximumEvents: 8,
    preparedAt: "2026-08-07T12:00:01.000Z"
  });

  const unavailable: LunaWorkerAdapter = {
    distillBatch() {
      return Promise.reject(new LunaInvocationError("unavailable", true, "offline"));
    },
    consolidateSession() {
      throw new Error("No consolidation expected.");
    }
  };
  await expect(runNextLunaWork({
    runtimeRoot,
    workerId: "worker-retry",
    now: "2026-08-07T12:00:02.000Z",
    currentTime: () => "2026-08-07T12:02:10.000Z",
    adapter: unavailable
  })).resolves.toMatchObject({ state: "retrying" });
  await expect(inspectCaptureEventState(runtimeRoot, eventId)).resolves.toMatchObject({
    state: "pending"
  });
  await expect(listSessionCandidates(runtimeRoot, "retry-session")).resolves.toEqual([]);
  const failedDatabase = await openRuntimeDatabase(runtimeRoot);
  try {
    const retry = failedDatabase.prepare(
      "SELECT next_retry_at FROM luna_operations WHERE operation_kind = 'distill_batch'"
    ).get();
    expect(retry?.next_retry_at).toMatch(/^2026-08-07T12:02:/u);
  } finally {
    failedDatabase.close();
  }

  let successfulDistillations = 0;
  const recovered: LunaWorkerAdapter = {
    distillBatch(request) {
      successfulDistillations += 1;
      return Promise.resolve({
        schemaVersion: 1,
        kind: "distillation",
        candidates: [{
          statement: "Remember the bounded rule.",
          primaryCategory: "preference_constraint",
          categoryTags: ["preference_constraint"],
          applicabilitySummary: "retry project",
          conditions: [],
          exclusions: [],
          preservedNegations: [],
          certainty: "asserted",
          sensitivity: "normal",
          evidenceIds: request.evidence.map((item) => item.evidenceId),
          durability: makeLongTermCandidateDurability(),
          importanceTags: [],
          importanceReasons: []
        }]
      });
    },
    consolidateSession() {
      throw new Error("No consolidation expected.");
    }
  };
  await expect(runNextLunaWork({
    runtimeRoot,
    workerId: "worker-retry",
    now: "2026-08-08T12:00:00.000Z",
    adapter: recovered
  })).resolves.toMatchObject({ state: "completed" });
  await expect(inspectCaptureEventState(runtimeRoot, eventId)).resolves.toMatchObject({
    state: "completed"
  });
  await expect(listSessionCandidates(runtimeRoot, "retry-session")).resolves.toHaveLength(1);

  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare(
      `UPDATE luna_operations
       SET state = 'retrying', next_retry_at = ?, updated_at = ?
       WHERE operation_id = (
         SELECT operation_id FROM distillation_batches LIMIT 1
       )`
    ).run("2026-08-08T12:00:01.000Z", "2026-08-08T12:00:01.000Z");
  } finally {
    database.close();
  }
  const mustNotReinvoke: LunaWorkerAdapter = {
    distillBatch() {
      throw new Error("A persisted Batch result must not invoke Luna again.");
    },
    consolidateSession() {
      throw new Error("No consolidation expected.");
    }
  };
  await expect(runNextLunaWork({
    runtimeRoot,
    workerId: "worker-replay",
    now: "2026-08-08T12:00:02.000Z",
    adapter: mustNotReinvoke
  })).resolves.toMatchObject({ state: "completed" });
  expect(successfulDistillations).toBe(1);
  await expect(listSessionCandidates(runtimeRoot, "retry-session")).resolves.toHaveLength(1);
});

test("a large schema-invalid Batch is split once and its children are consolidated", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-worker-split-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  for (let index = 0; index < 8; index += 1) {
    await captureEvent({
      runtimeRoot,
      event: {
        schemaVersion: 1,
        eventId: `msevent-split-${String(index)}`,
        deduplicationKey: `split-session:turn-${String(index)}`,
        agent: "codex",
        eventKind: index === 7 ? "SessionEnd" : "PostToolUse",
        occurredAt: `2026-08-07T13:00:0${String(index)}.000Z`,
        projectId: "msproj_123e4567-e89b-42d3-a456-426614174001",
        sessionId: "split-session",
        payload: { text: "x".repeat(10_000), ordinal: index }
      }
    });
  }
  const prepared = await prepareNextDistillationBatch({
    runtimeRoot,
    maximumEvents: 8,
    preparedAt: "2026-08-07T13:00:10.000Z"
  });
  if (prepared.state !== "queued") throw new Error("Expected large Batch.");
  const invalid: LunaWorkerAdapter = {
    distillBatch() {
      return Promise.reject(new LunaInvocationError(
        "schema_invalid",
        true,
        "private raw output",
        { stage: "output_schema", code: "invalid_type", path: "candidates.0.evidenceIds" }
      ));
    },
    consolidateSession() {
      throw new Error("No consolidation expected before child Batches complete.");
    }
  };
  await expect(runNextLunaWork({
    runtimeRoot,
    workerId: "worker-split",
    now: "2026-08-07T13:00:11.000Z",
    currentTime: () => "2026-08-07T13:00:12.000Z",
    adapter: invalid
  })).resolves.toMatchObject({ state: "split", operationId: prepared.operationId });

  const splitDatabase = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(splitDatabase.prepare(
      "SELECT state, last_error_diagnostic_json FROM luna_operations WHERE operation_id = ?"
    ).get(prepared.operationId)).toMatchObject({
      state: "dead_letter",
      last_error_diagnostic_json: JSON.stringify({
        stage: "output_schema",
        code: "invalid_type",
        path: "candidates.0.evidenceIds"
      })
    });
    expect(splitDatabase.prepare(
      "SELECT state, split_reason FROM distillation_batches WHERE batch_id = ?"
    ).get(prepared.batchId)).toMatchObject({ state: "blocked", split_reason: "schema_invalid_large_batch" });
    expect(splitDatabase.prepare(
      "SELECT COUNT(*) AS count FROM distillation_batches WHERE session_id = ? AND split_parent_batch_id = ?"
    ).get("split-session", prepared.batchId)?.count).toBe(2);
    expect(splitDatabase.prepare(
      `SELECT COUNT(*) AS count FROM distillation_batch_events AS assigned
       JOIN distillation_batches AS batch ON batch.batch_id = assigned.batch_id
       WHERE batch.split_parent_batch_id = ?`
    ).get(prepared.batchId)?.count).toBe(8);
    expect(JSON.stringify(splitDatabase.prepare(
      "SELECT last_error_diagnostic_json FROM luna_operations WHERE operation_id = ?"
    ).get(prepared.operationId))).not.toContain("private raw output");
  } finally {
    splitDatabase.close();
  }

  let consolidationCalls = 0;
  const recovered: LunaWorkerAdapter = {
    distillBatch() {
      return Promise.resolve({
        schemaVersion: 1,
        kind: "distillation",
        candidates: [],
        rejectionSummary: {
          schemaVersion: 1,
          coverage: "considered_memory_shaped_rejections_only",
          counts: { no_memory: 4, session_only: 0, uncertain: 0, source_echo: 0 },
          samples: []
        }
      });
    },
    consolidateSession() {
      consolidationCalls += 1;
      return Promise.resolve({ schemaVersion: 1, kind: "consolidation", candidates: [] });
    }
  };
  for (let index = 0; index < 3; index += 1) {
    await runNextLunaWork({
      runtimeRoot,
      workerId: "worker-split-recovery",
      now: `2026-08-07T13:01:0${String(index)}.000Z`,
      adapter: recovered
    });
  }
  expect(consolidationCalls).toBe(1);
  const completedDatabase = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(completedDatabase.prepare(
      "SELECT state FROM session_consolidations WHERE session_id = 'split-session'"
    ).get()?.state).toBe("completed");
  } finally {
    completedDatabase.close();
  }
});
