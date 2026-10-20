import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import { loadConfiguration } from "../configuration/index.js";
import type { MemoryCategory } from "../memories/categories.js";
import { dreamingPolicyVersion } from "../memories/origins.js";
import { assessExactCompact } from "../memories/representations.js";
import { readCanonicalMemory, SecretContentError, writeCanonicalMemory, type CanonicalMemory } from "../vault/index.js";
import type { DreamModel, ModelUsage, Reconciliation, Verdict } from "./model.js";

/**
 * Apply mode (ADR-0148): inject-tier items become agent-derived canonical Memory
 * with policy version `dreaming-v1`. Before writing, each item is compared with
 * the closest active Memory in its scope: the same statement seen again only
 * counts an observation, Human-authored Memory always wins (a duplicate is
 * skipped, a contradiction goes to review), and a newer verified statement
 * revises the dreaming Memory it corrects. Review-tier items that contradict a
 * dreaming Memory mark it review_due, which stops its injection.
 */

const generatorIdentity = "memstore:dreaming-v1";
const comparisonCandidates = 6;
const provenanceLimit = 24;
export const applyBatchSize = 8;

export type ApplyState = "pending" | "written" | "revised" | "observed" | "duplicate_human" | "conflict_human" | "review_due" | "skipped" | "failed";

export interface ApplyItem {
  readonly itemId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly tier: string;
  readonly text: string;
  readonly claimType: string;
  readonly scope: "project" | "global";
  readonly explicitUser: boolean;
  readonly sessionIds: readonly string[];
  readonly verdict: Partial<Verdict>;
}

export interface ApplyOutcome {
  readonly itemId: string;
  readonly state: Exclude<ApplyState, "pending">;
  readonly memoryId?: string;
  readonly reason: string;
}

interface ActiveMemory {
  readonly memoryId: string;
  readonly human: boolean;
  readonly text: string;
  readonly grams: ReadonlySet<string>;
  /** Set for a passage of a user-wide instruction file, which counts as Human-authored guidance. */
  readonly source?: string;
}

/** Passages of user-wide instruction files: paragraphs, with each list item on its own. */
async function instructionPassages(files: readonly string[]): Promise<ActiveMemory[]> {
  const passages: ActiveMemory[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const block of text.split(/\n\s*\n/u)) {
      const lines = block.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
      const items = lines.some((line) => /^[-*] /u.test(line)) ? lines.map((line) => line.replace(/^[-*] /u, "")) : [lines.join(" ")];
      for (const item of items) {
        if (item.length >= 8 && passages.length < 400) passages.push({ memoryId: "", human: true, text: item, grams: bigrams(item), source: file });
      }
    }
  }
  return passages;
}

/** Case-, space- and punctuation-insensitive form used to find the same statement again. */
export function statementKey(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(text: string): Set<string> {
  const key = statementKey(text);
  const grams = new Set<string>();
  for (let index = 0; index < key.length - 1; index += 1) grams.add(key.slice(index, index + 2));
  return grams;
}

function similarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function categoryFor(claimType: string): MemoryCategory {
  if (claimType === "preference" || claimType === "decision_requirement") return "preference_constraint";
  if (claimType === "workflow_process" || claimType === "machine_state") return "workflow_environment_toolchain";
  return "durable_reference";
}

/**
 * Global Memory needs global intent (ADR-0006): only the user's own lasting rule
 * is written globally. Other global items stay with the Project they came from.
 */
export function memoryScopeFor(item: ApplyItem): CanonicalMemory["scope"] {
  return item.scope === "global" && item.explicitUser && item.verdict.user_support === "user_stated_rule"
    ? { kind: "global" }
    : { kind: "project", projectId: item.projectId };
}

function representationsFor(text: string, revisionId: string): CanonicalMemory["representations"] {
  const compact = assessExactCompact({ body: text, conditions: [], exclusions: [], preservedNegations: [] });
  return {
    compact: { text: compact.text, validated: compact.validated, generatorIdentity, sourceRevisionId: revisionId, renderedTokenCount: compact.renderedTokenCount },
    standard: { text, validated: true, generatorIdentity, sourceRevisionId: revisionId, renderedTokenCount: compact.renderedTokenCount }
  };
}

function provenanceFor(item: ApplyItem): string[] {
  return [
    `dream:${item.runId}:${item.itemId}`,
    ...item.sessionIds.slice(0, 4).map((sessionId) => `session:${sessionId}`),
    ...(item.verdict.evidence ?? []).slice(0, 4).map((line) => `evidence:${line.replace(/\s+/gu, " ").slice(0, 200)}`)
  ];
}

function newMemory(item: ApplyItem, now: string): CanonicalMemory {
  const memoryId = `msmem_${randomUUID()}`;
  const revisionId = `msrev_${randomUUID()}`;
  const category = categoryFor(item.claimType);
  return {
    schemaVersion: 1,
    memoryId,
    revisionId,
    scope: memoryScopeFor(item),
    authority: "agent_derived",
    originKind: "model_extraction",
    sensitivity: "normal",
    lifecycle: "active",
    lifecycleDetails: {},
    primaryCategory: category,
    categoryTags: [category],
    importanceTags: [],
    startup: "auto",
    applicability: { summary: item.verdict.subsystem ?? "", conditions: [] },
    validity: { state: "valid" },
    createdAt: now,
    revisedAt: now,
    semanticContract: { schemaVersion: 1, claims: [item.text], conditions: [], exclusions: [], preservedNegations: [] },
    representations: representationsFor(item.text, revisionId),
    provenance: provenanceFor(item),
    injectionReceiptIds: [],
    relationships: [],
    contentIdentity: "0".repeat(64),
    policyVersion: dreamingPolicyVersion,
    body: item.text
  };
}

/** Active Human-authored and dreaming Memory an item of this Project could repeat or contradict. */
async function activeMemories(database: DatabaseSync, request: { readonly vaultRoot: string; readonly runtimeRoot: string; readonly projectId: string }): Promise<ActiveMemory[]> {
  const rows = database.prepare(
    `SELECT c.memory_id, c.authority FROM memory_catalog c
     WHERE c.lifecycle = 'active' AND (c.scope_kind = 'global' OR c.project_id = ?)
       AND (c.authority = 'human_authored' OR c.memory_id IN (SELECT memory_id FROM dream_memories))`
  ).all(request.projectId);
  const memories: ActiveMemory[] = [];
  for (const row of rows) {
    const read = await readCanonicalMemory({ vaultRoot: request.vaultRoot, runtimeRoot: request.runtimeRoot, memoryId: String(row.memory_id) });
    if (read === undefined) continue;
    const text = read.memory.semanticContract.claims.join(" ") || read.memory.body;
    memories.push({ memoryId: read.memory.memoryId, human: row.authority === "human_authored", text, grams: bigrams(text) });
  }
  return memories;
}

async function revise(request: {
  readonly vaultRoot: string; readonly runtimeRoot: string; readonly memoryId: string; readonly now: string;
  readonly change: (memory: CanonicalMemory, revisionId: string) => CanonicalMemory;
}): Promise<void> {
  const current = await readCanonicalMemory({ vaultRoot: request.vaultRoot, runtimeRoot: request.runtimeRoot, memoryId: request.memoryId });
  if (current === undefined) throw new Error("Dreaming Memory no longer exists.");
  const revisionId = `msrev_${randomUUID()}`;
  await writeCanonicalMemory({
    vaultRoot: request.vaultRoot, runtimeRoot: request.runtimeRoot, actor: "agent",
    memory: { ...request.change(current.memory, revisionId), revisionId, revisedAt: request.now, predecessorRevisionId: current.memory.revisionId },
    expectedContentIdentity: current.contentIdentity
  });
}

function withStatement(memory: CanonicalMemory, item: ApplyItem, revisionId: string): CanonicalMemory {
  return {
    ...memory,
    validity: { state: "valid" },
    applicability: { summary: item.verdict.subsystem ?? memory.applicability.summary, conditions: memory.applicability.conditions },
    semanticContract: { ...memory.semanticContract, claims: [item.text] },
    representations: representationsFor(item.text, revisionId),
    provenance: [...new Set([...provenanceFor(item), ...memory.provenance])].slice(0, provenanceLimit),
    body: item.text
  };
}

function recordDreamMemory(database: DatabaseSync, item: ApplyItem, memoryId: string, now: string, created: boolean): void {
  if (created) {
    const scope = memoryScopeFor(item);
    database.prepare(
      `INSERT INTO dream_memories(memory_id, statement_key, scope_kind, project_id, created_run_id, updated_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(memoryId, statementKey(item.text), scope.kind, scope.kind === "project" ? scope.projectId : null, item.runId, item.runId, now, now);
  } else {
    database.prepare("UPDATE dream_memories SET observation_count = observation_count + 1, updated_run_id = ?, updated_at = ? WHERE memory_id = ?")
      .run(item.runId, now, memoryId);
  }
}

/**
 * Decides and, unless previewing, applies one batch of items of one Project.
 * Returns the outcome of every item; the model is called only when some item
 * has a close existing Memory to compare with.
 */
export async function applyBatch(request: {
  readonly database: DatabaseSync;
  readonly vaultRoot: string;
  readonly runtimeRoot: string;
  readonly items: readonly ApplyItem[];
  readonly model: DreamModel;
  readonly now: string;
  readonly preview: boolean;
  readonly instructionFiles?: readonly string[];
}): Promise<{ readonly outcomes: ApplyOutcome[]; readonly usage?: ModelUsage }> {
  const { database } = request;
  if (!request.preview) await requireCurrentConfiguration(request);
  const projectId = request.items[0]?.projectId ?? "";
  const memories = [
    ...await activeMemories(database, { vaultRoot: request.vaultRoot, runtimeRoot: request.runtimeRoot, projectId }),
    ...await instructionPassages(request.instructionFiles ?? [])
  ];
  const byKey = new Map<string, { memoryId: string; active: boolean }>();
  for (const row of database.prepare(
    `SELECT d.memory_id, d.statement_key, c.lifecycle FROM dream_memories d LEFT JOIN memory_catalog c USING (memory_id)
     WHERE d.scope_kind = 'global' OR d.project_id = ?`
  ).all(projectId)) byKey.set(String(row.statement_key), { memoryId: String(row.memory_id), active: row.lifecycle === "active" });

  const outcomes = new Map<string, ApplyOutcome>();
  const toReconcile: ApplyItem[] = [];
  for (const item of request.items) {
    const known = byKey.get(statementKey(item.text));
    if (item.tier !== "inject") {
      // A review-tier item only matters when it contradicts a statement dreaming wrote.
      outcomes.set(item.itemId, known?.active === true
        ? { itemId: item.itemId, state: "review_due", memoryId: known.memoryId, reason: `verifier: ${item.verdict.verdict ?? "-"}` }
        : { itemId: item.itemId, state: "skipped", reason: "no_dreaming_memory_to_review" });
    } else if (known !== undefined) {
      outcomes.set(item.itemId, known.active
        ? { itemId: item.itemId, state: "observed", memoryId: known.memoryId, reason: "same_statement" }
        : { itemId: item.itemId, state: "skipped", memoryId: known.memoryId, reason: "rolled_back_or_archived" });
    } else {
      toReconcile.push(item);
    }
  }

  // Compare the rest with the closest active Memory and with earlier items of the batch.
  const aliases = new Map<string, ActiveMemory>();
  const itemAliases = new Map<string, ApplyItem>(toReconcile.map((item, index) => [`N${String(index + 1)}`, item]));
  const itemGrams = toReconcile.map((item) => bigrams(item.text));
  const prompts = toReconcile.map((item, index) => {
    const grams = itemGrams[index] ?? new Set<string>();
    const existing = memories.map((memory) => ({ memory, score: similarity(grams, memory.grams) }))
      .filter((entry) => entry.score >= 0.08).sort((left, right) => right.score - left.score).slice(0, comparisonCandidates)
      .map(({ memory }) => {
        let alias = [...aliases].find(([, value]) => value === memory)?.[0];
        if (alias === undefined) {
          alias = `${memory.human ? "H" : "D"}${String(aliases.size + 1)}`;
          aliases.set(alias, memory);
        }
        return { id: alias, text: memory.text };
      });
    // Earlier items of the batch may state the same thing.
    const earlier = toReconcile.slice(0, index).flatMap((other, position) =>
      similarity(grams, itemGrams[position] ?? new Set<string>()) >= 0.08 ? [{ id: `N${String(position + 1)}`, text: other.text }] : []);
    return { id: `N${String(index + 1)}`, text: item.text, candidates: [...existing, ...earlier] };
  });
  let usage: ModelUsage | undefined;
  let decisions = new Map<string, Reconciliation>();
  if (prompts.some((prompt) => prompt.candidates.length > 0)) {
    const reconciled = await request.model.reconcile({ items: prompts });
    usage = reconciled.usage;
    decisions = new Map(reconciled.results.map((result) => [result.id, result]));
  }

  const written = new Map<string, string>();
  for (const [alias, item] of itemAliases) {
    const decision = decisions.get(alias) ?? { id: alias, decision: "new" as const, target: "", reason: "no_close_memory" };
    const targetMemory = aliases.get(decision.target);
    const targetItemMemory = written.get(decision.target);
    const targetId = targetMemory === undefined ? targetItemMemory : targetMemory.memoryId;
    const humanTarget = targetMemory?.human === true;
    let outcome: ApplyOutcome;
    if (decision.decision !== "new" && targetMemory?.source !== undefined) {
      // Guidance every session already loads; nothing to write, and the user owns it.
      outcome = {
        itemId: item.itemId, state: decision.decision === "conflicts" ? "conflict_human" : "duplicate_human",
        reason: `${decision.reason}（${targetMemory.source}）`
      };
    } else if (decision.decision === "new" || targetId === undefined) {
      outcome = { itemId: item.itemId, state: "written", reason: decision.reason };
    } else if (humanTarget) {
      // Human-authored Memory is never revised by dreaming.
      outcome = decision.decision === "conflicts"
        ? { itemId: item.itemId, state: "conflict_human", memoryId: targetId, reason: decision.reason }
        : { itemId: item.itemId, state: "duplicate_human", memoryId: targetId, reason: decision.reason };
    } else if (decision.decision === "duplicate") {
      outcome = { itemId: item.itemId, state: "observed", memoryId: targetId, reason: decision.reason };
    } else {
      outcome = { itemId: item.itemId, state: "revised", memoryId: targetId, reason: decision.reason };
    }
    if (!request.preview && outcome.state === "written") {
      const memory = newMemory(item, request.now);
      try {
        await writeCanonicalMemory({ vaultRoot: request.vaultRoot, runtimeRoot: request.runtimeRoot, actor: "agent", memory });
        recordDreamMemory(database, item, memory.memoryId, request.now, true);
        outcome = { ...outcome, memoryId: memory.memoryId };
      } catch (error) {
        // Sensitivity checks reject secrets and uncertain sensitive content; such an item is never written.
        const sensitive = error instanceof SecretContentError || /sensitive content/iu.test(String(error));
        outcome = { itemId: item.itemId, state: sensitive ? "skipped" : "failed", reason: sensitive ? "sensitive_content" : errorReason(error) };
      }
    }
    if (outcome.memoryId !== undefined) written.set(alias, outcome.memoryId);
    outcomes.set(item.itemId, outcome);
  }

  if (!request.preview) {
    for (const item of request.items) {
      let outcome = outcomes.get(item.itemId);
      if (outcome === undefined || outcome.memoryId === undefined) continue;
      const memoryId = outcome.memoryId;
      try {
        if (outcome.state === "revised") {
          await revise({ ...request, memoryId, change: (memory, revisionId) => withStatement(memory, item, revisionId) });
          recordDreamMemory(database, item, memoryId, request.now, false);
          database.prepare("UPDATE dream_memories SET statement_key = ? WHERE memory_id = ?").run(statementKey(item.text), memoryId);
        } else if (outcome.state === "observed") {
          recordDreamMemory(database, item, memoryId, request.now, false);
        } else if (outcome.state === "review_due") {
          await revise({ ...request, memoryId, change: (memory) => ({
            ...memory, validity: { state: "review_due" },
            provenance: [`dream-review:${item.runId}:${item.itemId}`, ...memory.provenance].slice(0, provenanceLimit)
          }) });
        }
      } catch (error) {
        outcome = { itemId: item.itemId, state: "failed", memoryId, reason: errorReason(error) };
        outcomes.set(item.itemId, outcome);
      }
    }
    for (const outcome of outcomes.values()) {
      database.prepare("UPDATE dream_items SET apply_state = ?, apply_memory_id = ?, apply_reason = ? WHERE item_id = ?")
        .run(outcome.state, outcome.memoryId ?? null, outcome.reason.slice(0, 300), outcome.itemId);
    }
  }
  return { outcomes: request.items.map((item) => outcomes.get(item.itemId) ?? { itemId: item.itemId, state: "failed", reason: "no_outcome" }), ...(usage === undefined ? {} : { usage }) };
}

/**
 * Canonical writes refuse while the configuration runs on its last-known-good copy
 * (for example right after an edit the running code cannot read yet). That is not
 * the items' fault: stop before writing anything, so they stay pending and the run
 * retries after its backoff.
 */
export class ApplyDeferredError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ApplyDeferredError";
  }
}

async function requireCurrentConfiguration(paths: { readonly vaultRoot: string; readonly runtimeRoot: string }): Promise<void> {
  let current: boolean;
  try {
    const configuration = await loadConfiguration(paths);
    current = configuration.mode === "read_write" && configuration.recovery === undefined;
  } catch (error) {
    // Like active admission, a missing configuration document means no policy to honour; but a
    // missing last-known-good copy means the current document is invalid and has no fallback.
    const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    const path = typeof error === "object" && error !== null && "path" in error ? String(error.path) : "";
    current = missing && !path.includes("config-last-known-good");
  }
  if (!current) throw new ApplyDeferredError("Configuration is not current (invalid, unreadable or on its last-known-good copy); apply waits.");
}

function errorReason(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unknown_error";
}

/** Items of the given runs that apply should consider: inject items, and review items of a statement dreaming wrote. */
export function loadApplyItems(database: DatabaseSync, where: string, ...parameters: (string | null)[]): ApplyItem[] {
  return database.prepare(
    `SELECT i.item_id, i.run_id, r.project_id, i.tier, COALESCE(i.refined_statement, i.statement) AS text, i.claim_type, i.scope,
            i.explicit_user, i.session_ids_json, i.verdict_json, i.defense_json
     FROM dream_items i JOIN dream_runs r USING (run_id)
     WHERE ${where} ORDER BY r.created_at, i.item_id`
  ).all(...parameters).map((row) => {
    let verdict: Partial<Verdict> = {};
    try { verdict = JSON.parse(String(row.verdict_json ?? "{}")) as Partial<Verdict>; } catch { /* keep empty */ }
    let sessions: string[] = [];
    try { sessions = JSON.parse(String(row.session_ids_json ?? "[]")) as string[]; } catch { /* keep empty */ }
    return {
      itemId: String(row.item_id), runId: String(row.run_id), projectId: String(row.project_id), tier: String(row.tier),
      text: String(row.text), claimType: String(row.claim_type), scope: row.scope === "global" ? "global" : "project",
      explicitUser: row.explicit_user === 1, sessionIds: sessions, verdict
    };
  });
}
