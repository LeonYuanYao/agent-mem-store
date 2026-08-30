import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  previewMemoryWorkingSet,
  rebalanceMemoryWorkingSet,
  selectMemoryWorkingSet,
  type WorkingSetMemory
} from "../../../src/capacity/index.js";
import { activateConfigurationDocument } from "../../../src/configuration/index.js";
import { initializeMemStore } from "../../../src/operations/initialize.js";
import { inspectStatus } from "../../../src/operations/status.js";
import {
  buildRetrievalIndex,
  type EmbeddingAdapter
} from "../../../src/retrieval/index.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { runWorkerOnce } from "../../../src/worker/main.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("the pure selector deterministically reduces a 2,948-memory Project to low water", () => {
  const memories: WorkingSetMemory[] = Array.from({ length: 2_948 }, (_, index) => ({
    memoryId: `msmem_${String(index).padStart(4, "0")}`,
    revisionId: `msrev_${String(index).padStart(4, "0")}`,
    lastActivityAt: index < 1_287
      ? "2026-08-29T00:00:00.000Z"
      : `2026-01-${String(index % 28 + 1).padStart(2, "0")}T00:00:00.000Z`,
    hardProtected: index < 100,
    softScore: index % 17
  }));
  const selected = selectMemoryWorkingSet({
    memories,
    limits: { target: 2_500, hardLimit: 3_500, lowWater: 2_200 },
    coldDays: 7,
    observedAt: "2026-08-30T00:00:00.000Z"
  });
  expect(selected.ranked).toHaveLength(2_200);
  expect(selected.excluded).toHaveLength(748);
  expect(selected.mandatoryCount).toBe(1_287);
  expect(selected.hardProtectedCount).toBe(100);
  expect(selectMemoryWorkingSet({
    memories: [...memories].reverse(),
    limits: { target: 2_500, hardLimit: 3_500, lowWater: 2_200 },
    coldDays: 7,
    observedAt: "2026-08-30T00:00:00.000Z"
  }).ranked.map((memory) => memory.memoryId)).toEqual(
    selected.ranked.map((memory) => memory.memoryId)
  );
});

test("hard protection and recent activity remain mandatory ahead of soft ranking", () => {
  const memories: WorkingSetMemory[] = [
    { memoryId: "hard", revisionId: "r1", lastActivityAt: "2025-01-01T00:00:00.000Z", hardProtected: true, softScore: 0 },
    { memoryId: "recent", revisionId: "r2", lastActivityAt: "2026-08-29T00:00:00.000Z", hardProtected: false, softScore: 0 },
    { memoryId: "soft-high", revisionId: "r3", lastActivityAt: "2025-02-01T00:00:00.000Z", hardProtected: false, softScore: 100 },
    { memoryId: "soft-middle", revisionId: "r5", lastActivityAt: "2025-02-01T00:00:00.000Z", hardProtected: false, softScore: 50 },
    { memoryId: "soft-low", revisionId: "r4", lastActivityAt: "2025-02-01T00:00:00.000Z", hardProtected: false, softScore: 1 }
  ];
  const selected = selectMemoryWorkingSet({
    memories,
    limits: { target: 4, hardLimit: 6, lowWater: 3 },
    coldDays: 7,
    observedAt: "2026-08-30T00:00:00.000Z"
  });
  expect(selected.ranked.map((memory) => memory.memoryId)).toEqual(["recent", "soft-high", "hard"]);
  expect(selected.excluded.map((memory) => memory.memoryId).sort()).toEqual(["soft-low", "soft-middle"]);
  expect(selected.lowWaterUnreachable).toBe(false);
});

async function configureWorkingSetCapacity(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
}): Promise<void> {
  const policyPath = join(request.vaultRoot, "_MemStore", "policy.toml");
  const source = (await readFile(policyPath, "utf8"))
    .replace("target = 2500", "target = 3")
    .replace("hard_limit = 3500", "hard_limit = 5")
    .replace("low_water = 2200", "low_water = 2");
  await activateConfigurationDocument({
    ...request,
    document: "policy",
    source,
    preview: false
  });
}

test("capacity rebalancing reversibly bounds automatic ranking without archiving knowledge", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-working-set-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174101";
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });

  for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
    const suffix = String(ordinal + 100).padStart(12, "0");
    await writeCanonicalMemory({
      runtimeRoot,
      vaultRoot,
      actor: "agent",
      memory: {
        ...makeCanonicalMemory({
          memoryId: `msmem_223e4567-e89b-42d3-a456-${suffix}`,
          revisionId: `msrev_323e4567-e89b-42d3-a456-${suffix}`,
          body: `Working-set rule ${String(ordinal)}.`,
          authority: "agent_derived",
          importanceTags: ordinal === 1 ? ["constraint"] : [],
          scope: { kind: "project", projectId }
        }),
        createdAt: `2026-08-0${String(ordinal)}T00:00:00.000Z`,
        revisedAt: `2026-08-0${String(ordinal)}T00:00:00.000Z`
      }
    });
  }

  const policy = {
    project: { target: 3, hardLimit: 5, lowWater: 2 },
    global: { target: 300, hardLimit: 500, lowWater: 270 },
    coldDays: 7,
    governanceBatchSize: 50
  } as const;
  const preview = await previewMemoryWorkingSet({
    runtimeRoot,
    vaultRoot,
    policy,
    scope: { kind: "project", projectId },
    observedAt: "2026-08-30T00:00:00.000Z"
  });
  expect(preview).toMatchObject({
    durableActiveAgentCount: 4,
    rankedActiveAgentCount: 2,
    excludedCount: 2,
    hardProtectedCount: 0,
    lowWaterUnreachable: false
  });
  expect(preview.rankedMemoryIds).toEqual([
    "msmem_223e4567-e89b-42d3-a456-000000000104",
    "msmem_223e4567-e89b-42d3-a456-000000000103"
  ]);

  await expect(rebalanceMemoryWorkingSet({
    runtimeRoot,
    vaultRoot,
    policy,
    scope: { kind: "project", projectId },
    observedAt: "2026-08-30T00:00:00.000Z"
  })).resolves.toMatchObject({ changed: true, excludedCount: 2 });

  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM memory_ranking_exclusions"
    ).get()?.count).toBe(2);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM memory_catalog WHERE lifecycle = 'active'"
    ).get()?.count).toBe(4);
  } finally {
    database.close();
  }
  await expect(inspectStatus({ runtimeRoot, vaultRoot })).resolves.toMatchObject({
    memory_capacity: {
      pressured_space_count: 0,
      spaces: [{
        scope: { kind: "project", project_id: projectId },
        durable_active_agent_count: 4,
        ranked_active_agent_count: 2,
        ranking_excluded_count: 2,
        state: "available"
      }]
    }
  });
  const excludedMemoryId = preview.excludedMemoryIds[0];
  if (excludedMemoryId === undefined) throw new Error("Expected one excluded Memory.");
  const reviewDatabase = await openRuntimeDatabase(runtimeRoot);
  try {
    reviewDatabase.prepare(
      `INSERT INTO governance_runs(
         run_id, run_kind, state, includes_weekly, weekly_from, monthly_from,
         coverage_through, recovered_occurrence_count, current_phase,
         created_at, updated_at, completed_at, capacity_triggered
       ) VALUES ('msgovrun_working_set_test', 'weekly', 'completed', 1,
                 '2026-08-01T00:00:00.000Z', NULL, '2026-08-30T00:00:00.000Z',
                 1, 'finalize', '2026-08-30T00:00:00.000Z',
                 '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z', 0)`
    ).run();
    reviewDatabase.prepare(
      `INSERT INTO governance_review_suggestions(
         suggestion_id, run_id, target_memory_id, suggestion_kind,
         reason, evidence_refs_json, state, created_at
       ) VALUES ('msgovsuggestion_working_set_test', 'msgovrun_working_set_test', ?,
                 'other', 'Needs review.', '["test"]', 'open',
                 '2026-08-30T00:01:00.000Z')`
    ).run(excludedMemoryId);
    expect(reviewDatabase.prepare(
      "SELECT 1 FROM memory_ranking_exclusions WHERE memory_id = ?"
    ).get(excludedMemoryId)).toBeUndefined();
    expect(reviewDatabase.prepare(
      "SELECT dirty_generation FROM memory_working_set_generations WHERE singleton = 1"
    ).get()?.dirty_generation).toBe(2);
  } finally {
    reviewDatabase.close();
  }
});

test("the Worker resolves capacity pressure locally without scheduling model governance", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-working-set-worker-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174102";
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  await configureWorkingSetCapacity({ runtimeRoot, vaultRoot });
  for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
    const suffix = String(ordinal + 110).padStart(12, "0");
    await writeCanonicalMemory({
      runtimeRoot,
      vaultRoot,
      actor: "agent",
      memory: {
        ...makeCanonicalMemory({
          memoryId: `msmem_423e4567-e89b-42d3-a456-${suffix}`,
          revisionId: `msrev_523e4567-e89b-42d3-a456-${suffix}`,
          body: `Worker capacity rule ${String(ordinal)}.`,
          authority: "agent_derived",
          scope: { kind: "project", projectId }
        }),
        createdAt: "2026-08-01T00:00:00.000Z",
        revisedAt: `2026-08-0${String(ordinal)}T00:00:00.000Z`
      }
    });
  }
  let embeddingCalls = 0;
  const embedding: EmbeddingAdapter = {
    identity: {
      adapterVersion: "working-set-fixture-v1",
      modelIdentity: "working-set-fixture",
      artifactSha256: "d".repeat(64),
      dimensions: 2,
      normalization: "l2"
    },
    embed: (texts) => {
      embeddingCalls += 1;
      return Promise.resolve(texts.map(() => [1, 0]));
    }
  };
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: embedding,
    builtAt: "2026-08-30T11:00:00.000Z"
  });
  const callsAfterBuild = embeddingCalls;
  let publishedDocumentCount = 0;
  let publishedEligibleCount = 0;

  const worked = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "working-set-test-worker",
    now: "2026-08-30T12:00:00.000Z",
    workerStartedAt: "2026-08-30T10:00:00.000Z",
    adapters: {
      publishRetrievalSnapshot(snapshot) {
        publishedDocumentCount = snapshot.documents.length;
        publishedEligibleCount = snapshot.automaticEligibleOrdinals.length;
        return Promise.resolve();
      }
    }
  });
  expect(worked).toMatchObject({ state: "worked" });
  expect(worked.activities).toContain("memory-working-set:project:2/4");
  expect(worked.activities).toContain("memory-working-set:published:1");
  expect(publishedDocumentCount).toBe(4);
  expect(publishedEligibleCount).toBe(2);
  expect(embeddingCalls).toBe(callsAfterBuild);
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM memory_ranking_exclusions"
    ).get()?.count).toBe(2);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM governance_runs WHERE capacity_triggered = 1"
    ).get()?.count).toBe(0);
    expect(database.prepare(
      "SELECT dirty_generation, published_generation FROM memory_working_set_generations WHERE singleton = 1"
    ).get()).toMatchObject({ dirty_generation: 1, published_generation: 1 });
  } finally {
    database.close();
  }
  const dirtyDatabase = await openRuntimeDatabase(runtimeRoot);
  try {
    dirtyDatabase.prepare(
      `UPDATE memory_working_set_generations
       SET dirty_generation = 2, dirty_at = '2026-08-30T12:01:00.000Z'
       WHERE singleton = 1`
    ).run();
  } finally {
    dirtyDatabase.close();
  }
  let publicationCalls = 0;
  const failedPublication = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "working-set-test-worker",
    now: "2026-08-30T12:01:00.000Z",
    workerStartedAt: "2026-08-30T10:00:00.000Z",
    adapters: {
      publishRetrievalSnapshot() {
        publicationCalls += 1;
        return Promise.reject(new Error("test publication failure"));
      }
    }
  });
  expect(failedPublication.activities).toContain(
    "memory-working-set:publication-deferred:2026-08-30T12:06:00.000Z"
  );
  await expect(readFile(join(vaultRoot, "_MemStore", "Review Inbox.md"), "utf8"))
    .resolves.toContain("Retrieval snapshot publication is deferred");
  const coolingDown = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "working-set-test-worker",
    now: "2026-08-30T12:02:00.000Z",
    workerStartedAt: "2026-08-30T10:00:00.000Z",
    adapters: {
      publishRetrievalSnapshot() {
        publicationCalls += 1;
        return Promise.resolve();
      }
    }
  });
  expect(coolingDown.activities ?? []).not.toContain("memory-working-set:published:2");
  expect(publicationCalls).toBe(1);
  const recoveredPublication = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "working-set-test-worker",
    now: "2026-08-30T12:06:00.000Z",
    workerStartedAt: "2026-08-30T10:00:00.000Z",
    adapters: {
      publishRetrievalSnapshot() {
        publicationCalls += 1;
        return Promise.resolve();
      }
    }
  });
  expect(recoveredPublication.activities).toContain("memory-working-set:published:2");
  expect(publicationCalls).toBe(2);
  await expect(readFile(join(vaultRoot, "_MemStore", "Review Inbox.md"), "utf8"))
    .resolves.not.toContain("Retrieval snapshot publication is deferred");
  const publicationDatabase = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(publicationDatabase.prepare(
      `SELECT published_generation, publication_next_retry_at, publication_failure_count,
              last_error
       FROM memory_working_set_generations WHERE singleton = 1`
    ).get()).toMatchObject({
      published_generation: 2,
      publication_next_retry_at: null,
      publication_failure_count: 0,
      last_error: null
    });
  } finally {
    publicationDatabase.close();
  }
  const periodic = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "working-set-test-worker",
    now: "2026-08-30T18:00:00.000Z",
    workerStartedAt: "2026-08-30T10:00:00.000Z"
  });
  expect(periodic.activities).toContain("memory-working-set:project:2/4");
});

test("a broken canonical file defers capacity with backoff instead of blocking the Worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-working-set-failure-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174104";
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  await configureWorkingSetCapacity({ runtimeRoot, vaultRoot });
  for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
    const suffix = String(ordinal + 130).padStart(12, "0");
    await writeCanonicalMemory({
      runtimeRoot,
      vaultRoot,
      actor: "agent",
      memory: {
        ...makeCanonicalMemory({
          memoryId: `msmem_823e4567-e89b-42d3-a456-${suffix}`,
          revisionId: `msrev_923e4567-e89b-42d3-a456-${suffix}`,
          authority: "agent_derived",
          scope: { kind: "project", projectId },
          body: `Broken-file capacity rule ${String(ordinal)}.`
        }),
        createdAt: "2026-08-01T00:00:00.000Z",
        revisedAt: "2026-08-01T00:00:00.000Z"
      }
    });
  }
  const database = await openRuntimeDatabase(runtimeRoot);
  let canonicalPath: string;
  try {
    canonicalPath = String(database.prepare(
      "SELECT canonical_path FROM memory_catalog ORDER BY memory_id LIMIT 1"
    ).get()?.canonical_path);
  } finally {
    database.close();
  }
  await unlink(canonicalPath);

  const first = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "working-set-failure-worker",
    now: "2026-08-30T12:00:00.000Z",
    workerStartedAt: "2026-08-30T10:00:00.000Z"
  });
  expect(first.activities).toContain("memory-working-set:project:deferred");
  const failedDatabase = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(failedDatabase.prepare(
      `SELECT last_error, consecutive_failure_count, next_review_at
       FROM memory_capacity_obligations WHERE space_key = ?`
    ).get(`project:${projectId}`)).toMatchObject({
      last_error: "working_set_rebalance_failed",
      consecutive_failure_count: 1,
      next_review_at: "2026-08-30T12:05:00.000Z"
    });
  } finally {
    failedDatabase.close();
  }
  const second = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "working-set-failure-worker",
    now: "2026-08-30T12:01:00.000Z",
    workerStartedAt: "2026-08-30T10:00:00.000Z"
  });
  expect(second.activities ?? []).not.toContain("memory-working-set:project:deferred");
});
