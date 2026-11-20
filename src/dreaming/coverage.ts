import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { EvidenceReader } from "./msverify.js";

/**
 * Whether guidance that states a claim reaches every agent working in the Project (ADR-0187).
 *
 * Dreaming drops a claim the verifier finds in guidance agents already load (`documented_at`), but
 * Memory is injected into Claude Code and Codex alike while their guidance differs: Claude Code
 * loads CLAUDE.md files and what they import, Codex loads AGENTS.md files, and each has its own
 * skills. A claim stated only in one agent's guidance is dropped only if no other agent works in
 * the Project, or that agent's guidance states the same passage too.
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
  /** Skill names installed for each agent on this machine. */
  readonly skills: Readonly<Record<Agent, ReadonlySet<string>>>;
}

function hostRootAgent(root: string): Agent | undefined {
  if (/\/\.claude(\/|$)/u.test(root)) return "claude";
  if (/\/\.(codex|agents)(\/|$)/u.test(root)) return "codex";
  return undefined;
}

export async function guidanceContext(reader: EvidenceReader | undefined, hostRoots: readonly string[]): Promise<GuidanceContext> {
  const skills: Record<Agent, Set<string>> = { claude: new Set(), codex: new Set() };
  for (const root of hostRoots) {
    const agent = hostRootAgent(root);
    if (agent === undefined || root.endsWith(".md")) continue;
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) skills[agent].add(entry.name);
  }
  return { claudeImports: reader === undefined ? new Set() : await reader.claudeImports(), skills };
}

/** Which agents load a guidance file; undefined when that cannot be told, which counts as every agent. */
export function loadingAgents(path: string, context: GuidanceContext): readonly Agent[] | undefined {
  const name = basename(path);
  if (name === "CLAUDE.md" || name === "CLAUDE.local.md" || context.claudeImports.has(path)) return ["claude"];
  if (name === "AGENTS.md" || name === "AGENTS.override.md") return ["codex"];
  const skill = /(?:^|\/)skills\/([^/]+)\//u.exec(path)?.[1];
  if (skill !== undefined) {
    const agents = everyAgent.filter((agent) => context.skills[agent].has(skill) ||
      (agent === "claude" ? /(?:^|\/)\.claude\/skills\//u : /(?:^|\/)\.(?:agents|codex)\/skills\//u).test(path));
    return agents.length > 0 ? agents : undefined;
  }
  // Files under each agent's home directory, as the verifier names them.
  if (/^~\/\.claude\//u.test(path)) return ["claude"];
  if (/^~\/\.codex\//u.test(path)) return ["codex"];
  return undefined;
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
