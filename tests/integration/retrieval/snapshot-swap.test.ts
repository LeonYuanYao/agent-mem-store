import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  buildRetrievalIndex,
  type EmbeddingAdapter
} from "../../../src/retrieval/index.js";
import {
  loadRetrievalSnapshot,
  snapshotMemoriesForProject
} from "../../../src/retrieval/snapshot.js";
import {
  prepareSessionStartShadowPack,
  prepareUserPromptShadowPack
} from "../../../src/retrieval/packs.js";
import { recallSearch } from "../../../src/retrieval/recall.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a foreground snapshot omits ranking exclusions while retaining the full indexed corpus", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-working-set-snapshot-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";
  const included = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614176101",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614176111",
    authority: "agent_derived",
    scope: { kind: "project", projectId },
    body: "The included automatic retrieval rule."
  });
  const excluded = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614176102",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614176112",
    authority: "agent_derived",
    scope: { kind: "project", projectId },
    body: "The cold durable retrieval rule."
  });
  await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "agent", memory: included });
  await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "agent", memory: excluded });
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter,
    builtAt: "2026-08-26T18:20:00.000Z"
  });
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare(
      `INSERT INTO memory_ranking_exclusions(
         memory_id, revision_id, space_key, reason, excluded_at, evaluated_at
       ) VALUES (?, ?, ?, 'capacity_cold', ?, ?)`
    ).run(
      excluded.memoryId,
      excluded.revisionId,
      `project:${projectId}`,
      "2026-08-26T18:21:00.000Z",
      "2026-08-26T18:21:00.000Z"
    );
  } finally {
    database.close();
  }

  const snapshot = await loadRetrievalSnapshot({ runtimeRoot });
  expect(snapshot.documents.map((memory) => memory.memoryId)).toEqual([
    included.memoryId,
    excluded.memoryId
  ]);
  expect(snapshotMemoriesForProject({
    snapshot,
    projectId,
    requestedAt: "2026-08-26T18:22:00.000Z"
  }).map((memory) => memory.memoryId)).toEqual([included.memoryId]);
  expect(snapshot.searchIndex.documentsByMemoryId.has(excluded.memoryId)).toBe(false);
  const sessionStart = await prepareSessionStartShadowPack({
    runtimeRoot,
    vaultRoot,
    projectId,
    sessionId: "working-set-automatic-boundary",
    requestedAt: "2026-08-26T18:22:05.000Z",
    snapshot
  });
  expect(sessionStart.items.map((item) => item.memoryId)).not.toContain(excluded.memoryId);
  const prompt = await prepareUserPromptShadowPack({
    runtimeRoot,
    vaultRoot,
    projectId,
    sessionId: "working-set-automatic-boundary",
    prompt: "cold durable retrieval rule",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter,
    requestedAt: "2026-08-26T18:22:10.000Z",
    snapshot
  });
  expect(prompt.items.map((item) => item.memoryId)).not.toContain(excluded.memoryId);

  const scopeDatabase = await openRuntimeDatabase(runtimeRoot);
  try {
    scopeDatabase.prepare(
      "UPDATE memory_ranking_exclusions SET space_key = 'project:another-project' WHERE memory_id = ?"
    ).run(excluded.memoryId);
  } finally {
    scopeDatabase.close();
  }
  const scopeSafeSnapshot = await loadRetrievalSnapshot({ runtimeRoot });
  expect(snapshotMemoriesForProject({
    snapshot: scopeSafeSnapshot,
    projectId,
    requestedAt: "2026-08-26T18:22:30.000Z"
  }).map((memory) => memory.memoryId)).toContain(excluded.memoryId);
  const restoreDatabase = await openRuntimeDatabase(runtimeRoot);
  try {
    restoreDatabase.prepare(
      "UPDATE memory_ranking_exclusions SET space_key = ? WHERE memory_id = ?"
    ).run(`project:${projectId}`, excluded.memoryId);
  } finally {
    restoreDatabase.close();
  }

  const explicit = await recallSearch({
    runtimeRoot,
    vaultRoot,
    query: "cold durable retrieval rule",
    scope: "current",
    currentProjectId: projectId,
    callerIdentity: "test:explicit-working-set",
    adapter,
    requestedAt: "2026-08-26T18:23:00.000Z"
  });
  expect(explicit.items.map((item) => item.memoryId)).toContain(excluded.memoryId);
  const reactivated = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(reactivated.prepare(
      "SELECT 1 FROM memory_ranking_exclusions WHERE memory_id = ?"
    ).get(excluded.memoryId)).toBeUndefined();
    expect(reactivated.prepare(
      "SELECT dirty_generation FROM memory_working_set_generations WHERE singleton = 1"
    ).get()?.dirty_generation).toBe(1);
  } finally {
    reactivated.close();
  }
});

const adapter: EmbeddingAdapter = {
  identity: {
    adapterVersion: "snapshot-fixture-v1",
    modelIdentity: "snapshot-fixture",
    artifactSha256: "c".repeat(64),
    dimensions: 3,
    normalization: "l2"
  },
  embed: (texts) => Promise.resolve(texts.map((_, ordinal) =>
    ordinal % 2 === 0 ? [1, 0, 0] : [0, 1, 0]
  ))
};

test("an immutable Retrieval Snapshot retains one revision across an active-index swap", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-retrieval-snapshot-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const first = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614176001",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614176011",
    body: "The first immutable retrieval document."
  });
  await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "human", memory: first });
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter,
    builtAt: "2026-08-26T18:10:00.000Z"
  });
  const oldSnapshot = await loadRetrievalSnapshot({ runtimeRoot });

  const second = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614176002",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614176012",
    body: "The second immutable retrieval document."
  });
  await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "human", memory: second });
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter,
    builtAt: "2026-08-26T18:11:00.000Z"
  });
  const newSnapshot = await loadRetrievalSnapshot({ runtimeRoot });

  expect(newSnapshot.indexRevisionId).not.toBe(oldSnapshot.indexRevisionId);
  expect(oldSnapshot.documents.map((document) => document.memoryId)).toEqual([first.memoryId]);
  expect(newSnapshot.documents.map((document) => document.memoryId)).toEqual([
    first.memoryId,
    second.memoryId
  ]);
  expect(snapshotMemoriesForProject({
    snapshot: oldSnapshot,
    projectId: "msproj_123e4567-e89b-42d3-a456-426614174001",
    requestedAt: "2026-08-26T18:12:00.000Z"
  }).map((memory) => memory.memoryId)).toEqual([first.memoryId]);

  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";
  const databaseBacked = await prepareSessionStartShadowPack({
    runtimeRoot,
    vaultRoot,
    projectId,
    sessionId: "snapshot-parity-database",
    requestedAt: "2026-08-26T18:12:00.000Z"
  });
  const snapshotBacked = await prepareSessionStartShadowPack({
    runtimeRoot,
    vaultRoot,
    projectId,
    sessionId: "snapshot-parity-memory",
    requestedAt: "2026-08-26T18:12:00.000Z",
    snapshot: newSnapshot
  });
  expect(snapshotBacked.items.map((item) => ({
    memoryId: item.memoryId,
    representationKind: item.representationKind,
    text: item.text
  }))).toEqual(databaseBacked.items.map((item) => ({
    memoryId: item.memoryId,
    representationKind: item.representationKind,
    text: item.text
  })));
  expect(snapshotBacked.renderedTokenCount).toBe(databaseBacked.renderedTokenCount);
});
