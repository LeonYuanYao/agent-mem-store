import { expect, test } from "vitest";

import { isCatchAllRoot, relevantRepositories, tierOf, type TierInput } from "../../../src/dreaming/tier.js";
import { identifiersOf } from "../../../src/dreaming/presearch.js";
import { codexArguments } from "../../../src/dreaming/model.js";

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

test("a catch-all home-directory Project keeps global knowledge only", () => {
  expect(tierOf({ ...base, verdict: "confirmed", catchAllProject: true })).toEqual({ tier: "drop", reason: "catch_all_project" });
  expect(tierOf({ ...base, explicitUser: true, catchAllProject: true }).tier).toBe("drop");
  expect(tierOf({ ...base, explicitUser: true, scope: "global", catchAllProject: true })).toEqual({ tier: "inject", reason: "explicit_user" });
  expect(isCatchAllRoot("/Users/owner", "/Users/owner")).toBe(true);
  expect(isCatchAllRoot("/Users", "/Users/owner")).toBe(true);
  expect(isCatchAllRoot("/Users/owner/projects/app", "/Users/owner")).toBe(false);
  expect(isCatchAllRoot("/Users/owner2", "/Users/owner")).toBe(false);
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

test("verification keeps the command tools Codex needs; extraction disables them", () => {
  const common = { effort: "high", work: "/w", schemaPath: "/w/s.json", outputPath: "/w/o.json" };
  const verify = codexArguments({ ...common, shell: true });
  const extract = codexArguments({ ...common, shell: false });
  for (const feature of ["shell_tool", "unified_exec", "code_mode_host"]) {
    expect(verify.join(" ")).not.toContain(`--disable ${feature}`);
    expect(extract.join(" ")).toContain(`--disable ${feature}`);
  }
  expect(verify).toEqual(expect.arrayContaining(["--sandbox", "read-only", "--ephemeral", "--ignore-user-config"]));
  expect(verify.join(" ")).toContain("--disable plugins");
});

test("only the branches of repositories the item is about scope it", () => {
  const sourceBranches = [
    { repo: ".", branch: "merge/feat-runner", mergedIntoBaseline: false },
    { repo: "tteh", branch: "develop", mergedIntoBaseline: true }
  ];
  const relevantRepos = relevantRepositories({
    evidence: ["tteh@8b9c210dcd [R1-implementation 2026-09-25] src/preview.ts:3 setVideo", "host-skill [R2-host-skill] ~/x.md:1:y"],
    sourcePathRepos: [],
    presearch: [{ baseline: ["tteh/src/OrionSDK:2 files"], ownerBranches: [] }]
  });
  expect(relevantRepos).toEqual(["tteh"]);
  expect(relevantRepositories({ evidence: [], sourcePathRepos: [], presearch: [{ baseline: [".:1 files"], ownerBranches: ["tteh@feat/x"] }] }))
    .toEqual([".", "tteh"]);
  expect(tierOf({ ...base, explicitUser: true, scope: "global", sourceBranches }).tier).toBe("inject");
  expect(tierOf({ ...base, explicitUser: true, sourceBranches, relevantRepos })).toEqual({ tier: "inject", reason: "explicit_user" });
  expect(tierOf({ ...base, explicitUser: true, sourceBranches }).tier).toBe("branch");
  expect(tierOf({ ...base, explicitUser: true, sourceBranches, relevantRepos: ["."] }).tier).toBe("branch");
});
