import { join, relative, sep } from "node:path";

import { git, gitText, isAncestor } from "./git.js";
import type { RepoMap } from "./repo-map.js";

/**
 * Infers which branch each repository had checked out when a Session ran, from
 * the clone's reflog. Knowledge learned on an unmerged branch may not hold on the
 * baseline, so these facts let tiering scope unconfirmed memories to that branch.
 */
export interface SourceBranch {
  readonly repo: string;
  readonly branch: string;
  readonly mergedIntoBaseline: boolean;
}

interface ReflogEntry {
  readonly at: number;
  readonly target?: string;
}

const reflogCache = new Map<string, readonly ReflogEntry[]>();

async function reflog(directory: string): Promise<readonly ReflogEntry[]> {
  const cached = reflogCache.get(directory);
  if (cached !== undefined) return cached;
  const output = await gitText(directory, ["reflog", "--date=iso-strict", "--format=%gd|%gs"]);
  const entries: ReflogEntry[] = [];
  for (const line of (output ?? "").split("\n")) {
    const match = /^HEAD@\{(.+?)\}\|(.*)$/u.exec(line);
    if (match?.[1] === undefined) continue;
    const at = Date.parse(match[1]);
    if (Number.isNaN(at)) continue;
    const target = /moving from \S+ to (\S+)/u.exec(match[2] ?? "")?.[1];
    entries.push(target === undefined ? { at } : { at, target });
  }
  reflogCache.set(directory, entries);
  return entries;
}

export async function branchAt(directory: string, when: string): Promise<string | undefined> {
  const at = Date.parse(when);
  const entries = await reflog(directory);
  const before = entries.find((entry) => entry.at <= at && entry.target !== undefined);
  if (before?.target !== undefined) return before.target;
  // No checkout recorded before the Session: the current branch held then only if none happened since.
  if (entries.some((entry) => entry.at > at && entry.target !== undefined)) return undefined;
  const current = await gitText(directory, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return current === undefined || current === "HEAD" ? undefined : current;
}

export function cloneOf(cwds: readonly string[], projectRoots: readonly string[]): string | undefined {
  for (const cwd of cwds) {
    const root = [...projectRoots]
      .sort((a, b) => b.length - a.length)
      .find((candidate) => cwd === candidate || cwd.startsWith(`${candidate}${sep}`));
    if (root !== undefined) return root;
  }
  return undefined;
}

export async function sessionSourceBranches(request: {
  readonly map: RepoMap;
  readonly clone: string;
  readonly startedAt: string;
}): Promise<SourceBranch[]> {
  const result: SourceBranch[] = [];
  for (const repo of request.map.repos) {
    if (repo.kind === "submodule" || repo.sha === null) continue;
    const directory = repo.path === "." ? request.clone : join(request.clone, repo.path);
    if (relative(request.clone, directory).startsWith("..")) continue;
    const branch = await branchAt(directory, request.startedAt);
    if (branch === undefined) continue;
    const tip = await gitText(directory, ["rev-parse", "-q", "--verify", branch]);
    if (tip === undefined || tip === "") continue;
    // The baseline commit may come from a fresher clone; fall back to this clone's own baseline ref.
    const baselinePresent = (await git(directory, ["cat-file", "-e", `${repo.sha}^{commit}`])).code === 0;
    const baseline = baselinePresent ? repo.sha : repo.ref;
    result.push({ repo: repo.path, branch, mergedIntoBaseline: await isAncestor(directory, tip, baseline) });
  }
  return result;
}
