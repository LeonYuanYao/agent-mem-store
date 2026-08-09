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
import {
  enqueueCandidateAssessment,
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
      category: "tooling",
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
