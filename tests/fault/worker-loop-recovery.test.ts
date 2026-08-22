import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";

import { recordCaptureHealthIncident } from "../../src/capture/index.js";
import { initializeMemStore } from "../../src/operations/initialize.js";
import { inspectStatus } from "../../src/operations/status.js";
import type { EmbeddingAdapter } from "../../src/retrieval/index.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";
import { runWorker } from "../../src/worker/main.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("the continuous Worker survives one iteration failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-worker-loop-recovery-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });

  const controller = new AbortController();
  let identityReads = 0;
  const identity: EmbeddingAdapter["identity"] = {
    adapterVersion: "worker-loop-fixture-v1",
    modelIdentity: "worker-loop-fixture",
    artifactSha256: "a".repeat(64),
    dimensions: 2,
    normalization: "l2"
  };
  const embedding: EmbeddingAdapter = {
    get identity() {
      identityReads += 1;
      if (identityReads === 1) throw new Error("injected iteration failure");
      controller.abort();
      return identity;
    },
    embed: (texts) => Promise.resolve(texts.map(() => [1, 0]))
  };

  await expect(runWorker({
    runtimeRoot,
    vaultRoot,
    workerId: "worker-loop-recovery",
    startedAt: "2026-08-20T00:00:00.000Z",
    intervalMilliseconds: 100,
    signal: controller.signal,
    adapters: { embedding }
  })).resolves.toMatchObject({ state: "stopped", iterations: 2 });
  expect(identityReads).toBeGreaterThanOrEqual(2);

  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const incident = database.prepare(
      `SELECT category, occurrence_count, last_error_code, ended_at
       FROM capture_health_incidents WHERE category = 'worker_loop'`
    ).get() as unknown;
    const parsed = z.object({
      category: z.literal("worker_loop"),
      occurrence_count: z.literal(1),
      last_error_code: z.literal("worker_iteration_failed"),
      ended_at: z.iso.datetime()
    }).parse(incident);
    expect(parsed).toMatchObject({
      category: "worker_loop",
      occurrence_count: 1,
      last_error_code: "worker_iteration_failed"
    });
  } finally {
    database.close();
  }
  await expect(inspectStatus({ runtimeRoot, vaultRoot })).resolves.toMatchObject({
    worker: { health_incident: null }
  });
});

test("the continuous Worker backs off after consecutive idle iterations", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-worker-idle-backoff-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });

  const controller = new AbortController();
  const waits: number[] = [];
  const fallback = setTimeout(() => {
    controller.abort();
  }, 500);
  try {
    await expect(runWorker({
      runtimeRoot,
      vaultRoot,
      workerId: "worker-idle-backoff",
      startedAt: "2026-08-22T00:00:00.000Z",
      intervalMilliseconds: 100,
      signal: controller.signal,
      wait: (milliseconds) => {
        waits.push(milliseconds);
        if (waits.length === 4) controller.abort();
        return Promise.resolve();
      }
    })).resolves.toMatchObject({ state: "stopped", iterations: 4 });
  } finally {
    clearTimeout(fallback);
  }
  expect(waits).toEqual([500, 1_000, 3_000, 3_000]);
});

test("status exposes an unresolved body-free Worker loop incident", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-worker-loop-status-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  await recordCaptureHealthIncident({
    runtimeRoot,
    category: "worker_loop",
    errorCode: "worker_sqlite_busy",
    occurredAt: "2026-08-20T00:00:00.000Z"
  });

  await expect(inspectStatus({ runtimeRoot, vaultRoot })).resolves.toMatchObject({
    worker: {
      health_incident: {
        started_at: "2026-08-20T00:00:00.000Z",
        occurrence_count: 1,
        last_error_code: "worker_sqlite_busy"
      }
    }
  });
});
