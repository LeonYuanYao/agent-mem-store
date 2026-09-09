import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { buildRetrievalIndex, type EmbeddingAdapter } from "../../../src/retrieval/index.js";
import {
  inspectRetrievalReceipt,
  prepareSessionStartShadowPack,
  prepareUserPromptShadowPack
} from "../../../src/retrieval/packs.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { inspectStatus } from "../../../src/operations/status.js";
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
  await mkdir(join(root, "runtime"));
  await writeFile(join(root, "runtime", "config.toml"), "schema_version = 1\n[adapters]\nsession_start_injection = true\n");
  return { runtimeRoot: join(root, "runtime"), vaultRoot: join(root, "vault") };
}

test("disabled startup leaves prompt recall and its first legend intact", async () => {
  const roots = await createRoot();
  await rm(join(roots.runtimeRoot, "config.toml"));
  await writeAll(roots, [makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174991",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174992",
    scope: { kind: "project", projectId },
    body: "Use SQLite WAL for durable storage.",
    compact: "Use SQLite WAL for durable storage.",
    startup: "always"
  })]);
  const startup = await prepareSessionStartShadowPack({
    ...roots, projectId, sessionId: "startup-disabled", requestedAt: "2026-08-07T12:01:00.000Z"
  });
  expect(startup.emptyReason).toBe("session_start_disabled");
  expect(startup.items).toHaveLength(0);
  expect(startup.renderedTokenCount).toBe(0);
  const prompt = await prepareUserPromptShadowPack({
    ...roots, projectId, sessionId: "startup-disabled", prompt: "SQLite WAL",
    signals: { files: [], symbols: [], errors: [], commands: [] }, adapter,
    requestedAt: "2026-08-07T12:01:01.000Z"
  });
  expect(prompt.items).toHaveLength(1);
  expect(prompt.text).toContain("M=memory ref");
});

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
    expect.objectContaining({ memoryId: always.memoryId, memoryRef: 1, representationKind: "compact" }),
    expect.objectContaining({ memoryId: dynamicGlobal.memoryId, memoryRef: 2, representationKind: "compact" }),
    expect.objectContaining({ memoryId: identityFallback.memoryId, memoryRef: 3, representationKind: "identity" })
  ]));
  expect(pack.items.some((item) => item.memoryId === never.memoryId)).toBe(false);
  expect(pack.text.split("\n")[0]).toBe(
    "<memstore-context>Automatically selected long-term project background for session startup. It is not necessarily relevant to the current task. Use only clearly applicable items and ignore the rest. Current explicit instructions and verified workspace state take precedence.</memstore-context>"
  );
  expect(pack.text).toContain(
    "M=memory ref; S=P(current project)/G(global); A=H(human)/A(agent); R=C(compact)/S(standard)/I(identity)"
  );
  expect(pack.text).toContain("[M:1 S:P A:H R:C]");
  expect(pack.text).toContain("[M:2 S:G A:H R:C]");
  expect(pack.text).not.toContain("msmem_");
  expect(pack.text).not.toContain("msproj_");
  expect(pack.text).toContain("body is incomplete");
  expect(pack.text).toContain("read M:3 by identity");
  expect(pack.receiptId).toMatch(/^msreceipt_/u);
});

test("automatic packs exclude Agent-derived review-due knowledge", async () => {
  const roots = await createRoot();
  const memory = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174405",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174415",
    scope: { kind: "project", projectId },
    authority: "agent_derived",
    body: "Use SQLite WAL for the review-due queue.",
    compact: "Use SQLite WAL for the review-due queue.",
    startup: "always",
    validity: { state: "review_due" }
  });
  await writeCanonicalMemory({ ...roots, actor: "agent", memory });
  await buildRetrievalIndex({
    ...roots,
    adapter,
    builtAt: "2026-08-07T12:00:00.000Z"
  });

  const startup = await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "review-due-pack",
    requestedAt: "2026-08-07T12:01:00.000Z"
  });
  expect(startup.items).toEqual([]);

  const prompt = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId: "review-due-pack",
    prompt: "How should I configure the SQLite WAL queue?",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter,
    requestedAt: "2026-08-07T12:01:01.000Z"
  });
  expect(prompt.items).toEqual([]);
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
  expect(first.text.split("\n")[0]).toBe(
    "<memstore-context>Automatically retrieved historical long-term memory. Retrieval may include false positives. Use only items clearly applicable to the current request and ignore unrelated items. Current explicit instructions and verified workspace state take precedence.</memstore-context>"
  );
  expect(first.text).toContain(
    "M=memory ref; S=P(current project)/G(global); A=H(human)/A(agent); R=C(compact)/S(standard)/I(identity)"
  );
  expect(first.items).toEqual([
    expect.objectContaining({
      memoryId: sqlite.memoryId,
      relevanceBand: "high",
      representationKind: "standard"
    })
  ]);
  expect(first.renderedTokenCount).toBeLessThanOrEqual(1024);
  const receipt = await inspectRetrievalReceipt(roots.runtimeRoot, first.receiptId);
  if (receipt?.timings === undefined) throw new Error("Expected structured retrieval timings.");
  expect(Object.keys(receipt.timings).sort()).toEqual([
    "embeddingMs",
    "epochLoadMs",
    "rankingAndRelationshipMs",
    "receiptWriteMs",
    "scopeLoadMs",
    "totalMs",
    "vectorScanMs"
  ]);
  for (const value of Object.values(receipt.timings)) {
    expect(value).toBeGreaterThanOrEqual(0);
  }

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

test("UserPromptSubmit uses a short validated standard when a high exact Memory has no compact", async () => {
  const roots = await createRoot();
  const registry = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174591",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174592",
    scope: { kind: "project", projectId },
    body: "Use https://packages.example.com as the npm registry for internal packages.",
    compact: "Unvalidated compact must not be used.",
    standard: "Use https://packages.example.com as the npm registry for internal packages.",
    validatedCompact: false,
    validatedStandard: true,
    startup: "never",
    applicability: {
      summary: "Applies when configuring the acme npm registry.",
      conditions: []
    }
  });
  const exactAdapter: EmbeddingAdapter = {
    identity: adapter.identity,
    embed: (texts) => Promise.resolve(texts.map(() => [1, 0]))
  };
  await writeAll(roots, [registry]);
  await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "short-standard-pack",
    requestedAt: "2026-08-07T12:02:05.000Z"
  });

  const pack = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId: "short-standard-pack",
    prompt: "How do I configure the acme npm registry?",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter: exactAdapter,
    requestedAt: "2026-08-07T12:02:06.000Z"
  });

  expect(pack.items).toEqual([
    expect.objectContaining({
      memoryId: registry.memoryId,
      relevanceBand: "high",
      representationKind: "standard"
    })
  ]);
});

test("UserPromptSubmit reports a high candidate whose representation is unavailable", async () => {
  const roots = await createRoot();
  const unavailable = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174597",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174598",
    scope: { kind: "project", projectId },
    body: "The oversized-payload procedure has required detail that cannot be omitted.",
    compact: "Unvalidated compact must not be used.",
    standard: `oversized-payload ${"required detail ".repeat(100)}`,
    validatedCompact: false,
    validatedStandard: true,
    startup: "never"
  });
  await writeAll(roots, [unavailable]);
  await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "unavailable-representation-pack",
    requestedAt: "2026-08-07T12:02:08.500Z"
  });

  const pack = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId: "unavailable-representation-pack",
    prompt: "Show the oversized-payload procedure",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter,
    requestedAt: "2026-08-07T12:02:09.000Z"
  });
  const receipt = await inspectRetrievalReceipt(roots.runtimeRoot, pack.receiptId);
  const status = await inspectStatus(roots);

  expect(pack.items).toEqual([]);
  expect(receipt?.omittedItems).toEqual([
    expect.objectContaining({
      memoryId: unavailable.memoryId,
      relevanceBand: "high",
      omissionReason: "representation_unavailable"
    })
  ]);
  expect(status.pipelines.foreground_retrieval.high_representation_unavailable_count)
    .toBe(1);
});

test("UserPromptSubmit does not treat one rare natural-language term as an exact anchor", async () => {
  const roots = await createRoot();
  const relevant = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174593",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174594",
    scope: { kind: "project", projectId },
    body: "Use https://packages.example.com as the package source for internal npm packages.",
    compact: "Unvalidated compact must not be used.",
    standard: "Use https://packages.example.com as the package source for internal npm packages.",
    validatedCompact: false,
    validatedStandard: true,
    startup: "never",
    applicability: {
      summary: "Applies when configuring acme for internal npm packages.",
      conditions: []
    }
  });
  const unrelated = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174595",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174596",
    scope: { kind: "project", projectId },
    body: "AudioComponent.playMode is mapped through the component registry 配置。",
    compact: "AudioComponent.playMode is mapped through the component registry 配置。",
    startup: "never",
    applicability: {
      summary: "Applies to AudioComponent enum serialization.",
      conditions: []
    }
  });
  const registryAdapter: EmbeddingAdapter = {
    identity: {
      ...adapter.identity,
      adapterVersion: "registry-fixture-v1",
      modelIdentity: "registry-fixture-embedding",
      artifactSha256: "e".repeat(64)
    },
    embed: (texts) => Promise.resolve(texts.map((text) =>
      text.includes("AudioComponent") ? [0.84, 0.5425863987] : [1, 0]
    )),
    embedDocuments: (texts) => Promise.resolve(texts.map((text) =>
      text.includes("AudioComponent") ? [0.84, 0.5425863987] : [1, 0]
    )),
    embedQuery: (texts) => Promise.resolve(texts.map(() => [1, 0]))
  };
  await writeCanonicalMemory({ ...roots, actor: "human", memory: relevant });
  await writeCanonicalMemory({ ...roots, actor: "human", memory: unrelated });
  await buildRetrievalIndex({
    ...roots,
    adapter: registryAdapter,
    builtAt: "2026-08-07T12:00:01.000Z"
  });
  await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "ambiguous-registry-pack",
    requestedAt: "2026-08-07T12:02:07.000Z"
  });

  const pack = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId: "ambiguous-registry-pack",
    prompt: "给我一个把 acme 设置到本地 npm 的默认 registry 的方式",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter: registryAdapter,
    requestedAt: "2026-08-07T12:02:08.000Z"
  });

  expect(pack.items.map((item) => item.memoryId)).toEqual([relevant.memoryId]);
});

test("UserPromptSubmit does not promote an entire project cluster from one shared exact term", async () => {
  const roots = await createRoot();
  const relevant = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174601",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174611",
    scope: { kind: "project", projectId },
    body: "When creating an MR for the acme repository without an explicit platform, use review.example.com.",
    compact: "acme 仓库创建 MR 且未指定平台时，默认使用 review.example.com。",
    startup: "never",
    applicability: {
      summary: "适用于 acme 仓库的 MR 创建请求。",
      conditions: ["用户要求为 acme 仓库创建 MR 且未显式指定平台时。"]
    }
  });
  const noise = [
    {
      suffix: "602",
      body: "ACME workspace skill files require YAML frontmatter and catalog registration.",
      applicability: "适用于 ACME workspace 技能新增与目录维护。"
    },
    {
      suffix: "603",
      body: "ACME tool schemas must remain self-contained and must not reference workspace paths.",
      applicability: "适用于 ACME Ask AI workspace 工具定义。"
    },
    {
      suffix: "604",
      body: "Before building acme, inspect Git submodule state and local changes.",
      applicability: "适用于包含 Git 子模块的 acme 构建。"
    },
    {
      suffix: "605",
      body: "ACME formal evaluation runs from a fixed local Lark JSON snapshot.",
      applicability: "适用于 acme Ask AI self-optimization 评估。"
    },
    {
      suffix: "606",
      body: "Summarize ACME Use and Preview CLI progress in Chinese and English.",
      applicability: "适用于总结 ACME KR 进展。"
    }
  ].map((item) => makeCanonicalMemory({
    memoryId: `msmem_123e4567-e89b-42d3-a456-426614174${item.suffix}`,
    revisionId: `msrev_123e4567-e89b-42d3-a456-426614174${String(Number(item.suffix) + 10)}`,
    scope: { kind: "project", projectId },
    body: item.body,
    compact: item.body,
    startup: "never",
    applicability: { summary: item.applicability, conditions: [] }
  }));
  const clusteredAdapter: EmbeddingAdapter = {
    identity: adapter.identity,
    embed: (texts) => Promise.resolve(texts.map(() => [1, 0]))
  };
  await writeAll(roots, [relevant, ...noise]);
  await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "project-cluster-pack",
    requestedAt: "2026-08-07T12:02:10.000Z"
  });

  const pack = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId: "project-cluster-pack",
    prompt: "如果我让你给 acme 仓库创建一个 MR，但没有指定平台，你默认应该把 MR 创建到哪里？",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter: clusteredAdapter,
    requestedAt: "2026-08-07T12:02:11.000Z"
  });

  expect(pack.items.map((item) => item.memoryId)).toEqual([relevant.memoryId]);
});

test("UserPromptSubmit does not use one rare two-character acronym as an exact anchor", async () => {
  const roots = await createRoot();
  const relevant = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174641",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174651",
    scope: { kind: "project", projectId },
    body: "The default acme platform is review.example.com when no platform is specified.",
    compact: "acme 未指定平台时默认使用 review.example.com。",
    startup: "never",
    applicability: { summary: "适用于 acme 默认平台选择。", conditions: [] }
  });
  const acronymOnly = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174642",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174652",
    scope: { kind: "project", projectId },
    body: "After a Git conflict, do not create an MR until the conflict is resolved and verified.",
    compact: "Git 冲突解决并验证前不要创建 MR。",
    startup: "never",
    applicability: { summary: "适用于 Git 冲突处理。", conditions: [] }
  });
  const clusteredAdapter: EmbeddingAdapter = {
    identity: adapter.identity,
    embed: (texts) => Promise.resolve(texts.map(() => [1, 0]))
  };
  const fillers = Array.from({ length: 98 }, (_, index) => makeCanonicalMemory({
    memoryId: `msmem_20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    revisionId: `msrev_20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    scope: { kind: "project", projectId },
    body: `Unrelated durable formatter preference ${String(index)}.`,
    compact: `Unrelated formatter preference ${String(index)}.`,
    startup: "never"
  }));
  await writeAll(roots, [relevant, acronymOnly, ...fillers]);
  await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "short-acronym-pack",
    requestedAt: "2026-08-07T12:02:30.000Z"
  });

  const pack = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId: "short-acronym-pack",
    prompt: "acme MR review.example.com 默认平台？",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter: clusteredAdapter,
    requestedAt: "2026-08-07T12:02:31.000Z"
  });

  expect(pack.items.map((item) => item.memoryId)).toEqual([relevant.memoryId]);
});

test("UserPromptSubmit preserves Chinese intent across an inserted qualifier", async () => {
  const roots = await createRoot();
  const relevant = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174621",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174631",
    scope: { kind: "project", projectId },
    body: "默认目标平台由仓库配置决定。",
    compact: "默认目标平台由仓库配置决定。",
    startup: "never",
    applicability: { summary: "适用于询问默认目标平台。", conditions: [] }
  });
  const noise = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174622",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174632",
    scope: { kind: "project", projectId },
    body: "默认代码格式由 formatter 决定。",
    compact: "默认代码格式由 formatter 决定。",
    startup: "never",
    applicability: { summary: "适用于询问默认代码格式。", conditions: [] }
  });
  await writeAll(roots, [relevant, noise]);
  await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "cjk-qualifier-pack",
    requestedAt: "2026-08-07T12:02:20.000Z"
  });

  const pack = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId: "cjk-qualifier-pack",
    prompt: "默认平台？",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    requestedAt: "2026-08-07T12:02:21.000Z"
  });

  expect(pack.items).toEqual([
    expect.objectContaining({
      memoryId: relevant.memoryId,
      relevanceBand: "probable",
      representationKind: "compact"
    })
  ]);
});

test("UserPromptSubmit can recall a Memory from a bounded structured file signal", async () => {
  const roots = await createRoot();
  const fileRule = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174423",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174433",
    scope: { kind: "project", projectId },
    body: "When editing src/queue.ts, run the durable queue recovery test.",
    compact: "Run the recovery test after editing src/queue.ts.",
    startup: "never"
  });
  await writeAll(roots, [fileRule]);
  await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "structured-signal-pack",
    requestedAt: "2026-08-07T12:02:00.000Z"
  });

  const prompt = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId: "structured-signal-pack",
    prompt: "Quantum orbital symmetry.",
    signals: { files: ["src/queue.ts"], symbols: [], errors: [], commands: [] },
    requestedAt: "2026-08-07T12:02:01.000Z"
  });

  expect(prompt.items).toEqual([
    expect.objectContaining({
      memoryId: fileRule.memoryId,
      relevanceBand: "high"
    })
  ]);
  expect(prompt.items[0]?.reasons).toContain("session_signal");
});

test("automatic packs explain policy and compact fields only once per Context Epoch", async () => {
  const roots = await createRoot();
  const startup = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174417",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174427",
    scope: { kind: "project", projectId },
    body: "Keep startup memory concise.",
    compact: "Keep startup memory concise.",
    startup: "always"
  });
  const promptOnly = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174418",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174428",
    scope: { kind: "project", projectId },
    body: "Use SQLite WAL for durable prompt memory.",
    compact: "Use SQLite WAL for durable prompt memory.",
    startup: "never"
  });
  await writeAll(roots, [startup, promptOnly]);

  const firstEpoch = await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "memory-legend-epoch",
    requestedAt: "2026-08-07T12:01:00.000Z"
  });
  const prompt = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId: "memory-legend-epoch",
    prompt: "How should SQLite WAL be configured?",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter,
    requestedAt: "2026-08-07T12:01:01.000Z"
  });
  const secondEpoch = await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "memory-legend-epoch",
    requestedAt: "2026-08-07T12:02:00.000Z"
  });

  expect(firstEpoch.text).toContain("M=memory ref");
  expect(firstEpoch.text).toContain(
    "Automatically selected long-term project background for session startup"
  );
  expect(firstEpoch.text).toContain(
    "Later <memstore-candidates> blocks follow the same policy"
  );
  expect(prompt.items).toHaveLength(1);
  expect(prompt.text).not.toContain("M=memory ref");
  expect(prompt.text).not.toContain("Automatically retrieved historical long-term memory");
  expect(prompt.text).not.toContain("blocks follow the same policy");
  expect(prompt.text.split("\n")[0]).toBe("<memstore-candidates>");
  expect(prompt.text.split("\n").at(-1)).toBe("</memstore-candidates>");
  expect(secondEpoch.text).toContain("M=memory ref");
  expect(secondEpoch.text).toContain(
    "Automatically selected long-term project background for session startup"
  );
  expect(secondEpoch.text).toContain(
    "Later <memstore-candidates> blocks follow the same policy"
  );
});

test("an active Context Epoch created before the legend upgrade receives the legend once", async () => {
  const roots = await createRoot();
  const startup = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174419",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174429",
    scope: { kind: "project", projectId },
    body: "Keep the existing Context Epoch active.",
    compact: "Keep the existing Context Epoch active.",
    startup: "always"
  });
  const promptOnly = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174420",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174430",
    scope: { kind: "project", projectId },
    body: "Use SQLite WAL after an in-place upgrade.",
    compact: "Use SQLite WAL after an in-place upgrade.",
    startup: "never"
  });
  await writeAll(roots, [startup, promptOnly]);
  const sessionId = "pre-legend-active-epoch";
  await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId,
    requestedAt: "2026-08-07T12:03:00.000Z"
  });
  const database = await openRuntimeDatabase(roots.runtimeRoot);
  try {
    database.prepare(
      "UPDATE context_epochs SET memory_legend_version = 0 WHERE session_id = ? AND state = 'active'"
    ).run(sessionId);
  } finally {
    database.close();
  }

  const prompt = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId,
    prompt: "How should SQLite WAL work after the upgrade?",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter,
    requestedAt: "2026-08-07T12:03:01.000Z"
  });

  expect(prompt.items).toHaveLength(1);
  expect(prompt.text).toContain("M=memory ref");
});

test("UserPromptSubmit treats a portable M:<number> mention as a direct identity reference", async () => {
  const roots = await createRoot();
  const selected = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174423",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174433",
    scope: { kind: "project", projectId },
    body: "Use a stable direct-reference rule.",
    compact: "Use the direct-reference rule.",
    standard: "Use the stable direct-reference rule with its complete conditions.",
    startup: "never"
  });
  await writeAll(roots, [selected]);
  await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "portable-reference-pack",
    requestedAt: "2026-08-07T12:02:10.000Z"
  });

  const pack = await prepareUserPromptShadowPack({
    ...roots,
    projectId,
    sessionId: "portable-reference-pack",
    prompt: "Please inspect M:1.",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    requestedAt: "2026-08-07T12:02:11.000Z"
  });

  expect(pack.items).toEqual([
    expect.objectContaining({
      memoryId: selected.memoryId,
      memoryRef: 1,
      relevanceBand: "high",
      representationKind: "standard"
    })
  ]);
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

  expect(pack.text.split("\n")[0]).toBe(
    "<memstore-context>Automatically retrieved, possibly relevant historical long-term memory. Treat these items as candidates: verify applicability, ignore unrelated items, and read by M:<id> when more detail is needed. Current explicit instructions and verified workspace state take precedence.</memstore-context>"
  );
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

test("SessionStart keeps its item and token ceilings after portable references shrink headers", async () => {
  const roots = await createRoot();
  const memories = Array.from({ length: 80 }, (_, index) => makeCanonicalMemory({
    memoryId: `msmem_10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    revisionId: `msrev_10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    scope: { kind: "project", projectId },
    body: `Durable startup rule ${String(index)} ${"constraint ".repeat(57)}`,
    compact: `Durable startup rule ${String(index)} ${"constraint ".repeat(57)}`,
    startup: "auto",
    primaryCategory: "preference_constraint"
  }));
  await writeAll(roots, memories);

  const pack = await prepareSessionStartShadowPack({
    ...roots,
    projectId,
    sessionId: "token-saturated-session-start",
    requestedAt: "2026-08-07T12:10:01.000Z"
  });
  const receipt = await inspectRetrievalReceipt(roots.runtimeRoot, pack.receiptId);

  expect(pack.items.length).toBeGreaterThan(0);
  expect(pack.items.length).toBeLessThanOrEqual(12);
  expect(pack.renderedTokenCount).toBeLessThanOrEqual(1200);
  expect(receipt).toBeDefined();
  if (receipt === undefined) throw new Error("Expected a SessionStart retrieval Receipt.");
  expect(receipt.rowsExamined).toBeLessThan(memories.length);
  expect(receipt.terminalStopReason).toBe("pack_limit_reached");
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
