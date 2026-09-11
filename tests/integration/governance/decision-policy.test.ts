import { expect, test } from "vitest";
import { enforceGovernanceDecisionPolicy } from "../../../src/governance/decision-policy.js";
import type { GovernancePageRequest, GovernancePageReview } from "../../../src/governance/contracts.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const target = { ...makeCanonicalMemory({ memoryId: "target", revisionId: "r1",
  body: "This run passed JSON checks; the API request has not been tested.", authority: "agent_derived" }), category: "workflow_environment_toolchain" };
const changed = { ...target, memoryId: "changed", revisionId: "r2", body: "The old endpoint was retired and must no longer be used." };
const request: GovernancePageRequest = { schemaVersion: 1, runId: "run", runKind: "weekly", phase: "weekly",
  coverage: { from: "2026-09-01T00:00:00.000Z", through: "2026-09-11T00:00:00.000Z" }, pageOrdinal: 0,
  memories: [target, changed] };
function review(): GovernancePageReview {
  return { schemaVersion: 1, kind: "governance_page_review", agentActions: [
    { kind: "archive", targetMemoryId: "target", reason: "A one-off execution status.", evidenceRefs: ["target"] }
  ], reviewSuggestions: [], futurePurgeObligations: [], summaryItems: [], decisionEvidence: [{
    targetMemoryId: "target", kind: "archive", basis: "transient_progress", remainingDurableValue: "none",
    citations: [{ memoryId: "target", revisionId: "r1", quote: target.body }]
  }] };
}
function proof(output: GovernancePageReview) {
  const item = output.decisionEvidence?.[0];
  if (item === undefined) throw new Error("Expected fixture evidence.");
  return item;
}
function citation(output: GovernancePageReview) {
  const item = proof(output).citations[0];
  if (item === undefined) throw new Error("Expected fixture citation.");
  return item;
}
test.each(["weekly", "monthly"] as const)("%s accepts quoted transient progress but requires intact evidence", phase => {
  const input = { ...request, runKind: phase, phase };
  expect(enforceGovernanceDecisionPolicy(input, review()).agentActions).toHaveLength(1);
  const missing = review(); delete missing.decisionEvidence;
  expect(enforceGovernanceDecisionPolicy(input, missing).agentActions).toHaveLength(0);
  const wrongRevision = review(); citation(wrongRevision).revisionId = "old";
  expect(enforceGovernanceDecisionPolicy(input, wrongRevision).agentActions).toHaveLength(0);
  const fabricated = review(); citation(fabricated).quote = "not in the source";
  expect(enforceGovernanceDecisionPolicy(input, fabricated).agentActions).toHaveLength(0);
  const mixed = review(); proof(mixed).remainingDurableValue = "still_present";
  expect(enforceGovernanceDecisionPolicy(input, mixed).agentActions).toHaveLength(0);
});
test("review_due needs another concrete source and does not repeat an existing marker", () => {
  const output = review();
  output.agentActions = [{ kind: "mark_review_due", targetMemoryId: "target", reason: "Check the changed endpoint.", evidenceRefs: ["changed"] }];
  output.decisionEvidence = [{ targetMemoryId: "target", kind: "mark_review_due", basis: "concrete_change", remainingDurableValue: "still_present",
    citations: [{ memoryId: "target", revisionId: "r1", quote: target.body }] }];
  expect(enforceGovernanceDecisionPolicy(request, output).agentActions).toHaveLength(0);
  proof(output).citations = [{ memoryId: "changed", revisionId: "r2", quote: changed.body }];
  expect(enforceGovernanceDecisionPolicy(request, output).agentActions).toHaveLength(1);
  expect(enforceGovernanceDecisionPolicy(request, output, new Map([["changed", "r3"]])).agentActions).toHaveLength(0);
  expect(enforceGovernanceDecisionPolicy({ ...request, memories: [{ ...target, validity: { state: "review_due" } }, changed] }, output).agentActions).toHaveLength(0);
});
test("retirement requires another source and human reminders cannot cite absence of proof", () => {
  const output = review(); proof(output).basis = "explicit_retirement";
  expect(enforceGovernanceDecisionPolicy(request, output).agentActions).toHaveLength(0);
  proof(output).citations = [{ memoryId: "changed", revisionId: "r2", quote: changed.body }];
  expect(enforceGovernanceDecisionPolicy(request, output).agentActions).toHaveLength(1);
  output.reviewSuggestions = [{ targetMemoryId: "target", kind: "outdated", reason: "Cannot verify policy.", evidenceRefs: ["missing"] }];
  expect(enforceGovernanceDecisionPolicy(request, output).reviewSuggestions).toHaveLength(0);
});
