import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { captureEvent, inspectCaptureEventState } from "../../../src/capture/index.js";
import {
  enqueueCompactBackfill,
  inspectMemoryQualityPipeline,
  runNextMemoryQualityStep,
  scheduleCompactQuality,
  type MemoryQualityAdapter
} from "../../../src/quality/pipeline.js";
import { readCanonicalMemory, writeCanonicalMemory } from "../../../src/vault/index.js";
import { runWorkerOnce, type WorkerAdapters } from "../../../src/worker/main.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("compact backfill publishes only after a separate fidelity assessment", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-quality-pipeline-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memoryId = "msmem_123e4567-e89b-42d3-a456-426614174081";
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory: makeCanonicalMemory({
      memoryId,
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174081",
      authority: "agent_derived",
      body: "When publishing a release, run typecheck first and never skip the migration verification.",
      validatedCompact: false
    })
  });
  const calls: string[] = [];
  const adapter: MemoryQualityAdapter = {
    generateCompacts: (request) => {
      calls.push("generate");
      return Promise.resolve({
        schemaVersion: 1,
        kind: "compact_generation",
        items: request.memories.map((memory) => ({
          memoryId: memory.memoryId,
          compactText: "Before release, run typecheck and never skip migration verification."
        }))
      });
    },
    validateCompacts: (request) => {
      calls.push("validate");
      return Promise.resolve({
        schemaVersion: 1,
        kind: "compact_validation",
        items: request.memories.map((memory) => ({
          memoryId: memory.memoryId,
          state: "preserves" as const,
          reasonCode: "all_material_facts_preserved"
        }))
      });
    }
  };

  await expect(enqueueCompactBackfill({
    runtimeRoot,
    vaultRoot,
    requestedAt: "2026-08-18T23:00:00.000Z",
    preview: true
  })).resolves.toMatchObject({ state: "preview", eligibleCount: 1, enqueuedCount: 0 });
  await expect(inspectMemoryQualityPipeline({ runtimeRoot })).resolves.toMatchObject({ totalCount: 0 });
  await expect(enqueueCompactBackfill({
    runtimeRoot,
    vaultRoot,
    requestedAt: "2026-08-18T23:00:00.000Z",
    preview: false
  })).resolves.toMatchObject({ state: "enqueued", eligibleCount: 1, enqueuedCount: 1 });

  await expect(runNextMemoryQualityStep({
    runtimeRoot,
    vaultRoot,
    workerId: "quality-worker",
    now: "2026-08-18T23:00:01.000Z",
    adapter
  })).resolves.toMatchObject({ state: "generated", itemCount: 1 });
  const afterGeneration = await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId });
  expect(afterGeneration?.memory.representations.compact.validated).toBe(false);

  await expect(runNextMemoryQualityStep({
    runtimeRoot,
    vaultRoot,
    workerId: "quality-worker",
    now: "2026-08-18T23:00:02.000Z",
    adapter
  })).resolves.toMatchObject({ state: "published", itemCount: 1 });
  expect(calls).toEqual(["generate", "validate"]);
  const published = await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId });
  expect(published?.memory.revisionId).not.toBe(afterGeneration?.memory.revisionId);
  expect(published?.memory.representations.compact).toMatchObject({
    text: "Before release, run typecheck and never skip migration verification.",
    validated: true,
    sourceRevisionId: published?.memory.revisionId
  });
  await expect(inspectMemoryQualityPipeline({ runtimeRoot })).resolves.toMatchObject({
    completedCount: 1,
    pendingCount: 0
  });
});

test("a recent incomplete Turn does not starve a due quality scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-quality-fairness-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174082",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174082",
      authority: "agent_derived",
      body: "Keep quality work moving while an active Turn waits for Stop.",
      validatedCompact: false
    })
  });
  await scheduleCompactQuality({
    runtimeRoot,
    requestedAt: "2026-08-18T20:00:00.000Z",
    preview: false
  });
  const eventId = "msevent_quality_fairness_recent_turn";
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId,
      deduplicationKey: "codex:quality-fairness:recent-turn",
      agent: "codex",
      eventKind: "PostToolUse",
      occurredAt: "2026-08-18T20:59:50.000Z",
      projectId: "msproj_quality_fairness",
      sessionId: "quality-fairness-session",
      turnId: "quality-fairness-turn",
      payload: { output: "The active Turn has not stopped yet." }
    }
  });
  const quality = {
    generateCompacts: (request) => Promise.resolve({
      schemaVersion: 1 as const,
      kind: "compact_generation" as const,
      items: request.memories.map((memory) => ({
        memoryId: memory.memoryId,
        compactText: memory.body
      }))
    }),
    validateCompacts: () => Promise.reject(new Error("Validation is not expected.")),
    assessDuplicateClusters: () => Promise.reject(new Error("Duplicates are not expected."))
  } satisfies NonNullable<WorkerAdapters["quality"]>;

  await expect(runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "quality-fairness-worker",
    now: "2026-08-18T21:00:00.000Z",
    workerStartedAt: "2026-08-18T19:00:00.000Z",
    adapters: { quality }
  })).resolves.toEqual({
    state: "worked",
    activities: ["memory-quality-discovery:completed", "memory-quality:generated"]
  });
  await expect(inspectCaptureEventState(runtimeRoot, eventId)).resolves.toMatchObject({
    state: "pending"
  });
});
