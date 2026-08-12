import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { captureEvent, inspectCaptureEventState } from "../../src/capture/index.js";
import { listSessionCandidates } from "../../src/candidates/index.js";
import {
  inspectSessionDistillation,
  prepareNextDistillationBatch,
  runNextLunaWork,
  type LunaWorkerAdapter
} from "../../src/worker/distillation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

test("a long Session is distilled in batches and consolidated from structured results", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-distillation-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";
  const eventIds: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const eventId = `msevent_123e4567-e89b-42d3-a456-42661417410${String(index)}`;
    eventIds.push(eventId);
    await captureEvent({
      runtimeRoot,
      event: {
        schemaVersion: 1,
        eventId,
        deduplicationKey: `codex:long-session:turn-${String(index)}`,
        agent: "codex",
        eventKind: index === 4 ? "SessionEnd" : index % 2 === 0 ? "UserPromptSubmit" : "Stop",
        occurredAt: `2026-08-07T07:00:0${String(index)}.000Z`,
        projectId,
        sessionId: "long-session",
        turnId: `turn-${String(index)}`,
        payload: { text: `RAW-EVIDENCE-${String(index)}` }
      }
    });
  }

  for (let index = 0; index < 3; index += 1) {
    await expect(
      prepareNextDistillationBatch({
        runtimeRoot,
        maximumEvents: 2,
        preparedAt: `2026-08-07T07:01:0${String(index)}.000Z`
      })
    ).resolves.toMatchObject({ state: "queued", sessionId: "long-session" });
  }
  await expect(
    prepareNextDistillationBatch({
      runtimeRoot,
      maximumEvents: 2,
      preparedAt: "2026-08-07T07:01:03.000Z"
    })
  ).resolves.toEqual({ state: "empty" });

  const distillationEvidenceCounts: number[] = [];
  let consolidationInput = "";
  const adapter: LunaWorkerAdapter = {
    distillBatch(request) {
      distillationEvidenceCounts.push(request.evidence.length);
      return Promise.resolve({
        schemaVersion: 1,
        kind: "distillation",
        candidates: [
          {
            statement: `Batch statement ${request.operationId}`,
            primaryCategory: "preference_constraint",
            categoryTags: ["preference_constraint"],
            applicabilitySummary: "long session",
            conditions: [],
            exclusions: [],
            preservedNegations: [],
            certainty: "asserted",
            sensitivity: "normal",
            evidenceIds: [request.evidence[0]?.evidenceId ?? "missing-evidence"],
            importanceTags: ["constraint"],
            importanceReasons: [{
              tag: "constraint",
              reason: "Preserve the evidence from the end of this Batch.",
              evidenceIds: [request.evidence.at(-1)?.evidenceId ?? "missing-evidence"]
            }]
          }
        ]
      });
    },
    consolidateSession(request) {
      consolidationInput = JSON.stringify(request);
      for (const batch of request.batchResults) {
        const available = new Set(batch.evidenceIds);
        for (const evidenceId of batch.candidates.flatMap((candidate) =>
          candidate.importanceReasons.flatMap((reason) => reason.evidenceIds)
        )) {
          if (!available.has(evidenceId)) {
            throw new Error("Importance-reason evidence was omitted from consolidation aliases.");
          }
        }
      }
      return Promise.resolve({
        schemaVersion: 1,
        kind: "consolidation",
        candidates: [
          {
            statement: "Consolidated long-session knowledge.",
            primaryCategory: "preference_constraint",
            categoryTags: ["preference_constraint"],
            applicabilitySummary: "long session",
            conditions: [],
            exclusions: [],
            preservedNegations: [],
            certainty: "asserted",
            sensitivity: "normal",
            evidenceIds: [request.batchResults[0]?.evidenceIds[0] ?? "missing-evidence"],
            importanceTags: ["constraint"],
            importanceReasons: [{
              tag: "constraint",
              reason: "Preserve the final supporting evidence.",
              evidenceIds: [request.batchResults.at(-1)?.evidenceIds.at(-1) ?? "missing-evidence"]
            }]
          }
        ]
      });
    }
  };

  for (let index = 0; index < 4; index += 1) {
    await expect(
      runNextLunaWork({
        runtimeRoot,
        workerId: "worker-1",
        now: `2026-08-07T07:02:0${String(index)}.000Z`,
        adapter
      })
    ).resolves.toMatchObject({ state: "completed" });
  }

  const session = await inspectSessionDistillation({
    runtimeRoot,
    sessionId: "long-session"
  });
  expect(distillationEvidenceCounts).toEqual([2, 2, 1]);
  expect(session).toMatchObject({
    sessionId: "long-session",
    batchCount: 3,
    completedBatchCount: 3,
    consolidationState: "completed"
  });
  expect(consolidationInput).not.toContain("RAW-EVIDENCE");
  expect(consolidationInput).toContain("Batch statement");
  for (const eventId of eventIds) expect(consolidationInput).toContain(eventId);
  await expect(listSessionCandidates(runtimeRoot, "long-session")).resolves.toHaveLength(1);
  for (const eventId of eventIds) {
    await expect(inspectCaptureEventState(runtimeRoot, eventId)).resolves.toMatchObject({
      state: "completed"
    });
  }
});

test("the Worker coalescing window waits briefly but SessionEnd flushes the whole Session", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-coalescing-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  for (const [index, eventKind] of ["UserPromptSubmit", "Stop", "SessionEnd"].entries()) {
    await captureEvent({
      runtimeRoot,
      event: {
        schemaVersion: 1,
        eventId: `msevent_coalescing_${String(index)}`,
        deduplicationKey: `codex:coalescing:${String(index)}`,
        agent: "codex",
        eventKind: eventKind as "UserPromptSubmit" | "Stop" | "SessionEnd",
        occurredAt: `2026-08-07T08:00:0${String(index)}.000Z`,
        projectId: "msproj_coalescing",
        sessionId: "coalescing-session",
        payload: { index }
      }
    });
    if (index === 1) {
      await expect(prepareNextDistillationBatch({
        runtimeRoot,
        maximumEvents: 64,
        preparedAt: "2026-08-07T08:00:10.000Z",
        minimumEventAgeMilliseconds: 30_000
      })).resolves.toEqual({ state: "empty" });
    }
  }

  await expect(prepareNextDistillationBatch({
    runtimeRoot,
    maximumEvents: 64,
    preparedAt: "2026-08-07T08:00:03.000Z",
    minimumEventAgeMilliseconds: 30_000
  })).resolves.toMatchObject({
    state: "queued",
    sessionId: "coalescing-session",
    eventCount: 3
  });
});
