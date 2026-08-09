import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  assertHumanKnowledge,
  inspectHumanConflict
} from "../../../src/candidates/human.js";
import {
  enqueueHumanConflictAssessment,
  runNextHumanConflictAssessment,
  type HumanConflictAssessmentAdapter
} from "../../../src/worker/human-conflicts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a durable Luna conflict assessment informs review without resolving Human authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-human-conflict-worker-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const scope = {
    kind: "project" as const,
    projectId: "msproj_123e4567-e89b-42d3-a456-426614174001"
  };
  const existing = await assertHumanKnowledge({
    runtimeRoot,
    vaultRoot,
    scope,
    body: "Use the stable endpoint in production.",
    category: "api",
    assertedAt: "2026-08-07T14:00:00.000Z"
  });
  if (existing.state !== "created") throw new Error("Expected Human Memory.");
  const proposedBody = "Use the beta endpoint in staging.";
  const conflict = await assertHumanKnowledge({
    runtimeRoot,
    vaultRoot,
    scope,
    body: proposedBody,
    category: "api",
    potentialConflictMemoryIds: [existing.memoryId],
    assertedAt: "2026-08-07T14:00:01.000Z"
  });
  if (conflict.state !== "conflict") throw new Error("Expected Human conflict.");
  await enqueueHumanConflictAssessment({
    runtimeRoot,
    conflictId: conflict.conflictId,
    createdAt: "2026-08-07T14:00:02.000Z"
  });
  const adapter: HumanConflictAssessmentAdapter = {
    assessHumanConflict() {
      return Promise.resolve({
        schemaVersion: 1,
        kind: "conflict_assessment",
        state: "no_material_conflict",
        conflictingMemoryIds: []
      });
    }
  };
  await expect(runNextHumanConflictAssessment({
    runtimeRoot,
    vaultRoot,
    workerId: "human-conflict-worker",
    now: "2026-08-07T14:00:03.000Z",
    adapter
  })).resolves.toMatchObject({
    state: "completed",
    assessmentState: "no_material_conflict"
  });
  await expect(inspectHumanConflict(runtimeRoot, conflict.conflictId)).resolves.toMatchObject({
    state: "open",
    body: proposedBody
  });
});
