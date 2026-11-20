import { realpathSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { EvidenceReader } from "./msverify.js";

/**
 * Whether guidance that states a claim reaches every agent working in the Project (ADR-0187).
 *
 * Dreaming drops a claim the verifier finds in guidance agents already load (`documented_at`), but
 * Memory is injected into Claude Code and Codex alike while their guidance differs: Claude Code
 * loads CLAUDE.md files and what they import, Codex loads AGENTS.md files, and each has its own
 * skills. A claim stated only in one agent's guidance is dropped only if no other agent works in
 * the Project, or that agent's guidance states the same passage too. A file no agent loads, such as a
 * product's own skill resources or a README, documents nothing (ADR-0188).
 */
export type Agent = "claude" | "codex";
export const everyAgent: readonly Agent[] = ["claude", "codex"];

/**
 * Agents with a meaningful share of the Project's Sessions in the last 60 days: at least three
 * Sessions and a tenth of them. A Project without such Sessions counts every agent.
 */
export function activeAgents(database: DatabaseSync, projectId: string, now: string): Agent[] {
  const since = new Date(Date.parse(now) - 60 * 86_400_000).toISOString();
  const rows = database.prepare(
    `SELECT agent, COUNT(DISTINCT session_id) AS sessions FROM capture_events
     WHERE project_id = ? AND created_at >= ? GROUP BY agent`
  ).all(projectId, since);
  const total = rows.reduce((sum, row) => sum + Number(row.sessions), 0);
  const active = everyAgent.filter((agent) => rows.some((row) =>
    row.agent === agent && Number(row.sessions) >= 3 && Number(row.sessions) >= total / 10));
  return active.length > 0 ? active : [...everyAgent];
}

export interface GuidanceContext {
  /** Files CLAUDE.md files import, named as grep and the verifier name them. */
  readonly claudeImports: ReadonlySet<string>;
  /** Real paths of the skill directories each agent loads: those installed on this machine and each repository's own. */
  readonly skillDirectories: Readonly<Record<Agent, readonly string[]>>;
  /** Where repository-relative names live on disk, longest name first. */
  readonly repositories: readonly { readonly path: string; readonly directory: string }[];
}

function hostRootAgent(root: string): Agent | undefined {
  if (/\/\.claude(\/|$)/u.test(root)) return "claude";
  if (/\/\.(codex|agents)(\/|$)/u.test(root)) return "codex";
  return undefined;
}

/** A repository's own skill directories: Claude Code reads `.claude/skills`, Codex `.agents/skills` and `.codex/skills`. */
const repositorySkillRoots: readonly [string, Agent][] = [[".claude/skills", "claude"], [".agents/skills", "codex"], [".codex/skills", "codex"]];

async function skillEntries(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const paths = await Promise.all(entries.map((entry) => realpath(join(root, entry.name)).catch(() => undefined)));
  return paths.filter((path): path is string => path !== undefined);
}

export async function guidanceContext(reader: Pick<EvidenceReader, "repositories" | "claudeImports"> | undefined,
  hostRoots: readonly string[]): Promise<GuidanceContext> {
  const skillDirectories: Record<Agent, string[]> = { claude: [], codex: [] };
  for (const root of hostRoots) {
    const agent = hostRootAgent(root);
    if (agent === undefined || root.endsWith(".md")) continue;
    skillDirectories[agent].push(...await skillEntries(root));
  }
  const repositories: { path: string; directory: string }[] = [];
  for (const repo of reader?.repositories() ?? []) {
    const directory = await realpath(repo.directory).catch(() => repo.directory);
    repositories.push({ path: repo.path, directory });
    for (const [root, agent] of repositorySkillRoots) skillDirectories[agent].push(...await skillEntries(join(directory, root)));
  }
  repositories.sort((left, right) => right.path.length - left.path.length);
  return { claudeImports: reader === undefined ? new Set() : await reader.claudeImports(), skillDirectories, repositories };
}

/** Where a file named the way grep names it lives on disk, through any symbolic link. */
function onDisk(path: string, context: GuidanceContext): string | undefined {
  let absolute: string | undefined;
  if (path.startsWith("~/")) absolute = join(homedir(), path.slice(2));
  else if (isAbsolute(path)) absolute = path;
  else {
    const repo = context.repositories.find((entry) => entry.path !== "." && path.startsWith(`${entry.path}/`)) ??
      context.repositories.find((entry) => entry.path === ".");
    if (repo !== undefined) absolute = join(repo.directory, repo.path === "." ? path : path.slice(repo.path.length + 1));
  }
  if (absolute === undefined) return undefined;
  try { return realpathSync(absolute); } catch { /* not in the checkout */ }
  try { return join(realpathSync(dirname(absolute)), basename(absolute)); } catch { return absolute; }
}

/**
 * Which agents load a guidance file. Instruction files go to the agent that reads them; a skill file to
 * the agents whose skill directories hold it. Any other file, such as a product's own skill resources
 * or a README, is loaded by no agent (ADR-0188). `.ai/bootstrap.md` and `.ai/context.md`, which
 * instruction files point agents to, cannot be told and count for every agent.
 */
export function loadingAgents(path: string, context: GuidanceContext): readonly Agent[] | undefined {
  const name = basename(path);
  if (name === "CLAUDE.md" || name === "CLAUDE.local.md" || context.claudeImports.has(path)) return ["claude"];
  if (name === "AGENTS.md" || name === "AGENTS.override.md") return ["codex"];
  const file = onDisk(path, context);
  const skilled = file === undefined ? [] : everyAgent.filter((agent) =>
    context.skillDirectories[agent].some((directory) => file === directory || file.startsWith(`${directory}/`)));
  if (skilled.length > 0) return skilled;
  // Files under each agent's home directory, as the verifier names them.
  if (/^~\/\.claude\//u.test(path)) return ["claude"];
  if (/^~\/\.codex\//u.test(path)) return ["codex"];
  if (/(?:^|\/)\.ai\/(?:bootstrap|context)\.md$/u.test(path)) return undefined;
  return [];
}

/** The `path:line[-line]` references of a `documented_at` answer. */
export function documentedReferences(text: string): { path: string; from: number; to: number }[] {
  return [...text.matchAll(/([^\s;,，；:]+\.[A-Za-z0-9_]+):(\d+)(?:-(\d+))?/gu)].map((match) => {
    const from = Number(match[2]);
    return { path: match[1] ?? "", from, to: Math.max(from, Number(match[3] ?? match[2])) };
  });
}

async function citedLines(reference: { path: string; from: number; to: number }, reader: EvidenceReader): Promise<string[]> {
  const to = Math.min(reference.to, reference.from + 4);
  const lines = reference.path.startsWith("~/") || reference.path.startsWith("/")
    ? (await readFile(reference.path.startsWith("~/") ? join(homedir(), reference.path.slice(2)) : reference.path, "utf8").catch(() => ""))
      .split("\n").slice(reference.from - 1, to)
    : (await reader.show(reference.path, reference.from, to)).slice(1).map((line) => line.replace(/^\s*\d+ /u, ""));
  // Headings, list markers and short lines say too little to find the same passage elsewhere.
  return lines.map((line) => line.replace(/^\s*(?:#+|[-*]|\d+\.)\s+/u, "").trim()).filter((line) => line.length >= 12)
    .map((line) => line.slice(0, 80));
}

function hitPath(hit: string): string | undefined {
  return /^\S+ \[[^\]]+\] (.+?):\d+:/u.exec(hit)?.[1];
}

/**
 * The agents whose guidance states a claim the verifier found documented at `documentedAt`: the
 * agents loading the cited files, plus those loading another file with the same cited lines.
 */
export async function documentedFor(documentedAt: string, reader: EvidenceReader | undefined, context: GuidanceContext): Promise<readonly Agent[]> {
  const references = documentedReferences(documentedAt);
  if (references.length === 0) return everyAgent;
  const covered = new Set<Agent>();
  for (const reference of references) {
    const agents = loadingAgents(reference.path, context);
    if (agents === undefined) return everyAgent;
    for (const agent of agents) covered.add(agent);
    if (covered.size === everyAgent.length || reader === undefined) continue;
    for (const line of await citedLines(reference, reader)) {
      for (const hit of await reader.grep(line.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), { autoload: true })) {
        const path = hitPath(hit);
        if (path === undefined || path === reference.path) continue;
        for (const agent of loadingAgents(path, context) ?? everyAgent) covered.add(agent);
      }
    }
  }
  return everyAgent.filter((agent) => covered.has(agent));
}
