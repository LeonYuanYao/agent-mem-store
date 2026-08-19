import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { buildRetrievalIndex, type EmbeddingAdapter } from "../../src/retrieval/index.js";
import {
  CursorStaleError,
  recallSearch,
  recallShow
} from "../../src/retrieval/recall.js";
import { writeCanonicalMemory } from "../../src/vault/index.js";
import { makeCanonicalMemory } from "../helpers/canonical-memory.js";

const roots: string[] = [];
const projectA = "msproj_123e4567-e89b-42d3-a456-426614174001";
const projectB = "msproj_123e4567-e89b-42d3-a456-426614174002";

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
  embed: (texts) => Promise.resolve(texts.map((text) => {
    if (/sqlite|wal/iu.test(text)) return [1, 0, 0];
    if (/credential|secret/iu.test(text)) return [0, 1, 0];
    return [0, 0, 1];
  }))
};

async function createIndexedFixture(): Promise<{ runtimeRoot: string; vaultRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "memstore-recall-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memories = [
    makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174201",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174211",
      scope: { kind: "project", projectId: projectA },
      body: "Use SQLite WAL for durable local state.",
      compact: "Use SQLite WAL for durable state.",
      standard: "For durable local state, enable SQLite WAL and short transactions."
    }),
    makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174202",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174212",
      scope: { kind: "global" },
      body: "Never store credentials in long-term memory.",
      compact: "Never store credentials in memory."
    }),
    makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174203",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174213",
      scope: { kind: "project", projectId: projectB },
      body: "Use Maven for this unrelated project."
    })
  ];
  for (const memory of memories) {
    await writeCanonicalMemory({ vaultRoot, runtimeRoot, actor: "human", memory });
  }
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter,
    builtAt: "2026-08-07T10:00:00.000Z"
  });
  return { runtimeRoot, vaultRoot };
}

test("explicit recall searches current Project plus Global and deepens by Memory identity", async () => {
  const roots = await createIndexedFixture();
  const page = await recallSearch({
    ...roots,
    query: "SQLite WAL durability",
    scope: "current",
    currentProjectId: projectA,
    limit: 1,
    callerIdentity: "codex:test-session",
    adapter,
    requestedAt: "2026-08-07T10:01:00.000Z"
  });

  expect(page.items).toEqual([
    expect.objectContaining({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174201",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174211",
      scope: { kind: "project", projectId: projectA },
      authority: "human_authored",
      description: "Use SQLite WAL for durable state."
    })
  ]);
  expect(page.items.some((item) => item.scope.kind === "project" && item.scope.projectId === projectB)).toBe(false);
  expect(page.receiptId).toMatch(/^msreceipt_/u);

  const shown = await recallShow({
    ...roots,
    memoryId: page.items[0]?.memoryId ?? "",
    detail: "standard",
    callerIdentity: "codex:test-session",
    requestedAt: "2026-08-07T10:01:01.000Z"
  });
  expect(shown).toMatchObject({
    detail: "standard",
    body: "For durable local state, enable SQLite WAL and short transactions."
  });
});

test("an explicit search cursor is rejected when its query binding changes", async () => {
  const roots = await createIndexedFixture();
  const first = await recallSearch({
    ...roots,
    query: "durable memory",
    scope: "current",
    currentProjectId: projectA,
    limit: 1,
    callerIdentity: "codex:test-session",
    adapter,
    requestedAt: "2026-08-07T10:02:00.000Z"
  });
  expect(first.nextCursor).toBeDefined();
  if (first.nextCursor === undefined) throw new Error("Expected a continuation cursor.");

  await expect(recallSearch({
    ...roots,
    query: "different query",
    scope: "current",
    currentProjectId: projectA,
    limit: 1,
    cursor: first.nextCursor,
    callerIdentity: "codex:test-session",
    adapter,
    requestedAt: "2026-08-07T10:02:01.000Z"
  })).rejects.toBeInstanceOf(CursorStaleError);
});

test("explicit recall excludes knowledge outside its validity window", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-recall-validity-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const expired = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174204",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174214",
    scope: { kind: "project", projectId: projectA },
    body: "Expired SQLite WAL guidance.",
    validity: { state: "valid", validUntil: "2026-08-06T23:59:59.000Z" }
  });
  const future = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174205",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174215",
    scope: { kind: "project", projectId: projectA },
    body: "Future SQLite WAL guidance.",
    validity: { state: "valid", validFrom: "2026-08-08T00:00:00.000Z" }
  });
  for (const memory of [expired, future]) {
    await writeCanonicalMemory({ vaultRoot, runtimeRoot, actor: "human", memory });
  }
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter,
    builtAt: "2026-08-07T10:00:00.000Z"
  });

  const result = await recallSearch({
    runtimeRoot,
    vaultRoot,
    query: "SQLite WAL guidance",
    scope: "current",
    currentProjectId: projectA,
    callerIdentity: "codex:test-session",
    adapter,
    requestedAt: "2026-08-07T10:01:00.000Z"
  });

  expect(result.items).toEqual([]);
});

test("explicit recall keeps Agent-derived review-due knowledge readable with a warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-recall-review-due-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memoryId = "msmem_123e4567-e89b-42d3-a456-426614174206";
  await writeCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    actor: "agent",
    memory: makeCanonicalMemory({
      memoryId,
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174216",
      scope: { kind: "project", projectId: projectA },
      authority: "agent_derived",
      body: "Use SQLite WAL for this durable local queue.",
      compact: "Use SQLite WAL for this durable local queue.",
      validity: { state: "review_due" }
    })
  });
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter,
    builtAt: "2026-08-07T10:00:00.000Z"
  });

  const search = await recallSearch({
    runtimeRoot,
    vaultRoot,
    query: "SQLite WAL durable local queue",
    scope: "current",
    currentProjectId: projectA,
    callerIdentity: "codex:test-session",
    adapter,
    requestedAt: "2026-08-07T10:01:00.000Z"
  });
  expect(search.items).toEqual([
    expect.objectContaining({
      memoryId,
      warnings: ["agent_derived_review_due"]
    })
  ]);

  const shown = await recallShow({
    runtimeRoot,
    vaultRoot,
    memoryId,
    detail: "full",
    callerIdentity: "codex:test-session",
    requestedAt: "2026-08-07T10:01:01.000Z"
  });
  expect(shown.warning).toContain("review is due");
  expect(shown.body).toBe("Use SQLite WAL for this durable local queue.");
});

test("current Project scope cannot admit a Memory without an independent relevance match", async () => {
  const roots = await createIndexedFixture();

  const result = await recallSearch({
    ...roots,
    query: "long session batching backlog consolidation",
    scope: "current",
    currentProjectId: projectA,
    callerIdentity: "codex:test-session",
    requestedAt: "2026-08-07T10:02:30.000Z"
  });

  expect(result.items).toEqual([]);
});

test("a full explicit read records a full-body representation receipt", async () => {
  const roots = await createIndexedFixture();
  const shown = await recallShow({
    ...roots,
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174201",
    detail: "full",
    callerIdentity: "codex:test-session",
    requestedAt: "2026-08-07T10:03:00.000Z"
  });
  const { openRuntimeDatabase } = await import("../../src/runtime/database.js");
  const database = await openRuntimeDatabase(roots.runtimeRoot);
  try {
    const row = database.prepare(
      "SELECT representation_kind FROM retrieval_receipt_items WHERE receipt_id = ?"
    ).get(shown.receiptId);
    expect(row?.representation_kind).toBe("full");
  } finally {
    database.close();
  }
});
