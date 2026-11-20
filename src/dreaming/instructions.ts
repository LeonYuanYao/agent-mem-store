import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import { MemStoreCommandError } from "../contracts/envelope.js";
import { openRuntimeDatabaseReadOnly } from "../runtime/database.js";
import { readCanonicalMemory } from "../vault/index.js";
import { hostImports } from "./imports.js";
import type { DreamModel, InstructionJudgment, ModelUsage } from "./model.js";

/**
 * Suggestions to write a Global rule into the user-wide instruction files (ADR-0181).
 * Injection recalls a Memory by its similarity to the prompt, so a rule that holds in
 * every session ("reply in Chinese", "never touch the proxy") is rarely recalled; a
 * user-wide instruction file (`host_instruction_files`, such as an agent's global
 * CLAUDE.md or AGENTS.md) is loaded by every session instead. A judge model decides which Global Memories are such rules and
 * whether each file already states them. MemStore only suggests; it never edits those files.
 */

const suggestionSchema = z.object({
  memoryId: z.string(), memoryRef: z.number().int(), revisionId: z.string(), statement: z.string(), reason: z.string(),
  files: z.array(z.object({ path: z.string(), mergeInto: z.string(), text: z.string() })),
  firstSuggestedAt: z.string()
});
/** One rule to write: its Memory, and per instruction file the existing entry to merge into ("" for none) and the text. */
export type InstructionSuggestion = z.infer<typeof suggestionSchema>;
const stateSchema = z.object({
  version: z.literal(1),
  inputKey: z.string().optional(),
  judgedAt: z.string().optional(),
  failedInputKey: z.string().optional(),
  failedAt: z.string().optional(),
  failure: z.string().optional(),
  suggestions: z.array(suggestionSchema),
  /** Memory id to when the user dismissed its suggestion; never suggested again. */
  dismissed: z.record(z.string(), z.string()),
  /** Memory id to when it was first suggested, so a re-judgment does not announce it again. */
  firstSeen: z.record(z.string(), z.string())
});
export type InstructionSuggestionState = z.infer<typeof stateSchema>;

const emptyState = (): InstructionSuggestionState => ({ version: 1, suggestions: [], dismissed: {}, firstSeen: {} });
const ruleCharacters = 800;
const fileCharacters = 40_000;
/** A failed judgment of the same inputs is retried the next night, not on every step. */
const failureRetryMilliseconds = 20 * 3_600_000;

export function instructionSuggestionsPath(runtimeRoot: string): string {
  return join(runtimeRoot, "state", "instruction-suggestions.json");
}

export async function readInstructionSuggestions(runtimeRoot: string): Promise<InstructionSuggestionState> {
  const text = await readFile(instructionSuggestionsPath(runtimeRoot), "utf8").catch(() => undefined);
  if (text === undefined) return emptyState();
  try {
    const parsed = stateSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : emptyState();
  } catch {
    return emptyState();
  }
}

async function writeInstructionSuggestions(runtimeRoot: string, state: InstructionSuggestionState): Promise<void> {
  const path = instructionSuggestionsPath(runtimeRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(`${path}.tmp`, `${JSON.stringify(state, null, 1)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

const expandHome = (path: string): string => path.replace(/^~(?=\/|$)/u, homedir());
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

interface GlobalRule { readonly memoryId: string; readonly memoryRef: number; readonly revisionId: string; readonly text: string }

/** Active Global Memories that are not private, with their compact statement. */
async function globalRules(runtimeRoot: string, vaultRoot: string): Promise<GlobalRule[]> {
  const database = await openRuntimeDatabaseReadOnly(runtimeRoot);
  let ids: string[];
  try {
    ids = database.prepare(
      "SELECT memory_id FROM memory_catalog WHERE lifecycle = 'active' AND scope_kind = 'global' AND sensitivity = 'normal' ORDER BY memory_ref"
    ).all().map((row) => String(row.memory_id));
  } finally {
    database.close();
  }
  const rules: GlobalRule[] = [];
  for (const memoryId of ids) {
    const loaded = await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId }).catch(() => undefined);
    if (loaded?.memory.memoryRef === undefined) continue;
    const text = (loaded.memory.representations.compact.text.trim() || loaded.memory.body.trim()).slice(0, ruleCharacters);
    if (text !== "") rules.push({ memoryId, memoryRef: loaded.memory.memoryRef, revisionId: loaded.memory.revisionId, text });
  }
  return rules;
}

export interface InstructionRefresh {
  readonly state: InstructionSuggestionState;
  /** "judged" after a model call, "current" when nothing changed since the last judgment. */
  readonly outcome: "judged" | "current" | "failed" | "waiting_after_failure" | "no_files";
  readonly usage?: ModelUsage;
}

/**
 * Judges the Global rules again when they or the instruction files changed since the
 * last judgment (or always with `force`). A failure is recorded, not thrown: it must
 * never hold up a dream run.
 */
export async function refreshInstructionSuggestions(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly files: readonly string[];
  readonly model: Pick<DreamModel, "judgeInstructions">;
  readonly now: string;
  readonly force?: boolean;
}): Promise<InstructionRefresh> {
  const state = await readInstructionSuggestions(request.runtimeRoot);
  const judge = request.model.judgeInstructions?.bind(request.model);
  if (request.files.length === 0 || judge === undefined) return { state, outcome: "no_files" };
  // A file's text includes what it imports with `@path`, which its agent loads with it (ADR-0185).
  const files = await Promise.all(request.files.map(async (path, index) => {
    const imported = await hostImports([expandHome(path)]);
    const parts = [await readFile(expandHome(path), "utf8").catch(() => ""),
      ...await Promise.all(imported.map(async (file) => `\n\n（以下内容由 @ 引用加载：${file}）\n${await readFile(file, "utf8").catch(() => "")}`))];
    return { id: `F${String(index + 1)}`, path, text: parts.join("").slice(0, fileCharacters) };
  }));
  const rules = (await globalRules(request.runtimeRoot, request.vaultRoot)).filter((rule) => state.dismissed[rule.memoryId] === undefined);
  const inputKey = sha256(JSON.stringify([
    rules.map((rule) => `${rule.memoryId}:${rule.revisionId}`),
    files.map((file) => `${file.path}:${sha256(file.text)}`)
  ]));
  if (request.force !== true) {
    if (state.inputKey === inputKey) return { state, outcome: "current" };
    if (state.failedInputKey === inputKey && state.failedAt !== undefined &&
        Date.parse(request.now) - Date.parse(state.failedAt) < failureRetryMilliseconds) {
      return { state, outcome: "waiting_after_failure" };
    }
  }
  let judged: { readonly results: readonly InstructionJudgment[]; readonly usage: ModelUsage } | undefined;
  if (rules.length > 0) {
    try {
      judged = await judge({
        rules: rules.map((rule, index) => ({ id: `G${String(index + 1)}`, text: rule.text })),
        files: files.map(({ id, path, text }) => ({ id, path, text }))
      });
    } catch (error) {
      const failed: InstructionSuggestionState = { ...state, failedInputKey: inputKey, failedAt: request.now,
        failure: error instanceof Error ? error.message.slice(0, 200) : "unknown" };
      await writeInstructionSuggestions(request.runtimeRoot, failed);
      return { state: failed, outcome: "failed" };
    }
  }
  const byAlias = new Map(rules.map((rule, index) => [`G${String(index + 1)}`, rule]));
  const fileById = new Map(files.map((file) => [file.id, file]));
  const firstSeen = { ...state.firstSeen };
  const suggestions: InstructionSuggestion[] = [];
  for (const result of judged?.results ?? []) {
    const rule = byAlias.get(result.id);
    if (rule === undefined || !result.applies_everywhere) continue;
    const missing = result.files.flatMap((entry) => {
      const file = fileById.get(entry.file);
      return file === undefined || entry.covered || entry.proposal.trim() === ""
        ? [] : [{ path: file.path, mergeInto: entry.merge_into.trim(), text: entry.proposal.trim() }];
    });
    if (missing.length === 0) continue;
    const first = firstSeen[rule.memoryId] ?? request.now;
    firstSeen[rule.memoryId] = first;
    suggestions.push({ memoryId: rule.memoryId, memoryRef: rule.memoryRef, revisionId: rule.revisionId, statement: rule.text,
      reason: result.reason, files: missing, firstSuggestedAt: first });
  }
  const next: InstructionSuggestionState = { version: 1, inputKey, judgedAt: request.now, suggestions, dismissed: state.dismissed, firstSeen };
  await writeInstructionSuggestions(request.runtimeRoot, next);
  return { state: next, outcome: "judged", ...(judged === undefined ? {} : { usage: judged.usage }) };
}

/** `memstore instructions dismiss M:<id>`: the Memory is never suggested again. */
export async function dismissInstructionSuggestion(request: {
  readonly runtimeRoot: string;
  readonly memoryRef: number;
  readonly now: string;
}): Promise<{ readonly memoryId: string; readonly dismissed: boolean }> {
  const state = await readInstructionSuggestions(request.runtimeRoot);
  const database = await openRuntimeDatabaseReadOnly(request.runtimeRoot);
  let memoryId: string | undefined;
  try {
    const row = database.prepare("SELECT memory_id FROM memory_catalog WHERE memory_ref = ?").get(request.memoryRef);
    memoryId = row === undefined ? undefined : String(row.memory_id);
  } finally {
    database.close();
  }
  if (memoryId === undefined) throw new MemStoreCommandError("memory_not_found", `No Memory M:${String(request.memoryRef)}.`);
  const dismissed = state.dismissed[memoryId] === undefined;
  await writeInstructionSuggestions(request.runtimeRoot, {
    ...state,
    dismissed: { ...state.dismissed, [memoryId]: state.dismissed[memoryId] ?? request.now },
    suggestions: state.suggestions.filter((suggestion) => suggestion.memoryId !== memoryId)
  });
  return { memoryId, dismissed };
}

const statementCharacters = 80;

/** Chat lines for suggestions, oldest first: the rule, then where each file would take it. */
export function instructionSuggestionLines(suggestions: readonly InstructionSuggestion[]): string[] {
  const lines: string[] = [];
  for (const suggestion of [...suggestions].sort((left, right) => left.firstSuggestedAt.localeCompare(right.firstSuggestedAt) || left.memoryRef - right.memoryRef)) {
    const statement = suggestion.statement.replace(/\s+/gu, " ");
    lines.push(`- M:${String(suggestion.memoryRef)} ${statement.length <= statementCharacters ? statement : `${statement.slice(0, statementCharacters)}…`}`);
    for (const file of suggestion.files) {
      lines.push(`  - 写进 \`${file.path}\`${file.mergeInto === "" ? "" : `（并入「${file.mergeInto}」）`}：${file.text}`);
    }
  }
  return lines;
}
