import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  buildRetrievalIndex,
  inspectActiveRetrievalIndex,
  type EmbeddingAdapter
} from "../../../src/retrieval/index.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

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
