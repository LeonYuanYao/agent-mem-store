import { expect, test } from "vitest";

import { tierOf, type TierInput } from "../../../src/dreaming/tier.js";
import { identifiersOf } from "../../../src/dreaming/presearch.js";

const base: TierInput = {
  verdict: "inconclusive", durability: "long_term", branch: "", explicitUser: false, sessionCount: 1, sourceBranches: []
};

test("only confirmed, user-stated or recurring knowledge is injected", () => {
  expect(tierOf({ ...base, verdict: "confirmed" })).toEqual({ tier: "inject", reason: "confirmed" });
  expect(tierOf({ ...base, explicitUser: true })).toEqual({ tier: "inject", reason: "explicit_user" });
  expect(tierOf({ ...base, sessionCount: 2 })).toEqual({ tier: "inject", reason: "recurring" });
  expect(tierOf(base)).toEqual({ tier: "pool", reason: "single_session_inconclusive" });
  expect(tierOf({ ...base, verdict: "not_repo_verifiable" }).tier).toBe("pool");
});

test("negative, redundant and episodic knowledge never reaches injection", () => {
  expect(tierOf({ ...base, verdict: "contradicted", explicitUser: true }).tier).toBe("review");
  expect(tierOf({ ...base, verdict: "stale" }).tier).toBe("review");
  expect(tierOf({ ...base, verdict: "documented", sessionCount: 3 })).toEqual({ tier: "drop", reason: "already_in_autoloaded_docs" });
  expect(tierOf({ ...base, verdict: "confirmed", durability: "episodic" })).toEqual({ tier: "drop", reason: "episodic" });
});

test("knowledge from an unmerged branch stays with the branch unless the baseline confirms it", () => {
  const sourceBranches = [{ repo: "tteh", branch: "yaoyuan/opt/feature", mergedIntoBaseline: false }];
  expect(tierOf({ ...base, explicitUser: true, sourceBranches })).toEqual({ tier: "branch", reason: "yaoyuan/opt/feature" });
  expect(tierOf({ ...base, sessionCount: 2, sourceBranches }).tier).toBe("branch");
  expect(tierOf({ ...base, verdict: "confirmed", sourceBranches })).toEqual({ tier: "inject", reason: "confirmed" });
  expect(tierOf({ ...base, verdict: "branch_scoped", branch: "feat/x" })).toEqual({ tier: "branch", reason: "feat/x" });
  const merged = [{ repo: "tteh", branch: "develop", mergedIntoBaseline: true }];
  expect(tierOf({ ...base, explicitUser: true, sourceBranches: merged }).tier).toBe("inject");
});

test("pre-search identifiers come from code spans and identifier-shaped words", () => {
  expect(identifiersOf("`eh.preview.setVideo` reloads; use `start_preview_record` not recordStart")).toEqual(
    ["eh.preview.setVideo", "start_preview_record", "setVideo", "recordStart"]);
  expect(identifiersOf("用户偏好先做轻量化尝试")).toEqual([]);
});
