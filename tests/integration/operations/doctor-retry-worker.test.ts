import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";

import { initializeMemStore } from "../../../src/operations/initialize.js";
import { inspectDoctor, retryOperation } from "../../../src/operations/maintenance.js";
import { enqueueLunaOperation, claimLunaOperation, failLunaOperation } from "../../../src/luna/operations.js";
import { LunaInvocationError } from "../../../src/luna/index.js";
import { captureEvent } from "../../../src/capture/index.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { inspectStatus } from "../../../src/operations/status.js";
import { runWorkerOnce } from "../../../src/worker/main.js";
import { recordForegroundAttempt } from "../../../src/retrieval/foreground-attempts.js";

const roots: string[] = [];

test.each(["deadline_exceeded", "failed", "unavailable"] as const)("foreground health detects %s and recovers from subsequent real successes", async (outcome) => {
  const root = await mkdtemp(join(tmpdir(), "memstore-health-transition-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime"), vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  for (let i = 0; i < 3; i++) {
    const at = `2026-09-08T00:00:0${String(i)}.000Z`;
    await recordForegroundAttempt({ runtimeRoot, attempt: {
      requestId: `bad-${String(i)}`, eventKind: "UserPromptSubmit", outcome,
      admissionDelayMs: 0, computeMs: 1_100, receiptCommitMs: 0,
      observedClientElapsedMs: 1_100, postDeadlineWorkMs: 0, createdAt: at, completedAt: at
    } });
  }
  const inspect = (now: string) => inspectDoctor({ runtimeRoot, vaultRoot, deep: false, now });
  expect((await inspect("2026-09-08T00:01:00.000Z")).checks.find(c => c.name === "foreground_retrieval")?.state).toBe("warning");
  expect((await inspect("2026-09-08T07:00:00.000Z")).state).toBe("observing");
  for (let i = 0; i < 5; i++) {
    const at = `2026-09-08T00:05:0${String(i)}.000Z`;
    await recordForegroundAttempt({ runtimeRoot, attempt: {
      requestId: `good-${String(i)}`, eventKind: "UserPromptSubmit", outcome: "completed",
      admissionDelayMs: 0, computeMs: 50, receiptCommitMs: 0,
      observedClientElapsedMs: 50, postDeadlineWorkMs: 0, createdAt: at, completedAt: at
    } });
  }
  expect((await inspect("2026-09-08T00:11:00.000Z")).state).toBe("healthy");
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("doctor diagnoses an initialized isolated installation without repairing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-doctor-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const result = await inspectDoctor({ runtimeRoot, vaultRoot, deep: true });
  expect(result.state).toBe("healthy");
  expect(result.repaired).toBe(false);
  expect(result.checks.map((check) => [check.name, check.state])).toEqual([
    ["configuration", "ok"],
    ["foreground_retrieval", "ok"],
    ["retrieval_catalog_generation", "ok"],
    ["capture_inbox", "ok"],
    ["sqlite_integrity", "ok"],
    ["candidate_pipeline", "ok"],
    ["luna_operations", "ok"],
    ["governance", "ok"],
    ["vault_catalog", "ok"]
  ]);
});

test("doctor keeps recovered historical foreground deadlines as information instead of permanent degradation", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-doctor-recovered-foreground-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  for (let ordinal = 0; ordinal < 3; ordinal += 1) {
    await recordForegroundAttempt({
      runtimeRoot,
      attempt: {
        requestId: `historical-deadline-${String(ordinal)}`,
        eventKind: "UserPromptSubmit",
        outcome: "deadline_exceeded",
        admissionDelayMs: 0,
        computeMs: 1_100,
        receiptCommitMs: 0,
        observedClientElapsedMs: 1_100,
        postDeadlineWorkMs: 100,
        createdAt: `2026-08-01T00:00:0${String(ordinal)}.000Z`,
        completedAt: `2026-08-01T00:00:0${String(ordinal)}.000Z`
      }
    });
  }
  for (let ordinal = 0; ordinal < 20; ordinal += 1) {
    await recordForegroundAttempt({
      runtimeRoot,
      attempt: {
        requestId: `recent-completed-${String(ordinal)}`,
        eventKind: "UserPromptSubmit",
        outcome: "completed",
        admissionDelayMs: 0,
        computeMs: 80,
        receiptCommitMs: 5,
        observedClientElapsedMs: 80,
        postDeadlineWorkMs: 0,
        createdAt: `2026-08-20T00:00:${String(ordinal).padStart(2, "0")}.000Z`,
        completedAt: `2026-08-20T00:00:${String(ordinal).padStart(2, "0")}.000Z`
      }
    });
  }

  const result = await inspectDoctor({
    runtimeRoot,
    vaultRoot,
    deep: false,
    now: "2026-08-20T01:00:00.000Z"
  });
  expect(result.state).toBe("healthy");
  expect(result.checks.find((check) => check.name === "foreground_retrieval"))
    .toMatchObject({ state: "ok" });
  expect(result.checks.find((check) => check.name === "foreground_retrieval")?.detail)
    .toContain("3 lifetime deadlines");
});

test("doctor distinguishes cooldown waiting from exhausted recovery that needs explicit handling", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-doctor-offline-luna-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const operation = await enqueueLunaOperation({
    runtimeRoot,
    kind: "semantic_assessment",
    idempotencyKey: "doctor-offline-luna",
    payload: { candidateId: "candidate-offline" },
    createdAt: "2026-08-20T00:00:00.000Z"
  });
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare(
      `UPDATE luna_operations
       SET state = 'blocked', last_error_category = 'timeout', epoch_attempt_count = 7, updated_at = ?
       WHERE operation_id = ?`
    ).run("2026-08-20T00:10:00.000Z", operation.operationId);
  } finally {
    database.close();
  }

  const result = await inspectDoctor({
    runtimeRoot,
    vaultRoot,
    deep: false,
    now: "2026-08-20T01:00:00.000Z"
  });
  expect(result.state).toBe("observing");
  expect(result.checks.find((check) => check.name === "luna_operations"))
    .toMatchObject({ state: "info", nextEvaluationAt: "2026-08-20T06:10:00.000Z" });
  expect(result.checks.find((check) => check.name === "luna_operations")?.detail)
    .toContain("await recovery evidence and cooldown");
  const exhausted = await openRuntimeDatabase(runtimeRoot);
  exhausted.prepare("UPDATE luna_operations SET connection_recovery_count = 2 WHERE operation_id = ?")
    .run(operation.operationId);
  exhausted.close();
  const stopped = await inspectDoctor({ runtimeRoot, vaultRoot, deep: false,
    now: "2026-08-21T01:00:00.000Z" });
  expect(stopped.checks.find((check) => check.name === "luna_operations"))
    .toMatchObject({ state: "warning" });
  expect(stopped.checks.find((check) => check.name === "luna_operations")?.detail)
    .toContain("automatic retries stopped");
});

test("doctor treats an overdue normal index deadline as expected while recovery coalescing is active", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-doctor-index-recovery-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  for (let ordinal = 0; ordinal < 32; ordinal += 1) {
    await enqueueLunaOperation({
      runtimeRoot,
      kind: "semantic_assessment",
      idempotencyKey: `doctor-index-recovery-${String(ordinal)}`,
      payload: { candidateId: `candidate-${String(ordinal)}` },
      createdAt: "2026-08-20T00:00:00.000Z"
    });
  }
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare(
      `UPDATE retrieval_catalog_generations
       SET dirty_generation = 10, published_generation = 0,
           dirty_at = ?, force_due_at = ? WHERE singleton = 1`
    ).run("2026-08-20T00:00:00.000Z", "2026-08-20T00:02:00.000Z");
  } finally {
    database.close();
  }

  const result = await inspectDoctor({
    runtimeRoot,
    vaultRoot,
    deep: false,
    now: "2026-08-20T00:10:00.000Z"
  });
  expect(result.state).toBe("observing");
  expect(result.checks.find((check) => check.name === "retrieval_catalog_generation"))
    .toMatchObject({ state: "info" });
  expect(result.checks.find((check) => check.name === "retrieval_catalog_generation")?.detail)
    .toContain("recovery coalescing");
  const stalled = await inspectDoctor({ runtimeRoot, vaultRoot, deep: false, now: "2026-08-20T00:32:00.000Z" });
  expect(stalled.checks.find(check => check.name === "retrieval_catalog_generation")?.state).toBe("warning");
});

test("doctor reports a pending Runtime migration without applying it", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-doctor-pending-migration-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });

  const databasePath = join(runtimeRoot, "state", "memstore.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    DROP TABLE foreground_event_reservations;
    DROP TABLE foreground_attempt_maintenance;
    DROP TABLE foreground_attempt_overflow;
    DELETE FROM schema_migrations WHERE version = 52;
  `);
  legacy.close();

  const result = await inspectDoctor({ runtimeRoot, vaultRoot, deep: false });
  const inspected = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(inspected.prepare(
      "SELECT name FROM schema_migrations WHERE version = 52"
    ).get()).toBeUndefined();
    expect(inspected.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get("foreground_event_reservations")).toBeUndefined();
  } finally {
    inspected.close();
  }
  expect(result.state).toBe("error");
  expect(result.checks.find((check) => check.name === "foreground_retrieval"))
    .toMatchObject({ state: "error" });
});

test("doctor only reports stale waiting Candidates that still need evaluation", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-doctor-evaluated-waiting-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare(
      `INSERT INTO memory_candidates(
         candidate_id, fingerprint, scope_kind, project_id, statement,
         candidate_json, category, certainty, state, high_value, sensitivity,
         source_session_id, created_at, last_evidence_at, updated_at,
         successful_evaluation_at
       ) VALUES (?, ?, 'project', ?, ?, ?, 'durable_reference', 'asserted', 'waiting', 0,
                 'normal', ?, ?, ?, ?, ?)`
    ).run(
      "mscandidate_evaluated_waiting",
      "e".repeat(64),
      "msproj_doctor",
      "Evaluated but intentionally waiting.",
      JSON.stringify({
        statement: "Evaluated but intentionally waiting.",
        primaryCategory: "durable_reference",
        categoryTags: ["durable_reference"]
      }),
      "session-doctor",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z"
    );
  } finally {
    database.close();
  }

  const result = await inspectDoctor({ runtimeRoot, vaultRoot, deep: true });
  expect(result.state).toBe("healthy");
  expect(result.checks.find((check) => check.name === "candidate_pipeline"))
    .toMatchObject({ state: "ok" });

  const update = await openRuntimeDatabase(runtimeRoot);
  try {
    update.prepare(
      "UPDATE memory_candidates SET successful_evaluation_at = NULL WHERE candidate_id = ?"
    ).run("mscandidate_evaluated_waiting");
  } finally {
    update.close();
  }
  const stale = await inspectDoctor({ runtimeRoot, vaultRoot, deep: true });
  expect(stale.state).toBe("degraded");
  expect(stale.checks.find((check) => check.name === "candidate_pipeline"))
    .toMatchObject({ state: "warning" });
});

test("retry requeues one blocked Luna operation and worker pause remains observable", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-retry-worker-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const operation = await enqueueLunaOperation({
    runtimeRoot,
    kind: "semantic_assessment",
    idempotencyKey: "doctor-retry-operation",
    payload: { candidateId: "candidate" },
    createdAt: "2026-08-08T05:00:00.000Z"
  });
  const claimed = await claimLunaOperation({
    runtimeRoot, workerId: "test", now: "2026-08-08T05:00:01.000Z", leaseSeconds: 60
  });
  if (claimed.state !== "claimed") throw new Error("Expected claim.");
  await failLunaOperation({
    runtimeRoot,
    operationId: operation.operationId,
    leaseToken: claimed.leaseToken,
    failedAt: "2026-08-08T05:00:02.000Z",
    error: new LunaInvocationError("authentication", false, "blocked")
  });
  const blockedDoctor = await inspectDoctor({ runtimeRoot, vaultRoot, deep: false });
  expect(blockedDoctor.state).toBe("degraded");
  expect(blockedDoctor.checks.find((check) => check.name === "luna_operations"))
    .toMatchObject({ name: "luna_operations", state: "warning" });
  expect(blockedDoctor.checks.find((check) => check.name === "luna_operations")?.detail)
    .toContain("1 blocked");
  await expect(inspectStatus({ runtimeRoot, vaultRoot })).resolves.toMatchObject({
    luna: {
      pending_operation_count: 1,
      blocked_operation_count: 1
    }
  });
  await expect(retryOperation({
    runtimeRoot,
    operationId: operation.operationId,
    requestedAt: "2026-08-08T05:01:00.000Z",
    preview: true
  })).resolves.toMatchObject({ state: "preview", wouldRetry: true });
  await expect(retryOperation({
    runtimeRoot,
    operationId: operation.operationId,
    requestedAt: "2026-08-08T05:01:01.000Z",
    preview: false
  })).resolves.toEqual({
    state: "queued",
    operationId: operation.operationId,
    retryEpoch: 1,
    lifetimeAttemptCount: 1
  });
  await expect(runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "worker-test",
    now: "2026-08-08T05:02:00.000Z",
    workerStartedAt: "2026-08-08T04:00:00.000Z"
  })).resolves.toMatchObject({ state: "idle" });
});

test("Luna claims honor the caller's lane priority before operation age", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-lane-priority-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  await enqueueLunaOperation({
    runtimeRoot,
    kind: "distill_batch",
    idempotencyKey: "lane-priority:old-distillation",
    payload: { batchId: "old-distillation" },
    createdAt: "2026-08-08T04:00:00.000Z"
  });
  const consolidation = await enqueueLunaOperation({
    runtimeRoot,
    kind: "consolidate_session",
    idempotencyKey: "lane-priority:new-consolidation",
    payload: { sessionId: "closed-long-session" },
    createdAt: "2026-08-08T05:00:00.000Z"
  });

  await expect(claimLunaOperation({
    runtimeRoot,
    workerId: "lane-priority-worker",
    now: "2026-08-08T06:00:00.000Z",
    leaseSeconds: 60,
    kinds: ["consolidate_session", "distill_batch"]
  })).resolves.toMatchObject({
    state: "claimed",
    operation: { operationId: consolidation.operationId }
  });
});

test("status separates capture, distillation, consolidation, and semantic backlogs", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-pipeline-status-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent-status-unbatched",
      deduplicationKey: "status:unbatched",
      agent: "codex",
      eventKind: "PostToolUse",
      occurredAt: "2026-08-08T04:00:00.000Z",
      sessionId: "status-session",
      turnId: "status-turn",
      payload: { tool_name: "inspect", tool_response: { ok: true } }
    }
  });
  await enqueueLunaOperation({
    runtimeRoot,
    kind: "distill_batch",
    idempotencyKey: "status:distillation",
    payload: { batchId: "status-batch" },
    createdAt: "2026-08-08T04:00:01.000Z"
  });
  await enqueueLunaOperation({
    runtimeRoot,
    kind: "semantic_assessment",
    idempotencyKey: "status:semantic",
    payload: { candidateId: "status-candidate", evidenceGeneration: 1 },
    createdAt: "2026-08-08T04:00:02.000Z"
  });

  await expect(inspectStatus({ runtimeRoot, vaultRoot })).resolves.toMatchObject({
    pipelines: {
      capture: { unbatched_event_count: 1 },
      distillation: { active_operation_count: 1, blocked_operation_count: 0 },
      session_consolidation: { active_operation_count: 0, blocked_operation_count: 0 },
      semantic_assessment: { active_operation_count: 1, blocked_operation_count: 0 },
      conflict_assessment: { active_operation_count: 0, blocked_operation_count: 0 }
    }
  });
});
