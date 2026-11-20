import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";

import { git } from "./git.js";

/**
 * Files a CLAUDE.md pulls in with `@path` (ADR-0185). Claude Code loads them with the file, so
 * what they state is guidance the agent already has: a CLAUDE.md that is only `@AGENT.md` keeps
 * its rules in AGENT.md. Relative paths resolve against the importing file; `~/` and absolute
 * paths are honoured on the host. Imports inside code spans and code blocks do not count, and
 * imported files import further, at most five hops deep, as Claude Code does.
 */
export const importDepth = 5;

/** The import targets one file names, in order, without code spans or code blocks. */
export function importTargets(text: string): string[] {
  const prose = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gmu, "").replace(/`[^`\n]*`/gu, "");
  const targets: string[] = [];
  for (const match of prose.matchAll(/(?:^|[\s(（])@((?:~\/|\.{1,2}\/|\/)?[^\s@`'"<>()（）[\]{}，。；：、]+)/gu)) {
    const target = (match[1] ?? "").replace(/[.,;:!?]+$/u, "");
    // `@scope/package`, `@mention` and e-mail-like tokens are not files; they fail the existence check later.
    if (target !== "" && !targets.includes(target)) targets.push(target);
  }
  return targets;
}

/** Whether a file's imports are followed: CLAUDE.md files and what they import. */
export function followsImports(path: string): boolean {
  return basename(path) === "CLAUDE.md" || basename(path) === "CLAUDE.local.md";
}

/** Host files imported by the given instruction files, transitively; the files themselves are not included. */
export async function hostImports(files: readonly string[]): Promise<string[]> {
  const seen = new Set(files.map((file) => resolve(file)));
  const found: string[] = [];
  let level = files.filter(followsImports).map((file) => resolve(file));
  for (let depth = 0; depth < importDepth && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const file of level) {
      const text = await readFile(file, "utf8").catch(() => "");
      for (const target of importTargets(text)) {
        const path = target.startsWith("~/") ? join(homedir(), target.slice(2)) : isAbsolute(target) ? target : resolve(dirname(file), target);
        if (seen.has(path) || (await stat(path).catch(() => undefined))?.isFile() !== true) continue;
        seen.add(path);
        found.push(path);
        next.push(path);
      }
    }
    level = next;
  }
  return found;
}

/**
 * Repository files imported by the repository's CLAUDE.md files at a commit, transitively, as
 * paths inside the repository. Imports that leave the repository are not followed.
 */
export async function repositoryImports(directory: string, sha: string): Promise<string[]> {
  // git grep takes glob pathspecs (ls-tree does not); only files that mention "@" can import.
  const listed = await git(directory, ["grep", "-l", "-F", "-e", "@", sha, "--", ":(glob)**/CLAUDE.md", ":(glob)**/CLAUDE.local.md"]);
  if (listed.code !== 0) return [];
  let level = listed.stdout.split("\n").filter(Boolean).map((line) => line.slice(line.indexOf(":") + 1));
  const seen = new Set(level);
  const found: string[] = [];
  for (let depth = 0; depth < importDepth && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const file of level) {
      const shown = await git(directory, ["show", `${sha}:${file}`]);
      if (shown.code !== 0) continue;
      for (const target of importTargets(shown.stdout)) {
        if (target.startsWith("~/") || isAbsolute(target)) continue;
        const path = posix.normalize(posix.join(posix.dirname(file), target));
        if (path.startsWith("../") || seen.has(path)) continue;
        const type = await git(directory, ["cat-file", "-t", `${sha}:${path}`]);
        if (type.code !== 0 || type.stdout.trim() !== "blob") continue;
        seen.add(path);
        found.push(path);
        next.push(path);
      }
    }
    level = next;
  }
  return found;
}
