import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { handleCodexHook } from "../../../src/adapters/codex/hook.js";
import {
  buildRetrievalIndex,
  inspectActiveRetrievalIndex,
  pruneRetiredRetrievalSnapshots,
  type EmbeddingAdapter
} from "../../../src/retrieval/index.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";
import {
  beginRetrievalIndexBuild,
  completeRetrievalIndexBuild,
  inspectRetrievalCatalogGeneration
} from "../../../src/retrieval/index-coordinator.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const adapter: EmbeddingAdapter = {
  identity: {
    adapterVersion: "fixture-v1",
    modelIdentity: "fixture-embedding",
    artifactSha256: "b".repeat(64),
    dimensions: 3,
    normalization: "l2"
  },
  embed: (texts) => Promise.resolve(texts.map((text) =>
    text.includes("SQLite") ? [1, 0, 0] : [0, 1, 0]
  ))
};

test("a complete retrieval index revision publishes active Canonical Memory atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-index-build-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memories = [
    makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174101",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174111",
      body: "Use SQLite WAL for durable local state.",
      compact: "Use SQLite WAL for durable state."
    }),
    makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174102",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174112",
      body: "This archived rule must not be retrieved.",
      lifecycle: "archived"
    })
  ];
  for (const memory of memories) {
    await writeCanonicalMemory({ vaultRoot, runtimeRoot, actor: "human", memory });
  }

  const built = await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter,
    builtAt: "2026-08-07T10:00:00.000Z"
  });

  expect(built).toMatchObject({ state: "published", documentCount: 1, semanticReady: true });
  await expect(inspectActiveRetrievalIndex(runtimeRoot)).resolves.toEqual({
    indexRevisionId: built.indexRevisionId,
    documentCount: 1,
    semanticReady: true,
    adapterIdentity: adapter.identity
  });
});

test("a new index revision embeds only Canonical Memory missing from the compatible active index", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-index-incremental-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const embeddedBatches: string[][] = [];
  const incrementalAdapter: EmbeddingAdapter = {
    ...adapter,
    embed: (texts) => {
      embeddedBatches.push([...texts]);
      return Promise.resolve(texts.map((text) => text.includes("SQLite") ? [1, 0, 0] : [0, 1, 0]));
    }
  };
  const firstMemories = [
    makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174201",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174211",
      body: "Use SQLite WAL for durable local state."
    }),
    makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174202",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174212",
      body: "Keep program and data lifecycles separate."
    })
  ];
  for (const memory of firstMemories) {
    await writeCanonicalMemory({ vaultRoot, runtimeRoot, actor: "human", memory });
  }
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: incrementalAdapter,
    builtAt: "2026-08-07T10:00:00.000Z"
  });

  await writeCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174203",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174213",
      body: "Capture hooks must stay non-blocking."
    })
  });
  const rebuilt = await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: incrementalAdapter,
    builtAt: "2026-08-07T10:01:00.000Z"
  });

  expect(embeddedBatches.map((batch) => batch.length)).toEqual([2, 1]);
  expect(rebuilt.documentCount).toBe(3);
  await expect(inspectActiveRetrievalIndex(runtimeRoot)).resolves.toMatchObject({
    indexRevisionId: rebuilt.indexRevisionId,
    documentCount: 3
  });

  let incompatibleEmbeddingCount = 0;
  const incompatibleAdapter: EmbeddingAdapter = {
    ...incrementalAdapter,
    identity: {
      ...incrementalAdapter.identity,
      adapterVersion: "fixture-batch16-v2"
    },
    embed: (texts) => {
      incompatibleEmbeddingCount += texts.length;
      return Promise.resolve(texts.map(() => [1, 0, 0]));
    }
  };
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: incompatibleAdapter,
    builtAt: "2026-08-07T10:02:00.000Z"
  });
  expect(incompatibleEmbeddingCount).toBe(3);
});

test("retrieval index document embeddings are submitted in batches of at most sixteen", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-index-batch16-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const batchSizes: number[] = [];
  const batchAdapter: EmbeddingAdapter = {
    ...adapter,
    identity: { ...adapter.identity, adapterVersion: "fixture-explicit-batch16-v1" },
    embed: (texts) => {
      batchSizes.push(texts.length);
      return Promise.resolve(texts.map(() => [1, 0, 0]));
    }
  };
  for (let ordinal = 0; ordinal < 17; ordinal += 1) {
    const suffix = String(ordinal).padStart(3, "0");
    await writeCanonicalMemory({
      runtimeRoot,
      vaultRoot,
      actor: "human",
      memory: makeCanonicalMemory({
        memoryId: `msmem_123e4567-e89b-42d3-a456-426614175${suffix}`,
        revisionId: `msrev_123e4567-e89b-42d3-a456-426614175${suffix}`,
        body: `Batch-bounded retrieval document ${suffix}.`
      })
    });
  }

  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: batchAdapter,
    builtAt: "2026-08-07T10:03:00.000Z"
  });
  expect(batchSizes).toEqual([16, 1]);
});

test("a catalog change during a build leaves one consistent follow-up generation due", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-index-follow-up-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614175101",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614175111",
      body: "The build captures this first immutable revision."
    })
  });
  const lease = await beginRetrievalIndexBuild({
    runtimeRoot,
    now: "2026-08-07T10:10:00.000Z",
    activeIndexExists: false,
    adapterMatches: false,
    foregroundPressure: false
  });
  if (lease.state !== "started") throw new Error("Expected the initial generation lease.");
  let releaseEmbedding: (() => void) | undefined;
  let notifyEmbeddingStarted: (() => void) | undefined;
  const embeddingStarted = new Promise<void>((resolve) => { notifyEmbeddingStarted = resolve; });
  const embeddingReleased = new Promise<void>((resolve) => { releaseEmbedding = resolve; });
  const blockingAdapter: EmbeddingAdapter = {
    ...adapter,
    identity: { ...adapter.identity, adapterVersion: "fixture-follow-up-v1" },
    embed: async (texts) => {
      notifyEmbeddingStarted?.();
      await embeddingReleased;
      return texts.map(() => [1, 0, 0]);
    }
  };
  const building = buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: blockingAdapter,
    builtAt: "2026-08-07T10:10:01.000Z"
  });
  await embeddingStarted;
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614175102",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614175112",
      body: "This later revision belongs to the follow-up generation."
    })
  });
  releaseEmbedding?.();
  const published = await building;
  await completeRetrievalIndexBuild({
    runtimeRoot,
    targetGeneration: lease.targetGeneration,
    completedAt: "2026-08-07T10:10:02.000Z"
  });

  expect(published.documentCount).toBe(1);
  await expect(inspectRetrievalCatalogGeneration(runtimeRoot)).resolves.toMatchObject({
    dirtyGeneration: 2,
    publishedGeneration: 1,
    buildingGeneration: null
  });
});

test("index publication yields between bounded batches while the previous index stays active", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-index-publication-yield-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const firstMemory = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174301",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174311",
    body: "The foreground capture path must stay available."
  });
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: firstMemory
  });
  const firstIndex = await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter,
    builtAt: "2026-08-07T11:00:00.000Z"
  });
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174302",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174312",
      body: "Retrieval metadata is published in bounded batches."
    })
  });

  let capturedDuringPublication = false;
  const rebuilt = await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter,
    builtAt: "2026-08-07T11:01:00.000Z",
    publicationBatchSize: 1,
    onPublicationBatchCommitted: async (publishedDocumentCount) => {
      if (publishedDocumentCount !== 1) return;
      await expect(inspectActiveRetrievalIndex(runtimeRoot)).resolves.toMatchObject({
        indexRevisionId: firstIndex.indexRevisionId
      });
      const capture = await handleCodexHook({
        runtimeRoot,
        receivedAt: "2026-08-07T11:01:01.000Z",
        input: {
          hook_event_name: "PostToolUse",
          session_id: "index-publication-session",
          turn_id: "index-publication-turn",
          cwd: root,
          tool_name: "exec_command",
          tool_use_id: "index-publication-tool",
          tool_input: { cmd: "git status --short" },
          tool_response: { exit_code: 0 }
        }
      });
      expect(capture).toMatchObject({ captured: true, state: "captured" });
      capturedDuringPublication = true;
    }
  });

  expect(capturedDuringPublication).toBe(true);
  await expect(inspectActiveRetrievalIndex(runtimeRoot)).resolves.toMatchObject({
    indexRevisionId: rebuilt.indexRevisionId,
    documentCount: 2
  });
});

test("retired retrieval snapshots are pruned in bounded batches without deleting audit metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-index-pruning-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memory = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174351",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174361",
    body: "Retired snapshots must not accumulate forever."
  });
  await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "human", memory });
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174352",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174362",
      body: "Snapshot cleanup must yield between bounded FTS batches."
    })
  });
  const retired = await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter,
    builtAt: "2026-08-07T11:10:00.000Z"
  });
  const active = await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter,
    builtAt: "2026-08-07T11:11:00.000Z"
  });

  await expect(pruneRetiredRetrievalSnapshots({
    runtimeRoot,
    maximumSnapshots: 1,
    prunedAt: "2026-08-07T11:12:00.000Z"
  })).resolves.toEqual({ selectedCount: 1, prunedCount: 1, failedCount: 0 });

  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM retrieval_documents WHERE index_revision_id = ?"
    ).get(retired.indexRevisionId)?.count).toBe(0);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM active_fts_memories WHERE index_revision_id = ?"
    ).get(active.indexRevisionId)?.count).toBe(2);
    expect(database.prepare(
      "SELECT snapshot_pruned_at FROM retrieval_index_revisions WHERE index_revision_id = ?"
    ).get(retired.indexRevisionId)?.snapshot_pruned_at).toBe("2026-08-07T11:12:00.000Z");
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM retrieval_documents WHERE index_revision_id = ?"
    ).get(active.indexRevisionId)?.count).toBe(2);
  } finally {
    database.close();
  }
  await expect(access(join(runtimeRoot, "indexes", retired.indexRevisionId))).rejects.toThrow();
});
