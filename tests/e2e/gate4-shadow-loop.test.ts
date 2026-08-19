import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { handleCodexHook } from "../../src/adapters/codex/hook.js";
import { RecordingNotifier } from "../../src/adapters/macos/notifier.js";
import {
  listRecallEligibleMemoryIds,
  listSessionCandidates
} from "../../src/candidates/index.js";
import { initializeMemStore } from "../../src/operations/initialize.js";
import { buildRetrievalIndex, type EmbeddingAdapter } from "../../src/retrieval/index.js";
import {
  prepareSessionStartShadowPack,
  prepareUserPromptShadowPack
} from "../../src/retrieval/packs.js";
import { inspectReviewInbox } from "../../src/review/inbox.js";
import { writeCanonicalMemory } from "../../src/vault/index.js";
import { runWorkerOnce, type WorkerAdapters } from "../../src/worker/main.js";
import { makeCanonicalMemory } from "../helpers/canonical-memory.js";

const roots: string[] = [];
const projectId = "msproj_123e4567-e89b-42d3-a456-426614174901";
const humanMemoryId = "msmem_123e4567-e89b-42d3-a456-426614174902";

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const embedding: EmbeddingAdapter = {
  identity: {
    adapterVersion: "gate4-fixture-v1",
    modelIdentity: "gate4-fixture",
    artifactSha256: "d".repeat(64),
    dimensions: 2,
    normalization: "l2"
  },
  embed: (texts) => Promise.resolve(texts.map((text) =>
    /sqlite|wal/iu.test(text) ? [1, 0] : [0, 1]
  ))
};

test("the uninstalled Shadow loop reaches review without injecting or touching global state", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-gate4-shadow-loop-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, ".memstore-project"), JSON.stringify({
    schema_version: 1,
    project_id: projectId
  }));
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-09T00:59:00.000Z"));
  try {
    await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  } finally {
    vi.useRealTimers();
  }
  const humanMemory = makeCanonicalMemory({
    memoryId: humanMemoryId,
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174903",
    scope: { kind: "project", projectId },
    authority: "human_authored",
    body: "Human knowledge remains the highest authority."
  });
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: {
      ...humanMemory,
      createdAt: "2026-08-09T01:00:00.000Z",
      revisedAt: "2026-08-09T01:00:00.000Z"
    }
  });

  const commonHook = {
    session_id: "gate4-session",
    cwd: projectRoot
  };
  await expect(handleCodexHook({
    runtimeRoot,
    receivedAt: "2026-08-09T01:00:00.000Z",
    input: {
      ...commonHook,
      hook_event_name: "UserPromptSubmit",
      turn_id: "gate4-turn",
      prompt: "Use SQLite WAL and short transactions for durable state."
    }
  })).resolves.toMatchObject({ continue: true, captured: true });
  await expect(handleCodexHook({
    runtimeRoot,
    receivedAt: "2026-08-09T01:00:01.000Z",
    input: {
      ...commonHook,
      hook_event_name: "SessionEnd"
    }
  })).resolves.toMatchObject({ continue: true, captured: true });

  const notifier = new RecordingNotifier();
  const luna = {
    distillBatch(request) {
      const evidenceId = request.evidence.find((item) =>
        item.evidenceClass === "explicit_user_statement"
      )?.evidenceId;
      if (evidenceId === undefined) throw new Error("Expected explicit prompt evidence.");
      return Promise.resolve({
        schemaVersion: 1 as const,
        kind: "distillation" as const,
        candidates: [{
          statement: "Use SQLite WAL and short transactions for durable state.",
          primaryCategory: "architecture_contract",
          categoryTags: ["architecture_contract"],
          applicabilitySummary: "Current project",
          conditions: [],
          exclusions: [],
          preservedNegations: [],
          certainty: "asserted" as const,
          sensitivity: "normal" as const,
          evidenceIds: [evidenceId],
          importanceTags: [],
          importanceReasons: []
        }]
      });
    },
    consolidateSession() {
      return Promise.reject(new Error("One Batch must not consolidate."));
    },
    assessCandidateSemantics(request) {
      return Promise.resolve({
        schemaVersion: 1 as const,
        kind: "semantic_assessment" as const,
        state: "supported" as const,
        durabilityDisposition: "durable" as const,
        evidenceIds: request.evidence.map((item) => item.evidenceId)
      });
    },
    assessHumanConflict() {
      return Promise.reject(new Error("No Human conflict is expected."));
    }
  } satisfies NonNullable<WorkerAdapters["luna"]>;
  const governance = {
    reviewPage(request) {
      const human = request.memories.find((memory) => memory.memoryId === humanMemoryId);
      if (human === undefined) throw new Error("Expected Human Memory in governance page.");
      return Promise.resolve({
        schemaVersion: 1 as const,
        kind: "governance_page_review" as const,
        agentActions: [],
        reviewSuggestions: [{
          targetMemoryId: humanMemoryId,
          kind: "outdated" as const,
          reason: "Synthetic Gate 4 review proof.",
          evidenceRefs: ["gate4:synthetic"]
        }],
        futurePurgeObligations: [],
        summaryItems: ["Synthetic Gate 4 governance completed."]
      });
    }
  } satisfies NonNullable<WorkerAdapters["governance"]>;
  const adapters = { luna, governance, notifier };

  await expect(runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "gate4-worker",
    now: "2026-08-09T01:01:00.000Z",
    workerStartedAt: "2026-08-09T01:00:00.000Z",
    adapters
  })).resolves.toMatchObject({ state: "worked" });
  const candidates = await listSessionCandidates(runtimeRoot, "gate4-session");
  expect(candidates).toHaveLength(1);
  expect(await listSessionCandidates(runtimeRoot, "gate4-session")).toEqual([
    { candidateId: candidates[0]?.candidateId, state: "promoted" }
  ]);

  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: embedding,
    builtAt: "2026-08-09T01:03:00.000Z"
  });
  const startPack = await prepareSessionStartShadowPack({
    runtimeRoot,
    vaultRoot,
    projectId,
    sessionId: "gate4-recall-session",
    requestedAt: "2026-08-09T01:03:01.000Z"
  });
  const promptPack = await prepareUserPromptShadowPack({
    runtimeRoot,
    vaultRoot,
    projectId,
    sessionId: "gate4-recall-session",
    prompt: "How should SQLite WAL writes be structured?",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter: embedding,
    requestedAt: "2026-08-09T01:03:02.000Z"
  });
  const recallEligibleMemoryIds = await listRecallEligibleMemoryIds(runtimeRoot);
  const promotedMemoryId = recallEligibleMemoryIds.find((memoryId) => memoryId !== humanMemoryId);
  if (promotedMemoryId === undefined) throw new Error("Promoted Memory is not recall eligible.");
  expect(startPack).toMatchObject({ mode: "shadow", injected: false });
  expect(promptPack).toMatchObject({ mode: "shadow", injected: false });
  expect(startPack.items).not.toHaveLength(0);
  if (promptPack.items.length === 0) expect(promptPack.emptyReason).toBe("already_present");

  for (let ordinal = 0; ordinal < 4; ordinal += 1) {
    await runWorkerOnce({
      runtimeRoot,
      vaultRoot,
      workerId: "gate4-worker",
      now: `2026-08-10T11:0${String(ordinal + 1)}:00.000Z`,
      workerStartedAt: "2026-08-10T09:00:00.000Z",
      adapters
    });
  }
  const inbox = await inspectReviewInbox({ runtimeRoot, vaultRoot });
  expect(inbox?.counts.reviewSuggestions).toBe(1);
  expect(notifier.deliveries).toHaveLength(1);
  expect(notifier.deliveries[0]?.body).toMatch(/^1 items are ready/u);
});
