import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { captureEvent, inspectCaptureEventState } from "../../../src/capture/index.js";
import { LunaInvocationError } from "../../../src/luna/index.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import {
  enqueueCompactBackfill,
  inspectMemoryQualityPipeline,
  runNextMemoryQualityStep,
  scheduleCompactQuality,
  type MemoryQualityAdapter
} from "../../../src/quality/pipeline.js";
import { buildRetrievalIndex } from "../../../src/retrieval/index.js";
import { readCanonicalMemory, writeCanonicalMemory } from "../../../src/vault/index.js";
import { runWorkerOnce, type WorkerAdapters } from "../../../src/worker/main.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test.each(["gpt-6-luna", "gpt-5.6-luna"])("compact backfill preserves its generator across a separate fidelity assessment (%s)", async (generatorModel) => {
  const root = await mkdtemp(join(tmpdir(), "memstore-quality-pipeline-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memoryId = "msmem_123e4567-e89b-42d3-a456-426614174081";
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory: makeCanonicalMemory({
      memoryId,
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174081",
      authority: "agent_derived",
      body: "When publishing a release, run typecheck first and never skip the migration verification.",
      validatedCompact: false
    })
  });
  const calls: string[] = [];
  const adapter: MemoryQualityAdapter = {
    generateCompacts: (request) => {
      calls.push("generate");
      return Promise.resolve({
        schemaVersion: 1,
        kind: "compact_generation",
        items: request.memories.map((memory) => ({
          memoryId: memory.memoryId,
          compactText: "Before release, run typecheck and never skip migration verification."
        }))
      });
    },
    validateCompacts: (request) => {
      calls.push("validate");
      return Promise.resolve({
        schemaVersion: 1,
        kind: "compact_validation",
        items: request.memories.map((memory) => ({
          memoryId: memory.memoryId,
          state: "preserves" as const,
          reasonCode: "all_material_facts_preserved"
        }))
      });
    }
  };

  await expect(enqueueCompactBackfill({
    runtimeRoot,
    vaultRoot,
    requestedAt: "2026-08-18T23:00:00.000Z",
    preview: true
  })).resolves.toMatchObject({ state: "preview", eligibleCount: 1, enqueuedCount: 0 });
  await expect(inspectMemoryQualityPipeline({ runtimeRoot })).resolves.toMatchObject({ totalCount: 0 });
  await expect(enqueueCompactBackfill({
    runtimeRoot,
    vaultRoot,
    requestedAt: "2026-08-18T23:00:00.000Z",
    preview: false
  })).resolves.toMatchObject({ state: "enqueued", eligibleCount: 1, enqueuedCount: 1 });

  await expect(runNextMemoryQualityStep({
    runtimeRoot,
    vaultRoot,
    workerId: "quality-worker",
    now: "2026-08-18T23:00:01.000Z",
    adapter
  })).resolves.toMatchObject({ state: "generated", itemCount: 1 });
  const afterGeneration = await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId });
  expect(afterGeneration?.memory.representations.compact.validated).toBe(false);
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(database.prepare("SELECT generator_identity FROM memory_quality_items WHERE memory_id = ?")
      .get(memoryId)?.generator_identity).toBe("gpt-6-luna:compact-generation-v3");
    if (generatorModel === "gpt-5.6-luna") {
      database.prepare("UPDATE memory_quality_items SET generator_identity = ? WHERE memory_id = ?")
        .run("gpt-5.6-luna:compact-generation-v3", memoryId);
    }
  } finally { database.close(); }

  await expect(runNextMemoryQualityStep({
    runtimeRoot,
    vaultRoot,
    workerId: "quality-worker",
    now: "2026-08-18T23:00:02.000Z",
    adapter
  })).resolves.toMatchObject({ state: "published", itemCount: 1 });
  expect(calls).toEqual(["generate", "validate"]);
  const published = await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId });
  expect(published?.memory.revisionId).not.toBe(afterGeneration?.memory.revisionId);
  expect(published?.memory.representations.compact).toMatchObject({
    text: "Before release, run typecheck and never skip migration verification.",
    validated: true,
    generatorIdentity: `${generatorModel}:compact-generation-v3+gpt-6-luna:fidelity-v2`,
    sourceRevisionId: published?.memory.revisionId
  });
  await expect(inspectMemoryQualityPipeline({ runtimeRoot })).resolves.toMatchObject({
    completedCount: 1,
    pendingCount: 0
  });
});

test("a Human-authored Memory too long to inject gets a summary for the index without being revised", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-quality-human-summary-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memoryId = "msmem_123e4567-e89b-42d3-a456-426614174091";
  const body = `用 botmux 往其他群发消息的方法：${"先查目标群 chat_id，再带 --session-id 和 --chat-id 发送，确认返回 success 后才算送达。".repeat(12)}`;
  await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "human", memory: makeCanonicalMemory({
    memoryId, revisionId: "msrev_123e4567-e89b-42d3-a456-426614174091", authority: "human_authored",
    body, compact: body, validatedCompact: false
  }) });
  const summary = "botmux 往当前会话以外的飞书群发消息：用 botmux send 指定 --session-id 与目标 --chat-id，以返回 success 为送达。";
  const adapter: MemoryQualityAdapter = {
    generateCompacts: (request) => Promise.resolve({ schemaVersion: 1, kind: "compact_generation",
      items: request.memories.map((memory) => ({ memoryId: memory.memoryId, compactText: summary })) }),
    validateCompacts: (request) => Promise.resolve({ schemaVersion: 1, kind: "compact_validation",
      items: request.memories.map((memory) => ({ memoryId: memory.memoryId, state: "preserves" as const, reasonCode: "summary_preserves_core" })) })
  };
  const dirtyGeneration = async () => {
    const database = await openRuntimeDatabase(runtimeRoot);
    try { return Number(database.prepare("SELECT dirty_generation FROM retrieval_catalog_generations WHERE singleton = 1").get()?.dirty_generation); }
    finally { database.close(); }
  };
  await expect(enqueueCompactBackfill({ runtimeRoot, vaultRoot, requestedAt: "2026-10-28T03:00:00.000Z", preview: false }))
    .resolves.toMatchObject({ eligibleCount: 1, enqueuedCount: 1 });
  const before = await dirtyGeneration();
  const step = (now: string) => runNextMemoryQualityStep({ runtimeRoot, vaultRoot, workerId: "quality-worker", now, adapter });
  await expect(step("2026-10-28T03:00:01.000Z")).resolves.toMatchObject({ state: "generated" });
  await expect(step("2026-10-28T03:00:02.000Z")).resolves.toMatchObject({ state: "published", itemCount: 1 });

  // The Human-authored Memory itself is untouched.
  const current = await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId });
  expect(current?.memory.revisionId).toBe("msrev_123e4567-e89b-42d3-a456-426614174091");
  expect(current?.memory.body).toBe(body);
  expect(await dirtyGeneration()).toBe(before + 1);
  await expect(enqueueCompactBackfill({ runtimeRoot, vaultRoot, requestedAt: "2026-10-28T03:00:03.000Z", preview: true }))
    .resolves.toMatchObject({ eligibleCount: 0 });

  // The index injects the summary as compact; the body stays the full text.
  await buildRetrievalIndex({ runtimeRoot, vaultRoot, builtAt: "2026-10-28T03:00:04.000Z", adapter: {
    identity: { adapterVersion: "summary-fixture-v1", modelIdentity: "summary-fixture", artifactSha256: "d".repeat(64), dimensions: 2, normalization: "l2" },
    embed: (texts) => Promise.resolve(texts.map(() => [1, 0]))
  } });
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(database.prepare("SELECT compact_text, compact_validated FROM retrieval_documents WHERE memory_id = ?").get(memoryId))
      .toMatchObject({ compact_text: summary, compact_validated: 1 });
    expect(String(database.prepare("SELECT searchable_text FROM retrieval_documents WHERE memory_id = ?").get(memoryId)?.searchable_text))
      .toMatch(new RegExp(`^${summary.slice(0, 20)}`, "u"));
  } finally { database.close(); }
});

test("a compact judged lossy is rewritten from the first draft with every reason so far, at most twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-quality-lossy-repair-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const write = async (suffix: string) => {
    const memoryId = `msmem_123e4567-e89b-42d3-a456-4266141740${suffix}`;
    const body = `Effect House 的问题（TTEH 编辑器、Ask AI、PTC Agent 接口、EH 文档）都记到飞书文档「Effect House 问题记录」：${"先读总览表查重，新问题按编号续写并补充证据。".repeat(10)}`;
    await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "human", memory: makeCanonicalMemory({
      memoryId, revisionId: `msrev_123e4567-e89b-42d3-a456-4266141740${suffix}`, authority: "human_authored", body, compact: body, validatedCompact: false
    }) });
    return memoryId;
  };
  const fixed = await write("81");
  const stubborn = await write("82");
  const vague = "Effect House 相关问题统一记到飞书「Effect House 问题记录」，先查重再续号。";
  const scoped = "TTEH 编辑器、Ask AI、PTC Agent 接口和 EH 文档的问题统一记到飞书「Effect House 问题记录」，先查重再续号。";
  const drafts: { memoryId: string; rejectedDraft?: unknown }[] = [];
  const adapter: MemoryQualityAdapter = {
    generateCompacts: (request) => {
      drafts.push(...request.memories.map(({ memoryId, rejectedDraft }) => ({ memoryId, rejectedDraft })));
      return Promise.resolve({ schemaVersion: 1, kind: "compact_generation", items: request.memories.map((memory) => ({
        memoryId: memory.memoryId, compactText: memory.rejectedDraft === undefined || memory.memoryId === stubborn ? vague : scoped })) });
    },
    // Only the summary that names the cases it applies to preserves the Memory.
    validateCompacts: (request) => Promise.resolve({ schemaVersion: 1, kind: "compact_validation", items: request.memories.map((memory) => (
      memory.compactText === scoped
        ? { memoryId: memory.memoryId, state: "preserves" as const, reasonCode: "summary_preserves_core" }
        : { memoryId: memory.memoryId, state: "lossy" as const, reasonCode: "omits_scope" })) })
  };
  await enqueueCompactBackfill({ runtimeRoot, vaultRoot, requestedAt: "2026-10-29T03:00:00.000Z", preview: false });
  const step = (now: string) => runNextMemoryQualityStep({ runtimeRoot, vaultRoot, workerId: "quality-worker", now, adapter });
  await step("2026-10-29T03:00:01.000Z");
  await step("2026-10-29T03:00:02.000Z");
  // Both were judged lossy once: each is rewritten from the rejected draft and the reason.
  await step("2026-10-29T03:00:03.000Z");
  // The claim order among equally old items is not fixed.
  expect(drafts.slice(2)).toHaveLength(2);
  expect(drafts.slice(2)).toEqual(expect.arrayContaining([
    { memoryId: fixed, rejectedDraft: { compactText: vague, reasonCode: "omits_scope" } },
    { memoryId: stubborn, rejectedDraft: { compactText: vague, reasonCode: "omits_scope" } }
  ]));
  await step("2026-10-29T03:00:04.000Z");
  // The second rewrite still starts from the first draft and carries both reasons; a third lossy judgment is final.
  await step("2026-10-29T03:00:05.000Z");
  expect(drafts.at(-1)).toEqual({ memoryId: stubborn, rejectedDraft: { compactText: vague, reasonCode: "omits_scope; omits_scope" } });
  await step("2026-10-29T03:00:06.000Z");
  await expect(step("2026-10-29T03:00:07.000Z")).resolves.toMatchObject({ state: "empty" });
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(database.prepare("SELECT summary FROM memory_summaries WHERE memory_id = ?").get(fixed)).toMatchObject({ summary: scoped });
    expect(database.prepare("SELECT state, validation_state, validation_reason_code FROM memory_quality_items WHERE memory_id = ?").get(stubborn))
      .toMatchObject({ state: "rejected", validation_state: "lossy", validation_reason_code: "omits_scope" });
    expect(database.prepare("SELECT count(*) AS n FROM memory_summaries WHERE memory_id = ?").get(stubborn)).toMatchObject({ n: 0 });
  } finally { database.close(); }
});

test("an Agent revision immediately queues its unvalidated compact when quality is enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-quality-revision-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memoryId = "msmem_123e4567-e89b-42d3-a456-426614174082";
  const initialRevisionId = "msrev_123e4567-e89b-42d3-a456-426614174082";
  const initial = makeCanonicalMemory({
    memoryId,
    revisionId: initialRevisionId,
    authority: "agent_derived",
    body: "Use the internal package source for this package."
  });
  const created = await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory: initial
  });
  await scheduleCompactQuality({
    runtimeRoot,
    requestedAt: "2026-08-18T23:00:00.000Z",
    preview: false
  });
  const revisionId = "msrev_123e4567-e89b-42d3-a456-426614174092";
  const revised = makeCanonicalMemory({
    memoryId,
    revisionId,
    authority: "agent_derived",
    body: "Use the internal package source only for this package.",
    validatedCompact: false
  });

  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    expectedContentIdentity: created.contentIdentity,
    memory: {
      ...revised,
      predecessorRevisionId: initialRevisionId,
      createdAt: initial.createdAt,
      revisedAt: "2026-08-18T23:00:01.000Z"
    }
  });

  await expect(inspectMemoryQualityPipeline({ runtimeRoot })).resolves.toMatchObject({
    totalCount: 1,
    pendingGenerationCount: 1
  });
});

test("semantic anchor paraphrases reach independent compact fidelity validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-quality-semantic-anchor-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memoryId = "msmem_123e4567-e89b-42d3-a456-426614174083";
  const base = makeCanonicalMemory({
    memoryId,
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174083",
    authority: "agent_derived",
    body: "Use the safe synchronization procedure only when the repository has uncommitted changes.",
    validatedCompact: false
  });
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory: {
      ...base,
      semanticContract: {
        ...base.semanticContract,
        conditions: ["Only when the repository has uncommitted changes."]
      }
    }
  });
  const calls: string[] = [];
  const adapter: MemoryQualityAdapter = {
    generateCompacts: (request) => {
      calls.push("generate");
      return Promise.resolve({
        schemaVersion: 1,
        kind: "compact_generation",
        items: request.memories.map((memory) => ({
          memoryId: memory.memoryId,
          compactText: "Use the safe synchronization procedure only in a dirty working tree."
        }))
      });
    },
    validateCompacts: (request) => {
      calls.push("validate");
      return Promise.resolve({
        schemaVersion: 1,
        kind: "compact_validation",
        items: request.memories.map((memory) => ({
          memoryId: memory.memoryId,
          state: "preserves" as const,
          reasonCode: "condition_semantically_preserved"
        }))
      });
    }
  };
  await enqueueCompactBackfill({
    runtimeRoot,
    vaultRoot,
    requestedAt: "2026-08-20T08:00:00.000Z",
    preview: false
  });

  await expect(runNextMemoryQualityStep({
    runtimeRoot,
    vaultRoot,
    workerId: "quality-worker",
    now: "2026-08-20T08:00:01.000Z",
    adapter
  })).resolves.toMatchObject({ state: "generated", itemCount: 1 });
  await expect(runNextMemoryQualityStep({
    runtimeRoot,
    vaultRoot,
    workerId: "quality-worker",
    now: "2026-08-20T08:00:02.000Z",
    adapter
  })).resolves.toMatchObject({ state: "published", itemCount: 1 });
  expect(calls).toEqual(["generate", "validate"]);
});

test("an overlong generated compact is explicitly rejected after the adapter repair opportunity", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-quality-overlong-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174085",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174085",
      authority: "agent_derived",
      body: "Preserve dense conditions without publishing an overlong compact.",
      validatedCompact: false
    })
  });
  await enqueueCompactBackfill({
    runtimeRoot,
    vaultRoot,
    requestedAt: "2026-08-20T08:30:00.000Z",
    preview: false
  });
  const adapter: MemoryQualityAdapter = {
    generateCompacts: (request) => Promise.resolve({
      schemaVersion: 1,
      kind: "compact_generation",
      items: request.memories.map((memory) => ({
        memoryId: memory.memoryId,
        compactText: Array.from({ length: 120 }, () => "detail").join(" ")
      }))
    }),
    validateCompacts: () => Promise.reject(new Error("Validation is not expected."))
  };

  await expect(runNextMemoryQualityStep({
    runtimeRoot,
    vaultRoot,
    workerId: "quality-worker",
    now: "2026-08-20T08:30:01.000Z",
    adapter
  })).resolves.toMatchObject({ state: "rejected", itemCount: 1 });
  await expect(inspectMemoryQualityPipeline({ runtimeRoot })).resolves.toMatchObject({
    pendingCount: 0,
    rejectedCount: 1,
    rejectionReasons: [{
      reasonCode: "compact_over_token_limit_after_repair",
      count: 1
    }]
  });
});

test("quality status exposes bounded Luna failure diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-quality-safe-diagnostic-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174084",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174084",
      authority: "agent_derived",
      body: "Persist bounded quality diagnostics without provider output.",
      validatedCompact: false
    })
  });
  await enqueueCompactBackfill({
    runtimeRoot,
    vaultRoot,
    requestedAt: "2026-08-20T09:00:00.000Z",
    preview: false
  });
  const adapter: MemoryQualityAdapter = {
    generateCompacts: () => Promise.reject(new LunaInvocationError(
      "schema_invalid",
      true,
      "The returned Memory identity is not available.",
      { stage: "evidence_binding", code: "unknown_memory_alias", path: "items.0.memoryId" }
    )),
    validateCompacts: () => Promise.reject(new Error("Validation is not expected."))
  };

  await expect(runNextMemoryQualityStep({
    runtimeRoot,
    vaultRoot,
    workerId: "quality-worker",
    now: "2026-08-20T09:00:01.000Z",
    adapter
  })).resolves.toMatchObject({ state: "retrying", itemCount: 1 });
  await expect(inspectMemoryQualityPipeline({ runtimeRoot })).resolves.toMatchObject({
    failureDiagnostics: [{
      state: "retrying_generation",
      category: "schema_invalid",
      diagnostic: {
        stage: "evidence_binding",
        code: "unknown_memory_alias",
        path: "items.0.memoryId"
      },
      count: 1
    }]
  });
});

test("repeated structural failures shrink the claimed compact batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-quality-structural-shrink-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  for (let index = 0; index < 16; index += 1) {
    const suffix = String(index + 1).padStart(12, "0");
    await writeCanonicalMemory({
      runtimeRoot,
      vaultRoot,
      actor: "agent",
      memory: makeCanonicalMemory({
        memoryId: `msmem_123e4567-e89b-42d3-a456-${suffix}`,
        revisionId: `msrev_123e4567-e89b-42d3-a456-${suffix}`,
        authority: "agent_derived",
        body: `Durable compact claim ${String(index + 1)}.`,
        validatedCompact: false
      })
    });
  }
  await enqueueCompactBackfill({
    runtimeRoot,
    vaultRoot,
    requestedAt: "2026-08-20T10:00:00.000Z",
    preview: false
  });
  const generationBatchSizes: number[] = [];
  const adapter: MemoryQualityAdapter = {
    generateCompacts: (request) => {
      generationBatchSizes.push(request.memories.length);
      if (request.memories.length > 4) {
        return Promise.reject(new LunaInvocationError(
          "schema_invalid",
          true,
          "The compact output has an invalid structure.",
          { stage: "output_schema", code: "invalid_type", path: "items" }
        ));
      }
      return Promise.resolve({
        schemaVersion: 1,
        kind: "compact_generation",
        items: request.memories.map((memory) => ({
          memoryId: memory.memoryId,
          compactText: memory.body
        }))
      });
    },
    validateCompacts: () => Promise.reject(new Error("Validation is not expected."))
  };

  await expect(runNextMemoryQualityStep({
    runtimeRoot,
    vaultRoot,
    workerId: "quality-worker",
    now: "2026-08-20T10:00:01.000Z",
    adapter
  })).resolves.toMatchObject({ state: "retrying", itemCount: 16 });
  await expect(runNextMemoryQualityStep({
    runtimeRoot,
    vaultRoot,
    workerId: "quality-worker",
    now: "2026-08-21T10:00:01.000Z",
    adapter
  })).resolves.toMatchObject({ state: "retrying", itemCount: 8 });
  await expect(runNextMemoryQualityStep({
    runtimeRoot,
    vaultRoot,
    workerId: "quality-worker",
    now: "2026-08-22T10:00:01.000Z",
    adapter
  })).resolves.toMatchObject({ state: "generated", itemCount: 4 });
  expect(generationBatchSizes).toEqual([16, 8, 4]);
});

test("a recent incomplete Turn does not starve a due quality scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-quality-fairness-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174082",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174082",
      authority: "agent_derived",
      body: "Keep quality work moving while an active Turn waits for Stop.",
      validatedCompact: false
    })
  });
  await scheduleCompactQuality({
    runtimeRoot,
    requestedAt: "2026-08-18T20:00:00.000Z",
    preview: false
  });
  const eventId = "msevent_quality_fairness_recent_turn";
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId,
      deduplicationKey: "codex:quality-fairness:recent-turn",
      agent: "codex",
      eventKind: "PostToolUse",
      occurredAt: "2026-08-18T20:59:50.000Z",
      projectId: "msproj_quality_fairness",
      sessionId: "quality-fairness-session",
      turnId: "quality-fairness-turn",
      payload: { output: "The active Turn has not stopped yet." }
    }
  });
  const quality = {
    generateCompacts: (request) => Promise.resolve({
      schemaVersion: 1 as const,
      kind: "compact_generation" as const,
      items: request.memories.map((memory) => ({
        memoryId: memory.memoryId,
        compactText: memory.body
      }))
    }),
    validateCompacts: () => Promise.reject(new Error("Validation is not expected.")),
    assessDuplicateClusters: () => Promise.reject(new Error("Duplicates are not expected."))
  } satisfies NonNullable<WorkerAdapters["quality"]>;

  await expect(runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "quality-fairness-worker",
    now: "2026-08-18T21:00:00.000Z",
    workerStartedAt: "2026-08-18T19:00:00.000Z",
    adapters: { quality }
  })).resolves.toEqual({
    state: "worked",
    activities: ["memory-quality-discovery:completed", "memory-quality:generated"]
  });
  await expect(inspectCaptureEventState(runtimeRoot, eventId)).resolves.toMatchObject({
    state: "pending"
  });
});
