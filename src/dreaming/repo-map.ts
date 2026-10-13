import { readdir, stat } from "node:fs/promises";
import { join, normalize, relative, sep } from "node:path";
import { z } from "zod";

import { git, gitText, isAncestor } from "./git.js";

/**
 * A repository map describes every Git repository that can serve as evidence for
 * one Project: the root, nested independent repositories and submodules. Each
 * logical repository reads from one baseline commit, chosen from the clone whose
 * baseline is newest, so the checked-out branch and uncommitted work of any clone
 * never influence verification.
 */

/** Roots under the system temporary directories (scratch clones, test fixtures) are never dreamed about. */
export const temporaryRootPattern = /^(?:\/private)?\/(?:tmp|var\/folders)\//u;

export const repoEntrySchema = z.object({
  path: z.string(),
  kind: z.enum(["root", "nested", "submodule"]),
  directory: z.string(),
  clone: z.string(),
  parent: z.string().optional(),
  remote: z.string().optional(),
  ref: z.string(),
  sha: z.string().nullable(),
  commitDate: z.string().optional(),
  fetchedAt: z.string().nullable(),
  ownerEmail: z.string().optional(),
  docsOnly: z.boolean().default(false)
});
export type RepoEntry = z.infer<typeof repoEntrySchema>;

export const repoMapSchema = z.object({
  schemaVersion: z.literal(1),
  builtAt: z.string(),
  repos: z.array(repoEntrySchema),
  // Absolute paths: the verifier sandbox runs with an isolated HOME.
  hostSkillRoots: z.array(z.string()).default([])
});
export type RepoMap = z.infer<typeof repoMapSchema>;

const excludedDirectories = new Set([
  ".git", "node_modules", "tmp", "dist", "build", "out", "coverage", "__pycache__", ".venv", "venv", ".worktrees"
]);
const maximumDepth = 4;
const maximumRepositories = 32;

async function hasGitMarker(directory: string): Promise<boolean> {
  return stat(join(directory, ".git")).then(() => true, () => false);
}

async function discoverNested(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string, depth: number): Promise<void> {
    if (found.length >= maximumRepositories || depth > maximumDepth) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Symbolic links are not followed: they may point outside the Project.
      if (!entry.isDirectory() || excludedDirectories.has(entry.name)) continue;
      const child = join(directory, entry.name);
      if (await hasGitMarker(child)) found.push(relative(root, child));
      await walk(child, depth + 1);
    }
  }
  await walk(root, 1);
  return found;
}

async function baselineOf(directory: string): Promise<{ ref: string; sha: string; commitDate: string } | undefined> {
  let ref = await gitText(directory, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (ref === undefined || ref.length === 0) {
    for (const candidate of ["origin/main", "origin/master", "origin/develop"]) {
      if ((await git(directory, ["rev-parse", "-q", "--verify", candidate])).code === 0) {
        ref = candidate;
        break;
      }
    }
  }
  if (ref === undefined || ref.length === 0) return undefined;
  const sha = await gitText(directory, ["rev-parse", ref]);
  const commitDate = await gitText(directory, ["log", "-1", "--format=%cI", ref]);
  return sha === undefined || commitDate === undefined ? undefined : { ref, sha, commitDate };
}

async function fetchedAtOf(directory: string): Promise<string | null> {
  const gitDirectory = await gitText(directory, ["rev-parse", "--absolute-git-dir"]);
  if (gitDirectory === undefined) return null;
  const fetchHead = await stat(join(gitDirectory, "FETCH_HEAD")).catch(() => undefined);
  return fetchHead === undefined ? null : fetchHead.mtime.toISOString();
}

/** A repository whose files are overwhelmingly prose is a documentation source, ranked below code and project docs. */
async function isDocsOnly(directory: string, sha: string): Promise<boolean> {
  const files = (await gitText(directory, ["ls-tree", "-r", "--name-only", sha]))?.split("\n").filter(Boolean) ?? [];
  if (files.length === 0) return false;
  const prose = files.filter((file) => /\.(?:md|mdx|txt|rst)$/iu.test(file)).length;
  return prose / files.length >= 0.7;
}

export async function buildRepoMap(
  clones: readonly string[],
  builtAt: string,
  hostSkillRoots: readonly string[] = []
): Promise<RepoMap> {
  const best = new Map<string, RepoEntry>();
  for (const clone of clones) {
    if (!(await hasGitMarker(clone))) continue;
    const candidates: { path: string; kind: "root" | "nested" }[] = [
      { path: ".", kind: "root" },
      ...(await discoverNested(clone)).map((path) => ({ path, kind: "nested" as const }))
    ];
    const submodules = new Map<string, string>();
    for (const candidate of candidates) {
      const status = await gitText(join(clone, candidate.path), ["submodule", "status"]);
      for (const line of (status ?? "").split("\n")) {
        const parts = line.trim().split(/\s+/u);
        if (parts.length >= 2 && parts[1] !== undefined) {
          submodules.set(normalize(join(candidate.path, parts[1])), candidate.path);
        }
      }
    }
    for (const candidate of candidates) {
      if (submodules.has(normalize(candidate.path))) continue;
      const directory = join(clone, candidate.path);
      const baseline = await baselineOf(directory);
      if (baseline === undefined) continue;
      const entry: RepoEntry = {
        path: normalize(candidate.path),
        kind: candidate.kind,
        directory,
        clone,
        ref: baseline.ref,
        sha: baseline.sha,
        commitDate: baseline.commitDate,
        fetchedAt: await fetchedAtOf(directory),
        ...(await gitText(directory, ["remote", "get-url", "origin"]).then((remote) => remote === undefined ? {} : { remote })),
        ...(await gitText(directory, ["config", "user.email"]).then((email) => email === undefined || email === "" ? {} : { ownerEmail: email })),
        docsOnly: await isDocsOnly(directory, baseline.sha)
      };
      const current = best.get(entry.path);
      if (current === undefined || (entry.commitDate ?? "") > (current.commitDate ?? "")) best.set(entry.path, entry);
    }
    for (const [path, parent] of submodules) {
      if (!best.has(path)) {
        best.set(path, { path, kind: "submodule", directory: join(clone, path), clone, parent, ref: "", sha: null, fetchedAt: null, docsOnly: false });
      }
    }
  }
  // A second clone of the same remote nested deeper (test fixtures, baselines) is not independent evidence.
  const byRemote = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const path of [...best.keys()].sort((a, b) => a.split(sep).length - b.split(sep).length || a.length - b.length)) {
    const remote = best.get(path)?.remote;
    if (remote === undefined) continue;
    if (byRemote.has(remote)) duplicates.add(path);
    else byRemote.set(remote, path);
  }
  for (const path of [...best.keys()]) {
    if ([...duplicates].some((duplicate) => path === duplicate || path.startsWith(`${duplicate}${sep}`))) best.delete(path);
  }
  for (const entry of best.values()) {
    if (entry.kind !== "submodule" || entry.parent === undefined) continue;
    const parent = best.get(entry.parent);
    if (parent?.sha == null) continue;
    const inner = entry.parent === "." ? entry.path : relative(entry.parent, entry.path);
    const tree = await gitText(parent.directory, ["ls-tree", parent.sha, inner]);
    const pinned = tree?.split(/\s+/u)[2];
    const directory = join(parent.directory, inner);
    const available = pinned !== undefined && (await git(directory, ["cat-file", "-e", `${pinned}^{commit}`])).code === 0;
    best.set(entry.path, {
      ...entry,
      directory,
      clone: parent.clone,
      ref: `pinned-by ${entry.parent}@${parent.sha.slice(0, 10)}`,
      sha: available ? pinned : null,
      fetchedAt: parent.fetchedAt
    });
  }
  const repos = [...best.values()].sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));
  return { schemaVersion: 1, builtAt, repos, hostSkillRoots: [...hostSkillRoots] };
}

/** Longest-prefix routing from a project-relative path to its repository. */
export function routePath(map: RepoMap, path: string): { readonly repo: RepoEntry; readonly inner: string } | undefined {
  const cleaned = normalize(path.replace(/^\.\/+/u, ""));
  for (const repo of map.repos) {
    if (repo.path === "." ) return { repo, inner: cleaned };
    if (cleaned === repo.path) return { repo, inner: "." };
    if (cleaned.startsWith(`${repo.path}${sep}`)) return { repo, inner: relative(repo.path, cleaned) };
  }
  return undefined;
}

export function baselineIsFresh(repo: RepoEntry, now: string, freshDays: number): boolean {
  if (repo.fetchedAt === null || repo.sha === null) return false;
  return Date.parse(now) - Date.parse(repo.fetchedAt) <= freshDays * 86_400_000;
}

/** Recent branches by the repository owner that are not merged into the baseline. */
export async function ownerUnmergedBranches(
  repo: RepoEntry,
  now: string,
  options: { readonly days?: number; readonly limit?: number } = {}
): Promise<{ readonly name: string; readonly date: string; readonly tip: string }[]> {
  if (repo.sha === null || repo.kind === "submodule" || repo.ownerEmail === undefined) return [];
  const since = new Date(Date.parse(now) - (options.days ?? 75) * 86_400_000).toISOString().slice(0, 10);
  const listing = await gitText(repo.directory, [
    "for-each-ref", "--sort=-committerdate",
    "--format=%(refname:short)|%(committerdate:short)|%(authoremail)|%(objectname)", "refs/heads", "refs/remotes"
  ]);
  const owner = repo.ownerEmail.toLowerCase();
  const seenTips = new Set<string>();
  const branches: { name: string; date: string; tip: string }[] = [];
  for (const line of (listing ?? "").split("\n")) {
    const [name = "", date = "", author = "", tip = ""] = line.split("|");
    if (date < since || !author.toLowerCase().includes(owner) || seenTips.has(tip) || name.endsWith("/HEAD")) continue;
    if (await isAncestor(repo.directory, tip, repo.sha)) continue;
    seenTips.add(tip);
    branches.push({ name, date, tip });
    if (branches.length >= (options.limit ?? 25)) break;
  }
  return branches;
}
