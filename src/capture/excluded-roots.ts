import { createHash } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import { userPromptText } from "../contracts/prompt-text.js";

/**
 * Sessions started at or under `[adapters].excluded_roots` stay out of MemStore
 * (ADR-0173): their hooks capture nothing and inject nothing, so nothing from them
 * is distilled either. A prompt that starts with `ms：` or `ms:` turns MemStore on for
 * the rest of that Session. Hooks run as separate processes, so the opt-in is a
 * marker file per Session; it survives a resumed Session.
 */

const optInPrefix = /^\s*ms\s*[：:]/iu;

/** Whether the user's own text starts with the opt-in prefix. */
export function isOptInPrompt(prompt: string): boolean {
  return optInPrefix.test(userPromptText(prompt));
}

function markerPath(runtimeRoot: string, sessionId: string): string {
  return join(runtimeRoot, "state", "session-opt-ins", createHash("sha256").update(sessionId).digest("hex"));
}

/** The path through symlinks; a missing tail keeps its names below the nearest existing ancestor. */
async function canonical(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(await canonical(parent), basename(absolute));
  }
}

/**
 * One configured entry: a directory and everything below it, or, with a trailing
 * `*`, every directory beside it whose name starts with the rest (and everything
 * below those). `~` expands; the directory part is resolved through symlinks.
 */
async function entryMatcher(entry: string): Promise<(path: string) => boolean> {
  const expanded = entry.replace(/^~(?=\/|$)/u, homedir());
  if (expanded.endsWith("*")) {
    const prefix = join(await canonical(dirname(expanded)), basename(expanded).slice(0, -1));
    return (path) => path.startsWith(prefix);
  }
  const root = await canonical(expanded);
  const below = root.endsWith(sep) ? root : `${root}${sep}`;
  return (path) => path === root || path.startsWith(below);
}

export async function underExcludedRoot(path: string, entries: readonly string[]): Promise<boolean> {
  if (entries.length === 0) return false;
  const [target, matchers] = await Promise.all([canonical(path), Promise.all(entries.map(entryMatcher))]);
  return matchers.some((matches) => matches(target));
}

/**
 * How a hook event is served: normally, left out because its Session runs under an
 * excluded root, or normally from now on because this prompt opts the Session in.
 */
export async function excludedRootDecision(request: {
  readonly runtimeRoot: string;
  readonly sessionId: string;
  readonly path: string;
  readonly eventKind: string;
  readonly prompt?: string;
  readonly entries: readonly string[];
}): Promise<"served" | "excluded" | "opted_in"> {
  if (!await underExcludedRoot(request.path, request.entries)) return "served";
  const marker = markerPath(request.runtimeRoot, request.sessionId);
  if (await stat(marker).then(() => true, () => false)) return "served";
  if (request.eventKind !== "UserPromptSubmit" || !isOptInPrompt(request.prompt ?? "")) return "excluded";
  await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
  await writeFile(marker, "", { mode: 0o600 });
  return "opted_in";
}

/** The line shown when a prompt turns MemStore on for a Session under an excluded root. */
export const optInNotice = "MemStore：本会话已开启（此目录默认不采集、不注入）";
