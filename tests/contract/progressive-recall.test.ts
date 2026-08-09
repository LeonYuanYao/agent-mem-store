import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { buildRetrievalIndex, type EmbeddingAdapter } from "../../src/retrieval/index.js";
import {
  recallProvenance,
  recallRelated,
  recallSearch,
  recallShow,
  reportIrrelevant
} from "../../src/retrieval/recall.js";
import { writeCanonicalMemory } from "../../src/vault/index.js";
import { makeCanonicalMemory } from "../helpers/canonical-memory.js";

const roots: string[] = [];
const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const adapter: EmbeddingAdapter = {
  identity: {
    adapterVersion: "fixture-v1",
    modelIdentity: "fixture-embedding",
    artifactSha256: "b".repeat(64),
    dimensions: 2,
    normalization: "l2"
  },
  embed: (texts) => Promise.resolve(
    texts.map((text) => /sqlite|database/iu.test(text) ? [1, 0] : [0, 1])
  )
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memstore-progressive-recall-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const targetId = "msmem_123e4567-e89b-42d3-a456-426614174302";
  const source = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174301",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174311",
    body: "Use SQLite WAL for the database.",
    compact: "Use SQLite WAL.",
    scope: { kind: "project", projectId },
    relationships: [{ type: "supports", targetMemoryId: targetId }]
  });
  const target = makeCanonicalMemory({
    memoryId: targetId,
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174312",
    body: "Keep database transactions short.",
    compact: "Keep transactions short.",
    scope: { kind: "project", projectId }
  });
  for (const memory of [source, target]) {
    await writeCanonicalMemory({ vaultRoot, runtimeRoot, actor: "human", memory });
  }
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter,
    builtAt: "2026-08-07T11:00:00.000Z"
  });
  return { runtimeRoot, vaultRoot, source, target };
}

test("explicit provenance and relationships page identity-bearing records one hop at a time", async () => {
  const data = await fixture();
  const provenance = await recallProvenance({
    ...data,
    memoryId: data.source.memoryId,
    callerIdentity: "codex:test-session",
    requestedAt: "2026-08-07T11:01:00.000Z"
  });
  expect(provenance.items).toEqual([{ sourceIdentity: "fixture:source" }]);

  const related = await recallRelated({
    ...data,
    memoryId: data.source.memoryId,
    direction: "outgoing",
    callerIdentity: "codex:test-session",
    requestedAt: "2026-08-07T11:01:01.000Z"
  });
  expect(related.items).toEqual([
    expect.objectContaining({
      direction: "outgoing",
      relationshipType: "supports",
      memoryId: data.target.memoryId,
      revisionId: data.target.revisionId,
      description: "Keep transactions short."
    })
  ]);
});

test("irrelevant reports are receipt-bound, idempotent, and aggregate a bounded Bad Case outside the Vault", async () => {
  const data = await fixture();
  const search = await recallSearch({
    ...data,
    query: "SQLite database",
    scope: "current",
    currentProjectId: projectId,
    callerIdentity: "codex:test-session",
    adapter,
    requestedAt: "2026-08-07T11:02:00.000Z"
  });
  const memoryId = search.items[0]?.memoryId;
  if (memoryId === undefined) throw new Error("Expected a search result.");

  const first = await reportIrrelevant({
    runtimeRoot: data.runtimeRoot,
    receiptId: search.receiptId,
    memoryId,
    callerIdentity: "codex:test-session",
    observedAt: "2026-08-07T11:02:01.000Z"
  });
  const duplicate = await reportIrrelevant({
    runtimeRoot: data.runtimeRoot,
    receiptId: search.receiptId,
    memoryId,
    callerIdentity: "codex:test-session",
    observedAt: "2026-08-07T11:02:02.000Z"
  });

  expect(duplicate).toEqual(first);
  expect(first).toMatchObject({ occurrenceCount: 1, repairState: "open" });
  await expect(access(first.diagnosticBundlePath)).resolves.toBeUndefined();
  const bundle = await readFile(first.diagnosticBundlePath, "utf8");
  expect(bundle).toContain(search.receiptId);
  expect(bundle).not.toContain(data.source.body);
  expect(first.diagnosticBundlePath.startsWith(data.vaultRoot)).toBe(false);
});

test("explicit deep reads warn at cumulative token bands without imposing a product hard limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-explicit-chain-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memory = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174321",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174331",
    scope: { kind: "project", projectId },
    body: "detail ".repeat(9000),
    compact: "Large diagnostic reference."
  });
  await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "human", memory });
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter,
    builtAt: "2026-08-07T11:03:00.000Z"
  });

  const first = await recallShow({
    runtimeRoot,
    vaultRoot,
    memoryId: memory.memoryId,
    detail: "full",
    currentProjectId: projectId,
    callerIdentity: "codex:test-session",
    requestedAt: "2026-08-07T11:03:01.000Z"
  });
  expect(first.body).toBe(memory.body.trimEnd());
  expect(first.cumulativeTokenCount).toBeGreaterThan(8192);
  expect(first.warning).toContain("8,192");

  const second = await recallShow({
    runtimeRoot,
    vaultRoot,
    memoryId: memory.memoryId,
    detail: "full",
    currentProjectId: projectId,
    callerIdentity: "codex:test-session",
    chainId: first.chainId,
    requestedAt: "2026-08-07T11:03:02.000Z"
  });
  expect(second.body).toBe(memory.body.trimEnd());
  expect(second.cumulativeTokenCount).toBeGreaterThan(16_384);
  expect(second.warning).toContain("16,384");
});
