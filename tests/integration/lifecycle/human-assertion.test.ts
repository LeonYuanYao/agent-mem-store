import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  assertHumanKnowledge,
  inspectHumanConflict,
  resolveHumanConflict
} from "../../../src/candidates/human.js";
import { buildRetrievalIndex, type EmbeddingAdapter } from "../../../src/retrieval/index.js";
import {
  prepareSessionStartShadowPack,
  prepareUserPromptShadowPack
} from "../../../src/retrieval/packs.js";
import { readCanonicalMemory } from "../../../src/vault/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<{ runtimeRoot: string; vaultRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "memstore-human-"));
  roots.push(root);
  return { runtimeRoot: join(root, "runtime"), vaultRoot: join(root, "vault") };
}

const projectScope = {
  kind: "project" as const,
  projectId: "msproj_123e4567-e89b-42d3-a456-426614174001"
};

const embedding: EmbeddingAdapter = {
  identity: {
    adapterVersion: "fixture-v1",
    modelIdentity: "fixture-embedding",
    artifactSha256: "c".repeat(64),
    dimensions: 2,
    normalization: "l2"
  },
  embed: (texts) => Promise.resolve(texts.map(() => [1, 0]))
};

test("a Direct Human Assertion preserves the exact body without a Luna rewrite", async () => {
  const roots = await createRoot();
  const body = "Always preserve `--exact` and do NOT broaden this rule.\nSecond line stays.";
  const result = await assertHumanKnowledge({
    ...roots,
    scope: projectScope,
    body,
    primaryCategory: "preference_constraint",
    startup: "never",
    assertedAt: "2026-08-07T09:00:00.000Z"
  });
  expect(result).toMatchObject({ state: "created" });
  if (result.state !== "created") throw new Error("Expected a Human Memory.");
  const loaded = await readCanonicalMemory({ ...roots, memoryId: result.memoryId });
  expect(loaded?.memory.body).toBe(body);
  expect(loaded?.memory.authority).toBe("human_authored");
  expect(loaded?.memory.representations.compact).toMatchObject({
    text: body,
    validated: true,
    sourceRevisionId: loaded?.memory.revisionId
  });
  expect(loaded?.memory.provenance).toContain(`operation:${result.operationId}`);
  expect(await readFile(result.path, "utf8")).toContain(body);

  await buildRetrievalIndex({
    ...roots,
    adapter: embedding,
    builtAt: "2026-08-07T09:00:01.000Z"
  });
  await prepareSessionStartShadowPack({
    ...roots,
    projectId: projectScope.projectId,
    sessionId: "human-assertion-session",
    requestedAt: "2026-08-07T09:00:02.000Z"
  });
  const prompt = await prepareUserPromptShadowPack({
    ...roots,
    projectId: projectScope.projectId,
    sessionId: "human-assertion-session",
    prompt: "Should I broaden the exact rule?",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter: embedding,
    requestedAt: "2026-08-07T09:00:03.000Z"
  });
  expect(prompt.items).toEqual([
    expect.objectContaining({
      memoryId: result.memoryId,
      representationKind: "standard",
      relevanceBand: "high"
    })
  ]);
});

test("a generic conflicting assertion is isolated until the Human resolves it", async () => {
  const roots = await createRoot();
  const original = await assertHumanKnowledge({
    ...roots,
    scope: projectScope,
    body: "Use pnpm for this project.",
    primaryCategory: "workflow_environment_toolchain",
    assertedAt: "2026-08-07T09:10:00.000Z"
  });
  if (original.state !== "created") throw new Error("Expected original Memory.");

  const conflict = await assertHumanKnowledge({
    ...roots,
    scope: projectScope,
    body: "Use npm for this project.",
    primaryCategory: "workflow_environment_toolchain",
    potentialConflictMemoryIds: [original.memoryId],
    conflictDetectedBy: "gpt-5.6-luna",
    assertedAt: "2026-08-07T09:10:01.000Z"
  });
  expect(conflict).toMatchObject({ state: "conflict" });
  if (conflict.state !== "conflict") throw new Error("Expected a Human conflict.");
  await expect(inspectHumanConflict(roots.runtimeRoot, conflict.conflictId)).resolves.toMatchObject({
    state: "open",
    body: "Use npm for this project.",
    conflictingMemoryIds: [original.memoryId]
  });
  await expect(resolveHumanConflict({
    ...roots,
    conflictId: conflict.conflictId,
    resolution: { kind: "keep_existing" },
    resolvedAt: "2026-08-07T09:10:02.000Z"
  })).resolves.toMatchObject({ state: "kept_existing" });
  await expect(inspectHumanConflict(roots.runtimeRoot, conflict.conflictId)).resolves.toMatchObject({
    state: "kept_existing"
  });
});

test("a Human conflict can adopt the new assertion or distinguish its applicability", async () => {
  const roots = await createRoot();
  const original = await assertHumanKnowledge({
    ...roots,
    scope: projectScope,
    body: "Use the stable endpoint.",
    primaryCategory: "architecture_contract",
    assertedAt: "2026-08-07T09:15:00.000Z"
  });
  if (original.state !== "created") throw new Error("Expected original Memory.");
  const unrelated = await assertHumanKnowledge({
    ...roots,
    scope: projectScope,
    body: "Keep the API timeout at 30 seconds.",
    primaryCategory: "architecture_contract",
    assertedAt: "2026-08-07T09:15:00.500Z"
  });
  if (unrelated.state !== "created") throw new Error("Expected unrelated Memory.");
  const adoptConflict = await assertHumanKnowledge({
    ...roots,
    scope: projectScope,
    body: "Use the beta endpoint.",
    primaryCategory: "architecture_contract",
    potentialConflictMemoryIds: [original.memoryId],
    assertedAt: "2026-08-07T09:15:01.000Z"
  });
  if (adoptConflict.state !== "conflict") throw new Error("Expected conflict.");
  await expect(resolveHumanConflict({
    ...roots,
    conflictId: adoptConflict.conflictId,
    resolution: { kind: "adopt_new", replacesMemoryId: unrelated.memoryId },
    resolvedAt: "2026-08-07T09:15:01.500Z"
  })).rejects.toThrow("must replace a Memory named by this conflict");
  const adopted = await resolveHumanConflict({
    ...roots,
    conflictId: adoptConflict.conflictId,
    resolution: { kind: "adopt_new", replacesMemoryId: original.memoryId },
    resolvedAt: "2026-08-07T09:15:02.000Z"
  });
  expect(adopted).toMatchObject({ state: "adopted_new" });

  const distinguishConflict = await assertHumanKnowledge({
    ...roots,
    scope: projectScope,
    body: "Use the stable endpoint for production.",
    primaryCategory: "architecture_contract",
    potentialConflictMemoryIds: [adopted.state === "adopted_new" ? adopted.memoryId : original.memoryId],
    assertedAt: "2026-08-07T09:15:03.000Z"
  });
  if (distinguishConflict.state !== "conflict") throw new Error("Expected conflict.");
  const distinguished = await resolveHumanConflict({
    ...roots,
    conflictId: distinguishConflict.conflictId,
    resolution: {
      kind: "distinguish",
      applicabilitySummary: "Production deployments",
      conditions: ["Environment is production."]
    },
    resolvedAt: "2026-08-07T09:15:04.000Z"
  });
  expect(distinguished).toMatchObject({ state: "distinguished" });
  if (distinguished.state !== "distinguished") throw new Error("Expected distinguished Memory.");
  const scoped = await readCanonicalMemory({ ...roots, memoryId: distinguished.memoryId });
  expect(scoped?.memory.applicability).toEqual({
    summary: "Production deployments",
    conditions: ["Environment is production."]
  });
});

test("Private sensitivity survives conflict isolation and resolution", async () => {
  const roots = await createRoot();
  const original = await assertHumanKnowledge({
    ...roots,
    scope: projectScope,
    body: "Use the shared staging account.",
    primaryCategory: "workflow_environment_toolchain",
    sensitivity: "private",
    assertedAt: "2026-08-07T09:18:00.000Z"
  });
  if (original.state !== "created") throw new Error("Expected original Memory.");
  const conflict = await assertHumanKnowledge({
    ...roots,
    scope: projectScope,
    body: "Use the isolated staging account.",
    primaryCategory: "workflow_environment_toolchain",
    sensitivity: "private",
    potentialConflictMemoryIds: [original.memoryId],
    assertedAt: "2026-08-07T09:18:01.000Z"
  });
  if (conflict.state !== "conflict") throw new Error("Expected conflict.");
  const resolved = await resolveHumanConflict({
    ...roots,
    conflictId: conflict.conflictId,
    resolution: {
      kind: "distinguish",
      applicabilitySummary: "Isolated staging",
      conditions: []
    },
    resolvedAt: "2026-08-07T09:18:02.000Z"
  });
  if (resolved.state !== "distinguished") throw new Error("Expected resolution.");
  const memory = await readCanonicalMemory({ ...roots, memoryId: resolved.memoryId });
  expect(memory?.memory.sensitivity).toBe("private");
});

test("an explicit replacement archives the predecessor and creates a successor", async () => {
  const roots = await createRoot();
  const original = await assertHumanKnowledge({
    ...roots,
    scope: projectScope,
    body: "Use pnpm 9.",
    primaryCategory: "workflow_environment_toolchain",
    assertedAt: "2026-08-07T09:20:00.000Z"
  });
  if (original.state !== "created") throw new Error("Expected original Memory.");

  const successor = await assertHumanKnowledge({
    ...roots,
    scope: projectScope,
    body: "Use pnpm 10.",
    primaryCategory: "workflow_environment_toolchain",
    replacesMemoryId: original.memoryId,
    assertedAt: "2026-08-07T09:20:01.000Z"
  });
  expect(successor).toMatchObject({ state: "created", replacedMemoryId: original.memoryId });
  if (successor.state !== "created") throw new Error("Expected successor Memory.");
  const oldMemory = await readCanonicalMemory({ ...roots, memoryId: original.memoryId });
  const newMemory = await readCanonicalMemory({ ...roots, memoryId: successor.memoryId });
  expect(oldMemory?.memory).toMatchObject({
    lifecycle: "archived",
    successorMemoryId: successor.memoryId,
    lifecycleDetails: { purgeAfter: "2026-11-07T09:20:01.000Z" }
  });
  expect(newMemory?.memory).toMatchObject({
    lifecycle: "active",
    predecessorMemoryId: original.memoryId,
    body: "Use pnpm 10."
  });
});
