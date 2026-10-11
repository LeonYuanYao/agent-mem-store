import type { SourceBranch } from "./branches.js";

export type DreamTier = "inject" | "branch" | "pool" | "review" | "drop";

export interface TierInput {
  readonly verdict: string;
  readonly durability: "long_term" | "episodic";
  readonly branch: string;
  readonly explicitUser: boolean;
  readonly sessionCount: number;
  readonly sourceBranches: readonly SourceBranch[];
  /**
   * Repositories the item is about (from evidence, source paths and pre-search).
   * A workspace checked out on a feature branch says nothing about knowledge of a
   * nested repository on its baseline, so only these repositories' branches count.
   * When unknown, every source branch counts.
   */
  readonly relevantRepos?: readonly string[];
  /** Global knowledge (general tools) is not tied to any repository's branch. */
  readonly scope?: "project" | "global";
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
  const relevant = input.scope === "global" ? []
    : input.relevantRepos !== undefined && input.relevantRepos.length > 0
      ? input.sourceBranches.filter((source) => input.relevantRepos?.includes(source.repo) === true)
      : input.sourceBranches;
  const unmerged = relevant.filter((source) => !source.mergedIntoBaseline);
  if (input.verdict === "branch_scoped") return { tier: "branch", reason: input.branch || unmerged[0]?.branch || "unknown_branch" };
  if (unmerged.length > 0 && input.verdict !== "confirmed") return { tier: "branch", reason: unmerged[0]?.branch ?? "unknown_branch" };
  if (input.verdict === "confirmed") return { tier: "inject", reason: "confirmed" };
  if (input.explicitUser) return { tier: "inject", reason: "explicit_user" };
  if (input.sessionCount >= 2) return { tier: "inject", reason: "recurring" };
  return { tier: "pool", reason: `single_session_${input.verdict}` };
}

/** Repository paths named by verifier evidence ("repo@sha …"), routed source paths and pre-search hits. */
export function relevantRepositories(request: {
  readonly evidence: readonly string[];
  readonly sourcePathRepos: readonly string[];
  readonly presearch: readonly { readonly baseline: readonly string[]; readonly ownerBranches: readonly string[] }[];
}): string[] {
  // Most specific signal first: the verifier's evidence, then files the Session read, then identifier hits.
  const fromEvidence = request.evidence.flatMap((line) => {
    const match = /^([^\s@[\]]+)@[0-9a-f]{6,}/u.exec(line.trim());
    return match?.[1] === undefined ? [] : [match[1]];
  });
  if (fromEvidence.length > 0) return [...new Set(fromEvidence)];
  if (request.sourcePathRepos.length > 0) return [...new Set(request.sourcePathRepos)];
  const fromPresearch = request.presearch.flatMap((fact) => [
    ...fact.baseline.map((hit) => hit.slice(0, hit.lastIndexOf(":"))),
    ...fact.ownerBranches.map((hit) => hit.slice(0, hit.indexOf("@")))
  ]);
  return [...new Set(fromPresearch)].filter((repo) => repo.length > 0);
}
