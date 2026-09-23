import { z } from "zod";
import { lunaModelIdentity } from "../luna/model.js";

import { resumeCapacityCandidates } from "../vault/active-capacity.js";
import {
  evaluateCandidate,
  type CandidateContent,
  type SemanticAssessment
} from "../candidates/index.js";
import { readCapturedEvent } from "../capture/index.js";
import {
  LunaInvocationError,
  type LunaEvidence,
  type SemanticAssessmentOutput,
  type SemanticAssessmentRequest
} from "../luna/index.js";
import {
  claimLunaOperation,
  completeLunaOperation,
  enqueueLunaOperation,
  failLunaOperation,
  failLunaOperationLocally,
  type LunaOperationView
} from "../luna/operations.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import { mapCapturedEventToLunaEvidence } from "./evidence.js";

export interface CandidateAssessmentAdapter {
  assessCandidateSemantics(
    request: SemanticAssessmentRequest
  ): Promise<SemanticAssessmentOutput>;
}

export type PrepareCandidateEvaluationResult =
  | { readonly state: "empty" }
  | {
      readonly state: "evaluated";
      readonly candidateId: string;
      readonly evaluationState: "promoted" | "wait" | "rejected" | "conflict";
    }
  | {
      readonly state: "assessment_queued";
      readonly candidateId: string;
      readonly operationId: string;
    };

export type AdvanceCandidateReevaluationBackfillResult =
  | { readonly state: "empty" }
  | {
      readonly state: "advanced" | "completed";
      readonly scannedCandidateCount: number;
      readonly reopenedCandidateCount: number;
    };

export async function advanceCandidateReevaluationBackfill(request: {
  readonly runtimeRoot: string;
  readonly now: string;
  readonly maximumCandidates?: number;
}): Promise<AdvanceCandidateReevaluationBackfillResult> {
  const now = z.iso.datetime().parse(request.now);
  const maximumCandidates = z.number().int().min(1).max(256).parse(
    request.maximumCandidates ?? 64
  );
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const preflight = database.prepare(
      `SELECT state FROM candidate_reevaluation_backfill WHERE singleton = 1`
    ).get();
    if (preflight?.state !== "active") return { state: "empty" };
    database.exec("BEGIN IMMEDIATE");
    try {
      const progress = database.prepare(
        `SELECT state, last_candidate_id
         FROM candidate_reevaluation_backfill WHERE singleton = 1`
      ).get();
      if (progress?.state !== "active") {
        database.exec("COMMIT");
        return { state: "empty" };
      }
      const lastCandidateId = typeof progress.last_candidate_id === "string"
        ? progress.last_candidate_id
        : "";
      const rows = database.prepare(
        `SELECT candidate.candidate_id,
                CASE WHEN
                  candidate.state = 'waiting'
                  AND candidate.successful_evaluation_at IS NOT NULL
                  AND (
                    SELECT decision.reason
                    FROM governance_decisions AS decision
                    WHERE decision.candidate_id = candidate.candidate_id
                    ORDER BY decision.decided_at DESC, decision.decision_id DESC
                    LIMIT 1
                  ) = 'insufficient_evidence'
                  AND EXISTS (
                    SELECT 1
                    FROM candidate_evidence AS evidence
                    JOIN capture_events AS capture
                      ON capture.event_id = evidence.evidence_id
                    WHERE evidence.candidate_id = candidate.candidate_id
                      AND evidence.evidence_class = 'command_outcome'
                      AND evidence.integrity = 'intact'
                      AND evidence.source_truncated = 0
                      AND evidence.memory_echo = 0
                      AND evidence.evidence_content_identity IS NOT NULL
                      AND capture.event_kind = 'PostToolUse'
                      AND capture.source_truncated = 0
                      AND capture.whole_content_sha256 = evidence.evidence_content_identity
                      AND capture.occurred_at = evidence.occurred_at
                      AND evidence.source_identity =
                        capture.agent || ':' ||
                        COALESCE(capture.session_id, 'unknown') || ':' ||
                        COALESCE(capture.turn_id, capture.event_id)
                      AND NOT (
                        evidence.command_text IS NOT NULL
                        AND length(evidence.command_text) > 0
                        AND evidence.command_cwd IS NOT NULL
                        AND evidence.command_cwd LIKE '/%'
                        AND evidence.command_exit_code IS NOT NULL
                        AND evidence.command_result_identity IS NOT NULL
                      )
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM semantic_assessments AS assessment
                    WHERE assessment.candidate_id = candidate.candidate_id
                      AND assessment.evidence_generation = candidate.evidence_generation
                  )
                THEN 1 ELSE 0 END AS should_reopen
         FROM memory_candidates AS candidate
         WHERE candidate.candidate_id > ?
         ORDER BY candidate.candidate_id
         LIMIT ?`
      ).all(lastCandidateId, maximumCandidates);
      let reopenedCandidateCount = 0;
      const reopen = database.prepare(
        `UPDATE memory_candidates
         SET successful_evaluation_at = NULL, updated_at = ?
         WHERE candidate_id = ? AND successful_evaluation_at IS NOT NULL`
      );
      for (const row of rows) {
        if (row.should_reopen !== 1) continue;
        reopenedCandidateCount += Number(
          reopen.run(now, z.string().parse(row.candidate_id)).changes
        );
      }
      const completed = rows.length < maximumCandidates;
      const newestCandidateId = rows.length === 0
        ? lastCandidateId
        : z.string().parse(rows.at(-1)?.candidate_id);
      database.prepare(
        `UPDATE candidate_reevaluation_backfill
         SET state = ?, last_candidate_id = ?,
             scanned_candidate_count = scanned_candidate_count + ?,
             reopened_candidate_count = reopened_candidate_count + ?,
             updated_at = ?
         WHERE singleton = 1`
      ).run(
        completed ? "completed" : "active",
        newestCandidateId || null,
        rows.length,
        reopenedCandidateCount,
        now
      );
      database.exec("COMMIT");
      return {
        state: completed ? "completed" : "advanced",
        scannedCandidateCount: rows.length,
        reopenedCandidateCount
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function prepareNextCandidateEvaluation(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly now: string;
}): Promise<PrepareCandidateEvaluationResult> {
  const now = z.iso.datetime().parse(request.now);
  await resumeCapacityCandidates(request);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let candidateId: string | undefined;
  try {
    const candidate = database.prepare(
      `SELECT candidate.candidate_id
       FROM memory_candidates AS candidate
       WHERE candidate.state = 'waiting'
         AND candidate.promotion_generation IS NULL
         AND candidate.successful_evaluation_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM luna_operations AS operation
           WHERE operation.operation_kind = 'semantic_assessment'
             AND operation.state IN ('pending', 'processing', 'retrying', 'blocked')
             AND json_extract(operation.payload_json, '$.candidateId') = candidate.candidate_id
             AND json_extract(operation.payload_json, '$.evidenceGeneration') = candidate.evidence_generation
         )
       ORDER BY candidate.updated_at, candidate.candidate_id LIMIT 1`
    ).get();
    if (typeof candidate?.candidate_id === "string") {
      candidateId = candidate.candidate_id;
    }
  } finally {
    database.close();
  }
  if (candidateId === undefined) return { state: "empty" };

  const evaluation = await evaluateCandidate({
    runtimeRoot: request.runtimeRoot,
    vaultRoot: request.vaultRoot,
    candidateId,
    evaluatedAt: now
  });
  if (evaluation.state !== "wait" || evaluation.reason !== "semantic_assessment_required") {
    return {
      state: "evaluated",
      candidateId,
      evaluationState: evaluation.state
    };
  }
  const operation = await enqueueCandidateAssessment({
    runtimeRoot: request.runtimeRoot,
    candidateId,
    createdAt: now
  });
  return {
    state: "assessment_queued",
    candidateId,
    operationId: operation.operationId
  };
}

export async function enqueueCandidateAssessment(request: {
  readonly runtimeRoot: string;
  readonly candidateId: string;
  readonly createdAt: string;
}): Promise<LunaOperationView> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let evidenceGeneration: number;
  try {
    const candidate = database.prepare(
      `SELECT evidence_generation FROM memory_candidates
       WHERE candidate_id = ? AND state = 'waiting'`
    ).get(request.candidateId);
    if (candidate === undefined) {
      throw new Error("Only a waiting Candidate can request semantic assessment.");
    }
    evidenceGeneration = z.number().int().positive().parse(candidate.evidence_generation);
  } finally {
    database.close();
  }
  return enqueueLunaOperation({
    runtimeRoot: request.runtimeRoot,
    kind: "semantic_assessment",
    idempotencyKey: `semantic:${request.candidateId}:${String(evidenceGeneration)}`,
    payload: { candidateId: request.candidateId, evidenceGeneration },
    createdAt: request.createdAt
  });
}

async function loadAssessmentInput(request: {
  readonly runtimeRoot: string;
  readonly candidateId: string;
}): Promise<{
  readonly candidate: CandidateContent;
  readonly evidence: readonly LunaEvidence[];
}> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let candidate: CandidateContent;
  let evidenceRows: readonly Record<string, unknown>[];
  try {
    const row = database.prepare(
      "SELECT candidate_json FROM memory_candidates WHERE candidate_id = ?"
    ).get(request.candidateId);
    if (row === undefined) throw new Error("Candidate does not exist.");
    candidate = JSON.parse(z.string().parse(row.candidate_json)) as CandidateContent;
    evidenceRows = database.prepare(
      `SELECT evidence_id, source_identity, source_truncated, memory_echo,
              project_id, occurred_at, repo_revision, command_exit_code,
              evidence_content_identity
       FROM candidate_evidence WHERE candidate_id = ? ORDER BY occurred_at`
    ).all(request.candidateId);
  } finally {
    database.close();
  }
  const evidence = await Promise.all(evidenceRows.map(async (row) => {
    const evidenceId = z.string().parse(row.evidence_id);
    const event = await readCapturedEvent(request.runtimeRoot, evidenceId);
    if (event === undefined) {
      throw new Error("Semantic assessment evidence body is unavailable.");
    }
    return mapCapturedEventToLunaEvidence({
      event,
      sourceIdentity: z.string().parse(row.source_identity),
      sourceTruncated: row.source_truncated === 1,
      ...(typeof row.evidence_content_identity === "string"
        ? { evidenceContentIdentity: row.evidence_content_identity }
        : {})
    });
  }));
  return { candidate, evidence };
}

async function readPersistedAssessment(
  runtimeRoot: string,
  operationId: string
): Promise<SemanticAssessment | undefined> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const row = database.prepare(
      `SELECT state, evidence_ids_json, durability_disposition, assessed_by
       FROM semantic_assessments WHERE operation_id = ?`
    ).get(operationId);
    if (row === undefined) return undefined;
    return {
      state: z.enum([
        "supported",
        "partially_supported",
        "contradicted",
        "insufficient_evidence"
      ]).parse(row.state),
      evidenceIds: z.array(z.string()).parse(
        JSON.parse(z.string().parse(row.evidence_ids_json))
      ),
      durabilityDisposition: z.enum([
        "durable",
        "task_local",
        "transient",
        "no_retention",
        "uncertain",
        "legacy_unclassified"
      ]).parse(row.durability_disposition),
      assessedBy: z.string().parse(row.assessed_by),
      operationId
    };
  } finally {
    database.close();
  }
}

export type RunCandidateAssessmentResult =
  | { readonly state: "empty" }
  | {
      readonly state: "completed";
      readonly operationId: string;
      readonly evaluationState: "promoted" | "wait" | "rejected" | "conflict";
    }
  | { readonly state: "retrying" | "blocked"; readonly operationId: string };

export async function runNextCandidateAssessment(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly workerId: string;
  readonly now: string;
  readonly adapter: CandidateAssessmentAdapter;
}): Promise<RunCandidateAssessmentResult> {
  const claimed = await claimLunaOperation({
    runtimeRoot: request.runtimeRoot,
    workerId: request.workerId,
    now: request.now,
    leaseSeconds: 300,
    kinds: ["semantic_assessment"]
  });
  if (claimed.state === "empty") return { state: "empty" };
  const payload = z.object({
    candidateId: z.string().min(1),
    evidenceGeneration: z.number().int().positive()
  }).parse(
    claimed.operation.payload
  );
  try {
    const input = await loadAssessmentInput({
      runtimeRoot: request.runtimeRoot,
      candidateId: payload.candidateId
    });
    const persisted = await readPersistedAssessment(
      request.runtimeRoot,
      claimed.operation.operationId
    );
    const assessment =
      persisted ??
      await request.adapter.assessCandidateSemantics({
        operationId: claimed.operation.operationId,
        statement: input.candidate.statement,
        conditions: input.candidate.conditions,
        exclusions: input.candidate.exclusions,
        evidence: input.evidence
      });
    if (persisted === undefined) {
      const database = await openRuntimeDatabase(request.runtimeRoot);
      try {
        database.prepare(
          `INSERT INTO semantic_assessments(
             assessment_id, operation_id, candidate_id, state,
             evidence_ids_json, durability_disposition, evidence_generation,
             assessed_by, assessed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `msassessment_${claimed.operation.operationId}`,
          claimed.operation.operationId,
          payload.candidateId,
          assessment.state,
          JSON.stringify(assessment.evidenceIds),
          assessment.durabilityDisposition ?? "legacy_unclassified",
          payload.evidenceGeneration,
          lunaModelIdentity,
          request.now
        );
      } finally {
        database.close();
      }
    }
    const evaluation = await evaluateCandidate({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      candidateId: payload.candidateId,
      evaluatedAt: request.now,
      semanticAssessmentOperationId: claimed.operation.operationId
    });
    await completeLunaOperation({
      runtimeRoot: request.runtimeRoot,
      operationId: claimed.operation.operationId,
      leaseToken: claimed.leaseToken,
      completedAt: request.now
    });
    return {
      state: "completed",
      operationId: claimed.operation.operationId,
      evaluationState: evaluation.state
    };
  } catch (error) {
    const failed =
      error instanceof LunaInvocationError
        ? await failLunaOperation({
            runtimeRoot: request.runtimeRoot,
            operationId: claimed.operation.operationId,
            leaseToken: claimed.leaseToken,
            failedAt: request.now,
            error
          })
        : await failLunaOperationLocally({
            runtimeRoot: request.runtimeRoot,
            operationId: claimed.operation.operationId,
            leaseToken: claimed.leaseToken,
            failedAt: request.now,
            retryable: true
          });
    return { state: failed.state, operationId: claimed.operation.operationId };
  }
}
