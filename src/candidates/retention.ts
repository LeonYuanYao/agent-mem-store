import { randomUUID } from "node:crypto";
import { z } from "zod";

import { openRuntimeDatabase } from "../runtime/database.js";
import type { CandidateState } from "./index.js";

const candidateStateSchema = z.enum([
  "waiting",
  "promoted",
  "merged",
  "conflict",
  "rejected",
  "expired"
]);

function addDays(value: string, days: number): string {
  const date = new Date(z.iso.datetime().parse(value));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function recordDecision(
  database: Awaited<ReturnType<typeof openRuntimeDatabase>>,
  candidateId: string,
  decision: "promote" | "merge" | "wait" | "conflict" | "reject" | "expire",
  reason: string,
  decidedAt: string
): void {
  database.prepare(
    `INSERT INTO governance_decisions(
       decision_id, candidate_id, decision, reason, decided_at
     ) VALUES (?, ?, ?, ?, ?)`
  ).run(`msdecision_${randomUUID()}`, candidateId, decision, reason, decidedAt);
}

export async function listRecallEligibleMemoryIds(runtimeRoot: string): Promise<readonly string[]> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    return database
      .prepare(
        `SELECT memory_id FROM memory_catalog
         WHERE lifecycle = 'active' ORDER BY memory_id`
      )
      .all()
      .map((row) => z.string().parse(row.memory_id));
  } finally {
    database.close();
  }
}

export async function scheduleDueCandidateExpirations(request: {
  readonly runtimeRoot: string;
  readonly evaluatedAt: string;
  readonly ordinaryDays: number;
  readonly protectedDays: number;
}): Promise<{ readonly scheduledCandidateIds: readonly string[] }> {
  const now = z.iso.datetime().parse(request.evaluatedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  const scheduledCandidateIds: string[] = [];
  try {
    database.exec("BEGIN IMMEDIATE");
    const rows = database.prepare(
      `SELECT candidate.*, EXISTS(
         SELECT 1 FROM verification_requests AS request
         WHERE request.candidate_id = candidate.candidate_id AND request.state = 'open'
       ) AS has_open_request
       FROM memory_candidates AS candidate
       WHERE candidate.state IN ('waiting', 'conflict') AND candidate.pinned = 0
         AND candidate.promotion_generation IS NULL`
    ).all();
    for (const row of rows) {
      const protectedCandidate =
        row.high_value === 1 || row.state === "conflict" || row.has_open_request === 1;
      const dueAt = addDays(
        z.string().parse(row.last_evidence_at),
        protectedCandidate ? request.protectedDays : request.ordinaryDays
      );
      if (dueAt > now) continue;
      const candidateId = z.string().parse(row.candidate_id);
      const inserted = database.prepare(
        `INSERT INTO candidate_expiration_obligations(
           candidate_id, due_at, state, created_at
         ) VALUES (?, ?, 'pending', ?)
         ON CONFLICT(candidate_id) DO UPDATE SET
           due_at = excluded.due_at,
           state = 'pending',
           created_at = excluded.created_at,
           evaluated_at = NULL
         WHERE candidate_expiration_obligations.state = 'cancelled'`
      ).run(candidateId, dueAt, now);
      if (inserted.changes === 1) scheduledCandidateIds.push(candidateId);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  return { scheduledCandidateIds };
}

export async function expireDueCandidates(request: {
  readonly runtimeRoot: string;
  readonly evaluatedAt: string;
  readonly ordinaryDays: number;
  readonly protectedDays: number;
  readonly tombstoneDays?: number;
}): Promise<{ readonly expiredCandidateIds: readonly string[] }> {
  const now = z.iso.datetime().parse(request.evaluatedAt);
  const tombstoneDays = z.number().int().positive().parse(request.tombstoneDays ?? 180);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  const expiredCandidateIds: string[] = [];
  try {
    database.exec("BEGIN IMMEDIATE");
    const rows = database.prepare(
      `SELECT candidate.*, EXISTS(
         SELECT 1 FROM verification_requests AS request
         WHERE request.candidate_id = candidate.candidate_id AND request.state = 'open'
       ) AS has_open_request
       FROM memory_candidates AS candidate
       WHERE candidate.state IN ('waiting', 'conflict') AND candidate.pinned = 0
         AND candidate.promotion_generation IS NULL
         AND candidate.successful_evaluation_at IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM candidate_expiration_obligations AS obligation
           WHERE obligation.candidate_id = candidate.candidate_id
             AND obligation.state = 'pending' AND obligation.due_at <= ?
         )`
    ).all(now);
    for (const row of rows) {
      const protectedCandidate =
        row.high_value === 1 || row.state === "conflict" || row.has_open_request === 1;
      const deadline = addDays(
        z.string().parse(row.last_evidence_at),
        protectedCandidate ? request.protectedDays : request.ordinaryDays
      );
      if (deadline > now) continue;
      const candidateId = z.string().parse(row.candidate_id);
      const sourceIdentities = database.prepare(
        "SELECT source_identity FROM candidate_evidence WHERE candidate_id = ? ORDER BY source_identity"
      ).all(candidateId).map((item) => z.string().parse(item.source_identity));
      const expired = database.prepare(
        `UPDATE memory_candidates
         SET state = 'expired', statement = NULL, candidate_json = NULL,
             updated_at = ?
         WHERE candidate_id = ? AND state IN ('waiting', 'conflict')
           AND promotion_generation IS NULL`
      ).run(now, candidateId);
      if (expired.changes !== 1) continue;
      recordDecision(database, candidateId, "expire", "retention_elapsed_after_governance_recheck", now);
      database.prepare(
        `INSERT OR REPLACE INTO candidate_tombstones(
           candidate_id, fingerprint, scope_kind, project_id,
           source_identities_json, expiration_reason, expired_at, delete_after
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        candidateId,
        z.string().parse(row.fingerprint),
        z.string().parse(row.scope_kind),
        typeof row.project_id === "string" ? row.project_id : null,
        JSON.stringify(sourceIdentities),
        "retention_elapsed_after_governance_recheck",
        now,
        addDays(now, tombstoneDays)
      );
      database.prepare(
        `UPDATE candidate_expiration_obligations
         SET state = 'completed', evaluated_at = ? WHERE candidate_id = ?`
      ).run(now, candidateId);
      expiredCandidateIds.push(candidateId);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  return { expiredCandidateIds };
}

export async function inspectCandidate(runtimeRoot: string, candidateId: string): Promise<{
  readonly candidateId: string;
  readonly state: CandidateState;
  readonly bodyPresent: boolean;
  readonly tombstone?: { readonly bodyPresent: false; readonly deleteAfter: string };
}> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const row = database.prepare(
      "SELECT candidate_id, state, statement FROM memory_candidates WHERE candidate_id = ?"
    ).get(candidateId);
    if (row === undefined) throw new Error("Candidate does not exist.");
    const tombstone = database.prepare(
      "SELECT delete_after FROM candidate_tombstones WHERE candidate_id = ?"
    ).get(candidateId);
    return {
      candidateId,
      state: candidateStateSchema.parse(row.state),
      bodyPresent: typeof row.statement === "string",
      ...(tombstone === undefined
        ? {}
        : { tombstone: { bodyPresent: false as const, deleteAfter: z.string().parse(tombstone.delete_after) } })
    };
  } finally {
    database.close();
  }
}

export async function inspectVerificationRequest(
  runtimeRoot: string,
  verificationRequestId: string
): Promise<{
  readonly verificationRequestId: string;
  readonly candidateId: string;
  readonly state: "open" | "completed" | "cancelled";
  readonly description: string;
  readonly proposedAction: string;
}> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const row = database.prepare(
      `SELECT candidate_id, state, description, proposed_action
       FROM verification_requests WHERE verification_request_id = ?`
    ).get(verificationRequestId);
    if (row === undefined) throw new Error("Verification Request does not exist.");
    return {
      verificationRequestId,
      candidateId: z.string().parse(row.candidate_id),
      state: z.enum(["open", "completed", "cancelled"]).parse(row.state),
      description: z.string().parse(row.description),
      proposedAction: z.string().parse(row.proposed_action)
    };
  } finally {
    database.close();
  }
}

export async function purgeDueCandidateTombstones(request: {
  readonly runtimeRoot: string;
  readonly evaluatedAt: string;
}): Promise<{ readonly purgedCandidateIds: readonly string[] }> {
  const evaluatedAt = z.iso.datetime().parse(request.evaluatedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  const purgedCandidateIds: string[] = [];
  try {
    database.exec("BEGIN IMMEDIATE");
    const rows = database.prepare(
      `SELECT tombstone.candidate_id
       FROM candidate_tombstones AS tombstone
       WHERE tombstone.delete_after <= ? AND tombstone.pinned = 0
         AND NOT EXISTS (
           SELECT 1 FROM memory_candidates AS active_candidate
           WHERE active_candidate.predecessor_tombstone_candidate_id = tombstone.candidate_id
             AND active_candidate.state != 'expired'
         )
         AND NOT EXISTS (
           SELECT 1 FROM verification_requests AS request
           WHERE request.candidate_id = tombstone.candidate_id
             AND request.state = 'open'
         )
       ORDER BY tombstone.delete_after, tombstone.candidate_id`
    ).all(evaluatedAt);
    for (const row of rows) {
      const candidateId = z.string().parse(row.candidate_id);
      database.prepare("DELETE FROM semantic_assessments WHERE candidate_id = ?").run(candidateId);
      database.prepare("DELETE FROM verification_requests WHERE candidate_id = ?").run(candidateId);
      database.prepare("DELETE FROM governance_decisions WHERE candidate_id = ?").run(candidateId);
      database.prepare("DELETE FROM candidate_evidence WHERE candidate_id = ?").run(candidateId);
      database.prepare(
        "DELETE FROM candidate_expiration_obligations WHERE candidate_id = ?"
      ).run(candidateId);
      database.prepare("DELETE FROM candidate_tombstones WHERE candidate_id = ?").run(candidateId);
      database.prepare(
        "DELETE FROM memory_candidates WHERE candidate_id = ? AND state = 'expired'"
      ).run(candidateId);
      purgedCandidateIds.push(candidateId);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  return { purgedCandidateIds };
}
