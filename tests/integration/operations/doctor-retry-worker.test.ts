import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { initializeMemStore } from "../../../src/operations/initialize.js";
import { inspectDoctor, retryOperation } from "../../../src/operations/maintenance.js";
import { enqueueLunaOperation, claimLunaOperation, failLunaOperation } from "../../../src/luna/operations.js";
import { LunaInvocationError } from "../../../src/luna/index.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { runWorkerOnce } from "../../../src/worker/main.js";

const roots: string[] = [];

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
    ["sqlite_integrity", "ok"],
    ["candidate_pipeline", "ok"],
    ["vault_catalog", "ok"]
  ]);
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
  })).resolves.toEqual({ state: "queued", operationId: operation.operationId });
  await expect(runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "worker-test",
    now: "2026-08-08T05:02:00.000Z",
    workerStartedAt: "2026-08-08T04:00:00.000Z"
  })).resolves.toMatchObject({ state: "idle" });
});
