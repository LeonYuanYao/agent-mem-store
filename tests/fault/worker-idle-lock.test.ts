import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { initializeMemStore } from "../../src/operations/initialize.js";
import { RecordingNotifier } from "../../src/adapters/macos/notifier.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";
import { runWorkerOnce, type WorkerAdapters } from "../../src/worker/main.js";
import type { EmbeddingAdapter } from "../../src/retrieval/index.js";
import type { GovernanceAdapter } from "../../src/governance/worker.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

test("an idle Worker iteration does not request the Runtime SQLite write lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-worker-idle-lock-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "initialization-worker",
    now: "2026-08-22T01:59:00.000Z",
    workerStartedAt: "2026-08-22T01:58:00.000Z"
  });

  const lock = await openRuntimeDatabase(runtimeRoot);
  lock.exec("BEGIN IMMEDIATE");
  try {
    await expect(runWorkerOnce({
      runtimeRoot,
      vaultRoot,
      workerId: "idle-worker",
      now: "2026-08-22T02:00:00.000Z",
      workerStartedAt: "2026-08-22T01:59:00.000Z"
    })).resolves.toEqual({ state: "idle" });
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
});

test("configured Luna lanes do not request the write lock when every queue is empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-worker-idle-luna-lock-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const luna = {
    distillBatch: () => Promise.reject(new Error("No distillation is expected.")),
    consolidateSession: () => Promise.reject(new Error("No consolidation is expected.")),
    assessCandidateSemantics: () => Promise.reject(new Error("No assessment is expected.")),
    assessHumanConflict: () => Promise.reject(new Error("No conflict is expected."))
  } satisfies NonNullable<WorkerAdapters["luna"]>;
  await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "initialization-worker",
    now: "2026-08-22T02:09:00.000Z",
    workerStartedAt: "2026-08-22T02:08:00.000Z",
    adapters: { luna }
  });

  const lock = await openRuntimeDatabase(runtimeRoot);
  lock.exec("BEGIN IMMEDIATE");
  try {
    await expect(runWorkerOnce({
      runtimeRoot,
      vaultRoot,
      workerId: "idle-luna-worker",
      now: "2026-08-22T02:10:00.000Z",
      workerStartedAt: "2026-08-22T02:08:00.000Z",
      adapters: { luna }
    })).resolves.toEqual({ state: "idle" });
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
});

test("configured Shadow retrieval does not request the write lock without eligible events", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-worker-idle-shadow-lock-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const embedding: EmbeddingAdapter = {
    identity: {
      adapterVersion: "idle-lock-v1",
      modelIdentity: "idle-lock-fixture",
      artifactSha256: "a".repeat(64),
      dimensions: 2,
      normalization: "l2"
    },
    embed: (texts) => Promise.resolve(texts.map(() => [1, 0]))
  };
  await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "initialization-worker",
    now: "2026-08-22T02:19:00.000Z",
    workerStartedAt: "2026-08-22T02:18:00.000Z",
    adapters: { embedding }
  });

  const lock = await openRuntimeDatabase(runtimeRoot);
  lock.exec("BEGIN IMMEDIATE");
  try {
    await expect(runWorkerOnce({
      runtimeRoot,
      vaultRoot,
      workerId: "idle-shadow-worker",
      now: "2026-08-22T02:20:00.000Z",
      workerStartedAt: "2026-08-22T02:18:00.000Z",
      adapters: { embedding }
    })).resolves.toEqual({ state: "idle" });
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
});

test("configured quality lanes do not request the write lock when every queue is empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-worker-idle-quality-lock-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const quality = {
    generateCompacts: () => Promise.reject(new Error("No compact generation is expected.")),
    validateCompacts: () => Promise.reject(new Error("No compact validation is expected.")),
    assessDuplicateClusters: () => Promise.reject(new Error("No duplicate assessment is expected."))
  } satisfies NonNullable<WorkerAdapters["quality"]>;
  await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "initialization-worker",
    now: "2026-08-22T02:29:00.000Z",
    workerStartedAt: "2026-08-22T02:28:00.000Z",
    adapters: { quality }
  });

  const lock = await openRuntimeDatabase(runtimeRoot);
  lock.exec("BEGIN IMMEDIATE");
  try {
    await expect(runWorkerOnce({
      runtimeRoot,
      vaultRoot,
      workerId: "idle-quality-worker",
      now: "2026-08-22T02:30:00.000Z",
      workerStartedAt: "2026-08-22T02:28:00.000Z",
      adapters: { quality }
    })).resolves.toEqual({ state: "idle" });
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
});

test("configured notifications do not request the write lock when no reminder is due", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-worker-idle-notifier-lock-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const notifier = new RecordingNotifier();
  await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "initialization-worker",
    now: "2026-08-22T02:39:00.000Z",
    workerStartedAt: "2026-08-22T02:38:00.000Z",
    adapters: { notifier }
  });

  const lock = await openRuntimeDatabase(runtimeRoot);
  lock.exec("BEGIN IMMEDIATE");
  try {
    await expect(runWorkerOnce({
      runtimeRoot,
      vaultRoot,
      workerId: "idle-notifier-worker",
      now: "2026-08-22T02:40:00.000Z",
      workerStartedAt: "2026-08-22T02:38:00.000Z",
      adapters: { notifier }
    })).resolves.toEqual({ state: "idle" });
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
  expect(notifier.deliveries).toHaveLength(0);
});

test("configured governance does not request the write lock between due windows", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-worker-idle-governance-lock-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const governance: GovernanceAdapter = {
    reviewPage: () => Promise.reject(new Error("No governance review is expected."))
  };
  await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "initialization-worker",
    now: "2026-08-22T02:49:00.000Z",
    workerStartedAt: "2026-08-22T02:48:00.000Z",
    adapters: { governance }
  });

  const lock = await openRuntimeDatabase(runtimeRoot);
  lock.exec("BEGIN IMMEDIATE");
  try {
    await expect(runWorkerOnce({
      runtimeRoot,
      vaultRoot,
      workerId: "idle-governance-worker",
      now: "2026-08-22T02:50:00.000Z",
      workerStartedAt: "2026-08-22T02:48:00.000Z",
      adapters: { governance }
    })).resolves.toEqual({ state: "idle" });
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
});
