import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  claimLunaOperation,
  completeLunaOperation,
  enqueueLunaOperation,
  failLunaOperation,
  inspectLunaHealth,
  recordLunaHealthProbe,
  retryBlockedLunaOperations
} from "../../src/luna/operations.js";
import { LunaInvocationError } from "../../src/luna/index.js";

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
