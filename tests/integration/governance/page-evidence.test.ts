import { expect, test } from "vitest";
import { completePageEvidence } from "../../../src/governance/page-evidence.js";
import type { GovernanceAuditSignals, GovernanceMemoryInput } from "../../../src/governance/contracts.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";
const memory: GovernanceMemoryInput = { ...makeCanonicalMemory({ memoryId: "a", revisionId: "r", body: "A durable rule." }), category: "workflow_environment_toolchain" };
const audit: GovernanceAuditSignals = { exactDuplicateGroups: [], reviewedDuplicateClusters: [], brokenRelationshipTargets: [],
  openVaultConflictCount: 0, persistentHighValueAnomalyCount: 0, openBadCaseCount: 0, irrelevantObservationCount: 0, retrievalReceiptCount: 0,
  activeIndexRevisionId: null, modelHealthState: "healthy", lunaBacklogCount: 0, captureBacklogCount: 0, indexBuildActive: false };

test("page evidence drops unrelated, missing and cross-scope groups without partial expansion", async () => {
  const input = { ...audit, exactDuplicateGroups: [["x", "y"], ["a", "missing"], ["a", "global"], ["a", "b"], ["b", "c"]] };
  const result = await completePageEvidence([memory], input, id => Promise.resolve(id === "missing" ? undefined :
    { ...memory, memoryId: id, ...(id === "global" ? { scope: { kind: "global" as const } } : {}) }));
  expect(result.memories.map(m => m.memoryId)).toEqual(["a", "b"]);
  expect(result.auditSignals.exactDuplicateGroups).toEqual([["a", "b"]]);
});

test("related input has a body budget and does not truncate a group", async () => {
  const result = await completePageEvidence([memory], { ...audit, exactDuplicateGroups: [["a", "large"], ["a", "small"]] },
    id => Promise.resolve({ ...memory, memoryId: id, body: id === "large" ? "x".repeat(128 * 1024) : "small" }));
  expect(result.memories.map(m => m.memoryId)).toEqual(["a", "small"]);
  expect(result.auditSignals.exactDuplicateGroups).toEqual([["a", "small"]]);
});

test("related memory count is bounded independently of base page size", async () => {
  const groups = Array.from({ length: 60 }, (_, i) => ["a", `related-${String(i)}`]);
  const result = await completePageEvidence([memory], { ...audit, exactDuplicateGroups: groups }, id => Promise.resolve({ ...memory, memoryId: id }));
  expect(result.memories).toHaveLength(51);
  expect(result.auditSignals.exactDuplicateGroups).toHaveLength(50);
});
