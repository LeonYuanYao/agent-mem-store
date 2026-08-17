import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { captureEvent } from "../../src/capture/index.js";
import type { EmbeddingAdapter } from "../../src/retrieval/index.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";
import { writeCanonicalMemory } from "../../src/vault/index.js";
import { runWorkerOnce, type WorkerAdapters } from "../../src/worker/main.js";
import { makeCanonicalMemory } from "../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("an embedding failure leaves the Worker running and cools down before another index attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-index-worker-fault-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174601",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174611",
      body: "A failed derived index must not stop durable capture."
    })
  });
  let attempts = 0;
  const embedding: EmbeddingAdapter = {
    identity: {
      adapterVersion: "failing-worker-fixture-v1",
      modelIdentity: "failing-worker-fixture",
      artifactSha256: "f".repeat(64),
      dimensions: 2,
      normalization: "l2"
    },
    embed: () => {
      attempts += 1;
      return Promise.reject(new Error("embedding allocation failed"));
    }
  };
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent_123e4567-e89b-42d3-a456-426614174621",
      deduplicationKey: "codex:retrieval-fault-session:stop",
      agent: "codex",
      eventKind: "Stop",
      occurredAt: "2026-08-17T19:59:00.000Z",
      projectId: "msproj_123e4567-e89b-42d3-a456-426614174620",
      sessionId: "retrieval-fault-session",
      payload: { assistantMessage: "The capture queue must continue after an index failure." }
    }
  });
  const luna = {
    distillBatch: () => Promise.resolve({
      schemaVersion: 1 as const,
      kind: "distillation" as const,
      candidates: []
    }),
    consolidateSession: () => Promise.reject(new Error("No consolidation is expected.")),
    assessCandidateSemantics: () => Promise.reject(new Error("No Candidate is expected.")),
    assessHumanConflict: () => Promise.reject(new Error("No Human conflict is expected."))
  } satisfies NonNullable<WorkerAdapters["luna"]>;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-17T20:00:00.000Z"));

  await expect(runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "retrieval-fault-worker",
    now: "2026-08-17T20:00:00.000Z",
    workerStartedAt: "2026-08-17T19:00:00.000Z",
    adapters: { embedding, luna }
  })).resolves.toEqual({
    state: "worked",
    activities: ["retrieval-index:failed", "distillation:queued", "luna:completed"]
  });
  await expect(runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "retrieval-fault-worker",
    now: "2026-08-17T20:01:00.000Z",
    workerStartedAt: "2026-08-17T19:00:00.000Z",
    adapters: { embedding, luna }
  })).resolves.toEqual({ state: "idle" });
  expect(attempts).toBe(1);
});

test("a recent index build blocks a duplicate Worker but a stale building record self-recovers", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-index-worker-stale-build-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174701",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174711",
      body: "An abandoned index build must recover without waiting for its long lease."
    })
  });
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare(
      `INSERT INTO retrieval_index_build_activity(
         singleton, build_id, state, started_at, lease_until, completed_at
       ) VALUES (1, 'abandoned-build', 'building', ?, ?, NULL)`
    ).run("2026-08-17T19:54:00.000Z", "2026-08-18T01:54:00.000Z");
  } finally {
    database.close();
  }
  let attempts = 0;
  const embedding: EmbeddingAdapter = {
    identity: {
      adapterVersion: "stale-build-fixture-v1",
      modelIdentity: "stale-build-fixture",
      artifactSha256: "a".repeat(64),
      dimensions: 2,
      normalization: "l2"
    },
    embed: (texts) => {
      attempts += 1;
      return Promise.resolve(texts.map(() => [1, 0]));
    }
  };

  await expect(runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "recent-build-worker",
    now: "2026-08-17T19:55:00.000Z",
    workerStartedAt: "2026-08-17T19:55:00.000Z",
    adapters: { embedding }
  })).resolves.toEqual({ state: "idle" });
  await expect(runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "stale-build-worker",
    now: "2026-08-17T20:00:00.000Z",
    workerStartedAt: "2026-08-17T20:00:00.000Z",
    adapters: { embedding }
  })).resolves.toEqual({
    state: "worked",
    activities: ["retrieval-index:published"]
  });
  expect(attempts).toBe(1);
});
