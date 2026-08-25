import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { captureEvent, inspectCaptureEventState } from "../../src/capture/index.js";
import { listSessionCandidates } from "../../src/candidates/index.js";
import {
  inspectSessionDistillation,
  prepareNextDistillationBatch,
  prepareNextSessionConsolidation,
  runNextLunaWork,
  type LunaWorkerAdapter
} from "../../src/worker/distillation.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";
import { inspectAdmissionAudit } from "../../src/admission/audit.js";
import { makeLongTermCandidateDurability } from "../helpers/candidate-durability.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
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
            durability: makeLongTermCandidateDurability(),
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
            evidenceIds: [...new Set(
              request.batchResults.flatMap((batch) => batch.evidenceIds)
            )],
            durability: makeLongTermCandidateDurability(),
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
  const auditDatabase = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(auditDatabase.prepare(
      `SELECT source_kind, prompt_version
       FROM admission_audit
       ORDER BY created_at, source_kind`
    ).all()).toEqual([
      { source_kind: "distillation", prompt_version: 6 },
      { source_kind: "distillation", prompt_version: 6 },
      { source_kind: "distillation", prompt_version: 6 },
      { source_kind: "consolidation", prompt_version: 6 }
    ]);
  } finally {
    auditDatabase.close();
  }
  await expect(listSessionCandidates(runtimeRoot, "long-session")).resolves.toHaveLength(1);
  for (const eventId of eventIds) {
    await expect(inspectCaptureEventState(runtimeRoot, eventId)).resolves.toMatchObject({
      state: "completed"
    });
  }
});

test("Session consolidation cannot silently discard an explicit-user durable Candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-consolidation-authority-coverage-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const projectId = "msproj_consolidation_authority";
  const sessionId = "consolidation-authority-session";
  const events = [
    {
      eventId: "msevent_consolidation_authority_user",
      eventKind: "UserPromptSubmit" as const,
      turnId: "consolidation-authority-turn",
      payload: { prompt: "MemStore must use main as its ongoing maintenance branch." }
    },
    {
      eventId: "msevent_consolidation_authority_tool",
      eventKind: "PostToolUse" as const,
      turnId: "consolidation-authority-turn",
      payload: { output: "The branch was updated for this run." }
    },
    {
      eventId: "msevent_consolidation_authority_end",
      eventKind: "SessionEnd" as const,
      payload: { reason: "closed" }
    }
  ];
  for (const [index, event] of events.entries()) {
    await captureEvent({
      runtimeRoot,
      event: {
        schemaVersion: 1,
        eventId: event.eventId,
        deduplicationKey: `codex:consolidation-authority:${String(index)}`,
        agent: "codex",
        eventKind: event.eventKind,
        occurredAt: `2026-08-25T08:00:0${String(index)}.000Z`,
        projectId,
        sessionId,
        ...("turnId" in event ? { turnId: event.turnId } : {}),
        payload: event.payload
      }
    });
  }
  for (let index = 0; index < 2; index += 1) {
    await expect(prepareNextDistillationBatch({
      runtimeRoot,
      maximumEvents: 2,
      preparedAt: `2026-08-25T08:01:0${String(index)}.000Z`
    })).resolves.toMatchObject({ state: "queued", sessionId });
  }

  const durableStatement = "MemStore uses main as its ongoing maintenance branch.";
  const adapter: LunaWorkerAdapter = {
    distillBatch(request) {
      const evidence = request.evidence[0];
      if (evidence === undefined) throw new Error("Expected Batch evidence.");
      return Promise.resolve({
        schemaVersion: 1,
        kind: "distillation",
        candidates: [{
          statement: evidence.evidenceClass === "explicit_user_statement"
            ? durableStatement
            : "The branch changed during this task.",
          primaryCategory: "preference_constraint",
          categoryTags: ["preference_constraint"],
          applicabilitySummary: "MemStore maintenance",
          conditions: [],
          exclusions: [],
          preservedNegations: [],
          certainty: "asserted",
          sensitivity: "normal",
          evidenceIds: [evidence.evidenceId],
          durability: makeLongTermCandidateDurability(),
          importanceTags: [],
          importanceReasons: []
        }]
      });
    },
    consolidateSession() {
      return Promise.resolve({
        schemaVersion: 1,
        kind: "consolidation",
        candidates: [],
        consolidationSummary: {
          schemaVersion: 1,
          counts: { dedup: 2, source_echo: 0, downgrade: 0 },
          samples: []
        }
      });
    }
  };

  for (let index = 0; index < 3; index += 1) {
    await expect(runNextLunaWork({
      runtimeRoot,
      workerId: "worker-consolidation-authority",
      now: `2026-08-25T08:02:0${String(index)}.000Z`,
      adapter
    })).resolves.toMatchObject({ state: "completed" });
  }

  await expect(listSessionCandidates(runtimeRoot, sessionId)).resolves.toMatchObject([
    { state: "waiting" }
  ]);
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(database.prepare(
      "SELECT statement FROM memory_candidates WHERE source_session_id = ?"
    ).get(sessionId)).toEqual({ statement: durableStatement });
  } finally {
    database.close();
  }
});

test("the Worker persists considered rejections without inserting them into admission audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-admission-audit-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const projectId = "msproj_admission_audit";
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent_admission_audit",
      deduplicationKey: "codex:admission-audit",
      agent: "codex",
      eventKind: "SessionEnd",
      occurredAt: "2026-08-23T10:00:00.000Z",
      projectId,
      sessionId: "admission-audit-session",
      payload: { text: "Mixed durable and transient evidence." }
    }
  });
  const prepared = await prepareNextDistillationBatch({
    runtimeRoot,
    maximumEvents: 64,
    preparedAt: "2026-08-23T10:00:01.000Z"
  });
  if (prepared.state !== "queued") throw new Error("Expected one queued admission Batch.");

  const common = {
    primaryCategory: "workflow_environment_toolchain" as const,
    categoryTags: ["workflow_environment_toolchain" as const],
    applicabilitySummary: "future project work",
    conditions: [],
    exclusions: [],
    preservedNegations: [],
    certainty: "asserted" as const,
    sensitivity: "normal" as const,
    evidenceIds: ["msevent_admission_audit"],
    importanceTags: [],
    importanceReasons: []
  };
  const adapter: LunaWorkerAdapter = {
    distillBatch() {
      return Promise.resolve({
        schemaVersion: 1,
        kind: "distillation",
        candidates: [
          {
            ...common,
            statement: "Future releases require a clean typecheck.",
            retentionDecision: "long_term",
            durability: makeLongTermCandidateDurability()
          }
        ],
        rejectionSummary: {
          schemaVersion: 1,
          coverage: "considered_memory_shaped_rejections_only",
          counts: { no_memory: 1, session_only: 1, uncertain: 1, source_echo: 0 },
          samples: [{
            reason: "no_memory",
            proposition: "The typecheck completed at 10:00 today.",
            evidenceIds: ["msevent_admission_audit"]
          }]
        }
      });
    },
    consolidateSession() {
      throw new Error("A one-Batch Session must not consolidate.");
    }
  };

  await expect(runNextLunaWork({
    runtimeRoot,
    workerId: "worker-admission-audit",
    now: "2026-08-23T10:00:02.000Z",
    adapter
  })).resolves.toMatchObject({ state: "completed", operationId: prepared.operationId });

  await expect(listSessionCandidates(runtimeRoot, "admission-audit-session"))
    .resolves.toMatchObject([{ state: "waiting" }]);
  await expect(inspectAdmissionAudit({ runtimeRoot, operationId: prepared.operationId }))
    .resolves.toMatchObject([
      { ordinal: 0, retentionDecision: "long_term", outcome: "admitted", reason: "long_term" }
    ]);
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const row = database.prepare(
      "SELECT result_json FROM distillation_batches WHERE batch_id = ?"
    ).get(prepared.batchId);
    expect(JSON.parse(String(row?.result_json))).toMatchObject({
      rejectionSummary: {
        coverage: "considered_memory_shaped_rejections_only",
        counts: { no_memory: 1, session_only: 1, uncertain: 1, source_echo: 0 }
      }
    });
  } finally {
    database.close();
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

test("an active long-running Turn waits for Stop instead of creating micro-Batches", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-long-turn-coalescing-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const turnId = "long-turn-1";
  const eventKinds = ["UserPromptSubmit", "PostToolUse", "PostToolUse"] as const;
  for (const [index, eventKind] of eventKinds.entries()) {
    await captureEvent({
      runtimeRoot,
      event: {
        schemaVersion: 1,
        eventId: `msevent_long_turn_${String(index)}`,
        deduplicationKey: `codex:long-turn:${String(index)}`,
        agent: "codex",
        eventKind,
        occurredAt: `2026-08-07T09:00:0${String(index)}.000Z`,
        projectId: "msproj_long_turn",
        sessionId: "long-turn-session",
        turnId,
        payload: { index }
      }
    });
  }

  await expect(prepareNextDistillationBatch({
    runtimeRoot,
    maximumEvents: 64,
    preparedAt: "2026-08-07T10:00:00.000Z",
    minimumEventAgeMilliseconds: 30_000
  })).resolves.toEqual({ state: "empty" });

  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent_long_turn_stop",
      deduplicationKey: "codex:long-turn:stop",
      agent: "codex",
      eventKind: "Stop",
      occurredAt: "2026-08-07T10:00:01.000Z",
      projectId: "msproj_long_turn",
      sessionId: "long-turn-session",
      turnId,
      payload: { assistantMessage: "Completed the long-running task." }
    }
  });

  await expect(prepareNextDistillationBatch({
    runtimeRoot,
    maximumEvents: 64,
    preparedAt: "2026-08-07T10:00:02.000Z",
    minimumEventAgeMilliseconds: 30_000
  })).resolves.toMatchObject({
    state: "queued",
    sessionId: "long-turn-session",
    eventCount: 4
  });
});

test("an abandoned Turn is sealed after a bounded inactivity window", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-07T09:00:00.000Z"));
  const root = await mkdtemp(join(tmpdir(), "memstore-abandoned-turn-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const turnId = "abandoned-turn-1";
  for (let index = 0; index < 3; index += 1) {
    await captureEvent({
      runtimeRoot,
      event: {
        schemaVersion: 1,
        eventId: `msevent_abandoned_turn_${String(index)}`,
        deduplicationKey: `codex:abandoned-turn:${String(index)}`,
        agent: "codex",
        eventKind: "PostToolUse",
        occurredAt: `2026-08-07T09:00:0${String(index)}.000Z`,
        projectId: "msproj_abandoned_turn",
        sessionId: "abandoned-turn-session",
        turnId,
        payload: { index }
      }
    });
  }

  await expect(prepareNextDistillationBatch({
    runtimeRoot,
    maximumEvents: 64,
    preparedAt: "2026-08-07T10:00:00.000Z",
    minimumEventAgeMilliseconds: 30_000,
    staleTurnInactivityMilliseconds: 2 * 60 * 60 * 1_000
  })).resolves.toEqual({ state: "empty" });

  await expect(prepareNextDistillationBatch({
    runtimeRoot,
    maximumEvents: 64,
    preparedAt: "2026-08-07T11:00:03.000Z",
    minimumEventAgeMilliseconds: 30_000,
    staleTurnInactivityMilliseconds: 2 * 60 * 60 * 1_000
  })).resolves.toMatchObject({
    state: "queued",
    sessionId: "abandoned-turn-session",
    eventCount: 3
  });
});

test("an active long-running Turn checkpoints after reaching the retained-byte budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-long-turn-byte-checkpoint-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  for (let index = 0; index < 2; index += 1) {
    await captureEvent({
      runtimeRoot,
      event: {
        schemaVersion: 1,
        eventId: `msevent_long_turn_bytes_${String(index)}`,
        deduplicationKey: `codex:long-turn-bytes:${String(index)}`,
        agent: "codex",
        eventKind: "PostToolUse",
        occurredAt: `2026-08-07T11:00:0${String(index)}.000Z`,
        projectId: "msproj_long_turn_bytes",
        sessionId: "long-turn-byte-session",
        turnId: "long-turn-byte-1",
        payload: { output: "x".repeat(300 * 1024) }
      }
    });
  }

  await expect(prepareNextDistillationBatch({
    runtimeRoot,
    maximumEvents: 64,
    maximumRetainedBytes: 512 * 1024,
    preparedAt: "2026-08-07T11:01:00.000Z"
  })).resolves.toMatchObject({
    state: "queued",
    sessionId: "long-turn-byte-session"
  });
});

test("a resumed Session consolidates each newly closed Batch range", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-resumed-session-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const projectId = "msproj_resumed_session";

  const captureEpisode = async (episode: number): Promise<void> => {
    for (let index = 0; index < 3; index += 1) {
      await captureEvent({
        runtimeRoot,
        event: {
          schemaVersion: 1,
          eventId: `msevent_resumed_${String(episode)}_${String(index)}`,
          deduplicationKey: `codex:resumed:${String(episode)}:${String(index)}`,
          agent: "codex",
          eventKind: index === 2 ? "SessionEnd" : "PostToolUse",
          occurredAt: `2026-08-07T1${String(episode)}:00:0${String(index)}.000Z`,
          projectId,
          sessionId: "resumed-session",
          ...(index === 2 ? {} : { turnId: `episode-${String(episode)}-turn` }),
          payload: { episode, index }
        }
      });
    }
    for (let index = 0; index < 2; index += 1) {
      await expect(prepareNextDistillationBatch({
        runtimeRoot,
        maximumEvents: 2,
        preparedAt: `2026-08-07T1${String(episode)}:01:0${String(index)}.000Z`
      })).resolves.toMatchObject({ state: "queued", sessionId: "resumed-session" });
    }
  };

  let consolidationCalls = 0;
  const adapter: LunaWorkerAdapter = {
    distillBatch(request) {
      return Promise.resolve({
        schemaVersion: 1,
        kind: "distillation",
        candidates: [{
          statement: `Batch ${request.operationId}`,
          primaryCategory: "workflow_environment_toolchain",
          categoryTags: ["workflow_environment_toolchain"],
          applicabilitySummary: "resumed session",
          conditions: [],
          exclusions: [],
          preservedNegations: [],
          certainty: "asserted",
          sensitivity: "normal",
          evidenceIds: [request.evidence[0]?.evidenceId ?? "missing-evidence"],
          durability: makeLongTermCandidateDurability(),
          importanceTags: [],
          importanceReasons: []
        }]
      });
    },
    consolidateSession(request) {
      consolidationCalls += 1;
      return Promise.resolve({
        schemaVersion: 1,
        kind: "consolidation",
        candidates: [{
          statement: `Resumed Session generation ${String(consolidationCalls)}.`,
          primaryCategory: "workflow_environment_toolchain",
          categoryTags: ["workflow_environment_toolchain"],
          applicabilitySummary: "resumed session",
          conditions: [],
          exclusions: [],
          preservedNegations: [],
          certainty: "asserted",
          sensitivity: "normal",
          evidenceIds: [request.batchResults[0]?.evidenceIds[0] ?? "missing-evidence"],
          durability: makeLongTermCandidateDurability(),
          importanceTags: [],
          importanceReasons: []
        }]
      });
    }
  };

  await captureEpisode(2);
  for (let index = 0; index < 3; index += 1) {
    await runNextLunaWork({
      runtimeRoot,
      workerId: "worker-resumed",
      now: `2026-08-07T12:02:0${String(index)}.000Z`,
      adapter
    });
  }

  await captureEpisode(3);
  for (let index = 0; index < 3; index += 1) {
    await runNextLunaWork({
      runtimeRoot,
      workerId: "worker-resumed",
      now: `2026-08-07T13:02:0${String(index)}.000Z`,
      adapter
    });
  }

  expect(consolidationCalls).toBe(2);
  await expect(listSessionCandidates(runtimeRoot, "resumed-session")).resolves.toHaveLength(2);
});

test("completed legacy Batch ranges are discovered for consolidation backfill", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-consolidation-backfill-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  for (let index = 0; index < 3; index += 1) {
    await captureEvent({
      runtimeRoot,
      event: {
        schemaVersion: 1,
        eventId: `msevent_backfill_${String(index)}`,
        deduplicationKey: `codex:backfill:${String(index)}`,
        agent: "codex",
        eventKind: index === 2 ? "SessionEnd" : "PostToolUse",
        occurredAt: `2026-08-07T14:00:0${String(index)}.000Z`,
        projectId: "msproj_backfill",
        sessionId: "backfill-session",
        ...(index === 2 ? {} : { turnId: "backfill-turn" }),
        payload: { index }
      }
    });
  }
  for (let index = 0; index < 2; index += 1) {
    await prepareNextDistillationBatch({
      runtimeRoot,
      maximumEvents: 2,
      preparedAt: `2026-08-07T14:01:0${String(index)}.000Z`
    });
  }
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare(
      `UPDATE distillation_batches
       SET state = 'completed', result_json = ?, completed_at = ?`
    ).run(
      JSON.stringify({ schemaVersion: 1, kind: "distillation", candidates: [] }),
      "2026-08-07T14:02:00.000Z"
    );
    database.prepare(
      `UPDATE luna_operations
       SET state = 'completed', completed_at = ?, updated_at = ?
       WHERE operation_kind = 'distill_batch'`
    ).run("2026-08-07T14:02:00.000Z", "2026-08-07T14:02:00.000Z");
  } finally {
    database.close();
  }

  await expect(prepareNextSessionConsolidation({
    runtimeRoot,
    preparedAt: "2026-08-07T14:03:00.000Z"
  })).resolves.toMatchObject({
    state: "queued",
    sessionId: "backfill-session",
    fromBatchOrdinal: 0,
    throughBatchOrdinal: 1
  });
});

test("a directly ingested single-Batch episode is excluded from later consolidation", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-direct-episode-cursor-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const projectId = "msproj_direct_episode";
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent_direct_episode_1",
      deduplicationKey: "codex:direct-episode:1",
      agent: "codex",
      eventKind: "SessionEnd",
      occurredAt: "2026-08-07T15:00:00.000Z",
      projectId,
      sessionId: "direct-episode-session",
      payload: { episode: 1 }
    }
  });
  await prepareNextDistillationBatch({
    runtimeRoot,
    maximumEvents: 2,
    preparedAt: "2026-08-07T15:00:01.000Z"
  });

  let consolidationBatchCount = 0;
  const adapter: LunaWorkerAdapter = {
    distillBatch(request) {
      return Promise.resolve({
        schemaVersion: 1,
        kind: "distillation",
        candidates: [{
          statement: `Episode evidence ${request.evidence[0]?.evidenceId ?? "missing"}`,
          primaryCategory: "durable_reference",
          categoryTags: ["durable_reference"],
          applicabilitySummary: "direct episode",
          conditions: [],
          exclusions: [],
          preservedNegations: [],
          certainty: "asserted",
          sensitivity: "normal",
          evidenceIds: [request.evidence[0]?.evidenceId ?? "missing"],
          durability: makeLongTermCandidateDurability(),
          importanceTags: [],
          importanceReasons: []
        }]
      });
    },
    consolidateSession(request) {
      consolidationBatchCount = request.batchResults.length;
      return Promise.resolve({
        schemaVersion: 1,
        kind: "consolidation",
        candidates: [{
          statement: "Episode 2 consolidated knowledge.",
          primaryCategory: "durable_reference",
          categoryTags: ["durable_reference"],
          applicabilitySummary: "direct episode",
          conditions: [],
          exclusions: [],
          preservedNegations: [],
          certainty: "asserted",
          sensitivity: "normal",
          evidenceIds: [request.batchResults[0]?.evidenceIds[0] ?? "missing"],
          durability: makeLongTermCandidateDurability(),
          importanceTags: [],
          importanceReasons: []
        }]
      });
    }
  };
  await runNextLunaWork({
    runtimeRoot,
    workerId: "worker-direct-episode",
    now: "2026-08-07T15:00:02.000Z",
    adapter
  });

  for (let index = 0; index < 3; index += 1) {
    await captureEvent({
      runtimeRoot,
      event: {
        schemaVersion: 1,
        eventId: `msevent_direct_episode_2_${String(index)}`,
        deduplicationKey: `codex:direct-episode:2:${String(index)}`,
        agent: "codex",
        eventKind: index === 2 ? "SessionEnd" : "PostToolUse",
        occurredAt: `2026-08-07T16:00:0${String(index)}.000Z`,
        projectId,
        sessionId: "direct-episode-session",
        ...(index === 2 ? {} : { turnId: "direct-episode-turn-2" }),
        payload: { episode: 2, index }
      }
    });
  }
  for (let index = 0; index < 2; index += 1) {
    await prepareNextDistillationBatch({
      runtimeRoot,
      maximumEvents: 2,
      preparedAt: `2026-08-07T16:01:0${String(index)}.000Z`
    });
  }
  for (let index = 0; index < 3; index += 1) {
    await runNextLunaWork({
      runtimeRoot,
      workerId: "worker-direct-episode",
      now: `2026-08-07T16:02:0${String(index)}.000Z`,
      adapter
    });
  }

  expect(consolidationBatchCount).toBe(2);
});
