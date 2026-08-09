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
            category: "lesson",
            applicabilitySummary: "long session",
            conditions: [],
            exclusions: [],
            preservedNegations: [],
            certainty: "asserted",
            sensitivity: "normal",
            evidenceIds: request.evidence.map((item) => item.evidenceId),
            importanceTags: [],
            importanceReasons: []
          }
        ]
      });
    },
    consolidateSession(request) {
      consolidationInput = JSON.stringify(request);
      return Promise.resolve({
        schemaVersion: 1,
        kind: "consolidation",
        candidates: [
          {
            statement: "Consolidated long-session knowledge.",
            category: "lesson",
            applicabilitySummary: "long session",
            conditions: [],
            exclusions: [],
            preservedNegations: [],
            certainty: "asserted",
            sensitivity: "normal",
            evidenceIds: request.batchResults.flatMap((batch) => batch.evidenceIds),
            importanceTags: [],
            importanceReasons: []
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
  await expect(listSessionCandidates(runtimeRoot, "long-session")).resolves.toHaveLength(1);
  for (const eventId of eventIds) {
    await expect(inspectCaptureEventState(runtimeRoot, eventId)).resolves.toMatchObject({
      state: "completed"
    });
  }
});
