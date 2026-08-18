import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  createAgentCandidate,
  evaluateCandidate,
  expireDueCandidates,
  inspectCandidate,
  inspectVerificationRequest,
  listRecallEligibleMemoryIds,
  purgeDueCandidateTombstones,
  scheduleDueCandidateExpirations,
  type CandidateEvidence,
  type CreateCandidateResult
} from "../../../src/candidates/index.js";
import {
  assertHumanKnowledge,
  recordHumanGlobalAuthorization
} from "../../../src/candidates/human.js";
import { captureEvent } from "../../../src/capture/index.js";
import { readCanonicalMemory } from "../../../src/vault/index.js";
import { resolveProject } from "../../../src/projects/index.js";
import {
  enqueueCandidateAssessment,
  runNextCandidateAssessment
} from "../../../src/worker/governance.js";

const roots: string[] = [];

function requireCandidate(
  result: CreateCandidateResult
): Extract<CreateCandidateResult, { readonly state: "candidate" | "merged" }> {
  if (result.state !== "candidate" && result.state !== "merged") {
    throw new Error(`Expected Candidate creation, received ${result.state}.`);
  }
  return result;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<{ runtimeRoot: string; vaultRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "memstore-candidate-"));
  roots.push(root);
  return { runtimeRoot: join(root, "runtime"), vaultRoot: join(root, "vault") };
}

const candidate = {
  statement: "Run the repository typecheck before claiming completion.",
  primaryCategory: "workflow_environment_toolchain" as const,
  categoryTags: ["workflow_environment_toolchain" as const],
  applicabilitySummary: "This repository",
  conditions: [],
  exclusions: [],
  preservedNegations: [],
  certainty: "asserted" as const,
  importanceTags: ["constraint" as const]
};

async function captureUserEvidence(request: {
  readonly runtimeRoot: string;
  readonly evidenceId: string;
  readonly projectId: string;
  readonly occurredAt: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly prompt?: string;
  readonly memoryEcho?: boolean;
}): Promise<CandidateEvidence> {
  const sessionId = request.sessionId ?? `session-${request.evidenceId}`;
  const turnId = request.turnId ?? `turn-${request.evidenceId}`;
  const payload = { prompt: request.prompt ?? "A stable user-authored rule." };
  await captureEvent({
    runtimeRoot: request.runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: request.evidenceId,
      deduplicationKey: `candidate-test:${request.evidenceId}`,
      agent: "codex",
      eventKind: "UserPromptSubmit",
      occurredAt: request.occurredAt,
      projectId: request.projectId,
      sessionId,
      turnId,
      payload
    }
  });
  return {
    evidenceId: request.evidenceId,
    evidenceClass: "explicit_user_statement",
    sourceIdentity: `codex:${sessionId}:${turnId}`,
    projectId: request.projectId,
    occurredAt: request.occurredAt,
    integrity: "intact",
    sourceTruncated: false,
    memoryEcho: request.memoryEcho ?? false,
    evidenceContentIdentity: createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex")
  };
}

async function runDurableAssessment(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly candidateId: string;
  readonly state: "supported" | "partially_supported" | "contradicted" | "insufficient_evidence";
  readonly evidenceIds: readonly string[];
  readonly now: string;
}): Promise<string> {
  const operation = await enqueueCandidateAssessment({
    runtimeRoot: request.runtimeRoot,
    candidateId: request.candidateId,
    createdAt: request.now
  });
  const result = await runNextCandidateAssessment({
    runtimeRoot: request.runtimeRoot,
    vaultRoot: request.vaultRoot,
    workerId: "candidate-lifecycle-test-worker",
    now: request.now,
    adapter: {
      assessCandidateSemantics: () => Promise.resolve({
        schemaVersion: 1,
        kind: "semantic_assessment",
        state: request.state,
        evidenceIds: [...request.evidenceIds]
      })
    }
  });
  if (result.state !== "completed") {
    throw new Error(`Expected durable assessment, received ${result.state}.`);
  }
  return operation.operationId;
}

test("a Candidate stays outside recall until the deterministic Promotion Gate commits it", async () => {
  const roots = await createRoot();
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";
  const evidence = await captureUserEvidence({
    runtimeRoot: roots.runtimeRoot,
    evidenceId: "evidence-user-1",
    projectId,
    occurredAt: "2026-08-07T08:00:00.000Z",
    sessionId: "session-1",
    turnId: "turn-1"
  });
  const created = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "project", projectId },
    candidate,
    evidence: [evidence],
    sourceSessionId: "session-1",
    createdAt: "2026-08-07T08:00:01.000Z"
  }));

  expect(created.state).toBe("candidate");
  await expect(listRecallEligibleMemoryIds(roots.runtimeRoot)).resolves.toEqual([]);

  const concurrentEvidence = await captureUserEvidence({
    runtimeRoot: roots.runtimeRoot,
    evidenceId: "evidence-user-concurrent",
    projectId,
    occurredAt: "2026-08-07T08:00:01.500Z",
    prompt: "This is independent supporting wording."
  });
  let concurrentMergeBlocked = false;
  let concurrentStateChangeBlocked = false;
  const evaluated = await evaluateCandidate({
    ...roots,
    candidateId: created.candidateId,
    evaluatedAt: "2026-08-07T08:00:02.000Z",
    onPromotionReserved: async () => {
      try {
        await createAgentCandidate({
          ...roots,
          scope: { kind: "project", projectId },
          candidate,
          evidence: [concurrentEvidence],
          createdAt: "2026-08-07T08:00:01.500Z"
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("promotion is in progress");
        concurrentMergeBlocked = true;
      }
      try {
        await evaluateCandidate({
          ...roots,
          candidateId: created.candidateId,
          evaluatedAt: "2026-08-07T08:00:01.750Z",
          materialConflict: true
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("promotion is in progress");
        concurrentStateChangeBlocked = true;
      }
    }
  });
  expect(concurrentMergeBlocked).toBe(true);
  expect(concurrentStateChangeBlocked).toBe(true);
  expect(evaluated).toMatchObject({ state: "promoted" });
  if (evaluated.state !== "promoted") throw new Error("Expected promotion.");
  await expect(listRecallEligibleMemoryIds(roots.runtimeRoot)).resolves.toEqual([
    evaluated.memoryId
  ]);
});

test("a task-local explicit-user instruction cannot use lightweight promotion", async () => {
  const roots = await createRoot();
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";
  const evidence = await captureUserEvidence({
    runtimeRoot: roots.runtimeRoot,
    evidenceId: "evidence-exact-response-probe",
    projectId,
    occurredAt: "2026-08-07T08:05:00.000Z",
    prompt: "Run pwd once and reply with exactly MEMSTORE_POST_TOOL_PROBE_OK."
  });
  const created = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "project", projectId },
    candidate: {
      ...candidate,
      statement: "For this operation, run pwd and reply with MEMSTORE_POST_TOOL_PROBE_OK.",
      importanceTags: []
    },
    evidence: [evidence],
    sourceSessionId: "probe-session",
    createdAt: "2026-08-07T08:05:01.000Z"
  }));

  await expect(evaluateCandidate({
    ...roots,
    candidateId: created.candidateId,
    evaluatedAt: "2026-08-07T08:05:02.000Z"
  })).resolves.toMatchObject({
    state: "wait",
    reason: "semantic_assessment_required"
  });
  await expect(listRecallEligibleMemoryIds(roots.runtimeRoot)).resolves.toEqual([]);
});

test("retention cannot expire a Candidate while its promotion is reserved", async () => {
  const roots = await createRoot();
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";
  const evidence = await captureUserEvidence({
    runtimeRoot: roots.runtimeRoot,
    evidenceId: "evidence-retention-race",
    projectId,
    occurredAt: "2026-01-01T00:00:00.000Z"
  });
  const created = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "project", projectId },
    candidate,
    evidence: [evidence],
    createdAt: "2026-01-01T00:00:00.000Z"
  }));
  await expect(evaluateCandidate({
    ...roots,
    candidateId: created.candidateId,
    evaluatedAt: "2026-01-01T00:00:01.000Z",
    verificationNeed: {
      description: "Verify this rule before retention.",
      proposedAction: "Review the source statement."
    }
  })).resolves.toMatchObject({ state: "wait", reason: "verification_required" });
  await expect(scheduleDueCandidateExpirations({
    runtimeRoot: roots.runtimeRoot,
    evaluatedAt: "2026-01-03T00:00:00.000Z",
    ordinaryDays: 1,
    protectedDays: 1
  })).resolves.toEqual({ scheduledCandidateIds: [created.candidateId] });

  let concurrentExpirationSkipped = false;
  const promoted = await evaluateCandidate({
    ...roots,
    candidateId: created.candidateId,
    evaluatedAt: "2026-01-03T00:00:01.000Z",
    onPromotionReserved: async () => {
      const result = await expireDueCandidates({
        runtimeRoot: roots.runtimeRoot,
        evaluatedAt: "2026-01-03T00:00:01.500Z",
        ordinaryDays: 1,
        protectedDays: 1
      });
      concurrentExpirationSkipped = result.expiredCandidateIds.length === 0;
    }
  });

  expect(concurrentExpirationSkipped).toBe(true);
  expect(promoted).toMatchObject({ state: "promoted" });
  await expect(inspectCandidate(roots.runtimeRoot, created.candidateId)).resolves.toMatchObject({
    state: "promoted",
    bodyPresent: true
  });
});

test("Global promotion requires supported semantics and two independent non-Echo Projects", async () => {
  const roots = await createRoot();
  const projectA = "msproj_123e4567-e89b-42d3-a456-426614174001";
  const projectB = "msproj_123e4567-e89b-42d3-a456-426614174002";
  const initialEvidence = await Promise.all([
    captureUserEvidence({
      runtimeRoot: roots.runtimeRoot,
      evidenceId: "project-a",
      projectId: projectA,
      occurredAt: "2026-08-07T08:10:00.000Z",
      prompt: "Use pnpm for JavaScript repositories."
    }),
    captureUserEvidence({
      runtimeRoot: roots.runtimeRoot,
      evidenceId: "project-b-echo",
      projectId: projectB,
      occurredAt: "2026-08-07T08:10:01.000Z",
      prompt: "Use pnpm for JavaScript repositories.",
      memoryEcho: false
    })
  ]);
  const created = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "global" },
    candidate,
    evidence: initialEvidence,
    sourceSessionId: "session-global",
    createdAt: "2026-08-07T08:10:02.000Z"
  }));

  await expect(evaluateCandidate({
    ...roots,
    candidateId: created.candidateId,
    evaluatedAt: "2026-08-07T08:10:02.500Z",
    semanticAssessmentOperationId: "forged-luna-operation"
  })).rejects.toThrow("not a durable Luna result");
  const firstAssessmentOperationId = await runDurableAssessment({
    ...roots,
    candidateId: created.candidateId,
    state: "supported",
    evidenceIds: ["project-a", "project-b-echo"],
    now: "2026-08-07T08:10:03.000Z"
  });

  const independentEvidence = await captureUserEvidence({
    runtimeRoot: roots.runtimeRoot,
    evidenceId: "project-b-independent",
    projectId: projectB,
    occurredAt: "2026-08-07T08:10:04.000Z",
    prompt: "Standardize JavaScript package workflows on pnpm."
  });
  const merged = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "global" },
    candidate,
    evidence: [independentEvidence],
    sourceSessionId: "session-global-2",
    createdAt: "2026-08-07T08:10:04.000Z"
  }));
  expect(merged.state).toBe("merged");
  await expect(evaluateCandidate({
    ...roots,
    candidateId: created.candidateId,
    evaluatedAt: "2026-08-07T08:10:04.500Z",
    semanticAssessmentOperationId: firstAssessmentOperationId
  })).rejects.toThrow("stale");

  await runDurableAssessment({
    ...roots,
    candidateId: created.candidateId,
    state: "supported",
    evidenceIds: ["project-a", "project-b-independent"],
    now: "2026-08-07T08:10:05.000Z"
  });
  await expect(listRecallEligibleMemoryIds(roots.runtimeRoot)).resolves.toHaveLength(1);
});

test("uncertain claims wait with an explicit Verification Request and expire body-free", async () => {
  const roots = await createRoot();
  const created = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "project", projectId: "msproj_123e4567-e89b-42d3-a456-426614174001" },
    candidate: { ...candidate, certainty: "speculative", importanceTags: [] },
    evidence: [{
      evidenceId: "summary-only",
      evidenceClass: "agent_summary",
      sourceIdentity: "codex:summary",
      projectId: "msproj_123e4567-e89b-42d3-a456-426614174001",
      occurredAt: "2026-01-01T00:00:00.000Z",
      integrity: "intact",
      sourceTruncated: false,
      memoryEcho: false
    }],
    sourceSessionId: "session-old",
    createdAt: "2026-01-01T00:00:01.000Z"
  }));

  const waiting = await evaluateCandidate({
    ...roots,
    candidateId: created.candidateId,
    evaluatedAt: "2026-01-01T00:00:02.000Z",
    verificationNeed: {
      description: "Run the repository typecheck to verify the claim.",
      proposedAction: "pnpm typecheck"
    }
  });
  expect(waiting).toMatchObject({ state: "wait", reason: "verification_required" });
  expect("verificationRequestId" in waiting).toBe(true);
  if (!("verificationRequestId" in waiting)) {
    throw new Error("Expected Verification Request identity.");
  }
  await expect(
    inspectVerificationRequest(roots.runtimeRoot, waiting.verificationRequestId)
  ).resolves.toMatchObject({
    state: "open",
    proposedAction: "pnpm typecheck"
  });

  await scheduleDueCandidateExpirations({
    runtimeRoot: roots.runtimeRoot,
    evaluatedAt: "2026-07-02T00:00:00.000Z",
    ordinaryDays: 90,
    protectedDays: 180
  });
  const expired = await expireDueCandidates({
    runtimeRoot: roots.runtimeRoot,
    evaluatedAt: "2026-07-02T00:00:00.000Z",
    ordinaryDays: 90,
    protectedDays: 180
  });
  expect(expired.expiredCandidateIds).toContain(created.candidateId);
  await expect(inspectCandidate(roots.runtimeRoot, created.candidateId)).resolves.toMatchObject({
    state: "expired",
    bodyPresent: false,
    tombstone: { bodyPresent: false }
  });

  const repeated = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "project", projectId: "msproj_123e4567-e89b-42d3-a456-426614174001" },
    candidate: { ...candidate, certainty: "speculative", importanceTags: [] },
    evidence: [{
      evidenceId: "summary-repeat",
      evidenceClass: "agent_summary",
      sourceIdentity: "codex:summary",
      projectId: "msproj_123e4567-e89b-42d3-a456-426614174001",
      occurredAt: "2026-07-03T00:00:00.000Z",
      integrity: "intact",
      sourceTruncated: false,
      memoryEcho: true
    }],
    createdAt: "2026-07-03T00:00:00.000Z"
  }));
  expect(repeated).toEqual({ state: "merged", candidateId: created.candidateId });

  const renewedEvidence = await captureUserEvidence({
    runtimeRoot: roots.runtimeRoot,
    evidenceId: "new-independent-source",
    projectId: "msproj_123e4567-e89b-42d3-a456-426614174001",
    occurredAt: "2026-07-04T00:00:00.000Z"
  });
  const renewed = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "project", projectId: "msproj_123e4567-e89b-42d3-a456-426614174001" },
    candidate: { ...candidate, certainty: "speculative", importanceTags: [] },
    evidence: [renewedEvidence],
    createdAt: "2026-07-04T00:00:00.000Z"
  }));
  expect(renewed.state).toBe("candidate");
  expect(renewed.candidateId).not.toBe(created.candidateId);
});

test("Tombstones are deleted after their retention only when no active governance object refers to them", async () => {
  const roots = await createRoot();
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";
  await captureEvent({
    runtimeRoot: roots.runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "old-summary",
      deduplicationKey: "candidate-test:old-summary",
      agent: "codex",
      eventKind: "Stop",
      occurredAt: "2025-01-01T00:00:00.000Z",
      projectId,
      sessionId: "old-summary-session",
      payload: { assistantMessage: "An old unsupported observation." }
    }
  });
  const created = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "project", projectId },
    candidate: {
      ...candidate,
      statement: "An old unsupported observation.",
      certainty: "speculative",
      importanceTags: []
    },
    evidence: [{
      evidenceId: "old-summary",
      evidenceClass: "agent_summary",
      sourceIdentity: "old-summary-source",
      projectId,
      occurredAt: "2025-01-01T00:00:00.000Z",
      integrity: "intact",
      sourceTruncated: false,
      memoryEcho: false
    }],
    createdAt: "2025-01-01T00:00:00.000Z"
  }));
  await runDurableAssessment({
    ...roots,
    candidateId: created.candidateId,
    state: "insufficient_evidence",
    evidenceIds: ["old-summary"],
    now: "2025-01-01T00:00:01.000Z"
  });
  await scheduleDueCandidateExpirations({
    runtimeRoot: roots.runtimeRoot,
    evaluatedAt: "2025-04-02T00:00:00.000Z",
    ordinaryDays: 90,
    protectedDays: 180
  });
  await expireDueCandidates({
    runtimeRoot: roots.runtimeRoot,
    evaluatedAt: "2025-04-02T00:00:00.000Z",
    ordinaryDays: 90,
    protectedDays: 180,
    tombstoneDays: 7
  });

  await expect(purgeDueCandidateTombstones({
    runtimeRoot: roots.runtimeRoot,
    evaluatedAt: "2025-04-09T00:00:01.000Z"
  })).resolves.toEqual({ purgedCandidateIds: [created.candidateId] });
  await expect(inspectCandidate(roots.runtimeRoot, created.candidateId)).rejects.toThrow(
    "Candidate does not exist"
  );
});

test("strict evidence metadata and materially-new support control promotion and retention", async () => {
  const roots = await createRoot();
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";
  const forgedUserCandidate = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "project", projectId },
    candidate: { ...candidate, statement: "A forged user statement.", importanceTags: [] },
    evidence: [{
      evidenceId: "missing-user-event",
      evidenceClass: "explicit_user_statement",
      sourceIdentity: "codex:missing-session:missing-turn",
      projectId,
      occurredAt: "2026-08-07T14:59:00.000Z",
      integrity: "intact",
      sourceTruncated: false,
      memoryEcho: false,
      evidenceContentIdentity: "a".repeat(64)
    }],
    createdAt: "2026-08-07T14:59:00.000Z"
  }));
  await expect(evaluateCandidate({
    ...roots,
    candidateId: forgedUserCandidate.candidateId,
    evaluatedAt: "2026-08-07T14:59:01.000Z"
  })).resolves.toMatchObject({ state: "wait", reason: "insufficient_evidence" });

  const wrongProjectEvidence = await captureUserEvidence({
    runtimeRoot: roots.runtimeRoot,
    evidenceId: "wrong-project-user-event",
    projectId: "msproj_123e4567-e89b-42d3-a456-426614174099",
    occurredAt: "2026-08-07T14:59:02.000Z"
  });
  const wrongProjectCandidate = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "project", projectId },
    candidate: { ...candidate, statement: "A cross-project source leak.", importanceTags: [] },
    evidence: [wrongProjectEvidence],
    createdAt: "2026-08-07T14:59:02.000Z"
  }));
  await expect(evaluateCandidate({
    ...roots,
    candidateId: wrongProjectCandidate.candidateId,
    evaluatedAt: "2026-08-07T14:59:03.000Z"
  })).resolves.toMatchObject({ state: "wait", reason: "insufficient_evidence" });

  const mismatchedContentEvidence = await captureUserEvidence({
    runtimeRoot: roots.runtimeRoot,
    evidenceId: "mismatched-content-user-event",
    projectId,
    occurredAt: "2026-08-07T14:59:04.000Z"
  });
  const mismatchedContentCandidate = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "project", projectId },
    candidate: { ...candidate, statement: "A content-mismatched source.", importanceTags: [] },
    evidence: [{ ...mismatchedContentEvidence, evidenceContentIdentity: "b".repeat(64) }],
    createdAt: "2026-08-07T14:59:04.000Z"
  }));
  await expect(evaluateCandidate({
    ...roots,
    candidateId: mismatchedContentCandidate.candidateId,
    evaluatedAt: "2026-08-07T14:59:05.000Z"
  })).resolves.toMatchObject({ state: "wait", reason: "insufficient_evidence" });

  const commandCandidate = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "project", projectId },
    candidate: { ...candidate, statement: "The build passes on this checkout." },
    evidence: [{
      evidenceId: "incomplete-command",
      evidenceClass: "command_outcome",
      sourceIdentity: "command:build",
      projectId,
      occurredAt: "2026-08-07T15:00:00.000Z",
      integrity: "intact",
      sourceTruncated: false,
      memoryEcho: false,
      commandExitCode: 0
    }],
    createdAt: "2026-08-07T15:00:00.000Z"
  }));
  await expect(evaluateCandidate({
    ...roots,
    candidateId: commandCandidate.candidateId,
    evaluatedAt: "2026-08-07T15:00:01.000Z"
  })).resolves.toMatchObject({ state: "wait", reason: "insufficient_evidence" });

  const oldEvidence = await captureUserEvidence({
    runtimeRoot: roots.runtimeRoot,
    evidenceId: "old-source-first-extraction",
    projectId,
    occurredAt: "2025-01-01T00:00:00.000Z",
    sessionId: "same-source-session",
    turnId: "same-source-turn",
    prompt: "A tentative old preference."
  });
  const old = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "project", projectId },
    candidate: {
      ...candidate,
      statement: "A tentative old preference.",
      certainty: "speculative",
      importanceTags: []
    },
    evidence: [oldEvidence],
    createdAt: "2025-01-01T00:00:00.000Z"
  }));
  await expect(evaluateCandidate({
    ...roots,
    candidateId: old.candidateId,
    evaluatedAt: "2025-01-01T00:00:01.000Z"
  })).resolves.toMatchObject({ state: "wait", reason: "semantic_assessment_required" });
  const repeatedEvidence = await captureUserEvidence({
    runtimeRoot: roots.runtimeRoot,
    evidenceId: "same-source-reextracted",
    projectId,
    occurredAt: "2025-04-01T00:00:00.000Z",
    sessionId: "same-source-session",
    turnId: "same-source-turn",
    prompt: "A tentative old preference."
  });
  await createAgentCandidate({
    ...roots,
    scope: { kind: "project", projectId },
    candidate: {
      ...candidate,
      statement: "A tentative old preference.",
      certainty: "speculative",
      importanceTags: []
    },
    evidence: [repeatedEvidence],
    createdAt: "2025-04-01T00:00:00.000Z"
  });
  await expect(scheduleDueCandidateExpirations({
    runtimeRoot: roots.runtimeRoot,
    evaluatedAt: "2025-04-02T00:00:00.000Z",
    ordinaryDays: 90,
    protectedDays: 180
  })).resolves.toEqual({ scheduledCandidateIds: [old.candidateId] });
  await expect(expireDueCandidates({
    runtimeRoot: roots.runtimeRoot,
    evaluatedAt: "2025-04-02T00:00:00.000Z",
    ordinaryDays: 90,
    protectedDays: 180
  })).resolves.toEqual({ expiredCandidateIds: [] });
  await runDurableAssessment({
    ...roots,
    candidateId: old.candidateId,
    state: "insufficient_evidence",
    evidenceIds: ["old-source-first-extraction"],
    now: "2025-04-02T00:00:01.000Z"
  });
  await expect(scheduleDueCandidateExpirations({
    runtimeRoot: roots.runtimeRoot,
    evaluatedAt: "2025-04-02T00:00:02.000Z",
    ordinaryDays: 90,
    protectedDays: 180
  })).resolves.toEqual({ scheduledCandidateIds: [] });
  await expect(expireDueCandidates({
    runtimeRoot: roots.runtimeRoot,
    evaluatedAt: "2025-04-02T00:00:02.000Z",
    ordinaryDays: 90,
    protectedDays: 180
  })).resolves.toEqual({ expiredCandidateIds: [old.candidateId] });
});

test("Private Global Candidate promotion requires explicit Human scope authorization", async () => {
  const roots = await createRoot();
  const projectIds = [
    "msproj_123e4567-e89b-42d3-a456-426614174001",
    "msproj_123e4567-e89b-42d3-a456-426614174002"
  ];
  const privateEvidence = await Promise.all(projectIds.map((projectId, index) =>
    captureUserEvidence({
      runtimeRoot: roots.runtimeRoot,
      evidenceId: `private-${String(index)}`,
      projectId,
      occurredAt: `2026-08-07T16:00:0${String(index)}.000Z`,
      prompt: index === 0
        ? "Keep this cross-project preference private."
        : "This private preference applies across my projects."
    })
  ));
  const privateCandidate = {
    ...candidate,
    statement: "A private cross-project preference.",
    sensitivity: "private" as const
  };
  const created = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "global" },
    candidate: privateCandidate,
    evidence: privateEvidence,
    createdAt: "2026-08-07T16:00:03.000Z"
  }));
  const operationId = await runDurableAssessment({
    ...roots,
    candidateId: created.candidateId,
    state: "supported",
    evidenceIds: ["private-0", "private-1"],
    now: "2026-08-07T16:00:04.000Z"
  });
  await expect(evaluateCandidate({
    ...roots,
    candidateId: created.candidateId,
    evaluatedAt: "2026-08-07T16:00:05.000Z",
    semanticAssessmentOperationId: operationId
  })).resolves.toMatchObject({
    state: "wait",
    reason: "private_global_requires_human_authorization"
  });
  const authorization = await recordHumanGlobalAuthorization({
    runtimeRoot: roots.runtimeRoot,
    statement: privateCandidate.statement,
    maximumSensitivity: "private",
    authorizedAt: "2026-08-07T16:00:06.000Z",
    sourceIdentity: "manual-command:memory-global"
  });
  await createAgentCandidate({
    ...roots,
    scope: { kind: "global" },
    candidate: privateCandidate,
    evidence: privateEvidence,
    globalAuthorizationId: authorization.authorizationId,
    createdAt: "2026-08-07T16:00:06.000Z"
  });
  const promoted = await evaluateCandidate({
    ...roots,
    candidateId: created.candidateId,
    evaluatedAt: "2026-08-07T16:00:07.000Z",
    semanticAssessmentOperationId: operationId
  });
  expect(promoted).toMatchObject({ state: "promoted" });
  if (promoted.state !== "promoted") throw new Error("Expected Global promotion.");
  const memory = await readCanonicalMemory({ ...roots, memoryId: promoted.memoryId });
  expect(memory?.memory.provenance).toEqual(expect.arrayContaining([
    `operation:${authorization.operationId}`,
    "source:manual-command:memory-global"
  ]));
});

test("Human Memory evidence must bind the current revision and content identity", async () => {
  const roots = await createRoot();
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";
  const human = await assertHumanKnowledge({
    ...roots,
    scope: { kind: "project", projectId },
    body: "Use a content-addressed Human reference.",
    primaryCategory: "workflow_environment_toolchain",
    assertedAt: "2026-08-07T17:00:00.000Z"
  });
  if (human.state !== "created") throw new Error("Expected Human Memory.");
  const stored = await readCanonicalMemory({ ...roots, memoryId: human.memoryId });
  if (stored === undefined) throw new Error("Expected stored Human Memory.");

  const invalid = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "project", projectId },
    candidate: { ...candidate, statement: "An invalid Human reference.", importanceTags: [] },
    evidence: [{
      evidenceId: "human-reference-invalid",
      evidenceClass: "human_memory_reference",
      sourceIdentity: `${human.memoryId}:${stored.memory.revisionId}`,
      projectId,
      occurredAt: "2026-08-07T17:00:01.000Z",
      integrity: "intact",
      sourceTruncated: false,
      memoryEcho: false,
      humanMemoryId: human.memoryId,
      humanRevisionId: stored.memory.revisionId,
      humanContentIdentity: "f".repeat(64)
    }],
    createdAt: "2026-08-07T17:00:01.000Z"
  }));
  await expect(evaluateCandidate({
    ...roots,
    candidateId: invalid.candidateId,
    evaluatedAt: "2026-08-07T17:00:02.000Z"
  })).resolves.toMatchObject({ state: "wait", reason: "insufficient_evidence" });

  const valid = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "project", projectId },
    candidate: { ...candidate, statement: "A verified Human reference.", importanceTags: [] },
    evidence: [{
      evidenceId: "human-reference-valid",
      evidenceClass: "human_memory_reference",
      sourceIdentity: `${human.memoryId}:${stored.memory.revisionId}`,
      projectId,
      occurredAt: "2026-08-07T17:00:03.000Z",
      integrity: "intact",
      sourceTruncated: false,
      memoryEcho: false,
      humanMemoryId: human.memoryId,
      humanRevisionId: stored.memory.revisionId,
      humanContentIdentity: stored.contentIdentity
    }],
    createdAt: "2026-08-07T17:00:03.000Z"
  }));
  await expect(evaluateCandidate({
    ...roots,
    candidateId: valid.candidateId,
    evaluatedAt: "2026-08-07T17:00:04.000Z"
  })).resolves.toMatchObject({ state: "promoted" });
});

test("code evidence must match the current Git revision and file content", async () => {
  const roots = await createRoot();
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";
  const repositoryRoot = join(roots.runtimeRoot, "..", "source-repository");
  const filePath = join(repositoryRoot, "policy.txt");
  const content = "Keep the migration reversible.\n";
  await mkdir(repositoryRoot, { recursive: true });
  await writeFile(filePath, content, "utf8");
  execFileSync("git", ["init", "--quiet", repositoryRoot]);
  execFileSync("git", ["-C", repositoryRoot, "config", "user.email", "memstore@example.invalid"]);
  execFileSync("git", ["-C", repositoryRoot, "config", "user.name", "MemStore Test"]);
  execFileSync("git", ["-C", repositoryRoot, "add", "policy.txt"]);
  execFileSync("git", ["-C", repositoryRoot, "commit", "--quiet", "-m", "Add policy"]);
  const repoRevision = execFileSync(
    "git",
    ["-C", repositoryRoot, "rev-parse", "HEAD"],
    { encoding: "utf8" }
  ).trim();
  const fileContentIdentity = createHash("sha256").update(content).digest("hex");
  const created = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "project", projectId },
    candidate: { ...candidate, statement: "Keep this migration reversible.", importanceTags: [] },
    evidence: [{
      evidenceId: "verified-code-source",
      evidenceClass: "code_or_configuration",
      sourceIdentity: `git:${repoRevision}:policy.txt:${fileContentIdentity}`,
      projectId,
      occurredAt: "2026-08-07T17:10:00.000Z",
      integrity: "intact",
      sourceTruncated: false,
      memoryEcho: false,
      repoRevision,
      fileContentIdentity,
      filePath,
      repositoryRoot
    }],
    createdAt: "2026-08-07T17:10:00.000Z"
  }));
  await expect(evaluateCandidate({
    ...roots,
    candidateId: created.candidateId,
    evaluatedAt: "2026-08-07T17:10:01.000Z"
  })).resolves.toMatchObject({ state: "promoted" });

  const outsidePath = join(repositoryRoot, "..", "outside-policy.txt");
  const linkedPath = join(repositoryRoot, "linked-policy.txt");
  const outsideContent = "outside=true\n";
  await writeFile(outsidePath, outsideContent, "utf8");
  await symlink(outsidePath, linkedPath);
  const outsideIdentity = createHash("sha256").update(outsideContent).digest("hex");
  const escaped = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "project", projectId },
    candidate: { ...candidate, statement: "A symlink-escaped Git fact.", importanceTags: [] },
    evidence: [{
      evidenceId: "git-symlink-escape",
      evidenceClass: "code_or_configuration",
      sourceIdentity: `git:${repoRevision}:linked-policy.txt:${outsideIdentity}`,
      projectId,
      occurredAt: "2026-08-07T17:10:02.000Z",
      integrity: "intact",
      sourceTruncated: false,
      memoryEcho: false,
      repoRevision,
      fileContentIdentity: outsideIdentity,
      filePath: linkedPath,
      repositoryRoot
    }],
    createdAt: "2026-08-07T17:10:02.000Z"
  }));
  await expect(evaluateCandidate({
    ...roots,
    candidateId: escaped.candidateId,
    evaluatedAt: "2026-08-07T17:10:03.000Z"
  })).resolves.toMatchObject({ state: "wait", reason: "insufficient_evidence" });
});

test("non-Git Project file evidence binds its registered root and content", async () => {
  const roots = await createRoot();
  const projectRoot = join(roots.runtimeRoot, "..", "plain-project");
  const filePath = join(projectRoot, "settings.ini");
  const content = "mode=stable\n";
  await mkdir(projectRoot, { recursive: true });
  await writeFile(filePath, content, "utf8");
  const project = await resolveProject({
    path: projectRoot,
    runtimeRoot: roots.runtimeRoot
  });
  if (project.status !== "resolved") throw new Error("Expected non-Git Project.");
  const canonicalFilePath = join(project.root, "settings.ini");
  const fileContentIdentity = createHash("sha256").update(content).digest("hex");
  const created = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "project", projectId: project.projectId },
    candidate: {
      ...candidate,
      statement: "The plain Project uses stable mode.",
      importanceTags: []
    },
    evidence: [{
      evidenceId: "verified-non-git-file",
      evidenceClass: "code_or_configuration",
      sourceIdentity: `file:${canonicalFilePath}:${fileContentIdentity}`,
      projectId: project.projectId,
      occurredAt: "2026-08-07T17:20:00.000Z",
      integrity: "intact",
      sourceTruncated: false,
      memoryEcho: false,
      fileContentIdentity,
      filePath: canonicalFilePath
    }],
    createdAt: "2026-08-07T17:20:00.000Z"
  }));
  await expect(evaluateCandidate({
    ...roots,
    candidateId: created.candidateId,
    evaluatedAt: "2026-08-07T17:20:01.000Z"
  })).resolves.toMatchObject({ state: "promoted" });

  const outsidePath = join(project.root, "..", "outside-settings.ini");
  const linkedPath = join(project.root, "linked-settings.ini");
  const outsideContent = "mode=outside\n";
  await writeFile(outsidePath, outsideContent, "utf8");
  await symlink(outsidePath, linkedPath);
  const outsideIdentity = createHash("sha256").update(outsideContent).digest("hex");
  const escaped = requireCandidate(await createAgentCandidate({
    ...roots,
    scope: { kind: "project", projectId: project.projectId },
    candidate: {
      ...candidate,
      statement: "A symlink-escaped non-Git fact.",
      importanceTags: []
    },
    evidence: [{
      evidenceId: "non-git-symlink-escape",
      evidenceClass: "code_or_configuration",
      sourceIdentity: `file:${linkedPath}:${outsideIdentity}`,
      projectId: project.projectId,
      occurredAt: "2026-08-07T17:20:02.000Z",
      integrity: "intact",
      sourceTruncated: false,
      memoryEcho: false,
      fileContentIdentity: outsideIdentity,
      filePath: linkedPath
    }],
    createdAt: "2026-08-07T17:20:02.000Z"
  }));
  await expect(evaluateCandidate({
    ...roots,
    candidateId: escaped.candidateId,
    evaluatedAt: "2026-08-07T17:20:03.000Z"
  })).resolves.toMatchObject({ state: "wait", reason: "insufficient_evidence" });
});
