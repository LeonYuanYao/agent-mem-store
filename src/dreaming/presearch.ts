import { git } from "./git.js";
import { ownerUnmergedBranches, type RepoEntry, type RepoMap } from "./repo-map.js";

/**
 * Deterministic pre-search: identifiers in a statement are looked up at every
 * baseline and on the owner's unmerged branches. The verifier receives these
 * facts so branch-only knowledge is noticed even when the model would not search.
 */
export interface PresearchFact {
  readonly identifier: string;
  readonly baseline: readonly string[];
  readonly ownerBranches: readonly string[];
}

const ignored = new Set(["return", "string", "number", "boolean", "undefined", "function", "default", "project", "preview", "session"]);

export function identifiersOf(statement: string): string[] {
  const found = [
    ...[...statement.matchAll(/`([^`]{3,60})`/gu)].map((match) => match[1] ?? ""),
    ...statement.match(/\b[A-Za-z_][A-Za-z0-9_]*(?:[._][A-Za-z0-9_]+)+\b/gu) ?? [],
    ...statement.match(/\b[a-z]+[A-Z][A-Za-z0-9]{3,}\b|\b[A-Z][a-z]+[A-Z][A-Za-z0-9]+\b/gu) ?? []
  ];
  const result: string[] = [];
  for (const raw of found) {
    const identifier = raw.trim().replace(/^\(+|\)+$/gu, "");
    if (identifier.length < 5 || ignored.has(identifier.toLowerCase()) || (identifier.includes(" ") && identifier.length > 40)) continue;
    if (!result.includes(identifier)) result.push(identifier);
  }
  return result.slice(0, 6);
}

export async function presearch(
  map: RepoMap,
  statement: string,
  now: string,
  branchCache: Map<string, Awaited<ReturnType<typeof ownerUnmergedBranches>>> = new Map()
): Promise<PresearchFact[]> {
  const facts: PresearchFact[] = [];
  const branchesOf = async (repo: RepoEntry) => {
    const cached = branchCache.get(repo.directory);
    if (cached !== undefined) return cached;
    const branches = await ownerUnmergedBranches(repo, now);
    branchCache.set(repo.directory, branches);
    return branches;
  };
  for (const identifier of identifiersOf(statement)) {
    const baseline: string[] = [];
    const ownerBranches: string[] = [];
    for (const repo of map.repos) {
      if (repo.sha === null) continue;
      const hits = await git(repo.directory, ["grep", "-l", "-F", "-I", "-e", identifier, repo.sha]);
      if (hits.code === 0) baseline.push(`${repo.path}:${String(hits.stdout.split("\n").filter(Boolean).length)} files`);
      if (repo.kind === "submodule") continue;
      for (const branch of await branchesOf(repo)) {
        if (ownerBranches.length >= 3) break;
        if ((await git(repo.directory, ["grep", "-q", "-F", "-I", "-e", identifier, branch.tip])).code === 0) {
          ownerBranches.push(`${repo.path}@${branch.name}`);
        }
      }
    }
    facts.push({ identifier, baseline, ownerBranches });
  }
  return facts;
}

export function renderPresearch(facts: readonly PresearchFact[]): string {
  if (facts.length === 0) return "";
  return `（预检索：${facts.map((fact) =>
    `${fact.identifier}: 基准=${fact.baseline.join("; ") || "无"}; 未合入分支=${fact.ownerBranches.join("; ") || "无"}`).join(" | ")}）`;
}
