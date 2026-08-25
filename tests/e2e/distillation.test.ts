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
  recoverNextBlockedLifecycleOnlyBatch,
  runNextLunaWork,
  type LunaWorkerAdapter
} from "../../src/worker/distillation.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";
import { inspectAdmissionAudit } from "../../src/admission/audit.js";
import type { DistillationOutput } from "../../src/luna/index.js";
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

  for (let index = 0; index < 2; index += 1) {
    await expect(
      prepareNextDistillationBatch({
        runtimeRoot,
        maximumEvents: 2,
        preparedAt: `2026-08-07T07:01:0${String(index)}.000Z`
      })
    ).resolves.toMatchObject({ state: "queued", sessionId: "long-session" });
  }
  await expect(prepareNextDistillationBatch({
    runtimeRoot,
    maximumEvents: 2,
    preparedAt: "2026-08-07T07:01:02.000Z"
  })).resolves.toMatchObject({ state: "completed_without_model", sessionId: "long-session" });
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
      const substantiveBatches = request.batchResults.filter((batch) => batch.candidates.length > 0);
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
              substantiveBatches.flatMap((batch) => batch.evidenceIds)
            )],
            durability: makeLongTermCandidateDurability(),
            importanceTags: ["constraint"],
            importanceReasons: [{
              tag: "constraint",
              reason: "Preserve the final supporting evidence.",
              evidenceIds: [substantiveBatches.at(-1)?.evidenceIds.at(-1) ?? "missing-evidence"]
            }]
          }
        ]
      });
    }
  };

  for (let index = 0; index < 3; index += 1) {
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
  expect(distillationEvidenceCounts).toEqual([2, 2]);
  expect(session).toMatchObject({
    sessionId: "long-session",
    batchCount: 3,
    completedBatchCount: 3,
    consolidationState: "completed"
  });
  expect(consolidationInput).not.toContain("RAW-EVIDENCE");
  expect(consolidationInput).toContain("Batch statement");
  for (const eventId of eventIds.slice(0, -1)) expect(consolidationInput).toContain(eventId);
  expect(consolidationInput).not.toContain(eventIds.at(-1));
  const auditDatabase = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(auditDatabase.prepare(
      `SELECT source_kind, prompt_version
       FROM admission_audit
       ORDER BY created_at, source_kind`
    ).all()).toEqual([
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

test("Batch distillation cannot complete without a Candidate or considered disposition", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-empty-distillation-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent_empty_distillation_tool",
      deduplicationKey: "codex:empty-distillation:tool",
      agent: "codex",
      eventKind: "PostToolUse",
      occurredAt: "2026-08-25T07:00:00.000Z",
      projectId: "msproj_empty_distillation",
      sessionId: "empty-distillation-session",
      turnId: "empty-distillation-turn",
      payload: { output: "A reusable non-obvious schema limitation was verified." }
    }
  });
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent_empty_distillation_end",
      deduplicationKey: "codex:empty-distillation:end",
      agent: "codex",
      eventKind: "SessionEnd",
      occurredAt: "2026-08-25T07:00:01.000Z",
      projectId: "msproj_empty_distillation",
      sessionId: "empty-distillation-session",
      payload: { reason: "closed" }
    }
  });
  await expect(prepareNextDistillationBatch({
    runtimeRoot,
    maximumEvents: 64,
    preparedAt: "2026-08-25T07:01:00.000Z"
  })).resolves.toMatchObject({ state: "queued" });

  const adapter: LunaWorkerAdapter = {
    distillBatch() {
      return Promise.resolve({
        schemaVersion: 1,
        kind: "distillation",
        candidates: []
      });
    },
    consolidateSession() {
      throw new Error("An empty Batch must not advance to consolidation.");
    }
  };
  await expect(runNextLunaWork({
    runtimeRoot,
    workerId: "worker-empty-distillation",
    now: "2026-08-25T07:02:00.000Z",
    adapter
  })).resolves.toMatchObject({
    state: "retrying",
    operationKind: "distill_batch"
  });
});

test("lifecycle-only batches complete deterministically without spending Luna retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-lifecycle-only-distillation-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  for (const [eventId, eventKind, occurredAt] of [
    ["msevent_lifecycle_start", "SessionStart", "2026-08-25T08:00:00.000Z"],
    ["msevent_lifecycle_end", "SessionEnd", "2026-08-25T08:00:01.000Z"]
  ] as const) {
    await captureEvent({
      runtimeRoot,
      event: {
        schemaVersion: 1,
        eventId,
        deduplicationKey: `codex:lifecycle-only:${eventKind}`,
        agent: "codex",
        eventKind,
        occurredAt,
        projectId: "msproj_lifecycle_only",
        sessionId: "lifecycle-only-session",
        payload: eventKind === "SessionStart" ? { source: "startup" } : { reason: "other" }
      }
    });
  }
  const prepared = await prepareNextDistillationBatch({
    runtimeRoot,
    maximumEvents: 64,
    preparedAt: "2026-08-25T08:01:00.000Z"
  });
  expect(prepared).toMatchObject({
    state: "completed_without_model",
    eventCount: 2
  });
  if (prepared.state !== "completed_without_model") {
    throw new Error("Expected lifecycle-only deterministic completion.");
  }
  await expect(inspectCaptureEventState(runtimeRoot, "msevent_lifecycle_start"))
    .resolves.toMatchObject({ state: "completed" });
  await expect(inspectCaptureEventState(runtimeRoot, "msevent_lifecycle_end"))
    .resolves.toMatchObject({ state: "completed" });

  const legacy = await openRuntimeDatabase(runtimeRoot);
  try {
    legacy.prepare(
      `UPDATE luna_operations
       SET state = 'blocked', completed_at = NULL, last_error_category = 'schema_invalid'
       WHERE operation_id = ?`
    ).run(prepared.operationId);
    legacy.prepare(
      "UPDATE distillation_batches SET state = 'processing', completed_at = NULL WHERE batch_id = ?"
    ).run(prepared.batchId);
    legacy.prepare(
      `UPDATE capture_events SET state = 'pending'
       WHERE event_id IN ('msevent_lifecycle_start', 'msevent_lifecycle_end')`
    ).run();
  } finally {
    legacy.close();
  }
  await expect(recoverNextBlockedLifecycleOnlyBatch({
    runtimeRoot,
    recoveredAt: "2026-08-25T08:01:30.000Z"
  })).resolves.toEqual({ state: "completed", operationId: prepared.operationId });

  const adapter: LunaWorkerAdapter = {
    distillBatch: vi.fn(() => { throw new Error("Lifecycle-only events must not invoke Luna."); }),
    consolidateSession: vi.fn(() => { throw new Error("No consolidation operation is queued yet."); })
  };
  await expect(runNextLunaWork({
    runtimeRoot,
    workerId: "worker-lifecycle-only",
    now: "2026-08-25T08:02:00.000Z",
    adapter
  })).resolves.toEqual({ state: "empty" });
});

test("Session consolidation cannot silently discard priority durable Candidates", async () => {
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
  await expect(prepareNextDistillationBatch({
    runtimeRoot,
    maximumEvents: 2,
    preparedAt: "2026-08-25T08:01:00.000Z"
  })).resolves.toMatchObject({ state: "queued", sessionId });
  await expect(prepareNextDistillationBatch({
    runtimeRoot,
    maximumEvents: 2,
    preparedAt: "2026-08-25T08:01:01.000Z"
  })).resolves.toMatchObject({ state: "completed_without_model", sessionId });

  const durableStatement = "MemStore uses main as its ongoing maintenance branch.";
  const adapter: LunaWorkerAdapter = {
    distillBatch(request) {
      const candidates: DistillationOutput["candidates"][number][] = [];
      for (const evidence of request.evidence) {
        if (evidence.evidenceClass === "explicit_user_statement") {
          candidates.push({
            statement: durableStatement,
            primaryCategory: "preference_constraint" as const,
            categoryTags: ["preference_constraint" as const],
            applicabilitySummary: "MemStore maintenance",
            conditions: [],
            exclusions: [],
            preservedNegations: [],
            certainty: "asserted" as const,
            sensitivity: "normal" as const,
            evidenceIds: [evidence.evidenceId],
            durability: makeLongTermCandidateDurability(),
            importanceTags: [],
            importanceReasons: []
          });
          continue;
        }
        if (evidence.evidenceClass !== "command_outcome") continue;
        candidates.push({
          statement: "Idle Worker queues use a read-only preflight before requesting a write lock.",
          primaryCategory: "architecture_contract" as const,
          categoryTags: ["architecture_contract" as const],
          applicabilitySummary: "MemStore Worker queues",
          conditions: [],
          exclusions: [],
          preservedNegations: [],
          certainty: "asserted" as const,
          sensitivity: "normal" as const,
          evidenceIds: [evidence.evidenceId],
          durability: makeLongTermCandidateDurability(),
          importanceTags: ["architecture_invariant" as const, "recurrence_hazard" as const],
          importanceReasons: [
            {
              tag: "architecture_invariant" as const,
              reason: "Empty queues must remain read-only.",
              evidenceIds: [evidence.evidenceId]
            },
            {
              tag: "recurrence_hazard" as const,
              reason: "Idle lock contention can recur across Worker lanes.",
              evidenceIds: [evidence.evidenceId]
            }
          ]
        });
      }
      return Promise.resolve({
        schemaVersion: 1,
        kind: "distillation",
        candidates,
        ...(candidates.length > 0 ? {} : {
          rejectionSummary: {
            schemaVersion: 1 as const,
            coverage: "considered_memory_shaped_rejections_only" as const,
            counts: { no_memory: 0, session_only: 1, uncertain: 0, source_echo: 0 },
            samples: []
          }
        })
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

  for (let index = 0; index < 2; index += 1) {
    await expect(runNextLunaWork({
      runtimeRoot,
      workerId: "worker-consolidation-authority",
      now: `2026-08-25T08:02:0${String(index)}.000Z`,
      adapter
    })).resolves.toMatchObject({ state: "completed" });
  }

  await expect(listSessionCandidates(runtimeRoot, sessionId)).resolves.toHaveLength(2);
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(database.prepare(
      "SELECT statement FROM memory_candidates WHERE source_session_id = ? ORDER BY statement"
    ).all(sessionId)).toEqual([
      { statement: "Idle Worker queues use a read-only preflight before requesting a write lock." },
      { statement: durableStatement }
    ]);
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
      eventKind: "UserPromptSubmit",
      occurredAt: "2026-08-23T10:00:00.000Z",
      projectId,
      sessionId: "admission-audit-session",
      turnId: "admission-audit-turn",
      payload: { prompt: "Mixed durable and transient evidence." }
    }
  });
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent_admission_audit_stop",
      deduplicationKey: "codex:admission-audit:stop",
      agent: "codex",
      eventKind: "Stop",
      occurredAt: "2026-08-23T10:00:00.500Z",
      projectId,
      sessionId: "admission-audit-session",
      turnId: "admission-audit-turn",
      payload: { assistantMessage: "Transient response." }
    }
  });
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent_admission_audit_end",
      deduplicationKey: "codex:admission-audit:end",
      agent: "codex",
      eventKind: "SessionEnd",
      occurredAt: "2026-08-23T10:00:00.750Z",
      projectId,
      sessionId: "admission-audit-session",
      payload: { reason: "other" }
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
    await expect(prepareNextDistillationBatch({
      runtimeRoot,
      maximumEvents: 2,
      preparedAt: `2026-08-07T1${String(episode)}:01:00.000Z`
    })).resolves.toMatchObject({ state: "queued", sessionId: "resumed-session" });
    await expect(prepareNextDistillationBatch({
      runtimeRoot,
      maximumEvents: 2,
      preparedAt: `2026-08-07T1${String(episode)}:01:01.000Z`
    })).resolves.toMatchObject({ state: "completed_without_model", sessionId: "resumed-session" });
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
  for (let index = 0; index < 2; index += 1) {
    await runNextLunaWork({
      runtimeRoot,
      workerId: "worker-resumed",
      now: `2026-08-07T12:02:0${String(index)}.000Z`,
      adapter
    });
  }

  await captureEpisode(3);
  for (let index = 0; index < 2; index += 1) {
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
      eventKind: "Stop",
      occurredAt: "2026-08-07T15:00:00.000Z",
      projectId,
      sessionId: "direct-episode-session",
      turnId: "direct-episode-turn-1",
      payload: { episode: 1 }
    }
  });
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent_direct_episode_1_end",
      deduplicationKey: "codex:direct-episode:1:end",
      agent: "codex",
      eventKind: "SessionEnd",
      occurredAt: "2026-08-07T15:00:00.500Z",
      projectId,
      sessionId: "direct-episode-session",
      payload: { reason: "other" }
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
