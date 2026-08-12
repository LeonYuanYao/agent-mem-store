import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { listSessionCandidates } from "../../src/candidates/index.js";
import { captureEvent, inspectCaptureEventState } from "../../src/capture/index.js";
import { LunaInvocationError } from "../../src/luna/index.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";
import {
  prepareNextDistillationBatch,
  runNextLunaWork,
  type LunaWorkerAdapter
} from "../../src/worker/distillation.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a transient Luna failure leaves evidence retryable and later produces one Candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-worker-retry-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const eventId = "msevent-retry-1";
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId,
      deduplicationKey: "retry-session:turn-1",
      agent: "codex",
      eventKind: "SessionEnd",
      occurredAt: "2026-08-07T12:00:00.000Z",
      projectId: "msproj_123e4567-e89b-42d3-a456-426614174001",
      sessionId: "retry-session",
      payload: { text: "Remember the bounded rule." }
    }
  });
  await prepareNextDistillationBatch({
    runtimeRoot,
    maximumEvents: 8,
    preparedAt: "2026-08-07T12:00:01.000Z"
  });

  const unavailable: LunaWorkerAdapter = {
    distillBatch() {
      return Promise.reject(new LunaInvocationError("unavailable", true, "offline"));
    },
    consolidateSession() {
      throw new Error("No consolidation expected.");
    }
  };
  await expect(runNextLunaWork({
    runtimeRoot,
    workerId: "worker-retry",
    now: "2026-08-07T12:00:02.000Z",
    adapter: unavailable
  })).resolves.toMatchObject({ state: "retrying" });
  await expect(inspectCaptureEventState(runtimeRoot, eventId)).resolves.toMatchObject({
    state: "pending"
  });
  await expect(listSessionCandidates(runtimeRoot, "retry-session")).resolves.toEqual([]);

  let successfulDistillations = 0;
  const recovered: LunaWorkerAdapter = {
    distillBatch(request) {
      successfulDistillations += 1;
      return Promise.resolve({
        schemaVersion: 1,
        kind: "distillation",
        candidates: [{
          statement: "Remember the bounded rule.",
          primaryCategory: "preference_constraint",
          categoryTags: ["preference_constraint"],
          applicabilitySummary: "retry project",
          conditions: [],
          exclusions: [],
          preservedNegations: [],
          certainty: "asserted",
          sensitivity: "normal",
          evidenceIds: request.evidence.map((item) => item.evidenceId),
          importanceTags: [],
          importanceReasons: []
        }]
      });
    },
    consolidateSession() {
      throw new Error("No consolidation expected.");
    }
  };
  await expect(runNextLunaWork({
    runtimeRoot,
    workerId: "worker-retry",
    now: "2026-08-08T12:00:00.000Z",
    adapter: recovered
  })).resolves.toMatchObject({ state: "completed" });
  await expect(inspectCaptureEventState(runtimeRoot, eventId)).resolves.toMatchObject({
    state: "completed"
  });
  await expect(listSessionCandidates(runtimeRoot, "retry-session")).resolves.toHaveLength(1);

  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare(
      `UPDATE luna_operations
       SET state = 'retrying', next_retry_at = ?, updated_at = ?
       WHERE operation_id = (
         SELECT operation_id FROM distillation_batches LIMIT 1
       )`
    ).run("2026-08-08T12:00:01.000Z", "2026-08-08T12:00:01.000Z");
  } finally {
    database.close();
  }
  const mustNotReinvoke: LunaWorkerAdapter = {
    distillBatch() {
      throw new Error("A persisted Batch result must not invoke Luna again.");
    },
    consolidateSession() {
      throw new Error("No consolidation expected.");
    }
  };
  await expect(runNextLunaWork({
    runtimeRoot,
    workerId: "worker-replay",
    now: "2026-08-08T12:00:02.000Z",
    adapter: mustNotReinvoke
  })).resolves.toMatchObject({ state: "completed" });
  expect(successfulDistillations).toBe(1);
  await expect(listSessionCandidates(runtimeRoot, "retry-session")).resolves.toHaveLength(1);
});
