import { z } from "zod";
import type { GovernancePageReview } from "./contracts.js";

export const governancePolicyInputSchema = z.object({
  memories: z.array(z.object({
    memoryId: z.string(), revisionId: z.string(), body: z.string(),
    scope: z.discriminatedUnion("kind", [z.object({ kind: z.literal("global") }),
      z.object({ kind: z.literal("project"), projectId: z.string() })]),
    validity: z.object({ state: z.string() })
  })).readonly(),
  auditSignals: z.object({
    exactDuplicateGroups: z.array(z.array(z.string()).readonly()).readonly(),
    reviewedDuplicateClusters: z.array(z.object({
      memoryIds: z.tuple([z.string(), z.string()]).readonly(),
      decision: z.enum(["equivalent", "left_subsumes_right", "right_subsumes_left", "conflicts"])
    })).readonly()
  }).optional()
});

// Structural evidence checks complement model judgment; literal quotes alone
// do not establish semantic entailment or present-day truth.
export function enforceGovernanceDecisionPolicy(
  request: z.infer<typeof governancePolicyInputSchema>,
  review: GovernancePageReview,
  currentRevisions?: ReadonlyMap<string, string>
): GovernancePageReview {
  const memories = new Map(request.memories.map(memory => [memory.memoryId, memory]));
  function supported(kind: string, targetId: string, successorId?: string): boolean {
    const target = memories.get(targetId);
    if (target === undefined) return false;
    const proofs = (review.decisionEvidence ?? []).filter(proof =>
      proof.kind === kind && proof.targetMemoryId === targetId);
    if (proofs.length !== 1) return false;
    const proof = proofs[0];
    if (proof === undefined || !proof.citations.every(citation => {
      const source = memories.get(citation.memoryId);
      return source !== undefined && source.revisionId === citation.revisionId &&
        (currentRevisions === undefined || citation.memoryId === targetId ||
          currentRevisions.get(citation.memoryId) === citation.revisionId) &&
        source.body.includes(citation.quote) &&
        JSON.stringify(source.scope) === JSON.stringify(target.scope);
    })) return false;
    const external = proof.citations.some(citation => citation.memoryId !== targetId);
    if (kind === "mark_review_due" || kind === "review_suggestion") {
      return proof.basis === "concrete_change" && external &&
        (kind !== "mark_review_due" || target.validity.state !== "review_due");
    }
    if (kind === "supersede") {
      return proof.basis === "reviewed_successor" &&
        proof.remainingDurableValue === "preserved_by_successor" &&
        proof.citations.some(citation => citation.memoryId === successorId) &&
        (request.auditSignals?.reviewedDuplicateClusters.some(cluster =>
          (cluster.decision === "equivalent" ||
            (cluster.decision === "left_subsumes_right" && cluster.memoryIds[0] === successorId) ||
            (cluster.decision === "right_subsumes_left" && cluster.memoryIds[1] === successorId)) &&
          cluster.memoryIds.includes(targetId) && cluster.memoryIds.includes(successorId ?? "")) === true ||
          request.auditSignals?.exactDuplicateGroups.some(group =>
            group.includes(targetId) && group.includes(successorId ?? "")) === true);
    }
    return kind === "archive" && proof.remainingDurableValue === "none" &&
      ((proof.basis === "transient_progress" &&
        proof.citations.some(citation => citation.memoryId === targetId)) ||
        (proof.basis === "explicit_retirement" && external));
  }
  const agentActions = review.agentActions.filter(action =>
    action.kind === "add_relationship" || supported(action.kind, action.targetMemoryId,
      action.kind === "supersede" ? action.successorMemoryId : undefined));
  const reviewSuggestions = review.reviewSuggestions.filter(suggestion =>
    supported("review_suggestion", suggestion.targetMemoryId));
  const withheld = review.agentActions.length + review.reviewSuggestions.length -
    agentActions.length - reviewSuggestions.length;
  return {
    ...review, agentActions, reviewSuggestions,
    summaryItems: withheld === 0 ? review.summaryItems :
      [`Evidence policy accepted ${String(agentActions.length)} Agent actions and ${String(reviewSuggestions.length)} review suggestions; withheld ${String(withheld)} unsupported or redundant proposals.`]
  };
}
