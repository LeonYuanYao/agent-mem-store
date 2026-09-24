import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { loadRetentionAssessmentCache, matchRetentionAssessment, recordRetentionAssessment } from "../capacity/retention-cache.js";
import { retentionSubjectHash, retentionValuePolicyVersion, retentionValueSchema } from "../capacity/retention-value.js";
import { enforceGovernanceDecisionPolicy, governancePolicyInputSchema } from "./decision-policy.js";
import { completePageEvidence } from "./page-evidence.js";

import { LunaInvocationError } from "../luna/index.js";
import {
  diagnosticSource,
  recordLunaWorkFailure,
  recordLunaWorkSuccess
} from "../luna/operations.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import {
  archiveLifecycleDetails,
  loadArchiveRetentionMonths
} from "../lifecycle/archive-retention.js";
import {
  readCanonicalMemory,
  readCanonicalRevision,
  writeCanonicalMemory,
  type CanonicalMemory
} from "../vault/index.js";
import {
  governanceOutputSchema,
  type GovernanceAgentAction,
  type GovernanceAdapter,
  type GovernanceAuditSignals,
  type GovernanceMemoryInput,
  type GovernancePageRequest,
  type GovernancePageReview
} from "./contracts.js";

export type {
  GovernanceAdapter,
  GovernanceMemoryInput,
  GovernancePageRequest,
  GovernancePageReview
} from "./contracts.js";

type StepResult =
  | { readonly state: "idle" | "busy" | "blocked" }
  | { readonly state: "yielded"; readonly reason: "foreground_backlog" }
  | { readonly state: "reviewed" | "applied"; readonly runId: string; readonly phase: "weekly" | "monthly"; readonly pageOrdinal: number }
  | { readonly state: "phase_advanced"; readonly runId: string; readonly phase: "monthly" | "finalize" }
  | { readonly state: "retrying"; readonly runId: string; readonly nextRetryAt: string }
  | { readonly state: "completed"; readonly runId: string; readonly summaryItemCount: number };

interface RunRow {
  readonly runId: string;
  readonly runKind: "weekly" | "monthly";
  readonly state: "pending" | "processing" | "retrying" | "blocked";
  readonly includesWeekly: boolean;
  readonly weeklyFrom: string | null;
  readonly monthlyFrom: string | null;
  readonly coverageThrough: string;
  readonly currentPhase: "weekly" | "monthly" | "finalize";
  readonly attemptCount: number;
  readonly consecutiveFailureCount: number;
}

function parseRun(row: Record<string, unknown>): RunRow {
  return {
    runId: z.string().min(1).parse(row.run_id),
    runKind: z.enum(["weekly", "monthly"]).parse(row.run_kind),
    state: z.enum(["pending", "processing", "retrying", "blocked"]).parse(row.state),
    includesWeekly: row.includes_weekly === 1,
    weeklyFrom: z.string().nullable().parse(row.weekly_from),
    monthlyFrom: z.string().nullable().parse(row.monthly_from),
    coverageThrough: z.iso.datetime().parse(row.coverage_through),
    currentPhase: z.enum(["weekly", "monthly", "finalize"]).parse(row.current_phase),
    attemptCount: z.number().int().nonnegative().parse(row.attempt_count),
    consecutiveFailureCount: z.number().int().nonnegative().parse(row.consecutive_failure_count)
  };
}

function memoryInput(memory: CanonicalMemory): GovernanceMemoryInput {
  return {
    memoryId: memory.memoryId,
    revisionId: memory.revisionId,
    authority: memory.authority,
    scope: memory.scope,
    lifecycle: memory.lifecycle,
    category: memory.primaryCategory,
    applicability: memory.applicability,
    validity: memory.validity,
    semanticContract: memory.semanticContract,
    relationships: memory.relationships,
    provenance: memory.provenance,
    body: memory.body,
    revisedAt: memory.revisedAt
  };
}

async function loadAuditSignals(
  runtimeRoot: string,
  from: string,
  through: string,
  pageMemoryIds: readonly string[]
): Promise<GovernanceAuditSignals> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const count = (sql: string, ...values: string[]): number => {
      const row = database.prepare(sql).get(...values);
      return z.number().int().nonnegative().parse(row?.count);
    };
    const brokenRelationshipTargets = database.prepare(
      `SELECT DISTINCT relationship.target_memory_id
       FROM memory_relationships AS relationship
       LEFT JOIN memory_catalog AS target
         ON target.memory_id = relationship.target_memory_id
       WHERE target.memory_id IS NULL
       ORDER BY relationship.target_memory_id LIMIT 100`
    ).all().map((row) => z.string().parse(row.target_memory_id));
    const activeIndex = database.prepare(
      "SELECT index_revision_id FROM active_retrieval_index WHERE singleton = 1"
    ).get();
    const activeIndexRevisionId = typeof activeIndex?.index_revision_id === "string"
      ? activeIndex.index_revision_id
      : null;
    const duplicateRows = activeIndexRevisionId === null
      ? []
      : database.prepare(
          `SELECT standard_text, memory_id, scope_kind, project_id,
                  applicability_summary, applicability_conditions_json
           FROM retrieval_documents
           WHERE index_revision_id = ? ORDER BY standard_text, memory_id`
        ).all(activeIndexRevisionId);
    const duplicateMap = new Map<string, string[]>();
    for (const row of duplicateRows) {
      const key = JSON.stringify({
        text: z.string().parse(row.standard_text).trim().toLocaleLowerCase("en-US"),
        scope: row.scope_kind === "global"
          ? "global"
          : `project:${z.string().parse(row.project_id)}`,
        applicabilitySummary: z.string().parse(row.applicability_summary),
        applicabilityConditions: z.array(z.string()).parse(
          JSON.parse(z.string().parse(row.applicability_conditions_json))
        )
      });
      const ids = duplicateMap.get(key) ?? [];
      ids.push(z.string().parse(row.memory_id));
      duplicateMap.set(key, ids);
    }
    const exactDuplicateGroups = [...duplicateMap.values()]
      .filter((ids) => ids.length > 1 && ids.some(id => pageMemoryIds.includes(id)))
      .slice(0, 100);
    const pageSlots = pageMemoryIds.map(() => "?").join(",");
    const reviewedDuplicateClusters = database.prepare(
      `SELECT cluster.cluster_id, cluster.left_memory_id, cluster.right_memory_id,
              cluster.decision, cluster.reason_code
       FROM memory_duplicate_clusters AS cluster
       JOIN memory_catalog AS left_memory ON left_memory.memory_id = cluster.left_memory_id
       JOIN memory_catalog AS right_memory ON right_memory.memory_id = cluster.right_memory_id
       WHERE cluster.state = 'completed'
         AND cluster.decision IN (
           'equivalent', 'left_subsumes_right', 'right_subsumes_left', 'conflicts'
         )
         AND left_memory.current_revision_id = cluster.left_revision_id
         AND right_memory.current_revision_id = cluster.right_revision_id
         AND left_memory.lifecycle = 'active' AND right_memory.lifecycle = 'active'
         AND (cluster.left_memory_id IN (${pageSlots}) OR cluster.right_memory_id IN (${pageSlots}))
       ORDER BY cluster.completed_at DESC, cluster.cluster_id LIMIT 100`
    ).all(...pageMemoryIds, ...pageMemoryIds).map((row) => ({
      clusterId: z.string().parse(row.cluster_id),
      memoryIds: [
        z.string().parse(row.left_memory_id),
        z.string().parse(row.right_memory_id)
      ] as const,
      decision: z.enum([
        "equivalent", "left_subsumes_right", "right_subsumes_left", "conflicts"
      ]).parse(row.decision),
      reasonCode: z.string().parse(row.reason_code)
    }));
    const health = database.prepare(
      "SELECT state FROM luna_health_state WHERE singleton = 1"
    ).get();
    return {
      brokenRelationshipTargets,
      exactDuplicateGroups,
      reviewedDuplicateClusters,
      openVaultConflictCount: count("SELECT COUNT(*) AS count FROM vault_conflicts WHERE state = 'open'"),
      persistentHighValueAnomalyCount: count(
        "SELECT COUNT(*) AS count FROM high_value_anomalies WHERE state = 'persistent'"
      ),
      openBadCaseCount: count(
        "SELECT COUNT(*) AS count FROM bad_cases WHERE state IN ('open', 'repairing')"
      ),
      irrelevantObservationCount: count(
        "SELECT COUNT(*) AS count FROM irrelevant_observations WHERE observed_at > ? AND observed_at <= ?",
        from,
        through
      ),
      retrievalReceiptCount: count(
        "SELECT COUNT(*) AS count FROM retrieval_receipts WHERE created_at > ? AND created_at <= ?",
        from,
        through
      ),
      activeIndexRevisionId,
      modelHealthState: z.enum(["healthy", "degraded", "unavailable"]).parse(health?.state),
      lunaBacklogCount: count(
        "SELECT COUNT(*) AS count FROM luna_operations WHERE state IN ('pending', 'processing', 'retrying', 'blocked')"
      ),
      captureBacklogCount: count(
        "SELECT COUNT(*) AS count FROM capture_events WHERE state IN ('pending', 'processing', 'retrying')"
      ),
      indexBuildActive: database.prepare(
        `SELECT 1 FROM retrieval_index_build_activity
         WHERE singleton = 1 AND state = 'building' AND lease_until > ?`
      ).get(through) !== undefined
    };
  } finally {
    database.close();
  }
}

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function nextRevision(memory: CanonicalMemory, revisionId: string): CanonicalMemory["representations"] {
  return {
    ...(memory.representations.identity === undefined ? {} : {
      identity: { ...memory.representations.identity, sourceRevisionId: revisionId }
    }),
    compact: { ...memory.representations.compact, sourceRevisionId: revisionId },
    standard: { ...memory.representations.standard, sourceRevisionId: revisionId }
  };
}

function sameScope(left: CanonicalMemory["scope"], right: CanonicalMemory["scope"]): boolean {
  return left.kind === right.kind &&
    (left.kind === "global" || (right.kind === "project" && left.projectId === right.projectId));
}

function sameApplicability(left: CanonicalMemory, right: CanonicalMemory): boolean {
  return JSON.stringify(left.applicability) === JSON.stringify(right.applicability);
}

async function snapshotRevision(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly memoryId: string;
  readonly revisionId: string;
}): Promise<CanonicalMemory> {
  const result = await readCanonicalRevision(request);
  if (result === undefined) throw new Error("Governance snapshot revision is missing.");
  return result.memory;
}

async function currentMemory(runtimeRoot: string, vaultRoot: string, memoryId: string): Promise<CanonicalMemory> {
  const result = await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId });
  if (result === undefined) throw new Error("Governance target Memory is missing.");
  return result.memory;
}

async function writeAgentRevision(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly current: CanonicalMemory;
  readonly runId: string;
  readonly revisedAt: string;
  readonly changes: Partial<CanonicalMemory>;
}): Promise<void> {
  const revisionId = `msrev_${randomUUID()}`;
  await writeCanonicalMemory({
    runtimeRoot: request.runtimeRoot,
    vaultRoot: request.vaultRoot,
    actor: "agent",
    expectedContentIdentity: request.current.contentIdentity,
    memory: {
      ...request.current,
      ...request.changes,
      revisionId,
      predecessorRevisionId: request.current.revisionId,
      revisedAt: request.revisedAt,
      representations: nextRevision(request.current, revisionId),
      provenance: request.current.provenance.includes(`governance:${request.runId}`)
        ? request.current.provenance
        : [...request.current.provenance, `governance:${request.runId}`]
    }
  });
}

async function validateReview(
  runtimeRoot: string,
  runId: string,
  review: GovernancePageReview
): Promise<void> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const rows = database.prepare(
      `SELECT member.memory_id, catalog.authority, catalog.lifecycle
       FROM governance_run_members AS member
       JOIN memory_catalog AS catalog ON catalog.memory_id = member.memory_id
       WHERE member.run_id = ?`
    ).all(runId);
    const members = new Map(rows.map((row) => [
      z.string().parse(row.memory_id),
      {
        authority: z.enum(["human_authored", "agent_derived"]).parse(row.authority),
        lifecycle: z.enum(["active", "archived", "tombstone"]).parse(row.lifecycle)
      }
    ]));
    for (const action of review.agentActions) {
      const sourceId = action.kind === "add_relationship" ? action.sourceMemoryId : action.targetMemoryId;
      const source = members.get(sourceId);
      if (source?.authority !== "agent_derived") {
        throw new LunaInvocationError("schema_invalid", true, "Governance action has an invalid source.", {
          stage: "evidence_binding", code: "invalid_action_authority"
        });
      }
      if (action.kind === "add_relationship" && !members.has(action.targetMemoryId)) {
        throw new LunaInvocationError("schema_invalid", true, "Relationship target is outside the frozen governance run.", {
          stage: "evidence_binding", code: "relationship_target_outside_run"
        });
      }
      if (action.kind === "supersede" && members.get(action.successorMemoryId)?.authority !== "agent_derived") {
        throw new LunaInvocationError("schema_invalid", true, "Supersession successor must be Agent-derived in this run.", {
          stage: "evidence_binding", code: "invalid_successor_authority"
        });
      }
    }
    for (const suggestion of review.reviewSuggestions) {
      if (members.get(suggestion.targetMemoryId)?.authority !== "human_authored") {
        throw new LunaInvocationError("schema_invalid", true, "Review Suggestions are reserved for Human-authored Memory.", {
          stage: "evidence_binding", code: "invalid_review_authority"
        });
      }
    }
    for (const obligation of review.futurePurgeObligations) {
      if (members.get(obligation.memoryId)?.lifecycle !== "archived") {
        throw new LunaInvocationError("schema_invalid", true, "Future purge can only be proposed for archived Memory.", {
          stage: "evidence_binding", code: "purge_target_not_archived"
        });
      }
    }
  } finally {
    database.close();
  }
}

async function applyAgentAction(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly runId: string;
  readonly checkpointId: string;
  readonly coverageThrough: string;
  readonly action: GovernanceAgentAction;
  readonly actionKey: string;
}): Promise<Record<string, unknown>> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const existing = database.prepare(
      "SELECT result_json FROM governance_actions WHERE action_key = ?"
    ).get(request.actionKey);
    if (typeof existing?.result_json === "string") {
      return z.record(z.string(), z.unknown()).parse(JSON.parse(existing.result_json));
    }
  } finally {
    database.close();
  }
  const sourceId = request.action.kind === "add_relationship"
    ? request.action.sourceMemoryId
    : request.action.targetMemoryId;
  const source = await currentMemory(request.runtimeRoot, request.vaultRoot, sourceId);
  const snapshotDatabase = await openRuntimeDatabase(request.runtimeRoot);
  let snapshotRevisionId: string;
  try {
    const row = snapshotDatabase.prepare(
      `SELECT revision_id FROM governance_run_members
       WHERE run_id = ? AND memory_id = ? LIMIT 1`
    ).get(request.runId, sourceId);
    snapshotRevisionId = z.string().parse(row?.revision_id);
  } finally {
    snapshotDatabase.close();
  }
  let result: Record<string, unknown>;
  let desiredStateAlreadyPresent: boolean;
  if (request.action.kind === "archive") {
    desiredStateAlreadyPresent = source.lifecycle === "archived" &&
      source.lifecycleDetails.reason?.startsWith(`governance:${request.runId}:`) === true;
  } else if (request.action.kind === "supersede") {
    desiredStateAlreadyPresent = source.lifecycle === "archived" &&
      source.successorMemoryId === request.action.successorMemoryId &&
      source.lifecycleDetails.reason?.startsWith(`governance:${request.runId}:`) === true;
  } else if (request.action.kind === "mark_review_due") {
    desiredStateAlreadyPresent = source.validity.state === "review_due";
  } else {
    const relationshipType = request.action.relationshipType;
    const targetMemoryId = request.action.targetMemoryId;
    desiredStateAlreadyPresent = source.relationships.some((relationship) =>
      relationship.type === relationshipType && relationship.targetMemoryId === targetMemoryId
    );
  }
  const ledgerDatabase = await openRuntimeDatabase(request.runtimeRoot);
  let earlierRunAction: boolean;
  try {
    earlierRunAction = ledgerDatabase.prepare(
      `SELECT 1 FROM governance_actions
       WHERE run_id = ? AND target_memory_id = ? LIMIT 1`
    ).get(request.runId, sourceId) !== undefined;
  } finally {
    ledgerDatabase.close();
  }
  const canContinueRunChain = earlierRunAction &&
    source.provenance.includes(`governance:${request.runId}`);
  if (desiredStateAlreadyPresent) {
    result = { state: "already_applied" };
  } else if (source.revisionId !== snapshotRevisionId && !canContinueRunChain) {
    result = { state: "skipped", reason: "revision_changed_after_snapshot" };
  } else if (request.action.kind === "archive") {
    const archiveRetentionMonths = await loadArchiveRetentionMonths(request);
    await writeAgentRevision({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      current: source,
      runId: request.runId,
      revisedAt: request.coverageThrough,
      changes: {
        lifecycle: "archived",
        lifecycleDetails: archiveLifecycleDetails({
          previous: source.lifecycleDetails,
          archivedAt: request.coverageThrough,
          reason: `governance:${request.runId}:${request.action.reason}`,
          archiveRetentionMonths
        })
      }
    });
    result = { state: "archived" };
  } else if (request.action.kind === "supersede") {
    const successor = await currentMemory(
      request.runtimeRoot,
      request.vaultRoot,
      request.action.successorMemoryId
    );
    if (!sameScope(source.scope, successor.scope) || !sameApplicability(source, successor) ||
        successor.authority !== "agent_derived" || successor.lifecycle !== "active") {
      throw new Error("Supersession must preserve scope and applicability with an active Agent successor.");
    }
    const archiveRetentionMonths = await loadArchiveRetentionMonths(request);
    await writeAgentRevision({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      current: source,
      runId: request.runId,
      revisedAt: request.coverageThrough,
      changes: {
        lifecycle: "archived",
        successorMemoryId: successor.memoryId,
        lifecycleDetails: archiveLifecycleDetails({
          previous: source.lifecycleDetails,
          archivedAt: request.coverageThrough,
          reason: `governance:${request.runId}:${request.action.reason}`,
          archiveRetentionMonths
        })
      }
    });
    result = { state: "superseded", successorMemoryId: successor.memoryId };
  } else if (request.action.kind === "mark_review_due") {
    await writeAgentRevision({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      current: source,
      runId: request.runId,
      revisedAt: request.coverageThrough,
      changes: {
        validity: { ...source.validity, state: "review_due" }
      }
    });
    result = { state: "review_due" };
  } else {
    const relationshipType = request.action.relationshipType;
    const targetMemoryId = request.action.targetMemoryId;
    const alreadyPresent = source.relationships.some((relationship) =>
      relationship.type === relationshipType &&
      relationship.targetMemoryId === targetMemoryId
    );
    if (!alreadyPresent) {
      await writeAgentRevision({
        runtimeRoot: request.runtimeRoot,
        vaultRoot: request.vaultRoot,
        current: source,
        runId: request.runId,
        revisedAt: request.coverageThrough,
        changes: {
          relationships: [...source.relationships, {
            type: relationshipType,
            targetMemoryId
          }]
        }
      });
    }
    result = { state: alreadyPresent ? "already_present" : "relationship_added" };
  }
  const actionDatabase = await openRuntimeDatabase(request.runtimeRoot);
  try {
    actionDatabase.prepare(
      `INSERT OR IGNORE INTO governance_actions(
         action_id, run_id, checkpoint_id, action_key, action_kind,
         target_memory_id, result_json, applied_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `msgovaction_${randomUUID()}`,
      request.runId,
      request.checkpointId,
      request.actionKey,
      request.action.kind === "add_relationship"
        ? "relationship"
        : request.action.kind,
      sourceId,
      JSON.stringify(result),
      request.coverageThrough
    );
  } finally {
    actionDatabase.close();
  }
  return result;
}

async function applyReviewedCheckpoint(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly run: RunRow;
  readonly checkpoint: Record<string, unknown>;
  readonly now: string;
}): Promise<StepResult> {
  const checkpointId = z.string().parse(request.checkpoint.checkpoint_id);
  const phase = z.enum(["weekly", "monthly"]).parse(request.checkpoint.phase);
  const pageOrdinal = z.number().int().nonnegative().parse(request.checkpoint.page_ordinal);
  const outputSource = z.string().parse(request.checkpoint.output_json);
  if (sha256(outputSource) !== request.checkpoint.output_sha256) {
    throw new Error("Governance checkpoint output integrity check failed.");
  }
  const parsedReview = governanceOutputSchema.parse(JSON.parse(outputSource));
  const frozenInput = governancePolicyInputSchema.parse(JSON.parse(z.string().parse(request.checkpoint.input_json)));
  const retentionInput = z.object({
    retentionPolicyVersion: z.string().optional(),
    retentionTargets: z.array(z.object({ memoryId: z.string(), subjectHash: z.string() })).max(20).optional()
  }).parse(JSON.parse(z.string().parse(request.checkpoint.input_json)));
  if (retentionInput.retentionPolicyVersion === retentionValuePolicyVersion) {
    for (const assessment of parsedReview.retentionAssessments ?? []) {
      const target = retentionInput.retentionTargets?.find(item => item.memoryId === assessment.memoryId);
      if (target === undefined) continue;
      const current = await readCanonicalMemory({ ...request, memoryId: target.memoryId });
      if (current === undefined || retentionSubjectHash(current.memory) !== target.subjectHash) continue;
      const value = retentionValueSchema.parse({ contentKind: assessment.contentKind, horizon: assessment.horizon,
        priority: assessment.priority, futureUse: assessment.futureUse, reason: assessment.reason });
      await recordRetentionAssessment({ ...request, memory: current.memory,
        assessment: { ...value, policyVersion: retentionInput.retentionPolicyVersion }, assessedAt: request.now });
    }
  }
  const currentRevisions = new Map<string, string>();
  if (parsedReview.decisionEvidence !== undefined) {
    const evidenceDatabase = await openRuntimeDatabase(request.runtimeRoot);
    try {
      const lookup = evidenceDatabase.prepare("SELECT current_revision_id FROM memory_catalog WHERE memory_id = ?");
      for (const memory of frozenInput.memories) {
        const row = lookup.get(memory.memoryId);
        if (typeof row?.current_revision_id === "string") currentRevisions.set(memory.memoryId, row.current_revision_id);
      }
    } finally { evidenceDatabase.close(); }
  }
  const review = parsedReview.decisionEvidence === undefined ? parsedReview :
    enforceGovernanceDecisionPolicy(frozenInput, parsedReview, currentRevisions);
  for (const [index, action] of review.agentActions.entries()) {
    await applyAgentAction({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      runId: request.run.runId,
      checkpointId,
      coverageThrough: request.run.coverageThrough,
      action,
      actionKey: sha256(`${request.run.runId}:${checkpointId}:agent:${String(index)}:${JSON.stringify(action)}`)
    });
  }
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const [index, suggestion] of review.reviewSuggestions.entries()) {
        const proof = review.decisionEvidence?.find(item =>
          item.kind === "review_suggestion" && item.targetMemoryId === suggestion.targetMemoryId);
        const evidenceRefs = proof === undefined ? suggestion.evidenceRefs :
          [...proof.citations.map(item => `${item.memoryId}@${item.revisionId}`),
            ...frozenInput.memories.filter(memory => memory.memoryId === suggestion.targetMemoryId)
              .map(memory => `target:${memory.memoryId}@${memory.revisionId}`)].sort();
        const evidenceSource = JSON.stringify([...new Set(evidenceRefs)]);
        // The same revision evidence must not create another reminder each month,
        // including after a user dismissed or accepted the previous suggestion.
        const existing = database.prepare(
          `SELECT suggestion_id FROM governance_review_suggestions
           WHERE target_memory_id = ? AND suggestion_kind = ? AND evidence_refs_json = ? LIMIT 1`
        ).get(suggestion.targetMemoryId, suggestion.kind, evidenceSource);
        if (existing !== undefined) continue;
        const actionKey = sha256(`${request.run.runId}:${checkpointId}:review:${String(index)}:${JSON.stringify(suggestion)}`);
        const suggestionId = `msgovsuggest_${randomUUID()}`;
        database.prepare(
          `INSERT OR IGNORE INTO governance_review_suggestions(
             suggestion_id, run_id, target_memory_id, suggestion_kind,
             reason, evidence_refs_json, state, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`
        ).run(
          suggestionId, request.run.runId, suggestion.targetMemoryId,
          suggestion.kind, suggestion.reason, evidenceSource, request.now
        );
        database.prepare(
          `INSERT OR IGNORE INTO governance_actions(
             action_id, run_id, checkpoint_id, action_key, action_kind,
             target_memory_id, result_json, applied_at
           ) VALUES (?, ?, ?, ?, 'review_suggestion', ?, ?, ?)`
        ).run(
          `msgovaction_${randomUUID()}`, request.run.runId, checkpointId, actionKey,
          suggestion.targetMemoryId, JSON.stringify({ state: "open", suggestionId }), request.now
        );
      }
      for (const [index, obligation] of review.futurePurgeObligations.entries()) {
        const purgeId = `msgovpurge_${randomUUID()}`;
        database.prepare(
          `INSERT OR IGNORE INTO future_purge_obligations(
             purge_obligation_id, run_id, memory_id, not_before,
             reason, state, created_at
           ) VALUES (?, ?, ?, ?, ?, 'pending', ?)`
        ).run(
          purgeId, request.run.runId, obligation.memoryId,
          obligation.notBefore, obligation.reason, request.now
        );
        database.prepare(
          `INSERT OR IGNORE INTO governance_actions(
             action_id, run_id, checkpoint_id, action_key, action_kind,
             target_memory_id, result_json, applied_at
           ) VALUES (?, ?, ?, ?, 'future_purge', ?, ?, ?)`
        ).run(
          `msgovaction_${randomUUID()}`, request.run.runId, checkpointId,
          sha256(`${request.run.runId}:${checkpointId}:purge:${String(index)}:${JSON.stringify(obligation)}`),
          obligation.memoryId, JSON.stringify({ state: "pending", purgeId }), request.now
        );
      }
      database.prepare(
        `UPDATE governance_checkpoints
         SET state = 'applied', applied_at = ?, lease_token = NULL,
             leased_by = NULL, lease_until = NULL
         WHERE checkpoint_id = ? AND state = 'reviewed'`
      ).run(request.now, checkpointId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
  return { state: "applied", runId: request.run.runId, phase, pageOrdinal };
}

async function finalizeRun(runtimeRoot: string, run: RunRow, now: string): Promise<StepResult> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const checkpoints = database.prepare(
        `SELECT output_json FROM governance_checkpoints
         WHERE run_id = ? AND state = 'applied' ORDER BY phase, page_ordinal`
      ).all(run.runId);
      const summaryItems = checkpoints.flatMap((row) => {
        const source = z.string().parse(row.output_json);
        return governanceOutputSchema.parse(JSON.parse(source)).summaryItems;
      }).slice(0, 32);
      database.prepare(
        `UPDATE governance_obligations
         SET state = 'satisfied', satisfied_at = ?
         WHERE run_id = ? AND state = 'linked'`
      ).run(now, run.runId);
      if (run.includesWeekly) {
        database.prepare(
          `UPDATE governance_cursors SET successful_through = ?, updated_at = ?
           WHERE cadence = 'weekly'`
        ).run(run.coverageThrough, now);
      }
      if (run.runKind === "monthly") {
        database.prepare(
          `UPDATE governance_cursors SET successful_through = ?, updated_at = ?
           WHERE cadence = 'monthly'`
        ).run(run.coverageThrough, now);
      }
      database.prepare(
        `UPDATE governance_runs
         SET state = 'completed', summary_json = ?, completed_at = ?, updated_at = ?
         WHERE run_id = ? AND state IN ('pending', 'processing')`
      ).run(JSON.stringify({ summaryItems }), now, now, run.runId);
      database.exec("COMMIT");
      return { state: "completed", runId: run.runId, summaryItemCount: summaryItems.length };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function runNextGovernanceStep(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly now: string;
  readonly adapter: GovernanceAdapter;
  readonly workerId?: string;
  readonly modelLeaseSeconds?: number;
  readonly foregroundTurnCompleted?: boolean;
}): Promise<StepResult> {
  const now = z.iso.datetime().parse(request.now);
  const workerId = z.string().min(1).parse(request.workerId ?? `worker-${String(process.pid)}`);
  const leaseSeconds = z.number().int().positive().parse(request.modelLeaseSeconds ?? 900);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let run: RunRow | undefined;
  try {
    const row = database.prepare(
      `SELECT * FROM governance_runs
       WHERE state IN ('pending', 'processing', 'retrying', 'blocked')
       ORDER BY created_at LIMIT 1`
    ).get();
    if (row === undefined) return { state: "idle" };
    run = parseRun(row);
    if (run.state === "blocked") return { state: "blocked" };
    if (run.state === "retrying" &&
        typeof row.next_retry_at === "string" && row.next_retry_at > now) {
      return { state: "idle" };
    }
    const overdueRetry = run.state === "retrying" &&
      typeof row.next_retry_at === "string" && row.next_retry_at <= now;
    const reviewedCheckpoint = database.prepare(
      `SELECT 1 FROM governance_checkpoints
       WHERE run_id = ? AND phase = ? AND state = 'reviewed'
       LIMIT 1`
    ).get(run.runId, run.currentPhase);
    const backlog = database.prepare(
      `SELECT 1 FROM capture_events
       WHERE state IN ('pending', 'processing', 'retrying') LIMIT 1`
    ).get();
    const indexBacklog = database.prepare(
      `SELECT 1 FROM retrieval_index_build_activity
       WHERE singleton = 1 AND state = 'building' AND lease_until > ?`
    ).get(now);
    if (indexBacklog !== undefined ||
        (backlog !== undefined && request.foregroundTurnCompleted !== true &&
          !overdueRetry && reviewedCheckpoint === undefined)) {
      return { state: "yielded", reason: "foreground_backlog" };
    }
  } finally {
    database.close();
  }
  if (run.currentPhase === "finalize") {
    return finalizeRun(request.runtimeRoot, run, now);
  }

  const checkpointDatabase = await openRuntimeDatabase(request.runtimeRoot);
  let reviewed: Record<string, unknown> | undefined;
  try {
    reviewed = checkpointDatabase.prepare(
      `SELECT * FROM governance_checkpoints
       WHERE run_id = ? AND phase = ? AND state = 'reviewed'
       ORDER BY page_ordinal LIMIT 1`
    ).get(run.runId, run.currentPhase);
  } finally {
    checkpointDatabase.close();
  }
  if (reviewed !== undefined) {
    return applyReviewedCheckpoint({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      run,
      checkpoint: reviewed,
      now
    });
  }

  const inspectionDatabase = await openRuntimeDatabase(request.runtimeRoot);
  let checkpoint: Record<string, unknown> | undefined;
  let pageOrdinal: number;
  let members: readonly Record<string, unknown>[] = [];
  try {
    const pageSizeRow = inspectionDatabase.prepare(
      "SELECT page_size FROM governance_schedule WHERE singleton = 1"
    ).get();
    const pageSize = z.number().int().positive().parse(pageSizeRow?.page_size);
    const appliedCountRow = inspectionDatabase.prepare(
      `SELECT COUNT(*) AS count FROM governance_checkpoints
       WHERE run_id = ? AND phase = ? AND state = 'applied'`
    ).get(run.runId, run.currentPhase);
    pageOrdinal = z.number().int().nonnegative().parse(appliedCountRow?.count);
    checkpoint = inspectionDatabase.prepare(
      `SELECT * FROM governance_checkpoints
       WHERE run_id = ? AND phase = ? AND page_ordinal = ?`
    ).get(run.runId, run.currentPhase, pageOrdinal);
    if (checkpoint === undefined) {
      members = inspectionDatabase.prepare(
        `SELECT memory_id, revision_id FROM governance_run_members
         WHERE run_id = ? AND phase = ? AND member_ordinal >= ?
         ORDER BY member_ordinal LIMIT ?`
      ).all(run.runId, run.currentPhase, pageOrdinal * pageSize, pageSize);
    }
  } finally {
    inspectionDatabase.close();
  }
  if (checkpoint === undefined && members.length === 0) {
    const nextPhase = run.currentPhase === "weekly" && run.runKind === "monthly"
      ? "monthly"
      : "finalize";
    const phaseDatabase = await openRuntimeDatabase(request.runtimeRoot);
    try {
      phaseDatabase.prepare(
        `UPDATE governance_runs SET current_phase = ?, state = 'pending', updated_at = ?
         WHERE run_id = ? AND current_phase = ?`
      ).run(nextPhase, now, run.runId, run.currentPhase);
    } finally {
      phaseDatabase.close();
    }
    return { state: "phase_advanced", runId: run.runId, phase: nextPhase };
  }
  let preparedInput: { readonly source: string; readonly lastMemoryId: string } | undefined;
  if (checkpoint === undefined) {
    const memories: GovernanceMemoryInput[] = [];
    for (const member of members) {
      const memory = await snapshotRevision({
        runtimeRoot: request.runtimeRoot,
        vaultRoot: request.vaultRoot,
        memoryId: z.string().parse(member.memory_id),
        revisionId: z.string().parse(member.revision_id)
      });
      memories.push(memoryInput(memory));
    }
    const from = run.currentPhase === "weekly" ? run.weeklyFrom : run.monthlyFrom;
    if (from === null) throw new Error("Governance phase has no coverage start.");
    const auditSignals = run.currentPhase === "monthly"
      ? await loadAuditSignals(request.runtimeRoot, from, run.coverageThrough, memories.map(memory => memory.memoryId))
      : undefined;
    let completedPage = { memories, auditSignals };
    if (auditSignals !== undefined) {
      const evidenceDatabase = await openRuntimeDatabase(request.runtimeRoot);
      try {
        const frozen = evidenceDatabase.prepare(
          `SELECT member.revision_id FROM governance_run_members AS member
           JOIN memory_catalog AS catalog ON catalog.memory_id = member.memory_id
           WHERE member.run_id = ? AND member.phase = 'monthly' AND member.memory_id = ?
             AND member.revision_id = catalog.current_revision_id AND catalog.lifecycle = 'active'`
        );
        // Filter stale base revisions too: current cluster conclusions must not
        // be applied to a different frozen revision of the same identity.
        const current = (id: string): string | undefined => {
          const row = frozen.get(run.runId, id);
          return typeof row?.revision_id === "string" ? row.revision_id : undefined;
        };
        const usable = (ids: readonly string[]): boolean => ids.every(id => {
          const revision = current(id);
          const base = memories.find(memory => memory.memoryId === id);
          return revision !== undefined && (base === undefined || base.revisionId === revision);
        });
        completedPage = await completePageEvidence(memories, {
          ...auditSignals,
          exactDuplicateGroups: auditSignals.exactDuplicateGroups.filter(usable),
          reviewedDuplicateClusters: auditSignals.reviewedDuplicateClusters.filter(cluster => usable(cluster.memoryIds))
        }, async id => {
          const revisionId = current(id);
          if (revisionId === undefined) return undefined;
          const result = await readCanonicalRevision({ runtimeRoot: request.runtimeRoot, vaultRoot: request.vaultRoot, memoryId: id, revisionId });
          return result === undefined ? undefined : memoryInput(result.memory);
        });
      } finally { evidenceDatabase.close(); }
    }
    const retentionCache = await loadRetentionAssessmentCache(request.runtimeRoot);
    const retentionTargets = completedPage.memories.filter(memory => memory.authority === "agent_derived" && memory.lifecycle === "active" &&
      matchRetentionAssessment(retentionCache, memory) === undefined).slice(0, 20)
      .map(memory => ({ memoryId: memory.memoryId, subjectHash: retentionSubjectHash(memory) }));
    preparedInput = {
      source: JSON.stringify({
        retentionPolicyVersion: retentionValuePolicyVersion,
        retentionTargets,
        schemaVersion: 1,
        runId: run.runId,
        runKind: run.runKind,
        phase: run.currentPhase,
        coverage: { from, through: run.coverageThrough },
        pageOrdinal,
        memories: completedPage.memories,
        ...(completedPage.auditSignals === undefined ? {} : { auditSignals: completedPage.auditSignals })
      } satisfies GovernancePageRequest),
      lastMemoryId: z.string().parse(memories.at(-1)?.memoryId)
    };
  }

  const setupDatabase = await openRuntimeDatabase(request.runtimeRoot);
  try {
    setupDatabase.exec("BEGIN IMMEDIATE");
    try {
      if (preparedInput !== undefined) {
        setupDatabase.prepare(
          `INSERT OR IGNORE INTO governance_checkpoints(
             checkpoint_id, run_id, phase, page_ordinal, page_last_memory_id,
             input_json, input_sha256, state, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?)`
        ).run(
          `msgovcheckpoint_${randomUUID()}`, run.runId, run.currentPhase, pageOrdinal,
          preparedInput.lastMemoryId, preparedInput.source, sha256(preparedInput.source), now
        );
      }
      checkpoint = setupDatabase.prepare(
        `SELECT * FROM governance_checkpoints
         WHERE run_id = ? AND phase = ? AND page_ordinal = ?`
      ).get(run.runId, run.currentPhase, pageOrdinal);
      if (checkpoint === undefined) throw new Error("Governance checkpoint creation failed.");
      const checkpointId = z.string().min(1).parse(checkpoint.checkpoint_id);
      if (checkpoint.state === "model_processing" &&
          typeof checkpoint.lease_until === "string" && checkpoint.lease_until >= now) {
        setupDatabase.exec("COMMIT");
        return { state: "busy" };
      }
      const leaseToken = `msgovlease_${randomUUID()}`;
      const leaseUntil = new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
      const claimed = setupDatabase.prepare(
        `UPDATE governance_checkpoints
         SET state = 'model_processing', lease_token = ?, leased_by = ?, lease_until = ?
         WHERE checkpoint_id = ? AND (
           state = 'prepared' OR (state = 'model_processing' AND lease_until < ?)
         )`
      ).run(leaseToken, workerId, leaseUntil, checkpointId, now);
      if (claimed.changes !== 1) {
        setupDatabase.exec("COMMIT");
        return { state: "busy" };
      }
      setupDatabase.prepare(
        `UPDATE governance_runs SET state = 'processing', attempt_count = attempt_count + 1,
         next_retry_at = NULL, updated_at = ? WHERE run_id = ?`
      ).run(now, run.runId);
      checkpoint = { ...checkpoint, lease_token: leaseToken, state: "model_processing" };
      setupDatabase.exec("COMMIT");
    } catch (error) {
      setupDatabase.exec("ROLLBACK");
      throw error;
    }
  } finally {
    setupDatabase.close();
  }
  const checkpointId = z.string().min(1).parse(checkpoint.checkpoint_id);
  const checkpointLeaseToken = z.string().min(1).parse(checkpoint.lease_token);
  const inputSource = z.string().parse(checkpoint.input_json);
  if (sha256(inputSource) !== checkpoint.input_sha256) {
    throw new Error("Governance checkpoint input integrity check failed.");
  }
  const input = JSON.parse(inputSource) as GovernancePageRequest;
  try {
    const parsed = governanceOutputSchema.safeParse(await request.adapter.reviewPage(input));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new LunaInvocationError("schema_invalid", true, "Governance response failed schema validation.", {
        stage: "output_schema", code: issue?.code ?? "schema_mismatch",
        ...(issue === undefined || issue.path.length === 0 ? {} : { path: issue.path.join(".") })
      });
    }
    const output = parsed.data;
    await validateReview(
      request.runtimeRoot,
      run.runId,
      output
    );
    const outputSource = JSON.stringify(output);
    const resultDatabase = await openRuntimeDatabase(request.runtimeRoot);
    try {
      resultDatabase.exec("BEGIN IMMEDIATE");
      try {
        const updated = resultDatabase.prepare(
          `UPDATE governance_checkpoints
           SET state = 'reviewed', output_json = ?, output_sha256 = ?,
               lease_token = NULL, leased_by = NULL, lease_until = NULL
           WHERE checkpoint_id = ? AND state = 'model_processing' AND lease_token = ?`
        ).run(outputSource, sha256(outputSource), checkpointId, checkpointLeaseToken);
        if (updated.changes !== 1) throw new Error("Governance model lease was lost.");
        resultDatabase.prepare(
          `UPDATE governance_runs
           SET consecutive_failure_count = 0, last_error_category = NULL, last_error_diagnostic_json = NULL, updated_at = ?
           WHERE run_id = ?`
        ).run(now, run.runId);
        resultDatabase.exec("COMMIT");
      } catch (error) {
        resultDatabase.exec("ROLLBACK");
        throw error;
      }
    } finally {
      resultDatabase.close();
    }
    await recordLunaWorkSuccess({ runtimeRoot: request.runtimeRoot, completedAt: now });
    return {
      state: "reviewed",
      runId: run.runId,
      phase: input.phase,
      pageOrdinal: input.pageOrdinal
    };
  } catch (error) {
    const sqliteBusy = typeof error === "object" && error !== null && "errcode" in error &&
      (error.errcode === 5 || error.errcode === 6);
    const invocationError = error instanceof LunaInvocationError
      ? error
      : new LunaInvocationError("local_processing", sqliteBusy, "Governance failed during local processing.", {
        stage: "local_processing", code: sqliteBusy ? "sqlite_busy" : "governance_processing_failed"
      });
    const failureAttemptCount = run.consecutiveFailureCount + 1;
    const failure = await recordLunaWorkFailure({
      runtimeRoot: request.runtimeRoot,
      workId: `${run.runId}:${input.phase}:${String(input.pageOrdinal)}`,
      attemptCount: failureAttemptCount,
      failedAt: now,
      error: invocationError
    });
    const failureDatabase = await openRuntimeDatabase(request.runtimeRoot);
    try {
      failureDatabase.exec("BEGIN IMMEDIATE");
      failureDatabase.prepare(
        `UPDATE governance_checkpoints
         SET state = 'prepared', lease_token = NULL, leased_by = NULL, lease_until = NULL
         WHERE checkpoint_id = ? AND lease_token = ?`
      ).run(checkpointId, checkpointLeaseToken);
      failureDatabase.prepare(
        `UPDATE governance_runs SET state = ?, next_retry_at = ?,
         last_error_category = ?, last_error_diagnostic_json = ?, consecutive_failure_count = ?, updated_at = ?
         WHERE run_id = ?`
      ).run(
        failure.state,
        failure.nextRetryAt,
        invocationError.category,
        diagnosticSource(invocationError.diagnostic),
        failureAttemptCount,
        now,
        run.runId
      );
      failureDatabase.exec("COMMIT");
    } catch (databaseError) {
      failureDatabase.exec("ROLLBACK");
      throw databaseError;
    } finally {
      failureDatabase.close();
    }
    if (failure.state === "blocked" || failure.nextRetryAt === null) return { state: "blocked" };
    return { state: "retrying", runId: run.runId, nextRetryAt: failure.nextRetryAt };
  }
}
