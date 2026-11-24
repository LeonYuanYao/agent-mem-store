import type { DatabaseSync } from "node:sqlite";

import { MemStoreCommandError } from "../contracts/envelope.js";
import { projectDisplay, suggestionId } from "./report.js";

/**
 * Rules of the user's own that dreaming found and the user decides on (ADR-0191): dream items in
 * the `suggest` tier. An open suggestion has no apply_state; accepting one writes a Human-authored
 * Memory and records it as 'accepted', dismissing records 'dismissed'. Nothing here calls a model.
 */

export { suggestionId };

export interface RuleSuggestion {
  /** Short handle shown to the user: the first eight hex digits of the item id. */
  readonly id: string;
  readonly itemId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly projectLabel: string;
  readonly scope: "project" | "global";
  readonly text: string;
  readonly detail: string;
  /** Why it would have been injected: the user's words (explicit_user), recurring, confirmed. */
  readonly reason: string;
  /** When the run that found it completed; the digest lists each suggestion once from then. */
  readonly suggestedAt: string;
  readonly state: "open" | "accepted" | "dismissed";
  readonly memoryId?: string;
}

/** Suggestions of completed runs, oldest first; only open ones unless `includeClosed`. */
export function listRuleSuggestions(database: DatabaseSync, options: {
  readonly includeClosed?: boolean;
  readonly since?: string;
  readonly until?: string;
} = {}): RuleSuggestion[] {
  const rows = database.prepare(
    `SELECT i.item_id, i.run_id, r.project_id, i.scope, COALESCE(i.refined_statement, i.statement) AS text, i.detail, i.tier_reason,
            r.completed_at, i.apply_state, i.apply_memory_id
     FROM dream_items i JOIN dream_runs r USING (run_id)
     WHERE i.tier = 'suggest' AND r.completed_at IS NOT NULL
       AND (? = 1 OR i.apply_state IS NULL)
       AND (? IS NULL OR r.completed_at >= ?) AND (? IS NULL OR r.completed_at <= ?)
     ORDER BY r.completed_at, i.item_id`
  ).all(options.includeClosed === true ? 1 : 0, options.since ?? null, options.since ?? null, options.until ?? null, options.until ?? null);
  const labels = new Map<string, string>();
  return rows.map((row) => {
    const projectId = String(row.project_id);
    if (!labels.has(projectId)) labels.set(projectId, projectDisplay(database, projectId).label);
    const state = row.apply_state === "accepted" ? "accepted" : row.apply_state === "dismissed" ? "dismissed" : "open";
    return {
      id: suggestionId(String(row.item_id)),
      itemId: String(row.item_id),
      runId: String(row.run_id),
      projectId,
      projectLabel: labels.get(projectId) ?? projectId,
      scope: row.scope === "global" ? "global" : "project",
      text: String(row.text),
      detail: typeof row.detail === "string" ? row.detail : "",
      reason: String(row.tier_reason ?? ""),
      suggestedAt: String(row.completed_at),
      state,
      ...(typeof row.apply_memory_id === "string" ? { memoryId: row.apply_memory_id } : {})
    };
  });
}

/** The one suggestion a short id (or a full item id) names. */
export function findRuleSuggestion(database: DatabaseSync, id: string): RuleSuggestion {
  const wanted = suggestionId(id.trim());
  if (!/^[0-9a-f]{4,8}$/u.test(wanted)) throw new MemStoreCommandError("suggestion_id_required", "Give the suggestion id shown by `memstore rules`.");
  const matches = listRuleSuggestions(database, { includeClosed: true }).filter((suggestion) => suggestion.id.startsWith(wanted));
  if (matches.length === 0) throw new MemStoreCommandError("suggestion_not_found", `No rule suggestion ${wanted}.`);
  if (matches.length > 1) throw new MemStoreCommandError("suggestion_ambiguous", `${String(matches.length)} suggestions start with ${wanted}; give more digits.`);
  const [match] = matches;
  if (match === undefined) throw new MemStoreCommandError("suggestion_not_found", `No rule suggestion ${wanted}.`);
  return match;
}

const scopeLabel = (suggestion: RuleSuggestion, multipleProjects: boolean): string =>
  suggestion.scope === "global" ? "〔全局〕" : multipleProjects ? `〔${suggestion.projectLabel.split("/").at(-1)?.replace(/\)$/u, "") ?? ""}〕` : "";

/** One line per suggestion: the handle, where it would apply, and the rule. */
export function ruleSuggestionLines(suggestions: readonly RuleSuggestion[], maximumCharacters = 160): string[] {
  const multipleProjects = new Set(suggestions.filter((suggestion) => suggestion.scope === "project").map((suggestion) => suggestion.projectId)).size > 1;
  return suggestions.map((suggestion) => {
    const text = suggestion.text.length <= maximumCharacters ? suggestion.text : `${suggestion.text.slice(0, maximumCharacters)}…`;
    return `- \`${suggestion.id}\` ${scopeLabel(suggestion, multipleProjects)}${text}`;
  });
}
