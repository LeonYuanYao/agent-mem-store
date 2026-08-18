import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  createAgentCandidate,
  listRecallEligibleMemoryIds
} from "../../../src/candidates/index.js";
import { captureEvent } from "../../../src/capture/index.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import {
  advanceCandidateReevaluationBackfill,
  enqueueCandidateAssessment,
  prepareNextCandidateEvaluation,
  runNextCandidateAssessment,
  type CandidateAssessmentAdapter
} from "../../../src/worker/governance.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a durable semantic-assessment operation feeds the deterministic Promotion Gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-semantic-worker-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const evidence = [
    {
      eventId: "msevent-semantic-a",
      projectId: "msproj_123e4567-e89b-42d3-a456-426614174001",
      sourceIdentity: "codex:semantic-session-0:msevent-semantic-a"
    },
    {
      eventId: "msevent-semantic-b",
      projectId: "msproj_123e4567-e89b-42d3-a456-426614174002",
      sourceIdentity: "codex:semantic-session-1:msevent-semantic-b"
    }
  ];
  for (const [index, item] of evidence.entries()) {
    const payload = {
      text: index === 0
        ? "Use pnpm for JavaScript repositories."
        : "Standardize JavaScript dependency workflows on pnpm."
    };
    await captureEvent({
      runtimeRoot,
      event: {
        schemaVersion: 1,
        eventId: item.eventId,
        deduplicationKey: `semantic:${item.eventId}`,
        agent: "codex",
        eventKind: "UserPromptSubmit",
        occurredAt: `2026-08-07T13:00:0${String(index)}.000Z`,
        projectId: item.projectId,
        sessionId: `semantic-session-${String(index)}`,
        payload
      }
    });
  }
  const created = await createAgentCandidate({
    runtimeRoot,
    scope: { kind: "global" },
    candidate: {
      statement: "Use pnpm for JavaScript repositories.",
      primaryCategory: "workflow_environment_toolchain",
      categoryTags: ["workflow_environment_toolchain"],
      applicabilitySummary: "JavaScript repositories",
      conditions: [],
      exclusions: [],
      preservedNegations: [],
      certainty: "asserted",
      importanceTags: []
    },
    evidence: evidence.map((item, index) => ({
      evidenceId: item.eventId,
      evidenceClass: "explicit_user_statement" as const,
      sourceIdentity: item.sourceIdentity,
      projectId: item.projectId,
      occurredAt: `2026-08-07T13:00:0${String(index)}.000Z`,
      integrity: "intact" as const,
      sourceTruncated: false,
      memoryEcho: false,
      evidenceContentIdentity: createHash("sha256")
        .update(JSON.stringify({
          text: index === 0
            ? "Use pnpm for JavaScript repositories."
            : "Standardize JavaScript dependency workflows on pnpm."
        }))
        .digest("hex")
    })),
    createdAt: "2026-08-07T13:00:03.000Z"
  });
  if (created.state !== "candidate") throw new Error("Expected Candidate creation.");

  await enqueueCandidateAssessment({
    runtimeRoot,
    candidateId: created.candidateId,
    createdAt: "2026-08-07T13:00:04.000Z"
  });
  const adapter: CandidateAssessmentAdapter = {
    assessCandidateSemantics(request) {
      return Promise.resolve({
        schemaVersion: 1,
        kind: "semantic_assessment",
        state: "supported",
        evidenceIds: request.evidence.map((item) => item.evidenceId)
      });
    }
  };
  await expect(runNextCandidateAssessment({
    runtimeRoot,
    vaultRoot,
    workerId: "semantic-worker",
    now: "2026-08-07T13:00:05.000Z",
    adapter
  })).resolves.toMatchObject({ state: "completed", evaluationState: "promoted" });
  await expect(listRecallEligibleMemoryIds(runtimeRoot)).resolves.toHaveLength(1);
});

test("a supported task-local instruction is rejected by the durability gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-task-local-assessment-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";
  const eventId = "msevent-task-local-probe";
  const payload = {
    prompt: "Run pwd once and reply exactly MEMSTORE_POST_TOOL_PROBE_OK."
  };
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId,
      deduplicationKey: "semantic:task-local-probe",
      agent: "codex",
      eventKind: "UserPromptSubmit",
      occurredAt: "2026-08-07T13:30:00.000Z",
      projectId,
      sessionId: "task-local-session",
      turnId: "task-local-turn",
      payload
    }
  });
  const created = await createAgentCandidate({
    runtimeRoot,
    scope: { kind: "project", projectId },
    candidate: {
      statement: "Run pwd once and reply exactly MEMSTORE_POST_TOOL_PROBE_OK.",
      primaryCategory: "workflow_environment_toolchain",
      categoryTags: ["workflow_environment_toolchain"],
      applicabilitySummary: "Current task only",
      conditions: [],
      exclusions: [],
      preservedNegations: [],
      certainty: "asserted",
      importanceTags: []
    },
    evidence: [{
      evidenceId: eventId,
      evidenceClass: "explicit_user_statement",
      sourceIdentity: "codex:task-local-session:task-local-turn",
      projectId,
      occurredAt: "2026-08-07T13:30:00.000Z",
      integrity: "intact",
      sourceTruncated: false,
      memoryEcho: false,
      evidenceContentIdentity: createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex")
    }],
    createdAt: "2026-08-07T13:30:01.000Z"
  });
  if (created.state !== "candidate") throw new Error("Expected Candidate creation.");

  await enqueueCandidateAssessment({
    runtimeRoot,
    candidateId: created.candidateId,
    createdAt: "2026-08-07T13:30:02.000Z"
  });
  await expect(runNextCandidateAssessment({
    runtimeRoot,
    vaultRoot,
    workerId: "task-local-semantic-worker",
    now: "2026-08-07T13:30:03.000Z",
    adapter: {
      assessCandidateSemantics: (request) => Promise.resolve({
        schemaVersion: 1,
        kind: "semantic_assessment",
        state: "supported",
        durabilityDisposition: "task_local",
        evidenceIds: request.evidence.map((item) => item.evidenceId)
      })
    }
  })).resolves.toMatchObject({ state: "completed", evaluationState: "rejected" });
  await expect(listRecallEligibleMemoryIds(runtimeRoot)).resolves.toEqual([]);
});

test("a generic intact PostToolUse result requires Luna support before promotion", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-generic-tool-evidence-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";
  const eventId = "msevent-generic-tool-result";
  const occurredAt = "2026-08-07T14:00:00.000Z";
  const payload = {
    tool_name: "mcp__repository__inspect",
    tool_input: { path: "package.json" },
    tool_response: { packageManager: "pnpm@10.0.0" }
  };
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId,
      deduplicationKey: "semantic:generic-tool-result",
      agent: "codex",
      eventKind: "PostToolUse",
      occurredAt,
      projectId,
      sessionId: "generic-tool-session",
      turnId: "generic-tool-turn",
      payload
    }
  });
  const created = await createAgentCandidate({
    runtimeRoot,
    scope: { kind: "project", projectId },
    candidate: {
      statement: "This repository uses pnpm 10.",
      primaryCategory: "workflow_environment_toolchain",
      categoryTags: ["workflow_environment_toolchain"],
      applicabilitySummary: "This repository",
      conditions: [],
      exclusions: [],
      preservedNegations: [],
      certainty: "asserted",
      importanceTags: []
    },
    evidence: [{
      evidenceId: eventId,
      evidenceClass: "command_outcome",
      sourceIdentity: "codex:generic-tool-session:generic-tool-turn",
      projectId,
      occurredAt,
      integrity: "intact",
      sourceTruncated: false,
      memoryEcho: false,
      evidenceContentIdentity: createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex")
    }],
    createdAt: "2026-08-07T14:00:01.000Z"
  });
  if (created.state !== "candidate") throw new Error("Expected Candidate creation.");

  await expect(prepareNextCandidateEvaluation({
    runtimeRoot,
    vaultRoot,
    now: "2026-08-07T14:00:02.000Z"
  })).resolves.toMatchObject({
    state: "assessment_queued",
    candidateId: created.candidateId
  });
  await expect(listRecallEligibleMemoryIds(runtimeRoot)).resolves.toEqual([]);

  await expect(runNextCandidateAssessment({
    runtimeRoot,
    vaultRoot,
    workerId: "generic-tool-semantic-worker",
    now: "2026-08-07T14:00:03.000Z",
    adapter: {
      assessCandidateSemantics: () => Promise.resolve({
        schemaVersion: 1,
        kind: "semantic_assessment",
        state: "supported",
        evidenceIds: [eventId]
      })
    }
  })).resolves.toMatchObject({ state: "completed", evaluationState: "promoted" });
  await expect(listRecallEligibleMemoryIds(runtimeRoot)).resolves.toHaveLength(1);
});

test("the generic-tool evidence migration reopens historical insufficient Candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-generic-tool-backfill-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";
  const eventId = "msevent-historical-generic-tool-result";
  const occurredAt = "2026-08-07T15:00:00.000Z";
  const payload = {
    tool_name: "mcp__repository__inspect",
    tool_response: { packageManager: "pnpm@10.0.0" }
  };
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId,
      deduplicationKey: "semantic:historical-generic-tool-result",
      agent: "codex",
      eventKind: "PostToolUse",
      occurredAt,
      projectId,
      sessionId: "historical-generic-tool-session",
      turnId: "historical-generic-tool-turn",
      payload
    }
  });
  const created = await createAgentCandidate({
    runtimeRoot,
    scope: { kind: "project", projectId },
    candidate: {
      statement: "This repository uses pnpm 10.",
      primaryCategory: "workflow_environment_toolchain",
      categoryTags: ["workflow_environment_toolchain"],
      applicabilitySummary: "This repository",
      conditions: [],
      exclusions: [],
      preservedNegations: [],
      certainty: "asserted",
      importanceTags: []
    },
    evidence: [{
      evidenceId: eventId,
      evidenceClass: "command_outcome",
      sourceIdentity: "codex:historical-generic-tool-session:historical-generic-tool-turn",
      projectId,
      occurredAt,
      integrity: "intact",
      sourceTruncated: false,
      memoryEcho: false,
      evidenceContentIdentity: createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex")
    }],
    createdAt: "2026-08-07T15:00:01.000Z"
  });
  if (created.state !== "candidate") throw new Error("Expected Candidate creation.");
  const database = await openRuntimeDatabase(runtimeRoot);
  database.prepare(
    "UPDATE memory_candidates SET successful_evaluation_at = ? WHERE candidate_id = ?"
  ).run("2026-08-07T15:00:02.000Z", created.candidateId);
  database.prepare(
    `INSERT INTO governance_decisions(
       decision_id, candidate_id, decision, reason, decided_at
     ) VALUES (?, ?, 'wait', 'insufficient_evidence', ?)`
  ).run(
    "msdecision-historical-generic-tool",
    created.candidateId,
    "2026-08-07T15:00:02.000Z"
  );
  database.exec("DROP TABLE candidate_reevaluation_backfill");
  database.prepare("DELETE FROM schema_migrations WHERE version = 27").run();
  database.close();

  const migrated = await openRuntimeDatabase(runtimeRoot);
  migrated.close();
  await expect(advanceCandidateReevaluationBackfill({
    runtimeRoot,
    now: "2026-08-07T15:00:03.000Z"
  })).resolves.toMatchObject({
    state: "completed",
    reopenedCandidateCount: 1
  });
  const inspected = await openRuntimeDatabase(runtimeRoot);
  const row = inspected.prepare(
    "SELECT successful_evaluation_at FROM memory_candidates WHERE candidate_id = ?"
  ).get(created.candidateId);
  inspected.close();
  expect(row?.successful_evaluation_at).toBeNull();
});
