import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  buildRetrievalIndex,
  inspectActiveRetrievalIndex,
  type EmbeddingAdapter
} from "../../src/retrieval/index.js";
import { writeCanonicalMemory } from "../../src/vault/index.js";
import { makeCanonicalMemory } from "../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const identity = {
  adapterVersion: "fixture-v1",
  modelIdentity: "fixture-embedding",
  artifactSha256: "b".repeat(64),
  dimensions: 2,
  normalization: "l2" as const
};

test("a failed semantic rebuild leaves the last complete retrieval index active", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-index-fault-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174501",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174511",
      body: "Keep the last complete index readable."
    })
  });
  const healthy: EmbeddingAdapter = {
    identity,
    embed: (texts) => Promise.resolve(texts.map(() => [1, 0]))
  };
  const first = await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: healthy,
    builtAt: "2026-08-07T13:00:00.000Z"
  });
  const failing: EmbeddingAdapter = {
    identity,
    embed: () => Promise.reject(new Error("model artifact unavailable"))
  };

  await expect(buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: failing,
    builtAt: "2026-08-07T13:01:00.000Z"
  })).rejects.toThrow("model artifact unavailable");
  await expect(inspectActiveRetrievalIndex(runtimeRoot)).resolves.toMatchObject({
    indexRevisionId: first.indexRevisionId,
    documentCount: 1
  });
});
