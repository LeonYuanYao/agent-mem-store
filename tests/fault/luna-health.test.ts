import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  claimLunaOperation,
  completeLunaOperation,
  enqueueLunaOperation,
  failLunaOperation,
  failLunaOperationLocally,
  inspectLunaHealth,
  recordLunaHealthProbe,
  retryBlockedLunaOperations
} from "../../src/luna/operations.js";
import { LunaInvocationError } from "../../src/luna/index.js";
import { retryOperation } from "../../src/operations/maintenance.js";
import { inspectOperation } from "../../src/operations/status.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

test("an authentication failure keeps work durable and makes Luna visibly unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-auth-health-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const operation = await enqueueLunaOperation({
    runtimeRoot,
    kind: "distill_batch",
    idempotencyKey: "batch:session-1:0",
    projectId: "msproj_123e4567-e89b-42d3-a456-426614174001",
    sessionId: "session-1",
    payload: { evidenceIds: ["msevent_1"], privateBody: "must not reach status" },
    createdAt: "2026-08-07T06:00:00.000Z"
  });
  const claimed = await claimLunaOperation({
    runtimeRoot,
    workerId: "worker-1",
    now: "2026-08-07T06:00:01.000Z",
    leaseSeconds: 60
  });
  if (claimed.state !== "claimed") throw new Error("Expected claimed operation.");

  const failed = await failLunaOperation({
    runtimeRoot,
    operationId: claimed.operation.operationId,
    leaseToken: claimed.leaseToken,
    failedAt: "2026-08-07T06:00:02.000Z",
    error: new LunaInvocationError(
      "authentication",
      false,
      "Authentication failed with a private provider response."
    )
  });
  const health = await inspectLunaHealth({
    runtimeRoot,
    now: "2026-08-07T06:00:03.000Z"
  });

  expect(operation.state).toBe("queued");
  expect(failed).toEqual({
    state: "blocked",
    operationId: operation.operationId,
    nextRetryAt: null
  });
  expect(health).toMatchObject({
    state: "unavailable",
    reasonCategory: "authentication",
    pendingOperationCount: 1,
    oldestBacklogAgeSeconds: 3
  });
  expect(JSON.stringify(health)).not.toContain("privateBody");
  expect(JSON.stringify(health)).not.toContain("private provider response");
});

test("three retryable failures spanning two minutes degrade Luna with bounded backoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-degraded-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  await enqueueLunaOperation({
    runtimeRoot,
    kind: "semantic_assessment",
    idempotencyKey: "assessment:candidate-1",
    payload: { candidateId: "candidate-1" },
    createdAt: "2026-08-07T06:00:00.000Z"
  });

  for (const [index, now] of [
    "2026-08-07T06:00:01.000Z",
    "2026-08-07T06:01:01.000Z",
    "2026-08-07T06:02:02.000Z"
  ].entries()) {
    const claimed = await claimLunaOperation({
      runtimeRoot,
      workerId: "worker-1",
      now,
      leaseSeconds: 30
    });
    if (claimed.state !== "claimed") throw new Error("Expected retry claim.");
    const failedAt = new Date(Date.parse(now) + 1_000).toISOString();
    const result = await failLunaOperation({
      runtimeRoot,
      operationId: claimed.operation.operationId,
      leaseToken: claimed.leaseToken,
      failedAt,
      error: new LunaInvocationError("unavailable", true, "temporary failure"),
      ...(index < 2 ? { retryAfter: now } : {})
    });
    expect(result.state).toBe("retrying");
  }

  const health = await inspectLunaHealth({
    runtimeRoot,
    now: "2026-08-07T06:02:04.000Z"
  });
  expect(health).toMatchObject({
    state: "degraded",
    reasonCategory: "unavailable",
    consecutiveFailures: 3,
    pendingOperationCount: 1
  });
  expect(health.nextRetryAt).toMatch(/^2026-08-07T06:/u);
});

test("a retryable Luna operation blocks after six automatic retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-retry-limit-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const operation = await enqueueLunaOperation({
    runtimeRoot,
    kind: "distill_batch",
    idempotencyKey: "retry-limit:batch-1",
    payload: { batchId: "batch-1" },
    createdAt: "2026-08-07T06:00:00.000Z"
  });

  for (let attempt = 1; attempt <= 7; attempt += 1) {
    const now = new Date(Date.parse("2026-08-07T06:00:00.000Z") + attempt * 1_000)
      .toISOString();
    const claimed = await claimLunaOperation({
      runtimeRoot,
      workerId: "worker-1",
      now,
      leaseSeconds: 60
    });
    if (claimed.state !== "claimed") throw new Error("Expected retry claim.");
    expect(claimed.operation.attemptCount).toBe(attempt);
    const failed = await failLunaOperation({
      runtimeRoot,
      operationId: operation.operationId,
      leaseToken: claimed.leaseToken,
      failedAt: now,
      error: new LunaInvocationError("schema_invalid", true, "invalid structured output"),
      retryAfter: new Date(Date.parse(now) + 1_000).toISOString()
    });
    expect(failed.state).toBe(attempt < 7 ? "retrying" : "blocked");
    expect(failed.nextRetryAt).toBe(attempt < 7
      ? new Date(Date.parse(now) + 1_000).toISOString()
      : null);
  }

  await expect(claimLunaOperation({
    runtimeRoot,
    workerId: "worker-1",
    now: "2026-08-07T07:00:00.000Z",
    leaseSeconds: 60
  })).resolves.toEqual({ state: "empty" });

  await expect(retryOperation({
    runtimeRoot,
    operationId: operation.operationId,
    requestedAt: "2026-08-07T07:00:01.000Z",
    preview: false
  })).resolves.toEqual({
    state: "queued",
    operationId: operation.operationId,
    retryEpoch: 1,
    lifetimeAttemptCount: 7
  });
  const manualClaim = await claimLunaOperation({
    runtimeRoot,
    workerId: "worker-1",
    now: "2026-08-07T07:00:02.000Z",
    leaseSeconds: 60
  });
  if (manualClaim.state !== "claimed") throw new Error("Expected manual retry claim.");
  expect(manualClaim.operation).toMatchObject({
    attemptCount: 8,
    retryEpoch: 1,
    epochAttemptCount: 1
  });
  await expect(failLunaOperation({
    runtimeRoot,
    operationId: operation.operationId,
    leaseToken: manualClaim.leaseToken,
    failedAt: "2026-08-07T07:00:03.000Z",
    error: new LunaInvocationError("schema_invalid", true, "invalid structured output"),
    retryAfter: "2026-08-07T07:00:04.000Z"
  })).resolves.toMatchObject({ state: "retrying" });
  await expect(inspectOperation(runtimeRoot, operation.operationId)).resolves.toMatchObject({
    phase: "retrying",
    attempt_count: 8,
    retry_epoch: 1,
    epoch_attempt_count: 1
  });
});

test("the retry epoch migration preserves attempts from an existing Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-retry-migration-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const operation = await enqueueLunaOperation({
    runtimeRoot,
    kind: "distill_batch",
    idempotencyKey: "retry-migration:batch-1",
    payload: { batchId: "batch-1" },
    createdAt: "2026-08-07T06:00:00.000Z"
  });
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare(
      `UPDATE luna_operations
       SET state = 'blocked', attempt_count = 7, epoch_attempt_count = 0
       WHERE operation_id = ?`
    ).run(operation.operationId);
    database.prepare("DELETE FROM schema_migrations WHERE version = 24").run();
  } finally {
    database.close();
  }
  const migrated = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(migrated.prepare(
      "SELECT attempt_count, retry_epoch, epoch_attempt_count FROM luna_operations WHERE operation_id = ?"
    ).get(operation.operationId)).toEqual({
      attempt_count: 7,
      retry_epoch: 0,
      epoch_attempt_count: 7
    });
  } finally {
    migrated.close();
  }
});

test("a retryable local Luna processing failure uses the same retry limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-local-retry-limit-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const operation = await enqueueLunaOperation({
    runtimeRoot,
    kind: "distill_batch",
    idempotencyKey: "local-retry-limit:batch-1",
    payload: { batchId: "batch-1" },
    createdAt: "2026-08-07T06:00:00.000Z"
  });

  for (let attempt = 1; attempt <= 7; attempt += 1) {
    const now = new Date(Date.parse("2026-08-07T06:00:00.000Z") + attempt * 20 * 60_000)
      .toISOString();
    const claimed = await claimLunaOperation({
      runtimeRoot,
      workerId: "worker-1",
      now,
      leaseSeconds: 60
    });
    if (claimed.state !== "claimed") throw new Error("Expected local retry claim.");
    const failed = await failLunaOperationLocally({
      runtimeRoot,
      operationId: operation.operationId,
      leaseToken: claimed.leaseToken,
      failedAt: now,
      retryable: true
    });
    expect(failed.state).toBe(attempt < 7 ? "retrying" : "blocked");
  }
});

test("a successful queued operation clears a transient healthy-state failure streak", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-transient-health-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const operation = await enqueueLunaOperation({
    runtimeRoot,
    kind: "distill_batch",
    idempotencyKey: "transient:batch-1",
    payload: { evidenceIds: ["msevent_1"] },
    createdAt: "2026-08-07T06:00:00.000Z"
  });
  const firstClaim = await claimLunaOperation({
    runtimeRoot,
    workerId: "worker-1",
    now: "2026-08-07T06:00:01.000Z",
    leaseSeconds: 60
  });
  if (firstClaim.state !== "claimed") throw new Error("Expected first claim.");
  await failLunaOperation({
    runtimeRoot,
    operationId: operation.operationId,
    leaseToken: firstClaim.leaseToken,
    failedAt: "2026-08-07T06:00:02.000Z",
    error: new LunaInvocationError("unavailable", true, "temporary failure"),
    retryAfter: "2026-08-07T06:00:03.000Z"
  });
  const secondClaim = await claimLunaOperation({
    runtimeRoot,
    workerId: "worker-1",
    now: "2026-08-07T06:00:03.000Z",
    leaseSeconds: 60
  });
  if (secondClaim.state !== "claimed") throw new Error("Expected retry claim.");
  await completeLunaOperation({
    runtimeRoot,
    operationId: operation.operationId,
    leaseToken: secondClaim.leaseToken,
    completedAt: "2026-08-07T06:00:04.000Z"
  });

  await expect(inspectLunaHealth({
    runtimeRoot,
    now: "2026-08-07T06:00:05.000Z"
  })).resolves.toMatchObject({
    state: "healthy",
    reasonCategory: null,
    consecutiveFailures: 0,
    pendingOperationCount: 0,
    lastSuccessAt: "2026-08-07T06:00:04.000Z"
  });
});

test("recovery requires a successful probe and a real queued Luna operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-recovery-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const operation = await enqueueLunaOperation({
    runtimeRoot,
    kind: "distill_batch",
    idempotencyKey: "recovery:batch-1",
    payload: { evidenceIds: ["msevent_1"] },
    createdAt: "2026-08-07T06:00:00.000Z"
  });
  const firstClaim = await claimLunaOperation({
    runtimeRoot,
    workerId: "worker-1",
    now: "2026-08-07T06:00:01.000Z",
    leaseSeconds: 60
  });
  if (firstClaim.state !== "claimed") throw new Error("Expected first claim.");
  await failLunaOperation({
    runtimeRoot,
    operationId: operation.operationId,
    leaseToken: firstClaim.leaseToken,
    failedAt: "2026-08-07T06:00:02.000Z",
    error: new LunaInvocationError("invalid_model", false, "model missing")
  });
  await retryBlockedLunaOperations({
    runtimeRoot,
    requestedAt: "2026-08-07T06:10:00.000Z"
  });
  const secondClaim = await claimLunaOperation({
    runtimeRoot,
    workerId: "worker-1",
    now: "2026-08-07T06:10:01.000Z",
    leaseSeconds: 60
  });
  if (secondClaim.state !== "claimed") throw new Error("Expected retry claim.");

  await recordLunaHealthProbe({
    runtimeRoot,
    succeededAt: "2026-08-07T06:10:02.000Z"
  });
  expect(
    (await inspectLunaHealth({
      runtimeRoot,
      now: "2026-08-07T06:10:03.000Z"
    })).state
  ).toBe("unavailable");
  await completeLunaOperation({
    runtimeRoot,
    operationId: operation.operationId,
    leaseToken: secondClaim.leaseToken,
    completedAt: "2026-08-07T06:10:04.000Z"
  });

  expect(
    await inspectLunaHealth({
      runtimeRoot,
      now: "2026-08-07T06:10:05.000Z"
    })
  ).toMatchObject({
    state: "healthy",
    consecutiveFailures: 0,
    pendingOperationCount: 0,
    lastSuccessAt: "2026-08-07T06:10:04.000Z"
  });
});

test("two successful real operations recover health without a separate model call", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-automatic-probe-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const first = await enqueueLunaOperation({
    runtimeRoot,
    kind: "distill_batch",
    idempotencyKey: "automatic-probe:first",
    payload: { batchId: "first" },
    createdAt: "2026-08-07T06:00:00.000Z"
  });
  await enqueueLunaOperation({
    runtimeRoot,
    kind: "distill_batch",
    idempotencyKey: "automatic-probe:second",
    payload: { batchId: "second" },
    createdAt: "2026-08-07T06:00:01.000Z"
  });
  const failedClaim = await claimLunaOperation({
    runtimeRoot, workerId: "worker-1", now: "2026-08-07T06:00:02.000Z", leaseSeconds: 60
  });
  if (failedClaim.state !== "claimed") throw new Error("Expected failed claim.");
  await failLunaOperation({
    runtimeRoot,
    operationId: first.operationId,
    leaseToken: failedClaim.leaseToken,
    failedAt: "2026-08-07T06:00:03.000Z",
    error: new LunaInvocationError("invalid_model", false, "model missing")
  });
  await retryBlockedLunaOperations({
    runtimeRoot,
    requestedAt: "2026-08-07T06:00:04.000Z"
  });

  const probeClaim = await claimLunaOperation({
    runtimeRoot, workerId: "worker-1", now: "2026-08-07T06:00:05.000Z", leaseSeconds: 60
  });
  if (probeClaim.state !== "claimed") throw new Error("Expected probe claim.");
  await completeLunaOperation({
    runtimeRoot,
    operationId: probeClaim.operation.operationId,
    leaseToken: probeClaim.leaseToken,
    completedAt: "2026-08-07T06:00:06.000Z"
  });
  await expect(inspectLunaHealth({
    runtimeRoot,
    now: "2026-08-07T06:00:07.000Z"
  })).resolves.toMatchObject({ state: "unavailable", lastSuccessAt: "2026-08-07T06:00:06.000Z" });

  const recoveryClaim = await claimLunaOperation({
    runtimeRoot, workerId: "worker-1", now: "2026-08-07T06:00:08.000Z", leaseSeconds: 60
  });
  if (recoveryClaim.state !== "claimed") throw new Error("Expected recovery claim.");
  await completeLunaOperation({
    runtimeRoot,
    operationId: recoveryClaim.operation.operationId,
    leaseToken: recoveryClaim.leaseToken,
    completedAt: "2026-08-07T06:00:09.000Z"
  });
  await expect(inspectLunaHealth({
    runtimeRoot,
    now: "2026-08-07T06:00:10.000Z"
  })).resolves.toMatchObject({ state: "healthy", reasonCategory: null, consecutiveFailures: 0 });
});
