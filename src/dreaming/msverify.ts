import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { git } from "./git.js";
import { ownerUnmergedBranches, routePath, type RepoEntry, type RepoMap } from "./repo-map.js";

/**
 * Read-only evidence commands for the dreaming verifier. Every repository read
 * goes through git objects at the repository's baseline commit, and each hit is
 * labelled with a source-authority rank and the file's last change date so the
 * verifier can weigh conflicting sources.
 */

export const outputLineCap = 120;
const autoloadPathspecs = [":(glob)AGENTS.md", ":(glob)CLAUDE.md", ":(glob).ai/bootstrap.md", ":(glob).ai/context.md"];

export function sourceRank(repo: RepoEntry, innerPath: string): string {
  const path = innerPath.toLowerCase();
  const name = basename(path);
  if (repo.kind === "submodule" && path.endsWith(".d.ts")) return "R1-sdk-typings";
  if (/(^|\/)(__tests__|tests?)\//u.test(path) || /\.(test|spec)\./u.test(name)) return "R2-tests";
  if (/(^|\/)examples?\//u.test(path)) return "R4-example";
  if (repo.docsOnly) return "R3-docs-repo";
  if (/\.(md|mdx|txt|rst)$/u.test(path)) return "R2-project-docs-or-skill";
  return "R1-implementation";
}

export class EvidenceReader {
  readonly #map: RepoMap;
  readonly #dates = new Map<string, string>();

  public constructor(map: RepoMap) {
    this.#map = map;
  }

  async #fileDate(repo: RepoEntry, innerPath: string): Promise<string> {
    const key = `${repo.directory}\0${innerPath}`;
    const cached = this.#dates.get(key);
    if (cached !== undefined) return cached;
    const result = repo.sha === null ? undefined : await git(repo.directory, ["log", "-1", "--format=%cs", repo.sha, "--", innerPath]);
    const date = result?.code === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : "?";
    this.#dates.set(key, date);
    return date;
  }

  #label(repo: RepoEntry): string {
    return `${repo.path}@${(repo.sha ?? "unavailable").slice(0, 10)}`;
  }

  public map(): string[] {
    return this.#map.repos.map((repo) =>
      `${repo.path.padEnd(48)} ${repo.kind.padEnd(9)} ${(repo.ref || "-").padEnd(36)} ${(repo.sha ?? "UNAVAILABLE").slice(0, 10)} ` +
      `commit=${(repo.commitDate ?? "-").slice(0, 10)} fetched=${repo.fetchedAt?.slice(0, 10) ?? "never"}${repo.docsOnly ? " docs-only" : ""}`);
  }

  public async grep(pattern: string, options: {
    readonly ignoreCase?: boolean; readonly repo?: string; readonly path?: string; readonly autoload?: boolean;
  } = {}): Promise<string[]> {
    const lines: string[] = [];
    for (const repo of this.#map.repos) {
      if (repo.sha === null || (options.repo !== undefined && repo.path !== options.repo)) continue;
      if (options.autoload === true && repo.kind === "submodule") continue;
      const args = ["grep", "-n", "-I", "--full-name", "-E", ...(options.ignoreCase === true ? ["-i"] : []), "-e", pattern, repo.sha];
      if (options.autoload === true) args.push("--", ...autoloadPathspecs);
      else if (options.path !== undefined) args.push("--", options.path);
      const result = await git(repo.directory, args);
      if (result.code !== 0 && result.code !== 1) {
        lines.push(`[${this.#label(repo)}] error: ${result.stderr.trim().slice(0, 200)}`);
        continue;
      }
      for (const line of result.stdout.split("\n").filter(Boolean).slice(0, outputLineCap)) {
        const rest = line.slice(line.indexOf(":") + 1);
        const inner = rest.slice(0, rest.indexOf(":"));
        const prefix = repo.path === "." ? "" : `${repo.path}/`;
        lines.push(`${this.#label(repo)} [${sourceRank(repo, inner)} ${await this.#fileDate(repo, inner)}] ${prefix}${rest.slice(0, 300)}`);
      }
    }
    if (options.autoload === true) lines.push(...await this.#hostSkillGrep(pattern, options.ignoreCase === true));
    return lines.length > 0 ? lines : ["no matches in any repository baseline"];
  }

  async #hostSkillGrep(pattern: string, ignoreCase: boolean): Promise<string[]> {
    let expression: RegExp;
    try {
      expression = new RegExp(pattern, ignoreCase ? "iu" : "u");
    } catch (error) {
      return [`invalid pattern: ${(error as Error).message}`];
    }
    const hits: string[] = [];
    const home = homedir();
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 3 || hits.length >= outputLineCap) return;
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const path = join(directory, entry.name);
        const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && (await stat(path).catch(() => undefined))?.isDirectory() === true);
        if (isDirectory) await visit(path, depth + 1);
        else if (entry.name.endsWith(".md")) {
          const text = await readFile(path, "utf8").catch(() => "");
          text.split("\n").forEach((line, index) => {
            if (expression.test(line) && hits.length < outputLineCap) {
              hits.push(`host-skill [R2-host-skill] ${path.replace(home, "~")}:${String(index + 1)}:${line.trim().slice(0, 240)}`);
            }
          });
        }
      }
    };
    for (const root of this.#map.hostSkillRoots) await visit(root, 0);
    return hits;
  }

  public async show(path: string, from = 1, to?: number): Promise<string[]> {
    const routed = routePath(this.#map, path);
    if (routed?.repo.sha == null) return ["path does not belong to a repository with an available baseline"];
    const { repo, inner } = routed;
    const result = await git(repo.directory, ["show", `${routed.repo.sha}:${inner}`]);
    if (result.code !== 0) return [`[${this.#label(repo)}] ${inner}: not present at baseline`];
    const numbered = result.stdout.split("\n").map((text, index) => `${String(index + 1).padStart(5)} ${text}`);
    return [
      `[${this.#label(repo)}] ${inner}  class=${sourceRank(repo, inner)} last_changed=${await this.#fileDate(repo, inner)}`,
      ...numbered.slice(Math.max(1, from) - 1, to ?? numbered.length)
    ];
  }

  public async list(path: string): Promise<string[]> {
    const routed = routePath(this.#map, path);
    if (routed?.repo.sha == null) return ["path does not belong to a repository with an available baseline"];
    const { repo, inner } = routed;
    const sha = repo.sha ?? "";
    const target = inner === "." ? sha : `${sha}:${inner}`;
    const result = await git(repo.directory, ["ls-tree", "--name-only", target]);
    return [`[${this.#label(repo)}] ${inner}`, ...(result.code === 0 ? result.stdout.split("\n").filter(Boolean) : ["not present at baseline"])];
  }

  public async pickaxe(text: string, repoFilter?: string): Promise<string[]> {
    const lines: string[] = [];
    for (const repo of this.#map.repos) {
      if (repo.kind === "submodule" || repo.sha === null || (repoFilter !== undefined && repo.path !== repoFilter)) continue;
      const result = await git(repo.directory, ["log", "--all", "-S", text, "-n", "15", "--format=%h %cs %s"], { timeoutMilliseconds: 180_000 });
      for (const line of result.code === 0 ? result.stdout.split("\n").filter(Boolean) : []) {
        const sha = line.split(" ")[0] ?? "";
        const inBaseline = (await git(repo.directory, ["merge-base", "--is-ancestor", sha, repo.sha])).code === 0;
        const branches = await git(repo.directory, ["branch", "-a", "--contains", sha, "--format=%(refname:short)"]);
        lines.push(`${this.#label(repo)} ${line.slice(0, 140)} | in_baseline=${String(inBaseline)} | branches=${branches.stdout.split("\n").filter(Boolean).slice(0, 4).join(",")}`);
      }
    }
    return lines.length > 0 ? lines : ["no commits add or remove this text on any local branch"];
  }

  public async branchGrep(pattern: string, now: string, options: {
    readonly ignoreCase?: boolean; readonly repo?: string; readonly path?: string;
  } = {}): Promise<string[]> {
    const lines: string[] = [];
    for (const repo of this.#map.repos) {
      if (repo.kind === "submodule" || repo.sha === null || (options.repo !== undefined && repo.path !== options.repo)) continue;
      for (const branch of await ownerUnmergedBranches(repo, now)) {
        const args = ["grep", "-n", "-I", "--full-name", "-E", "-m", "3", ...(options.ignoreCase === true ? ["-i"] : []), "-e", pattern, branch.tip];
        if (options.path !== undefined) args.push("--", options.path);
        const result = await git(repo.directory, args, { timeoutMilliseconds: 120_000 });
        if (result.code !== 0) continue;
        for (const line of result.stdout.split("\n").filter(Boolean).slice(0, 6)) {
          const rest = line.slice(line.indexOf(":") + 1);
          const inner = rest.slice(0, rest.indexOf(":"));
          const onBaseline = (await git(repo.directory, ["grep", "-q", "-E", "-e", pattern, repo.sha, "--", inner])).code === 0;
          lines.push(`${repo.path}@branch:${branch.name} (${branch.date}) [${onBaseline ? "also-in-baseline" : "NOT-in-baseline"}] ${rest.slice(0, 260)}`);
        }
      }
    }
    return lines.length > 0 ? lines : ["pattern not found on any recent unmerged branch of the repository owner"];
  }
}

export function capLines(lines: readonly string[]): string[] {
  return lines.length <= outputLineCap
    ? [...lines]
    : [...lines.slice(0, outputLineCap), `…[${String(lines.length - outputLineCap)} more lines truncated; narrow with --repo/--path]`];
}
