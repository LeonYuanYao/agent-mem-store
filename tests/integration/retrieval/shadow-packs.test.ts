import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { buildRetrievalIndex, type EmbeddingAdapter } from "../../../src/retrieval/index.js";
import {
  inspectRetrievalReceipt,
  prepareSessionStartShadowPack,
  prepareUserPromptShadowPack
} from "../../../src/retrieval/packs.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

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
  embed: (texts) => Promise.resolve(texts.map((text) => {
    if (/sqlite|wal/iu.test(text)) return [1, 0];
    if (/probable/iu.test(text)) return [0.75, 0.6614378278];
    if (/related recovery/iu.test(text)) return [0.6, 0.8];
    if (/architecture ideas/iu.test(text)) return [1, 0];
    return [0, 1];
  }))
};

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "memstore-shadow-pack-"));
  roots.push(root);
  return { runtimeRoot: join(root, "runtime"), vaultRoot: join(root, "vault") };
}

async function writeAll(
  roots: { runtimeRoot: string; vaultRoot: string },
  memories: readonly ReturnType<typeof makeCanonicalMemory>[]
) {
  for (const memory of memories) {
    await writeCanonicalMemory({ ...roots, actor: "human", memory });
  }
  await buildRetrievalIndex({
    ...roots,
    adapter,
    builtAt: "2026-08-07T12:00:00.000Z"
  });
}

test("SessionStart prepares a bounded authority-labelled Core Memory Pack without injecting it", async () => {
  const roots = await createRoot();
  const always = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174401",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174411",
    scope: { kind: "project", projectId },
    body: "Always run typecheck before completion.",
    compact: "Run typecheck before completion.",
    startup: "always",
    primaryCategory: "preference_constraint"
  });
  const dynamicGlobal = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174402",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174412",
    scope: { kind: "global" },
    body: "Never persist credentials.",
    compact: "Never persist credentials.",
    primaryCategory: "safety_data_integrity"
  });
  const identityFallback = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174403",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174413",
    scope: { kind: "project", projectId },
    body: "A detailed recovery procedure whose compact is unavailable.",
    compact: "stale compact",
    validatedCompact: false,
    identityLabel: "Database recovery procedure",
    primaryCategory: "failure_recovery_hazard"
  });
  const never = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174404",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174414",
    scope: { kind: "project", projectId },
    body: "Do not include this at SessionStart.",
    compact: "SessionStart must omit this.",
    startup: "never"
  });
  await writeAll(roots, [always, dynamicGlobal, identityFallback, never]);

  const pack = await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "session-start-pack",
    requestedAt: "2026-08-07T12:01:00.000Z"
  });

  expect(pack).toMatchObject({ mode: "shadow", injected: false, kind: "session_start" });
  expect(pack.renderedTokenCount).toBeLessThanOrEqual(1200);
  expect(pack.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ memoryId: always.memoryId, representationKind: "compact" }),
    expect.objectContaining({ memoryId: dynamicGlobal.memoryId, representationKind: "compact" }),
    expect.objectContaining({ memoryId: identityFallback.memoryId, representationKind: "identity" })
  ]));
  expect(pack.items.some((item) => item.memoryId === never.memoryId)).toBe(false);
  expect(pack.text).toContain("historical long-term memory");
  expect(pack.text).toContain("body is incomplete");
  expect(pack.receiptId).toMatch(/^msreceipt_/u);
});

test("UserPromptSubmit uses relevance bands, upgrades exact high matches, and suppresses repeat revisions", async () => {
  const roots = await createRoot();
  const sqlite = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174421",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174431",
    scope: { kind: "project", projectId },
    body: "Use SQLite WAL for durable local state.",
    compact: "Use SQLite WAL.",
    standard: "Use SQLite WAL and keep write transactions short for durable local state.",
    startup: "never"
  });
  const unrelated = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174422",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174432",
    scope: { kind: "global" },
    body: "Use a preferred meeting-note format.",
    startup: "never"
  });
  await writeAll(roots, [sqlite, unrelated]);
  await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "user-prompt-pack",
    requestedAt: "2026-08-07T12:02:00.000Z"
  });

  const first = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId: "user-prompt-pack",
    prompt: "How should I configure SQLite WAL?",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter,
    requestedAt: "2026-08-07T12:02:01.000Z"
  });
  expect(first).toMatchObject({ mode: "shadow", injected: false, kind: "user_prompt" });
  expect(first.items).toEqual([
    expect.objectContaining({
      memoryId: sqlite.memoryId,
      relevanceBand: "high",
      representationKind: "standard"
    })
  ]);
  expect(first.renderedTokenCount).toBeLessThanOrEqual(1024);

  const repeated = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId: "user-prompt-pack",
    prompt: "SQLite WAL again",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter,
    requestedAt: "2026-08-07T12:02:02.000Z"
  });
  expect(repeated.items).toEqual([]);
  expect(repeated.emptyReason).toBe("already_present");
});

test("probable-only automatic recall remains compact and admits at most two items", async () => {
  const roots = await createRoot();
  const memories = [1, 2, 3].map((ordinal) => makeCanonicalMemory({
    memoryId: `msmem_123e4567-e89b-42d3-a456-42661417444${String(ordinal)}`,
    revisionId: `msrev_123e4567-e89b-42d3-a456-42661417445${String(ordinal)}`,
    scope: { kind: "project", projectId },
    body: `设计 probable note ${String(ordinal)}.`,
    compact: `设计 probable note ${String(ordinal)}.`,
    standard: `Probable design note ${String(ordinal)} with more details.`,
    startup: "never"
  }));
  await writeAll(roots, memories);
  await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "probable-pack",
    requestedAt: "2026-08-07T12:03:00.000Z"
  });

  const pack = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId: "probable-pack",
    prompt: "设计 提议 讨论",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter,
    requestedAt: "2026-08-07T12:03:01.000Z"
  });

  expect(pack.items).toHaveLength(2);
  expect(pack.items.every((item) =>
    item.relevanceBand === "probable" && item.representationKind === "compact"
  )).toBe(true);
});

test("Context Epoch accounting applies post-soft authority gates and never crosses the hard limit", async () => {
  const roots = await createRoot();
  const memories = [1, 2, 3].map((ordinal) => makeCanonicalMemory({
    memoryId: `msmem_123e4567-e89b-42d3-a456-42661417446${String(ordinal)}`,
    revisionId: `msrev_123e4567-e89b-42d3-a456-42661417447${String(ordinal)}`,
    scope: { kind: "project", projectId },
    body: `SQLite epoch rule ${String(ordinal)}.`,
    compact: `SQLite rule ${String(ordinal)}.`,
    standard: `SQLite epoch rule ${String(ordinal)} with detailed guidance.`,
    startup: "never"
  }));
  await writeAll(roots, memories);
  await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "epoch-budget",
    requestedAt: "2026-08-07T12:04:00.000Z"
  });

  const first = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId: "epoch-budget",
    prompt: memories[0]?.memoryId ?? "",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter,
    policy: { epochSoftTarget: 1, epochHardLimit: 1000 },
    requestedAt: "2026-08-07T12:04:01.000Z"
  });
  expect(first.items[0]?.representationKind).toBe("standard");

  const postSoft = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId: "epoch-budget",
    prompt: memories[1]?.memoryId ?? "",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter,
    policy: { epochSoftTarget: 1, epochHardLimit: 1000 },
    requestedAt: "2026-08-07T12:04:02.000Z"
  });
  expect(postSoft.items[0]?.representationKind).toBe("compact");
  const receipt = await inspectRetrievalReceipt(roots.runtimeRoot, postSoft.receiptId);
  expect(receipt).toMatchObject({
    budgetTier: "post_soft",
    softTargetRestricted: true,
    selectedMemoryIds: [memories[1]?.memoryId]
  });

  const hardBlocked = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId: "epoch-budget",
    prompt: memories[2]?.memoryId ?? "",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter,
    policy: { epochSoftTarget: 1, epochHardLimit: 1 },
    requestedAt: "2026-08-07T12:04:03.000Z"
  });
  expect(hardBlocked.items).toEqual([]);
  expect(hardBlocked.emptyReason).toBe("hard_limit_blocked");
  expect((await inspectRetrievalReceipt(roots.runtimeRoot, hardBlocked.receiptId))?.hardLimitBlocked).toBe(true);
});

test("one-hop expansion still requires the adjacent Memory to reach a relevance band independently", async () => {
  const roots = await createRoot();
  const relatedId = "msmem_123e4567-e89b-42d3-a456-426614174482";
  const seed = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174481",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174491",
    scope: { kind: "project", projectId },
    body: "Use SQLite WAL.",
    compact: "Use SQLite WAL.",
    startup: "never",
    relationships: [{ type: "requires", targetMemoryId: relatedId }]
  });
  const adjacent = makeCanonicalMemory({
    memoryId: relatedId,
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174492",
    scope: { kind: "project", projectId },
    body: "恢复 Related recovery procedure.",
    compact: "恢复 Related recovery procedure.",
    startup: "never"
  });
  await writeAll(roots, [seed, adjacent]);
  await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "relationship-pack",
    requestedAt: "2026-08-07T12:05:00.000Z"
  });

  const pack = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId: "relationship-pack",
    prompt: `${seed.memoryId} 恢复`,
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter,
    requestedAt: "2026-08-07T12:05:01.000Z"
  });
  expect(pack.items.find((item) => item.memoryId === seed.memoryId)?.relevanceBand).toBe("high");
  const related = pack.items.find((item) => item.memoryId === adjacent.memoryId);
  expect(related?.relevanceBand).toBe("probable");
  expect(related?.reasons).toContain("one_hop_relationship");
});

test("automatic Shadow Packs exclude knowledge outside its validity window", async () => {
  const roots = await createRoot();
  const expired = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174483",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174493",
    scope: { kind: "project", projectId },
    body: "Expired SQLite WAL rule.",
    compact: "Expired SQLite WAL rule.",
    startup: "always",
    validity: { state: "valid", validUntil: "2026-08-06T23:59:59.000Z" }
  });
  const future = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174484",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174494",
    scope: { kind: "project", projectId },
    body: "Future SQLite WAL rule.",
    compact: "Future SQLite WAL rule.",
    startup: "always",
    validity: { state: "valid", validFrom: "2026-08-08T00:00:00.000Z" }
  });
  await writeAll(roots, [expired, future]);

  const session = await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "validity-pack",
    requestedAt: "2026-08-07T12:00:00.000Z"
  });
  expect(session.items).toEqual([]);

  const prompt = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId: "validity-pack",
    prompt: "SQLite WAL rule",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter,
    requestedAt: "2026-08-07T12:00:01.000Z"
  });
  expect(prompt.items).toEqual([]);
});

test("SessionStart pages lightweight bucket rows beyond the first sixteen candidates", async () => {
  const roots = await createRoot();
  const unavailable = Array.from({ length: 16 }, (_, index) => makeCanonicalMemory({
    memoryId: `msmem_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    revisionId: `msrev_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    scope: { kind: "project", projectId },
    body: `Unavailable startup candidate ${String(index)}.`,
    compact: "stale compact",
    validatedCompact: false,
    startup: "always",
    primaryCategory: "preference_constraint"
  }));
  const available = makeCanonicalMemory({
    memoryId: "msmem_ffffffff-ffff-4fff-8fff-ffffffffffff",
    revisionId: "msrev_ffffffff-ffff-4fff-8fff-ffffffffffff",
    scope: { kind: "project", projectId },
    body: "The seventeenth startup candidate remains discoverable.",
    compact: "Keep paging startup candidates.",
    startup: "always",
    primaryCategory: "preference_constraint"
  });
  await writeAll(roots, [...unavailable, available]);

  const pack = await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "paged-session-start",
    requestedAt: "2026-08-07T12:10:00.000Z"
  });
  const receipt = await inspectRetrievalReceipt(roots.runtimeRoot, pack.receiptId);

  expect(pack.items.map((item) => item.memoryId)).toContain(available.memoryId);
  expect(receipt).toMatchObject({
    rowsExamined: 17,
    bucketPageCount: 2,
    terminalStopReason: "candidates_exhausted"
  });
});

test("a high semantic baseline without a lexical or applicability anchor stays out of automatic recall", async () => {
  const roots = await createRoot();
  const unrelated = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174485",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174495",
    scope: { kind: "project", projectId },
    body: "Preferred meeting note format.",
    compact: "Use the preferred meeting note format.",
    startup: "never"
  });
  await writeAll(roots, [unrelated]);
  await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "semantic-baseline",
    requestedAt: "2026-08-07T12:11:00.000Z"
  });
  const elevatedBaseline: EmbeddingAdapter = {
    identity: adapter.identity,
    embed: (texts) => Promise.resolve(texts.map(() => [0.6614378278, 0.75]))
  };

  const pack = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId: "semantic-baseline",
    prompt: "quantum chemistry orbital symmetry",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter: elevatedBaseline,
    requestedAt: "2026-08-07T12:11:01.000Z"
  });

  expect(pack.items).toEqual([]);
  expect(pack.emptyReason).toBe("no_relevant_memory");
});
