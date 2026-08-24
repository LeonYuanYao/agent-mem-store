import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { captureEvent } from "../../../src/capture/index.js";
import { initializeMemStore } from "../../../src/operations/initialize.js";
import {
  inspectKnowledgeVerificationRun,
  recordKnowledgeVerificationRun
} from "../../../src/operations/knowledge-verification.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a source-first verification run records an independently reviewable recall result", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-knowledge-verification-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const sessionId = "verification-session";
  const eventIds = ["matched", "missed", "omitted", "ambiguous"].map(
    (suffix) => `msevent_verification_${suffix}`
  );
  for (const [index, eventId] of eventIds.entries()) {
    await captureEvent({
      runtimeRoot,
      event: {
        schemaVersion: 1,
        eventId,
        deduplicationKey: `codex:verification:${String(index)}`,
        agent: "codex",
        eventKind: index === 0 ? "UserPromptSubmit" : "PostToolUse",
        occurredAt: `2026-08-24T10:00:0${String(index)}.000Z`,
        projectId: "msproj_verification",
        sessionId,
        turnId: `turn-${String(index)}`,
        payload: { text: `Source evidence ${String(index)}` }
      }
    });
  }
  const memory = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174301",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174301",
    authority: "agent_derived",
    body: "Run the project typecheck before a release."
  });
  await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "agent", memory });
  const request = {
    runtimeRoot,
    reviewerKind: "model_proposed_human_confirmed" as const,
    sourceWindow: {
      startedAt: "2026-08-24T00:00:00.000Z",
      endedAt: "2026-08-24T23:59:59.000Z"
    },
    sampleFrame: {
      kind: "source_first_session_stratified" as const,
      strata: ["project", "session_length"] as Array<"project" | "session_length">,
      perStratumCap: 2
    },
    units: [
      {
        unitId: "unit-matched",
        sourceRef: { sessionId, turnIds: ["turn-0"], evidenceIds: [eventIds[0] ?? ""] },
        eligibleDurablePresent: true,
        disposition: "matched_durable" as const,
        linkedMemoryIds: [memory.memoryId],
        note: "The durable rule is present in Canonical Memory."
      },
      {
        unitId: "unit-missed",
        sourceRef: { sessionId, turnIds: ["turn-1"], evidenceIds: [eventIds[1] ?? ""] },
        eligibleDurablePresent: true,
        disposition: "missed_durable" as const,
        linkedMemoryIds: [],
        note: "A durable exception was not retained."
      },
      {
        unitId: "unit-omitted",
        sourceRef: { sessionId, turnIds: ["turn-2"], evidenceIds: [eventIds[2] ?? ""] },
        eligibleDurablePresent: false,
        disposition: "correct_omission" as const,
        linkedMemoryIds: []
      },
      {
        unitId: "unit-ambiguous",
        sourceRef: { sessionId, turnIds: ["turn-3"], evidenceIds: [eventIds[3] ?? ""] },
        eligibleDurablePresent: false,
        disposition: "ambiguous" as const,
        linkedMemoryIds: [],
        note: "The source does not establish whether this applies beyond the task."
      }
    ],
    createdAt: "2026-08-24T12:00:00.000Z"
  };

  await expect(recordKnowledgeVerificationRun({
    ...request,
    reviewerKind: "model_proposed",
    preview: true
  })).resolves.toMatchObject({ state: "preview", dry_run: true, recall: 0.5 });
  await expect(recordKnowledgeVerificationRun({
    ...request,
    reviewerKind: "model_proposed",
    preview: false
  })).rejects.toThrow("Human confirmation is required");

  await expect(recordKnowledgeVerificationRun({ ...request, preview: true })).resolves.toEqual({
    state: "preview",
    dry_run: true,
    would_change: ["knowledge_verification_run"],
    counts: { matched_durable: 1, missed_durable: 1, correct_omission: 1, ambiguous: 1 },
    recall: 0.5
  });

  const recorded = await recordKnowledgeVerificationRun({ ...request, preview: false });
  if (recorded.state !== "recorded") throw new Error("Expected a recorded Verification Run.");
  expect(recorded).toMatchObject({
    state: "recorded",
    counts: { matched_durable: 1, missed_durable: 1, correct_omission: 1, ambiguous: 1 },
    recall: 0.5
  });
  const inspected = await inspectKnowledgeVerificationRun({
    runtimeRoot,
    runId: recorded.runId
  });
  expect(inspected).toMatchObject({
    runId: recorded.runId,
    policyVersion: "source-first-recall-v1",
    reviewerKind: "model_proposed_human_confirmed",
    sampleFrame: { kind: "source_first_session_stratified" },
    counts: { matched_durable: 1, missed_durable: 1, correct_omission: 1, ambiguous: 1 },
    recall: 0.5
  });
  expect(JSON.stringify(inspected?.units)).toContain('"unitId":"unit-matched"');
  expect(JSON.stringify(inspected?.units)).toContain('"disposition":"missed_durable"');
});

test("source-first verification rejects evidence outside the declared source window", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-knowledge-window-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const eventId = "msevent_verification_outside_window";
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId,
      deduplicationKey: "codex:verification:outside-window",
      agent: "codex",
      eventKind: "UserPromptSubmit",
      occurredAt: "2026-08-23T23:59:59.000Z",
      projectId: "msproj_verification",
      sessionId: "verification-window-session",
      turnId: "turn-outside",
      payload: { text: "A source outside the declared window." }
    }
  });

  await expect(recordKnowledgeVerificationRun({
    runtimeRoot,
    reviewerKind: "human",
    sourceWindow: {
      startedAt: "2026-08-24T00:00:00.000Z",
      endedAt: "2026-08-24T23:59:59.000Z"
    },
    sampleFrame: {
      kind: "source_first_session_stratified",
      strata: ["session_recency"],
      perStratumCap: 1
    },
    units: [{
      unitId: "unit-outside-window",
      sourceRef: {
        sessionId: "verification-window-session",
        turnIds: ["turn-outside"],
        evidenceIds: [eventId]
      },
      eligibleDurablePresent: false,
      disposition: "correct_omission",
      linkedMemoryIds: []
    }],
    createdAt: "2026-08-24T12:00:00.000Z",
    preview: true
  })).rejects.toThrow("outside the declared source window");
});
