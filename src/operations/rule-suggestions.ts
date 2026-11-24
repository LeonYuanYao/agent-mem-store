import { stat } from "node:fs/promises";

import { MemStoreCommandError } from "../contracts/envelope.js";
import { temporaryRootPattern } from "../dreaming/repo-map.js";
import { findRuleSuggestion, listRuleSuggestions, ruleSuggestionLines, type RuleSuggestion } from "../dreaming/suggestions.js";
import { openRuntimeDatabase, openRuntimeDatabaseReadOnly } from "../runtime/database.js";
import { rememberAssert } from "./remember.js";

/**
 * `memstore rules` (ADR-0191): the user's own rules dreaming found, which the user accepts as
 * Human-authored Memory or dismisses. Accepting goes through `remember assert`, so the Memory is
 * the user's assertion with the text the user accepted (or rewrote with --text).
 */

export async function listRules(request: { readonly runtimeRoot: string; readonly includeClosed?: boolean }): Promise<{
  readonly suggestions: readonly RuleSuggestion[];
  readonly text: string;
}> {
  const database = await openRuntimeDatabaseReadOnly(request.runtimeRoot);
  try {
    const suggestions = listRuleSuggestions(database, { includeClosed: request.includeClosed === true });
    const open = suggestions.filter((suggestion) => suggestion.state === "open");
    const closed = suggestions.filter((suggestion) => suggestion.state !== "open");
    const text = suggestions.length === 0 ? "没有待确认的规则提议。"
      : [
          ...(open.length === 0 ? ["没有待确认的规则提议。"] : [`**待确认的规则提议 · ${String(open.length)}**（dreaming 从你的原话或纠正里看出来的；确认后写成你的手写记忆）`,
            ...ruleSuggestionLines(open, 400)]),
          ...(closed.length === 0 ? [] : ["", "**已处理**", ...closed.map((suggestion) =>
            `- \`${suggestion.id}\` ${suggestion.state === "accepted" ? "已记住" : "不要"}：${suggestion.text.slice(0, 80)}`)]),
          ...(open.length === 0 ? [] : ["", "要记住：`memstore rules accept <id>`（可加 `--text` 改写）；不要：`memstore rules dismiss <id>`"])
        ].join("\n");
    return { suggestions, text };
  } finally {
    database.close();
  }
}

async function liveRoot(roots: readonly string[]): Promise<string | undefined> {
  for (const root of roots.filter((candidate) => !temporaryRootPattern.test(candidate))) {
    if (await stat(root).then((entry) => entry.isDirectory(), () => false)) return root;
  }
  return undefined;
}

export async function acceptRule(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly id: string;
  readonly text?: string;
  readonly now: string;
  readonly preview: boolean;
}): Promise<Record<string, unknown>> {
  let suggestion: RuleSuggestion;
  let roots: string[];
  const database = await openRuntimeDatabaseReadOnly(request.runtimeRoot);
  try {
    suggestion = findRuleSuggestion(database, request.id);
    roots = database.prepare("SELECT canonical_root FROM project_roots WHERE project_id = ? ORDER BY last_used_at DESC")
      .all(suggestion.projectId).map((row) => String(row.canonical_root));
  } finally {
    database.close();
  }
  if (suggestion.state !== "open") {
    throw new MemStoreCommandError("suggestion_closed", `Suggestion ${suggestion.id} is already ${suggestion.state}.`);
  }
  const body = (request.text ?? suggestion.text).trim();
  if (body === "") throw new MemStoreCommandError("invalid_content_input", "The rule text is empty.");
  const root = suggestion.scope === "global" ? undefined : await liveRoot(roots);
  if (suggestion.scope === "project" && root === undefined) {
    throw new MemStoreCommandError("project_unresolved", `No existing root of ${suggestion.projectLabel} to file the rule under.`);
  }
  const result = await rememberAssert({
    runtimeRoot: request.runtimeRoot, vaultRoot: request.vaultRoot, path: root ?? process.cwd(), body,
    scope: suggestion.scope, startup: "auto", preview: request.preview, assertedAt: request.now
  }) as { readonly state?: string; readonly memoryId?: string; readonly memoryRef?: number };
  const suggestionFields = { suggestion: suggestion.id, text: body, scope: suggestion.scope,
    ...(suggestion.scope === "project" ? { project: suggestion.projectLabel } : {}) };
  if (request.preview) return { ...suggestionFields, remember: result };
  // Only a Memory that now holds the rule closes the suggestion; a conflict or a sensitive value leaves it open.
  if ((result.state === "created" || result.state === "unchanged") && typeof result.memoryId === "string") {
    const writable = await openRuntimeDatabase(request.runtimeRoot);
    try {
      writable.prepare("UPDATE dream_items SET apply_state = 'accepted', apply_memory_id = ?, apply_reason = ? WHERE item_id = ? AND apply_state IS NULL")
        .run(result.memoryId, request.text === undefined ? `accepted ${request.now}` : `accepted ${request.now}, rewritten by the user`, suggestion.itemId);
    } finally {
      writable.close();
    }
    return { ...suggestionFields, state: "accepted", memory_id: result.memoryId, remember: result };
  }
  return { ...suggestionFields, state: "open", remember: result };
}

export async function dismissRule(request: { readonly runtimeRoot: string; readonly id: string; readonly now: string }): Promise<Record<string, unknown>> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const suggestion = findRuleSuggestion(database, request.id);
    if (suggestion.state === "accepted") {
      throw new MemStoreCommandError("suggestion_closed", `Suggestion ${suggestion.id} was accepted; archive its Memory instead.`);
    }
    database.prepare("UPDATE dream_items SET apply_state = 'dismissed', apply_reason = ? WHERE item_id = ? AND apply_state IS NULL")
      .run(`dismissed ${request.now}`, suggestion.itemId);
    return { suggestion: suggestion.id, state: "dismissed", text: suggestion.text };
  } finally {
    database.close();
  }
}
