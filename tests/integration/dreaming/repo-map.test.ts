import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { branchAt, sessionSourceBranches } from "../../../src/dreaming/branches.js";
import { EvidenceReader, sourceRank } from "../../../src/dreaming/msverify.js";
import { buildRepoMap, routePath } from "../../../src/dreaming/repo-map.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function run(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Owner", GIT_AUTHOR_EMAIL: "owner@example.com",
      GIT_COMMITTER_NAME: "Owner", GIT_COMMITTER_EMAIL: "owner@example.com" }
  }).trim();
}

/** A clone of a bare origin, so `origin/HEAD` exists the way it does for real checkouts. */
async function clonedRepository(parent: string, name: string, files: Record<string, string>): Promise<string> {
  const seed = join(parent, `${name}-seed`);
  await mkdir(seed, { recursive: true });
  run(seed, "init", "-q", "-b", "main");
  run(seed, "config", "user.email", "owner@example.com");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(seed, path, ".."), { recursive: true });
    await writeFile(join(seed, path), content);
  }
  run(seed, "add", "-A");
  run(seed, "commit", "-q", "-m", "baseline");
  const bare = join(parent, `${name}.git`);
  run(parent, "clone", "-q", "--bare", seed, bare);
  return bare;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memstore-dream-repo-"));
  directories.push(root);
  const workspaceOrigin = await clonedRepository(root, "workspace", { "AGENTS.md": "Use Bits to create merge requests.\n", "README.md": "workspace\n" });
  const engineOrigin = await clonedRepository(root, "engine", {
    "src/preview.ts": "export function setVideo() { reloadEffect(); }\n",
    "src/__tests__/preview.test.ts": "test('setVideo reloads', () => {});\n"
  });
  const clone = join(root, "clone");
  run(root, "clone", "-q", workspaceOrigin, clone);
  run(clone, "config", "user.email", "owner@example.com");
  run(clone, "clone", "-q", engineOrigin, "engine");
  run(join(clone, "engine"), "config", "user.email", "owner@example.com");
  // Temporary scratch clones are never evidence.
  await mkdir(join(clone, "tmp"), { recursive: true });
  run(join(clone, "tmp"), "clone", "-q", engineOrigin, "scratch");
  // A deeper second clone of the same remote (a test fixture) is not independent evidence.
  await mkdir(join(clone, "test", "results"), { recursive: true });
  run(join(clone, "test", "results"), "clone", "-q", engineOrigin, "engine-copy");
  return { root, clone };
}

test("the repository map reads every repository at its baseline, never the checkout", async () => {
  const { clone } = await fixture();
  // Uncommitted and branch-only edits must not change baseline evidence.
  await writeFile(join(clone, "engine", "src", "preview.ts"), "export function setVideo() { keepState(); }\n");
  run(join(clone, "engine"), "checkout", "-q", "-b", "feature/keep-state");
  run(join(clone, "engine"), "commit", "-q", "-am", "keep state on feature");

  const map = await buildRepoMap([clone], new Date().toISOString(), []);
  expect(map.repos.map((repo) => repo.path).sort()).toEqual([".", "engine"]);
  expect(routePath(map, "engine/src/preview.ts")?.inner).toBe("src/preview.ts");

  const reader = new EvidenceReader(map);
  const hits = await reader.grep("reloadEffect|keepState");
  expect(hits.join("\n")).toContain("engine/src/preview.ts:1:export function setVideo() { reloadEffect(); }");
  expect(hits.join("\n")).not.toContain("keepState");
  expect(hits[0]).toMatch(/\[R1-implementation \d{4}-\d{2}-\d{2}\]/u);
  expect((await reader.show("engine/src/preview.ts"))[1]).toContain("reloadEffect");
  expect((await reader.grep("Bits", { autoload: true })).join("\n")).toContain("AGENTS.md:1");

  const branch = await reader.branchGrep("keepState", new Date().toISOString());
  expect(branch.join("\n")).toContain("engine@branch:feature/keep-state");
  expect(branch.join("\n")).toContain("NOT-in-baseline");
});

test("source ranks order implementation, tests, docs and examples", async () => {
  const { clone } = await fixture();
  const map = await buildRepoMap([clone], new Date().toISOString(), []);
  const engine = map.repos.find((repo) => repo.path === "engine");
  expect(engine).toBeDefined();
  if (engine === undefined) return;
  expect(sourceRank(engine, "src/preview.ts")).toBe("R1-implementation");
  expect(sourceRank(engine, "src/__tests__/preview.test.ts")).toBe("R2-tests");
  expect(sourceRank(engine, "docs/guide.md")).toBe("R2-project-docs-or-skill");
  expect(sourceRank(engine, "examples/demo.json")).toBe("R4-example");
});

test("the branch a Session ran on is recovered from the reflog", async () => {
  const { clone } = await fixture();
  const engine = join(clone, "engine");
  const before = new Date(Date.now() - 1_000).toISOString();
  run(engine, "checkout", "-q", "-b", "feature/unmerged");
  await writeFile(join(engine, "src", "extra.ts"), "export const extra = 1;\n");
  run(engine, "add", "-A");
  run(engine, "commit", "-q", "-m", "unmerged work");
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
  const during = new Date().toISOString();
  expect(await branchAt(engine, during)).toBe("feature/unmerged");
  expect(await branchAt(engine, before)).toBeUndefined();

  const map = await buildRepoMap([clone], new Date().toISOString(), []);
  const branches = await sessionSourceBranches({ map, clone, startedAt: during });
  expect(branches).toContainEqual({ repo: "engine", branch: "feature/unmerged", mergedIntoBaseline: false });
  expect(branches).toContainEqual({ repo: ".", branch: "main", mergedIntoBaseline: true });
});
