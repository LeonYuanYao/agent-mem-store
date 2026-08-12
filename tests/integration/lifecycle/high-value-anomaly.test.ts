import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  createAgentCandidate,
  evaluateHighValueAnomalies,
  listSessionCandidates
} from "../../../src/candidates/index.js";
import { captureEvent } from "../../../src/capture/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a one-off high-value Session burst stays provisional across catch-up windows", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-high-value-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";
  for (let index = 0; index < 12; index += 1) {
    const evidenceId = `evidence-${String(index)}`;
    const turnId = `turn-${String(index)}`;
    const occurredAt = `2026-08-07T10:00:${String(index).padStart(2, "0")}.000Z`;
    const payload = { prompt: `Distinct reusable constraint ${String(index)}.` };
    await captureEvent({
      runtimeRoot,
      event: {
        schemaVersion: 1,
        eventId: evidenceId,
        deduplicationKey: `high-value:${evidenceId}`,
        agent: "codex",
        eventKind: "UserPromptSubmit",
        occurredAt,
        projectId,
        sessionId: "burst-session",
        turnId,
        payload
      }
    });
    await createAgentCandidate({
      runtimeRoot,
      scope: { kind: "project", projectId },
      candidate: {
        statement: `Distinct reusable constraint ${String(index)}.`,
        primaryCategory: "preference_constraint",
        categoryTags: ["preference_constraint"],
        applicabilitySummary: "test project",
        conditions: [],
        exclusions: [],
        preservedNegations: [],
        certainty: "asserted",
        importanceTags: index < 10 ? ["constraint"] : [],
        importanceReasons: index < 10
          ? [{
              tag: "constraint",
              reason: "The user supplied a reusable constraint.",
              evidenceIds: [evidenceId]
            }]
          : []
      },
      evidence: [{
        evidenceId,
        evidenceClass: "explicit_user_statement",
        sourceIdentity: `codex:burst-session:${turnId}`,
        projectId,
        occurredAt,
        integrity: "intact",
        sourceTruncated: false,
        memoryEcho: false,
        evidenceContentIdentity: createHash("sha256")
          .update(JSON.stringify(payload))
          .digest("hex")
      }],
      sourceSessionId: "burst-session",
      createdAt: occurredAt
    });
  }

  const first = await evaluateHighValueAnomalies({
    runtimeRoot,
    evaluatedAt: "2026-08-21T11:00:00.000Z",
    evaluation: {
      kind: "weekly",
      windowStart: "2026-08-01T00:00:00.000Z",
      windowEnd: "2026-08-08T00:00:00.000Z"
    }
  });
  expect(first).toContainEqual(expect.objectContaining({
    anomalyKind: "session_burst",
    state: "provisional"
  }));

  const second = await evaluateHighValueAnomalies({
    runtimeRoot,
    evaluatedAt: "2026-08-21T11:00:00.000Z",
    evaluation: {
      kind: "weekly",
      windowStart: "2026-08-08T00:00:00.000Z",
      windowEnd: "2026-08-15T00:00:00.000Z"
    }
  });
  expect(second).not.toContainEqual(expect.objectContaining({
    anomalyKind: "session_burst"
  }));
  expect(await listSessionCandidates(runtimeRoot, "burst-session")).toHaveLength(12);
  expect(await listSessionCandidates(runtimeRoot, "burst-session")).toEqual(
    expect.arrayContaining([expect.objectContaining({ state: "waiting" })])
  );
});
