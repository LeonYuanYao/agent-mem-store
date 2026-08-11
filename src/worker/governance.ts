import { z } from "zod";

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

export async function prepareNextCandidateEvaluation(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly now: string;
}): Promise<PrepareCandidateEvaluationResult> {
  const now = z.iso.datetime().parse(request.now);
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
      `SELECT state, evidence_ids_json, assessed_by
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
             evidence_ids_json, evidence_generation, assessed_by, assessed_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'gpt-5.6-luna', ?)`
        ).run(
          `msassessment_${claimed.operation.operationId}`,
          claimed.operation.operationId,
          payload.candidateId,
          assessment.state,
          JSON.stringify(assessment.evidenceIds),
          payload.evidenceGeneration,
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
