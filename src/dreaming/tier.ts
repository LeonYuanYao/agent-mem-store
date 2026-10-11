import type { SourceBranch } from "./branches.js";

export type DreamTier = "inject" | "branch" | "pool" | "review" | "drop";

export interface TierInput {
  readonly verdict: string;
  readonly durability: "long_term" | "episodic";
  readonly branch: string;
  readonly explicitUser: boolean;
  readonly sessionCount: number;
  readonly sourceBranches: readonly SourceBranch[];
}

/**
 * Local admission. Only repository-confirmed, user-stated or recurring knowledge
 * is injected automatically; knowledge from unmerged branches stays with its
 * branch unless the baseline confirms it; everything else remains searchable.
 */
export function tierOf(input: TierInput): { readonly tier: DreamTier; readonly reason: string } {
  if (input.durability === "episodic") return { tier: "drop", reason: "episodic" };
  if (input.verdict === "contradicted" || input.verdict === "stale") return { tier: "review", reason: input.verdict };
  if (input.verdict === "documented") return { tier: "drop", reason: "already_in_autoloaded_docs" };
  const unmerged = input.sourceBranches.filter((source) => !source.mergedIntoBaseline);
  if (input.verdict === "branch_scoped") return { tier: "branch", reason: input.branch || unmerged[0]?.branch || "unknown_branch" };
  if (unmerged.length > 0 && input.verdict !== "confirmed") return { tier: "branch", reason: unmerged[0]?.branch ?? "unknown_branch" };
  if (input.verdict === "confirmed") return { tier: "inject", reason: "confirmed" };
  if (input.explicitUser) return { tier: "inject", reason: "explicit_user" };
  if (input.sessionCount >= 2) return { tier: "inject", reason: "recurring" };
  return { tier: "pool", reason: `single_session_${input.verdict}` };
}
