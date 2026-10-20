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
  /**
   * The verifier's reading of the user's own words behind a user-stated item. A
   * pasted task description or words the user never said do not count as the
   * user's rule; absent for items verified before this check existed.
   */
  readonly userSupport?: string;
  /** Where guidance the agent already reads states the item, judged apart from its truth ("" or absent when nowhere). */
  readonly documentedAt?: string;
  /** The user asked to remember this material (`remember extract`): what survives verification is kept. */
  readonly userRequested?: boolean;
  /** The Project is a catch-all root (see `isCatchAllRoot`): it keeps global knowledge only. */
  readonly catchAllProject?: boolean;
}

/**
 * The home directory (or an ancestor) registered as a non-Git Project root becomes
 * the Project of every non-Git directory below it: app workspaces, downloads,
 * scratch folders. It is not one project, so nothing is kept as its knowledge.
 */
export function isCatchAllRoot(root: string, home: string): boolean {
  return root === home || root === "/" || home.startsWith(`${root}/`);
}

/**
 * Local admission. Only repository-confirmed, user-stated or recurring knowledge
 * is injected automatically; knowledge from unmerged branches stays with its
 * branch unless the baseline confirms it; everything else remains searchable.
 */
export function tierOf(input: TierInput): { readonly tier: DreamTier; readonly reason: string } {
  // The user's own instruction for one task may still be a preference: keep it searchable instead of dropping it.
  const userTaskInstruction = input.explicitUser && input.userSupport === "user_task_instruction";
  if (input.durability === "episodic" && !userTaskInstruction) return { tier: "drop", reason: "episodic" };
  if (input.catchAllProject === true && input.scope !== "global") return { tier: "drop", reason: "catch_all_project" };
  if (input.verdict === "contradicted" || input.verdict === "stale") return { tier: "review", reason: input.verdict };
  if (input.verdict === "documented" || (input.documentedAt ?? "") !== "") return { tier: "drop", reason: "already_in_autoloaded_docs" };
  // Repeated across Sessions, it reads as a lasting preference after all.
  if (userTaskInstruction) return input.sessionCount >= 2 ? { tier: "inject", reason: "recurring" } : { tier: "pool", reason: "user_task_instruction" };
  const relevant = input.scope === "global" ? []
    : input.relevantRepos !== undefined && input.relevantRepos.length > 0
      ? input.sourceBranches.filter((source) => input.relevantRepos?.includes(source.repo) === true)
      : input.sourceBranches;
  const unmerged = relevant.filter((source) => !source.mergedIntoBaseline);
  if (input.verdict === "branch_scoped") return { tier: "branch", reason: input.branch || unmerged[0]?.branch || "unknown_branch" };
  if (unmerged.length > 0 && input.verdict !== "confirmed") return { tier: "branch", reason: unmerged[0]?.branch ?? "unknown_branch" };
  if (input.verdict === "confirmed") return { tier: "inject", reason: "confirmed" };
  if (input.userRequested === true) return { tier: "inject", reason: "user_requested" };
  // Only the user's own lasting rule is admitted; an instruction for one task, a pasted task text or words the user never said are not.
  const userStated = input.explicitUser &&
    !["user_task_instruction", "pasted_task_instruction", "not_user_stated"].includes(input.userSupport ?? "");
  if (userStated) return { tier: "inject", reason: "explicit_user" };
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
