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
import { prepareSessionStartShadowPack } from "../../../src/retrieval/packs.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
