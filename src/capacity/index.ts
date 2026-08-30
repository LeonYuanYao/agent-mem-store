import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import {
  loadConfiguration,
  type LoadedConfiguration
} from "../configuration/index.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import { inspectStandaloneCanonicalFile } from "../vault/index.js";

export type MemoryCapacityPolicy = LoadedConfiguration["policy"]["memoryCapacity"];

export const defaultMemoryCapacityPolicy: MemoryCapacityPolicy = {
  project: { target: 2_500, hardLimit: 3_500, lowWater: 2_200 },
  global: { target: 300, hardLimit: 500, lowWater: 270 },
  coldDays: 7,
  governanceBatchSize: 50
};

export const capacityGovernanceRetryDelayMilliseconds = 6 * 60 * 60 * 1_000;
const capacityRetryBaseDelayMilliseconds = 5 * 60 * 1_000;

export type MemoryWorkingSetScope =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "global" };

export interface MemoryWorkingSetPreview {
  readonly scope: MemoryWorkingSetScope;
  readonly durableActiveAgentCount: number;
  readonly rankedActiveAgentCount: number;
  readonly excludedCount: number;
  readonly mandatoryCount: number;
  readonly hardProtectedCount: number;
  readonly lowWaterUnreachable: boolean;
  readonly rankedMemoryIds: readonly string[];
  readonly excludedMemoryIds: readonly string[];
}

interface WorkingSetCatalogRow {
  readonly memory_id: string;
  readonly current_revision_id: string;
  readonly canonical_path: string;
  readonly revised_at: string;
}

interface WorkingSetCandidateRow {
  readonly memory_id: string;
  readonly pinned: number;
  readonly high_value: number;
  readonly evidence_count: number;
}

interface WorkingSetDatabaseInputs {
  readonly catalogRows: readonly WorkingSetCatalogRow[];
  readonly selectedRows: readonly Record<string, unknown>[];
  readonly candidateRows: readonly WorkingSetCandidateRow[];
  readonly relationshipRows: readonly Record<string, unknown>[];
  readonly reviewRows: readonly Record<string, unknown>[];
  readonly priorityRows: readonly Record<string, unknown>[];
  readonly conflictRows: readonly Record<string, unknown>[];
  readonly token: string;
}

export interface WorkingSetMemory {
  readonly memoryId: string;
  readonly revisionId: string;
  readonly lastActivityAt: string;
  readonly hardProtected: boolean;
  readonly softScore: number;
}

function workingSetSpaceKey(scope: MemoryWorkingSetScope): string {
  return scope.kind === "global" ? "global" : `project:${scope.projectId}`;
}

export function selectMemoryWorkingSet(request: {
  readonly memories: readonly WorkingSetMemory[];
  readonly limits: MemoryCapacityPolicy["project"];
  readonly coldDays: number;
  readonly observedAt: string;
}): {
  readonly ranked: readonly WorkingSetMemory[];
  readonly excluded: readonly WorkingSetMemory[];
  readonly mandatoryCount: number;
  readonly hardProtectedCount: number;
  readonly lowWaterUnreachable: boolean;
} {
  const coldSince = Date.parse(request.observedAt) - request.coldDays * 24 * 60 * 60 * 1_000;
  if (request.memories.length <= request.limits.target) {
    const mandatory = request.memories.filter((memory) =>
      memory.hardProtected || Date.parse(memory.lastActivityAt) >= coldSince
    );
    return {
      ranked: [...request.memories].sort((left, right) => left.memoryId.localeCompare(right.memoryId)),
      excluded: [],
      mandatoryCount: mandatory.length,
      hardProtectedCount: request.memories.filter((memory) => memory.hardProtected).length,
      lowWaterUnreachable: false
    };
  }
  const mandatory = request.memories.filter((memory) =>
    memory.hardProtected || Date.parse(memory.lastActivityAt) >= coldSince
  );
  const optional = request.memories.filter((memory) =>
    !memory.hardProtected && Date.parse(memory.lastActivityAt) < coldSince
  ).sort((left, right) =>
    right.lastActivityAt.localeCompare(left.lastActivityAt) ||
    right.softScore - left.softScore ||
    left.memoryId.localeCompare(right.memoryId)
  );
  const targetCount = Math.max(request.limits.lowWater, mandatory.length);
  const ranked = [
    ...mandatory,
    ...optional.slice(0, Math.max(0, targetCount - mandatory.length))
  ].sort((left, right) =>
    right.lastActivityAt.localeCompare(left.lastActivityAt) ||
    right.softScore - left.softScore ||
    left.memoryId.localeCompare(right.memoryId)
  );
  const rankedIds = new Set(ranked.map((memory) => memory.memoryId));
  return {
    ranked,
    excluded: request.memories.filter((memory) => !rankedIds.has(memory.memoryId)),
    mandatoryCount: mandatory.length,
    hardProtectedCount: mandatory.filter((memory) => memory.hardProtected).length,
    lowWaterUnreachable: mandatory.length > request.limits.lowWater
  };
}

function loadWorkingSetDatabaseInputs(
  database: DatabaseSync,
  scope: MemoryWorkingSetScope
): WorkingSetDatabaseInputs {
  const scopeParameters = [
    scope.kind,
    scope.kind,
    scope.kind === "project" ? scope.projectId : null
  ] as const;
  const catalogRows = database.prepare(
      `SELECT memory_id, current_revision_id, canonical_path, revised_at
       FROM memory_catalog
       WHERE lifecycle = 'active' AND authority = 'agent_derived'
         AND scope_kind = ? AND (? = 'global' OR project_id = ?)
       ORDER BY memory_id`
    ).all(...scopeParameters) as unknown as readonly WorkingSetCatalogRow[];
  const selectedRows = database.prepare(
      `SELECT catalog.memory_id, MAX(receipt.created_at) AS selected_at
       FROM retrieval_receipt_items AS item
       JOIN memory_catalog AS catalog ON catalog.memory_id = item.memory_id
       JOIN retrieval_receipts AS receipt ON receipt.receipt_id = item.receipt_id
       WHERE item.outcome = 'selected'
         AND catalog.lifecycle = 'active' AND catalog.authority = 'agent_derived'
         AND catalog.scope_kind = ? AND (? = 'global' OR catalog.project_id = ?)
       GROUP BY catalog.memory_id
       ORDER BY catalog.memory_id`
    ).all(...scopeParameters);
  const candidateRows = database.prepare(
      `SELECT candidate.promoted_memory_id AS memory_id,
              MAX(candidate.pinned) AS pinned,
              MAX(candidate.high_value) AS high_value,
              COUNT(DISTINCT evidence.evidence_id) AS evidence_count
       FROM memory_candidates AS candidate
       JOIN memory_catalog AS catalog ON catalog.memory_id = candidate.promoted_memory_id
       LEFT JOIN candidate_evidence AS evidence ON evidence.candidate_id = candidate.candidate_id
       WHERE candidate.promoted_memory_id IS NOT NULL
         AND catalog.lifecycle = 'active' AND catalog.authority = 'agent_derived'
         AND catalog.scope_kind = ? AND (? = 'global' OR catalog.project_id = ?)
       GROUP BY candidate.promoted_memory_id
       ORDER BY candidate.promoted_memory_id`
    ).all(...scopeParameters) as unknown as readonly WorkingSetCandidateRow[];
  const relationshipRows = database.prepare(
      `WITH related(memory_id) AS (
         SELECT source_memory_id FROM memory_relationships
         UNION ALL
         SELECT target_memory_id FROM memory_relationships
       )
       SELECT related.memory_id, COUNT(*) AS relationship_count
       FROM related
       JOIN memory_catalog AS catalog ON catalog.memory_id = related.memory_id
       WHERE catalog.lifecycle = 'active' AND catalog.authority = 'agent_derived'
         AND catalog.scope_kind = ? AND (? = 'global' OR catalog.project_id = ?)
       GROUP BY related.memory_id
       ORDER BY related.memory_id`
    ).all(...scopeParameters);
  const reviewRows = database.prepare(
      `SELECT suggestion.target_memory_id AS memory_id
       FROM governance_review_suggestions AS suggestion
       JOIN memory_catalog AS catalog ON catalog.memory_id = suggestion.target_memory_id
       WHERE suggestion.state = 'open'
         AND catalog.lifecycle = 'active' AND catalog.authority = 'agent_derived'
         AND catalog.scope_kind = ? AND (? = 'global' OR catalog.project_id = ?)
       UNION
       SELECT candidate.promoted_memory_id AS memory_id
       FROM verification_requests AS verification
       JOIN memory_candidates AS candidate ON candidate.candidate_id = verification.candidate_id
       JOIN memory_catalog AS catalog ON catalog.memory_id = candidate.promoted_memory_id
       WHERE verification.state = 'open' AND candidate.promoted_memory_id IS NOT NULL
         AND catalog.lifecycle = 'active' AND catalog.authority = 'agent_derived'
         AND catalog.scope_kind = ? AND (? = 'global' OR catalog.project_id = ?)
       ORDER BY memory_id`
    ).all(...scopeParameters, ...scopeParameters);
  const priorityRows = database.prepare(
      `SELECT document.memory_id, document.base_priority_tier
       FROM active_retrieval_index AS active
       JOIN retrieval_documents AS document ON document.index_revision_id = active.index_revision_id
       JOIN memory_catalog AS catalog ON catalog.memory_id = document.memory_id
       WHERE active.singleton = 1
         AND catalog.lifecycle = 'active' AND catalog.authority = 'agent_derived'
         AND catalog.scope_kind = ? AND (? = 'global' OR catalog.project_id = ?)
       ORDER BY document.memory_id`
    ).all(...scopeParameters);
  const conflictRows = database.prepare(
      `SELECT conflict_id, proposed_memory_id, conflicting_memory_ids_json
       FROM human_memory_conflicts
       WHERE state = 'open'
         AND scope_kind = ? AND (? = 'global' OR project_id = ?)
       ORDER BY conflict_id`
    ).all(...scopeParameters);
  const token = createHash("sha256").update(JSON.stringify({
    catalogRows,
    selectedRows,
    candidateRows,
    relationshipRows,
    reviewRows,
    priorityRows,
    conflictRows
  })).digest("hex");
  return {
    catalogRows,
    selectedRows,
    candidateRows,
    relationshipRows,
    reviewRows,
    priorityRows,
    conflictRows,
    token
  };
}

async function loadWorkingSetMemories(request: {
  readonly runtimeRoot: string;
  readonly scope: MemoryWorkingSetScope;
}): Promise<{ readonly memories: readonly WorkingSetMemory[]; readonly inputToken: string }> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let inputs: WorkingSetDatabaseInputs;
  try {
    inputs = loadWorkingSetDatabaseInputs(database, request.scope);
  } finally {
    database.close();
  }
  const {
    catalogRows,
    selectedRows,
    candidateRows,
    relationshipRows,
    reviewRows,
    priorityRows,
    conflictRows
  } = inputs;
  const selectedAt = new Map(selectedRows.flatMap((row) =>
    typeof row.memory_id === "string" && typeof row.selected_at === "string"
      ? [[row.memory_id, row.selected_at] as const]
      : []
  ));
  const candidates = new Map(candidateRows.map((row) => [row.memory_id, row] as const));
  const relationshipCounts = new Map(relationshipRows.flatMap((row) =>
    typeof row.memory_id === "string" && typeof row.relationship_count === "number"
      ? [[row.memory_id, row.relationship_count] as const]
      : []
  ));
  const openReviewIds = new Set(reviewRows.flatMap((row) =>
    typeof row.memory_id === "string" ? [row.memory_id] : []
  ));
  for (const row of conflictRows) {
    if (typeof row.proposed_memory_id === "string") openReviewIds.add(row.proposed_memory_id);
    if (typeof row.conflicting_memory_ids_json === "string") {
      try {
        const parsed = z.array(z.string()).safeParse(JSON.parse(row.conflicting_memory_ids_json));
        if (parsed.success) for (const memoryId of parsed.data) openReviewIds.add(memoryId);
      } catch {
        // The proposed identity remains protected even if legacy conflict metadata is malformed.
      }
    }
  }
  const priorityByMemoryId = new Map(priorityRows.flatMap((row) =>
    typeof row.memory_id === "string" && typeof row.base_priority_tier === "string"
      ? [[row.memory_id, row.base_priority_tier] as const]
      : []
  ));
  const controlledRiskCategories = new Set([
    "safety_data_integrity",
    "failure_recovery_hazard",
    "preference_constraint"
  ]);
  const result: WorkingSetMemory[] = [];
  for (const row of catalogRows) {
    const inspected = await inspectStandaloneCanonicalFile(row.canonical_path);
    const memory = inspected.memory;
    const candidate = candidates.get(row.memory_id);
    const hardProtected = memory.lifecycleDetails.pinned === true ||
      memory.lifecycleDetails.retainForever === true ||
      memory.startup === "always" ||
      candidate?.pinned === 1 ||
      openReviewIds.has(row.memory_id) ||
      controlledRiskCategories.has(memory.primaryCategory);
    const basePriorityTier = priorityByMemoryId.get(row.memory_id);
    const priority = basePriorityTier === "critical"
      ? 3
      : basePriorityTier === "strong" ? 2 : 1;
    const softScore = priority * 100 + Number(candidate?.high_value === 1) * 20 +
      Math.min(candidate?.evidence_count ?? 0, 5) * 3 +
      Math.min(relationshipCounts.get(row.memory_id) ?? 0, 5) * 2 +
      Math.min(memory.importanceTags.length, 5);
    const latestSelectedAt = selectedAt.get(row.memory_id);
    result.push({
      memoryId: row.memory_id,
      revisionId: row.current_revision_id,
      lastActivityAt: latestSelectedAt !== undefined && latestSelectedAt > row.revised_at
        ? latestSelectedAt
        : row.revised_at,
      hardProtected,
      softScore
    });
  }
  return { memories: result, inputToken: inputs.token };
}

export async function previewMemoryWorkingSet(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly policy: MemoryCapacityPolicy;
  readonly scope: MemoryWorkingSetScope;
  readonly observedAt: string;
}): Promise<MemoryWorkingSetPreview> {
  return (await calculateMemoryWorkingSet(request)).preview;
}

async function calculateMemoryWorkingSet(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly policy: MemoryCapacityPolicy;
  readonly scope: MemoryWorkingSetScope;
  readonly observedAt: string;
}): Promise<{
  readonly preview: MemoryWorkingSetPreview;
  readonly revisions: ReadonlyMap<string, string>;
  readonly inputToken: string;
}> {
  z.iso.datetime().parse(request.observedAt);
  const loaded = await loadWorkingSetMemories(request);
  const memories = loaded.memories;
  const limits = capacityLimitsForScope(request.policy, request.scope);
  const selected = selectMemoryWorkingSet({
    memories,
    limits,
    coldDays: request.policy.coldDays,
    observedAt: request.observedAt
  });
  return {
    preview: {
      scope: request.scope,
      durableActiveAgentCount: memories.length,
      rankedActiveAgentCount: selected.ranked.length,
      excludedCount: selected.excluded.length,
      mandatoryCount: selected.mandatoryCount,
      hardProtectedCount: selected.hardProtectedCount,
      lowWaterUnreachable: selected.lowWaterUnreachable,
      rankedMemoryIds: selected.ranked.map((memory) => memory.memoryId),
      excludedMemoryIds: selected.excluded.map((memory) => memory.memoryId)
    },
    revisions: new Map(memories.map((memory) => [memory.memoryId, memory.revisionId] as const)),
    inputToken: loaded.inputToken
  };
}

export async function rebalanceMemoryWorkingSet(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly policy: MemoryCapacityPolicy;
  readonly scope: MemoryWorkingSetScope;
  readonly observedAt: string;
}): Promise<MemoryWorkingSetPreview & { readonly changed: boolean }> {
  const calculation = await calculateMemoryWorkingSet(request);
  const { preview, revisions, inputToken } = calculation;
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let changed = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    const key = workingSetSpaceKey(request.scope);
    if (loadWorkingSetDatabaseInputs(database, request.scope).token !== inputToken) {
      throw new Error("Working-set inputs changed during reconciliation.");
    }
    const existing = database.prepare(
      "SELECT memory_id, revision_id FROM memory_ranking_exclusions WHERE space_key = ? ORDER BY memory_id"
    ).all(key);
    const existingKeys = existing.map((row) => `${String(row.memory_id)}:${String(row.revision_id)}`);
    const desiredKeys = preview.excludedMemoryIds.map((memoryId) =>
      `${memoryId}:${revisions.get(memoryId) ?? "missing"}`
    ).sort();
    changed = JSON.stringify(existingKeys) !== JSON.stringify(desiredKeys);
    if (changed) {
      database.prepare("DELETE FROM memory_ranking_exclusions WHERE space_key = ?").run(key);
      const insert = database.prepare(
        `INSERT INTO memory_ranking_exclusions(
           memory_id, revision_id, space_key, reason, excluded_at, evaluated_at
         ) VALUES (?, ?, ?, 'capacity_cold', ?, ?)`
      );
      for (const memoryId of preview.excludedMemoryIds) {
        const revisionId = revisions.get(memoryId);
        if (revisionId === undefined) throw new Error("Working-set revision is missing.");
        insert.run(memoryId, revisionId, key, request.observedAt, request.observedAt);
      }
      database.prepare(
        `UPDATE memory_working_set_generations
         SET dirty_generation = dirty_generation + 1, dirty_at = ?,
             last_rebalanced_at = ?, last_error = NULL
         WHERE singleton = 1`
      ).run(request.observedAt, request.observedAt);
    } else {
      database.prepare(
        `UPDATE memory_working_set_generations
         SET last_rebalanced_at = ?, last_error = NULL WHERE singleton = 1`
      ).run(request.observedAt);
    }
    const limits = capacityLimitsForScope(request.policy, request.scope);
    const nextRebalanceAt = new Date(
      Date.parse(request.observedAt) + capacityGovernanceRetryDelayMilliseconds
    ).toISOString();
    const obligationState = preview.lowWaterUnreachable ? "pending" : "satisfied";
    database.prepare(
      `INSERT INTO memory_capacity_obligations(
         space_key, scope_kind, project_id, state, active_count,
         target_count, hard_limit, low_water, cold_days,
         governance_batch_size, first_exceeded_at, last_observed_at,
         next_review_at, satisfied_at, mandatory_count, hard_protected_count,
         ranking_excluded_count, low_water_unreachable, last_rebalanced_at,
         last_error, consecutive_failure_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
       ON CONFLICT(space_key) DO UPDATE SET
         state = excluded.state,
         active_count = excluded.active_count,
         target_count = excluded.target_count,
         hard_limit = excluded.hard_limit,
         low_water = excluded.low_water,
         cold_days = excluded.cold_days,
         governance_batch_size = excluded.governance_batch_size,
         last_observed_at = excluded.last_observed_at,
         next_review_at = excluded.next_review_at,
         run_id = NULL,
         satisfied_at = excluded.satisfied_at,
         mandatory_count = excluded.mandatory_count,
         hard_protected_count = excluded.hard_protected_count,
         ranking_excluded_count = excluded.ranking_excluded_count,
         low_water_unreachable = excluded.low_water_unreachable,
         last_rebalanced_at = excluded.last_rebalanced_at,
         last_error = NULL,
         consecutive_failure_count = 0`
    ).run(
      key,
      request.scope.kind,
      request.scope.kind === "project" ? request.scope.projectId : null,
      obligationState,
      preview.rankedActiveAgentCount,
      limits.target,
      limits.hardLimit,
      limits.lowWater,
      request.policy.coldDays,
      request.policy.governanceBatchSize,
      request.observedAt,
      request.observedAt,
      nextRebalanceAt,
      obligationState === "satisfied" ? request.observedAt : null,
      preview.mandatoryCount,
      preview.hardProtectedCount,
      preview.excludedCount,
      preview.lowWaterUnreachable ? 1 : 0,
      request.observedAt
    );
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  return { ...preview, changed };
}

export async function rebalancePressuredMemorySpaces(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly policy: MemoryCapacityPolicy;
  readonly observedAt: string;
}): Promise<readonly (
  | ({ readonly state: "rebalanced" } & MemoryWorkingSetPreview & { readonly changed: boolean })
  | {
      readonly state: "deferred";
      readonly scope: MemoryWorkingSetScope;
      readonly errorCode: string;
      readonly nextRetryAt: string;
    }
)[]> {
  await reconcileMemoryCapacity({
    runtimeRoot: request.runtimeRoot,
    policy: request.policy,
    observedAt: request.observedAt
  });
  const before = inspectMemoryCapacity({ runtimeRoot: request.runtimeRoot, policy: request.policy });
  const scopes = new Map<string, MemoryWorkingSetScope>();
  for (const space of before.spaces) {
    if (space.state === "available") continue;
    if (space.last_error !== null && space.last_error !== undefined &&
        typeof space.next_review_at === "string" && space.next_review_at > request.observedAt) {
      continue;
    }
    const scope: MemoryWorkingSetScope = space.scope.kind === "global"
        ? { kind: "global" }
        : { kind: "project", projectId: space.scope.project_id };
    scopes.set(workingSetSpaceKey(scope), scope);
  }
  const dueDatabase = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const dueRows = dueDatabase.prepare(
      `SELECT scope_kind, project_id FROM memory_capacity_obligations
       WHERE next_review_at IS NOT NULL AND next_review_at <= ?
         AND (ranking_excluded_count > 0 OR low_water_unreachable = 1 OR last_error IS NOT NULL)`
    ).all(request.observedAt);
    for (const row of dueRows) {
      const scope: MemoryWorkingSetScope = row.scope_kind === "global"
        ? { kind: "global" }
        : { kind: "project", projectId: z.string().min(1).parse(row.project_id) };
      scopes.set(workingSetSpaceKey(scope), scope);
    }
  } finally {
    dueDatabase.close();
  }
  const results: (
    | ({ readonly state: "rebalanced" } & MemoryWorkingSetPreview & { readonly changed: boolean })
    | {
        readonly state: "deferred";
        readonly scope: MemoryWorkingSetScope;
        readonly errorCode: string;
        readonly nextRetryAt: string;
      }
  )[] = [];
  for (const scope of scopes.values()) {
    try {
      results.push({
        state: "rebalanced",
        ...(await rebalanceMemoryWorkingSet({ ...request, scope }))
      });
    } catch {
      const errorCode = "working_set_rebalance_failed";
      const failure = await recordMemoryWorkingSetRebalanceFailure({
        runtimeRoot: request.runtimeRoot,
        scope,
        failedAt: request.observedAt,
        errorCode
      });
      results.push({ state: "deferred", scope, errorCode, nextRetryAt: failure.nextRetryAt });
    }
  }
  await reconcileMemoryCapacity({
    runtimeRoot: request.runtimeRoot,
    policy: request.policy,
    observedAt: request.observedAt
  });
  return results;
}

async function recordMemoryWorkingSetRebalanceFailure(request: {
  readonly runtimeRoot: string;
  readonly scope: MemoryWorkingSetScope;
  readonly failedAt: string;
  readonly errorCode: string;
}): Promise<{ readonly nextRetryAt: string }> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    const key = workingSetSpaceKey(request.scope);
    const row = database.prepare(
      "SELECT consecutive_failure_count FROM memory_capacity_obligations WHERE space_key = ?"
    ).get(key);
    const previousFailures = z.number().int().nonnegative().parse(
      row?.consecutive_failure_count ?? 0
    );
    const delay = Math.min(
      capacityGovernanceRetryDelayMilliseconds,
      capacityRetryBaseDelayMilliseconds * 2 ** Math.min(previousFailures, 7)
    );
    const nextRetryAt = new Date(Date.parse(request.failedAt) + delay).toISOString();
    database.prepare(
      `UPDATE memory_capacity_obligations
       SET state = 'pending', next_review_at = ?, satisfied_at = NULL,
           last_error = ?, consecutive_failure_count = consecutive_failure_count + 1,
           last_observed_at = ?
       WHERE space_key = ?`
    ).run(nextRetryAt, request.errorCode, request.failedAt, key);
    database.prepare(
      `UPDATE memory_working_set_generations
       SET last_error = ? WHERE singleton = 1`
    ).run(request.errorCode);
    database.exec("COMMIT");
    return { nextRetryAt };
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

export async function inspectMemoryWorkingSetGeneration(runtimeRoot: string): Promise<{
  readonly dirtyGeneration: number;
  readonly publishedGeneration: number;
  readonly dirtyAt: string | null;
  readonly lastRebalancedAt: string | null;
  readonly lastPublishedAt: string | null;
  readonly lastError: string | null;
  readonly publicationNextRetryAt: string | null;
  readonly publicationFailureCount: number;
}> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const row = database.prepare(
      `SELECT dirty_generation, published_generation, dirty_at,
              last_rebalanced_at, last_published_at, last_error,
              publication_next_retry_at, publication_failure_count
       FROM memory_working_set_generations WHERE singleton = 1`
    ).get();
    return {
      dirtyGeneration: z.number().int().nonnegative().parse(row?.dirty_generation),
      publishedGeneration: z.number().int().nonnegative().parse(row?.published_generation),
      dirtyAt: typeof row?.dirty_at === "string" ? row.dirty_at : null,
      lastRebalancedAt: typeof row?.last_rebalanced_at === "string" ? row.last_rebalanced_at : null,
      lastPublishedAt: typeof row?.last_published_at === "string" ? row.last_published_at : null,
      lastError: typeof row?.last_error === "string" ? row.last_error : null,
      publicationNextRetryAt: typeof row?.publication_next_retry_at === "string"
        ? row.publication_next_retry_at
        : null,
      publicationFailureCount: z.number().int().nonnegative().parse(
        row?.publication_failure_count
      )
    };
  } finally {
    database.close();
  }
}

export async function markMemoryWorkingSetPublished(request: {
  readonly runtimeRoot: string;
  readonly generation: number;
  readonly publishedAt: string;
}): Promise<void> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.prepare(
      `UPDATE memory_working_set_generations
       SET published_generation = MAX(published_generation, ?),
           last_published_at = ?, last_error = NULL,
           publication_next_retry_at = NULL, publication_failure_count = 0
       WHERE singleton = 1 AND dirty_generation >= ?`
    ).run(request.generation, request.publishedAt, request.generation);
  } finally {
    database.close();
  }
}

export async function recordMemoryWorkingSetPublicationFailure(request: {
  readonly runtimeRoot: string;
  readonly failedAt: string;
  readonly errorCode: string;
}): Promise<{ readonly nextRetryAt: string }> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    const row = database.prepare(
      `SELECT publication_failure_count
       FROM memory_working_set_generations WHERE singleton = 1`
    ).get();
    const previousFailures = z.number().int().nonnegative().parse(
      row?.publication_failure_count
    );
    const delay = Math.min(
      capacityGovernanceRetryDelayMilliseconds,
      capacityRetryBaseDelayMilliseconds * 2 ** Math.min(previousFailures, 7)
    );
    const nextRetryAt = new Date(Date.parse(request.failedAt) + delay).toISOString();
    database.prepare(
      `UPDATE memory_working_set_generations
       SET dirty_at = COALESCE(dirty_at, ?), last_error = ?,
           publication_next_retry_at = ?,
           publication_failure_count = publication_failure_count + 1
       WHERE singleton = 1`
    ).run(request.failedAt, request.errorCode, nextRetryAt);
    database.exec("COMMIT");
    return { nextRetryAt };
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

export async function loadMemoryCapacityPolicy(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
}): Promise<MemoryCapacityPolicy> {
  try {
    await access(join(request.vaultRoot, "_MemStore", "policy.toml"));
  } catch {
    return defaultMemoryCapacityPolicy;
  }
  const configuration = await loadConfiguration(request);
  return configuration.mode === "read_write"
    ? configuration.policy.memoryCapacity
    : defaultMemoryCapacityPolicy;
}

export function capacityLimitsForScope(
  policy: MemoryCapacityPolicy,
  scope: { readonly kind: "project" } | { readonly kind: "global" }
): MemoryCapacityPolicy["project"] {
  return scope.kind === "global" ? policy.global : policy.project;
}

export interface MemorySpaceCapacity {
  readonly scope:
    | { readonly kind: "project"; readonly project_id: string }
    | { readonly kind: "global" };
  readonly active_agent_memory_count: number;
  readonly durable_active_agent_count: number;
  readonly ranked_active_agent_count: number;
  readonly ranking_excluded_count: number;
  readonly target: number;
  readonly hard_limit: number;
  readonly low_water: number;
  readonly state: "available" | "pressured" | "hard_limited";
  readonly obligation_state?: "pending" | "linked";
  readonly next_review_at?: string | null;
  readonly governance_run_id?: string | null;
  readonly mandatory_count?: number;
  readonly hard_protected_count?: number;
  readonly low_water_unreachable?: boolean;
  readonly last_rebalanced_at?: string | null;
  readonly last_error?: string | null;
}

export interface MemoryCapacityStatus {
  readonly pressured_space_count: number;
  readonly hard_limited_space_count: number;
  readonly open_obligation_count: number;
  readonly spaces: readonly MemorySpaceCapacity[];
}

export interface MemoryCapacityReconciliation extends MemoryCapacityStatus {
  readonly pending_obligation_count: number;
}

function spaceKey(scope: MemorySpaceCapacity["scope"]): string {
  return scope.kind === "global" ? "global" : `project:${scope.project_id}`;
}

function capacityState(
  count: number,
  target: number,
  hardLimit: number
): MemorySpaceCapacity["state"] {
  if (count >= hardLimit) return "hard_limited";
  if (count > target) return "pressured";
  return "available";
}

export function inspectMemoryCapacity(request: {
  readonly runtimeRoot: string;
  readonly policy: MemoryCapacityPolicy;
}): MemoryCapacityStatus {
  const database = new DatabaseSync(
    join(request.runtimeRoot, "state", "memstore.sqlite"),
    { readOnly: true }
  );
  try {
    const countRows = database.prepare(
      `SELECT catalog.scope_kind, catalog.project_id,
              COUNT(*) AS durable_count,
              SUM(CASE WHEN exclusion.memory_id IS NULL THEN 1 ELSE 0 END) AS ranked_count,
              SUM(CASE WHEN exclusion.memory_id IS NULL THEN 0 ELSE 1 END) AS excluded_count
       FROM memory_catalog AS catalog
       LEFT JOIN memory_ranking_exclusions AS exclusion
         ON exclusion.memory_id = catalog.memory_id
        AND exclusion.revision_id = catalog.current_revision_id
        AND exclusion.space_key = CASE
          WHEN catalog.scope_kind = 'global' THEN 'global'
          ELSE 'project:' || catalog.project_id END
       WHERE catalog.lifecycle = 'active' AND catalog.authority = 'agent_derived'
       GROUP BY catalog.scope_kind, catalog.project_id
       ORDER BY ranked_count DESC, catalog.scope_kind, catalog.project_id`
    ).all();
    const obligationRows = database.prepare(
      `SELECT space_key, state, next_review_at, run_id, mandatory_count,
              hard_protected_count, low_water_unreachable,
              last_rebalanced_at, last_error
       FROM memory_capacity_obligations
       WHERE state IN ('pending', 'linked') OR ranking_excluded_count > 0`
    ).all();
    const obligations = new Map(obligationRows.map((row) => [
      z.string().parse(row.space_key),
      {
        state: z.enum(["pending", "linked", "satisfied"]).parse(row.state),
        nextReviewAt: typeof row.next_review_at === "string" ? row.next_review_at : null,
        runId: typeof row.run_id === "string" ? row.run_id : null,
        mandatoryCount: z.number().int().nonnegative().parse(row.mandatory_count),
        hardProtectedCount: z.number().int().nonnegative().parse(row.hard_protected_count),
        lowWaterUnreachable: row.low_water_unreachable === 1,
        lastRebalancedAt: typeof row.last_rebalanced_at === "string" ? row.last_rebalanced_at : null,
        lastError: typeof row.last_error === "string" ? row.last_error : null
      }
    ]));
    const spacesByKey = new Map<string, MemorySpaceCapacity>();
    for (const row of countRows) {
      const kind = z.enum(["project", "global"]).parse(row.scope_kind);
      const durableCount = z.number().int().nonnegative().parse(row.durable_count);
      const rankedCount = z.number().int().nonnegative().parse(row.ranked_count);
      const excludedCount = z.number().int().nonnegative().parse(row.excluded_count);
      const policy = kind === "global" ? request.policy.global : request.policy.project;
      const scope: MemorySpaceCapacity["scope"] = kind === "global"
        ? { kind: "global" }
        : { kind: "project", project_id: z.string().min(1).parse(row.project_id) };
      const obligation = obligations.get(spaceKey(scope));
      spacesByKey.set(spaceKey(scope), {
        scope,
        active_agent_memory_count: rankedCount,
        durable_active_agent_count: durableCount,
        ranked_active_agent_count: rankedCount,
        ranking_excluded_count: excludedCount,
        target: policy.target,
        hard_limit: policy.hardLimit,
        low_water: policy.lowWater,
        state: capacityState(rankedCount, policy.target, policy.hardLimit),
        ...(obligation === undefined ? {} : {
          ...(obligation.state === "satisfied" ? {} : { obligation_state: obligation.state }),
          next_review_at: obligation.nextReviewAt,
          governance_run_id: obligation.runId,
          mandatory_count: obligation.mandatoryCount,
          hard_protected_count: obligation.hardProtectedCount,
          low_water_unreachable: obligation.lowWaterUnreachable,
          last_rebalanced_at: obligation.lastRebalancedAt,
          last_error: obligation.lastError
        })
      });
    }
    for (const [key, obligation] of obligations) {
      if (spacesByKey.has(key)) continue;
      const isGlobal = key === "global";
      const policy = isGlobal ? request.policy.global : request.policy.project;
      spacesByKey.set(key, {
        scope: isGlobal
          ? { kind: "global" }
          : { kind: "project", project_id: key.slice("project:".length) },
        active_agent_memory_count: 0,
        durable_active_agent_count: 0,
        ranked_active_agent_count: 0,
        ranking_excluded_count: 0,
        target: policy.target,
        hard_limit: policy.hardLimit,
        low_water: policy.lowWater,
        state: "available",
        ...(obligation.state === "satisfied" ? {} : { obligation_state: obligation.state }),
        next_review_at: obligation.nextReviewAt,
        governance_run_id: obligation.runId,
        mandatory_count: obligation.mandatoryCount,
        hard_protected_count: obligation.hardProtectedCount,
        low_water_unreachable: obligation.lowWaterUnreachable,
        last_rebalanced_at: obligation.lastRebalancedAt,
        last_error: obligation.lastError
      });
    }
    const allSpaces = [...spacesByKey.values()];
    const pressured = allSpaces.filter((space) => space.state !== "available");
    const visible = allSpaces
      .filter((space) =>
        space.state !== "available" ||
        space.obligation_state !== undefined ||
        space.ranking_excluded_count > 0
      )
      .sort((left, right) =>
        right.active_agent_memory_count - left.active_agent_memory_count
        || spaceKey(left.scope).localeCompare(spaceKey(right.scope))
      );
    return {
      pressured_space_count: pressured.length,
      hard_limited_space_count: pressured.filter((space) => space.state === "hard_limited").length,
      open_obligation_count: [...obligations.values()].filter(
        (obligation) => obligation.state !== "satisfied"
      ).length,
      spaces: visible
    };
  } finally {
    database.close();
  }
}

export async function reconcileMemoryCapacity(request: {
  readonly runtimeRoot: string;
  readonly policy: MemoryCapacityPolicy;
  readonly observedAt: string;
}): Promise<MemoryCapacityReconciliation> {
  const observedAt = z.iso.datetime().parse(request.observedAt);
  const latestNextReviewAt = new Date(
    Date.parse(observedAt) + capacityGovernanceRetryDelayMilliseconds
  ).toISOString();
  const status = inspectMemoryCapacity(request);
  if (status.spaces.length === 0 && status.open_obligation_count === 0) {
    return { ...status, pending_obligation_count: 0 };
  }
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const liveKeys = new Set<string>();
      for (const space of status.spaces) {
        if (space.state === "available") continue;
        const key = spaceKey(space.scope);
        liveKeys.add(key);
        database.prepare(
           `INSERT INTO memory_capacity_obligations(
             space_key, scope_kind, project_id, state, active_count,
             target_count, hard_limit, low_water, cold_days,
             governance_batch_size, first_exceeded_at, last_observed_at, next_review_at
           ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(space_key) DO UPDATE SET
             active_count = excluded.active_count,
             target_count = excluded.target_count,
             hard_limit = excluded.hard_limit,
             low_water = excluded.low_water,
             cold_days = excluded.cold_days,
             governance_batch_size = excluded.governance_batch_size,
             last_observed_at = excluded.last_observed_at,
             state = CASE
               WHEN memory_capacity_obligations.state = 'linked' THEN 'linked'
               ELSE 'pending'
             END,
             next_review_at = CASE
               WHEN memory_capacity_obligations.state = 'linked'
                 THEN memory_capacity_obligations.next_review_at
               WHEN memory_capacity_obligations.last_error IS NOT NULL
                 THEN memory_capacity_obligations.next_review_at
               WHEN memory_capacity_obligations.state = 'satisfied'
                 THEN excluded.next_review_at
               ELSE MIN(
                 COALESCE(memory_capacity_obligations.next_review_at, excluded.next_review_at),
                 ?
               )
             END,
             run_id = CASE
               WHEN memory_capacity_obligations.state = 'linked'
                 THEN memory_capacity_obligations.run_id
               ELSE NULL
             END,
             satisfied_at = NULL`
        ).run(
          key,
          space.scope.kind,
          space.scope.kind === "project" ? space.scope.project_id : null,
          space.active_agent_memory_count,
          space.target,
          space.hard_limit,
          space.low_water,
          request.policy.coldDays,
          request.policy.governanceBatchSize,
          observedAt,
          observedAt,
          observedAt,
          latestNextReviewAt
        );
      }
      const existing = database.prepare(
        `SELECT space_key, scope_kind, project_id, state, target_count,
                low_water_unreachable
         FROM memory_capacity_obligations WHERE state != 'satisfied'`
      ).all();
      for (const obligation of existing) {
        const key = z.string().parse(obligation.space_key);
        if (liveKeys.has(key) || obligation.state === "linked") continue;
        const scopeKind = z.enum(["project", "global"]).parse(obligation.scope_kind);
        const projectId = typeof obligation.project_id === "string"
          ? obligation.project_id
          : null;
        const countRow = database.prepare(
          `SELECT COUNT(*) AS count FROM memory_catalog AS catalog
           WHERE catalog.lifecycle = 'active' AND catalog.authority = 'agent_derived'
             AND catalog.scope_kind = ?
             AND (? = 'global' OR catalog.project_id = ?)
             AND NOT EXISTS (
               SELECT 1 FROM memory_ranking_exclusions AS exclusion
               WHERE exclusion.memory_id = catalog.memory_id
                 AND exclusion.revision_id = catalog.current_revision_id
                 AND exclusion.space_key = CASE
                   WHEN catalog.scope_kind = 'global' THEN 'global'
                   ELSE 'project:' || catalog.project_id END
             )`
        ).get(scopeKind, scopeKind, projectId);
        const count = z.number().int().nonnegative().parse(countRow?.count);
        const target = z.number().int().positive().parse(obligation.target_count);
        const lowWaterUnreachable = obligation.low_water_unreachable === 1;
        if (count <= target && !lowWaterUnreachable) {
          database.prepare(
            `UPDATE memory_capacity_obligations
             SET state = 'satisfied', active_count = ?, last_observed_at = ?,
                 next_review_at = NULL, run_id = NULL, satisfied_at = ?
             WHERE space_key = ?`
          ).run(count, observedAt, observedAt, key);
        } else {
          database.prepare(
            `UPDATE memory_capacity_obligations
             SET active_count = ?, last_observed_at = ? WHERE space_key = ?`
          ).run(count, observedAt, key);
        }
      }
      const pending = database.prepare(
        "SELECT COUNT(*) AS count FROM memory_capacity_obligations WHERE state = 'pending'"
      ).get();
      database.exec("COMMIT");
      return {
        ...status,
        pending_obligation_count: z.number().int().nonnegative().parse(pending?.count)
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}
