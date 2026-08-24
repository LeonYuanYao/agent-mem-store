import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { classifyLocalSensitivity } from "../contracts/sensitivity.js";
import type {
  ConsolidationOutput,
  DistillationOutput,
  DistilledCandidate
} from "../luna/index.js";
import { LunaInvocationError } from "../luna/index.js";
import { openRuntimeDatabase } from "../runtime/database.js";

export const admissionAuditRetentionMilliseconds = 14 * 24 * 60 * 60 * 1_000;
export const admissionAuditPruneIntervalMilliseconds = 24 * 60 * 60 * 1_000;
const admissionPolicyVersion = "atomic-admission-v1";
const maximumAdmittedCandidates = 64;

export type AdmissionRetentionDecision =
  | "long_term"
  | "project_phase"
  | "session_only"
  | "no_memory"
  | "uncertain";

export type AdmissionOutcome = "admitted" | "rejected" | "isolated";

export interface AdmissionClassification {
  readonly retentionDecision: AdmissionRetentionDecision;
  readonly outcome: AdmissionOutcome;
  readonly reason:
    | "long_term"
    | "project_phase"
    | "session_only"
    | "no_memory"
    | "uncertain"
    | "task_observation";
}

function retentionDecision(candidate: DistilledCandidate): AdmissionRetentionDecision {
  return candidate.retentionDecision ?? candidate.durability.disposition;
}

export function classifyAdmission(candidate: DistilledCandidate): AdmissionClassification {
  const decision = retentionDecision(candidate);
  if (decision === "no_memory") {
    return { retentionDecision: decision, outcome: "rejected", reason: "no_memory" };
  }
  if (decision === "session_only") {
    return { retentionDecision: decision, outcome: "rejected", reason: "session_only" };
  }
  if (decision === "uncertain") {
    return { retentionDecision: decision, outcome: "isolated", reason: "uncertain" };
  }
  if (candidate.durability.abstractionLevel === "task_observation") {
    return { retentionDecision: decision, outcome: "rejected", reason: "task_observation" };
  }
  return { retentionDecision: decision, outcome: "admitted", reason: decision };
}

export function admittedOutput<T extends DistillationOutput | ConsolidationOutput>(output: T): T {
  const candidates = output.candidates.filter((candidate) =>
    classifyAdmission(candidate).outcome === "admitted"
  );
  if (candidates.length > maximumAdmittedCandidates) {
    throw new LunaInvocationError(
      "schema_invalid",
      true,
      "Luna returned more than 64 durable admission candidates.",
      { stage: "retention_validation", code: "admitted_candidate_limit_exceeded" }
    );
  }
  return {
    ...output,
    candidates
  };
}

export async function recordAdmissionAudit(request: {
  readonly runtimeRoot: string;
  readonly operationId: string;
  readonly sourceKind: "distillation" | "consolidation";
  readonly sourceId: string;
  readonly candidates: readonly DistilledCandidate[];
  readonly promptVersion: number;
  readonly createdAt: string;
}): Promise<void> {
  const createdAt = z.iso.datetime().parse(request.createdAt);
  const promptVersion = z.number().int().positive().parse(request.promptVersion);
  const expiresAt = new Date(
    Date.parse(createdAt) + admissionAuditRetentionMilliseconds
  ).toISOString();
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("DELETE FROM admission_audit WHERE operation_id = ?").run(
        request.operationId
      );
      const insert = database.prepare(
        `INSERT INTO admission_audit(
           admission_id, operation_id, source_kind, source_id, candidate_ordinal,
           retention_decision, abstraction_level, outcome, reason,
           statement_text, statement_sha256, statement_redacted,
           evidence_ids_json, policy_version, prompt_version, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const [ordinal, candidate] of request.candidates.entries()) {
        const classification = classifyAdmission(candidate);
        const sensitivity = classifyLocalSensitivity(candidate.statement);
        const statementRedacted = sensitivity.state !== "normal";
        const identity = createHash("sha256")
          .update(`${request.operationId}:${String(ordinal)}`)
          .digest("hex")
          .slice(0, 32);
        insert.run(
          `msadmission_${identity}`,
          request.operationId,
          request.sourceKind,
          request.sourceId,
          ordinal,
          classification.retentionDecision,
          candidate.durability.abstractionLevel,
          classification.outcome,
          classification.reason,
          statementRedacted ? null : candidate.statement,
          statementRedacted
            ? null
            : createHash("sha256").update(candidate.statement).digest("hex"),
          statementRedacted ? 1 : 0,
          JSON.stringify([...new Set(candidate.evidenceIds)]),
          admissionPolicyVersion,
          promptVersion,
          createdAt,
          expiresAt
        );
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export interface AdmissionAuditView extends AdmissionClassification {
  readonly admissionId: string;
  readonly operationId: string;
  readonly sourceKind: "distillation" | "consolidation";
  readonly sourceId: string;
  readonly ordinal: number;
  readonly abstractionLevel: "reusable_rule" | "project_fact" | "task_observation";
  readonly statement?: string;
  readonly statementSha256?: string;
  readonly statementRedacted: boolean;
  readonly evidenceIds: readonly string[];
  readonly policyVersion: string;
  readonly promptVersion: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export async function inspectAdmissionAudit(request: {
  readonly runtimeRoot: string;
  readonly operationId: string;
}): Promise<readonly AdmissionAuditView[]> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    return database.prepare(
      `SELECT admission_id, operation_id, source_kind, source_id,
              candidate_ordinal, retention_decision, abstraction_level,
              outcome, reason, statement_text, statement_sha256,
              statement_redacted, evidence_ids_json, policy_version,
              prompt_version, created_at, expires_at
       FROM admission_audit
       WHERE operation_id = ?
       ORDER BY candidate_ordinal`
    ).all(request.operationId).map((row) => ({
      admissionId: z.string().parse(row.admission_id),
      operationId: z.string().parse(row.operation_id),
      sourceKind: z.enum(["distillation", "consolidation"]).parse(row.source_kind),
      sourceId: z.string().parse(row.source_id),
      ordinal: z.number().int().nonnegative().parse(row.candidate_ordinal),
      retentionDecision: z.enum([
        "long_term", "project_phase", "session_only", "no_memory", "uncertain"
      ]).parse(row.retention_decision),
      abstractionLevel: z.enum([
        "reusable_rule", "project_fact", "task_observation"
      ]).parse(row.abstraction_level),
      outcome: z.enum(["admitted", "rejected", "isolated"]).parse(row.outcome),
      reason: z.enum([
        "long_term", "project_phase", "session_only", "no_memory",
        "uncertain", "task_observation"
      ]).parse(row.reason),
      ...(typeof row.statement_text === "string" ? { statement: row.statement_text } : {}),
      ...(typeof row.statement_sha256 === "string"
        ? { statementSha256: z.string().length(64).parse(row.statement_sha256) }
        : {}),
      statementRedacted: row.statement_redacted === 1,
      evidenceIds: z.array(z.string()).parse(JSON.parse(z.string().parse(row.evidence_ids_json))),
      policyVersion: z.string().parse(row.policy_version),
      promptVersion: z.number().int().positive().parse(row.prompt_version),
      createdAt: z.iso.datetime().parse(row.created_at),
      expiresAt: z.iso.datetime().parse(row.expires_at)
    }));
  } finally {
    database.close();
  }
}

export async function pruneExpiredAdmissionAudit(request: {
  readonly runtimeRoot: string;
  readonly now: string;
}): Promise<{ readonly deletedCount: number }> {
  const now = z.iso.datetime().parse(request.now);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = database.prepare(
        "DELETE FROM admission_audit WHERE expires_at <= ?"
      ).run(now);
      database.prepare(
        `UPDATE admission_audit_maintenance
         SET next_prune_at = ?, last_pruned_at = ?
         WHERE singleton = 1`
      ).run(
        new Date(Date.parse(now) + admissionAuditPruneIntervalMilliseconds).toISOString(),
        now
      );
      database.exec("COMMIT");
      return { deletedCount: Number(result.changes) };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function boundedAuditText(value: string, limit = 320): string {
  if (value.length <= limit) return value;
  const side = Math.floor((limit - 3) / 2);
  return `${value.slice(0, side)}...${value.slice(-side)}`;
}

export function summarizeAdmissionAudit(
  database: DatabaseSync,
  request: { readonly startedAt: string; readonly now: string }
): Record<string, unknown> {
  const startedAt = z.iso.datetime().parse(request.startedAt);
  const now = z.iso.datetime().parse(request.now);
  const rows = database.prepare(
    `SELECT admission_id, retention_decision, outcome, reason,
            statement_text, statement_redacted, created_at
     FROM admission_audit
     WHERE created_at >= ? AND expires_at > ?
     ORDER BY created_at, admission_id`
  ).all(startedAt, now);
  const outcomes = { admitted: 0, rejected: 0, isolated: 0 };
  const decisions = {
    long_term: 0,
    project_phase: 0,
    session_only: 0,
    no_memory: 0,
    uncertain: 0
  };
  const reasons = {
    long_term: 0,
    project_phase: 0,
    session_only: 0,
    no_memory: 0,
    uncertain: 0,
    task_observation: 0
  };
  let redactedCount = 0;
  const parsed = rows.map((row) => {
    const outcome = z.enum(["admitted", "rejected", "isolated"]).parse(row.outcome);
    const decision = z.enum([
      "long_term", "project_phase", "session_only", "no_memory", "uncertain"
    ]).parse(row.retention_decision);
    const reason = z.enum([
      "long_term", "project_phase", "session_only", "no_memory",
      "uncertain", "task_observation"
    ]).parse(row.reason);
    outcomes[outcome] += 1;
    decisions[decision] += 1;
    reasons[reason] += 1;
    if (row.statement_redacted === 1) redactedCount += 1;
    return {
      admissionId: z.string().parse(row.admission_id),
      retentionDecision: decision,
      outcome,
      reason,
      ...(typeof row.statement_text === "string"
        ? { statement: boundedAuditText(row.statement_text) }
        : { statementRedacted: true }),
      createdAt: z.iso.datetime().parse(row.created_at)
    };
  });
  return {
    policyVersion: admissionPolicyVersion,
    retentionDays: admissionAuditRetentionMilliseconds / (24 * 60 * 60 * 1_000),
    totalCount: parsed.length,
    outcomes,
    decisions,
    reasons,
    redactedCount,
    rejectedSamples: parsed.filter((item) => item.outcome === "rejected").slice(0, 10),
    isolatedSamples: parsed.filter((item) => item.outcome === "isolated").slice(0, 10)
  };
}
