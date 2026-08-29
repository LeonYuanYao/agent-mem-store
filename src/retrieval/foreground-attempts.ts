import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  openRuntimeDatabase,
  openRuntimeDatabaseReadOnly
} from "../runtime/database.js";

const outcomeSchema = z.enum([
  "completed",
  "empty",
  "busy",
  "deadline_exceeded",
  "cancelled",
  "unavailable",
  "failed"
]);

export const foregroundAttemptRecordSchema = z.object({
  requestId: z.string().min(1),
  eventKind: z.enum(["SessionStart", "UserPromptSubmit"]),
  eventId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  receiptId: z.string().min(1).optional(),
  indexRevisionId: z.string().min(1).optional(),
  outcome: outcomeSchema,
  admissionDelayMs: z.number().nonnegative(),
  computeMs: z.number().nonnegative(),
  receiptCommitMs: z.number().nonnegative(),
  observedClientElapsedMs: z.number().nonnegative(),
  cancellationObservedMs: z.number().nonnegative().optional(),
  postDeadlineWorkMs: z.number().nonnegative(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime()
});

export type ForegroundAttemptRecord = z.infer<typeof foregroundAttemptRecordSchema>;

export async function recordForegroundAttempt(request: {
  readonly runtimeRoot: string;
  readonly attempt: ForegroundAttemptRecord;
}): Promise<void> {
  const attempt = foregroundAttemptRecordSchema.parse(request.attempt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.prepare(
      `INSERT OR IGNORE INTO foreground_attempts(
         attempt_id, request_id, event_kind, event_id, project_id,
         receipt_id, index_revision_id, outcome, admission_delay_ms,
         compute_ms, receipt_commit_ms, observed_client_elapsed_ms,
         cancellation_observed_ms, post_deadline_work_ms, created_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `msattempt_${randomUUID()}`,
      attempt.requestId,
      attempt.eventKind,
      attempt.eventId ?? null,
      attempt.projectId ?? null,
      attempt.receiptId ?? null,
      attempt.indexRevisionId ?? null,
      attempt.outcome,
      attempt.admissionDelayMs,
      attempt.computeMs,
      attempt.receiptCommitMs,
      attempt.observedClientElapsedMs,
      attempt.cancellationObservedMs ?? null,
      attempt.postDeadlineWorkMs,
      attempt.createdAt,
      attempt.completedAt
    );
  } finally {
    database.close();
  }
}

export async function inspectForegroundAttempts(runtimeRoot: string): Promise<{
  readonly totalCount: number;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly deadlineCount: number;
  readonly cancellationCount: number;
  readonly postDeadlineCount: number;
  readonly maximumPostDeadlineWorkMs: number;
}> {
  const database = await openRuntimeDatabaseReadOnly(runtimeRoot);
  try {
    const rows = database.prepare(
      `SELECT outcome, COUNT(*) AS count,
              MAX(post_deadline_work_ms) AS maximum_post_deadline_work_ms
       FROM foreground_attempts GROUP BY outcome`
    ).all();
    const outcomes: Record<string, number> = Object.fromEntries(rows.map((row) => [
      outcomeSchema.parse(row.outcome),
      z.number().int().nonnegative().parse(row.count)
    ]));
    const overflowRows = database.prepare(
      `SELECT outcome, SUM(occurrence_count) AS count
       FROM foreground_attempt_overflow GROUP BY outcome`
    ).all();
    for (const row of overflowRows) {
      const outcome = outcomeSchema.parse(row.outcome);
      outcomes[outcome] = (outcomes[outcome] ?? 0) +
        z.number().int().nonnegative().parse(row.count);
    }
    const totalCount = Object.values(outcomes).reduce((total, count) => total + count, 0);
    const maximumPostDeadlineWorkMs = rows.reduce((maximum, row) => Math.max(
      maximum,
      z.number().nonnegative().parse(row.maximum_post_deadline_work_ms ?? 0)
    ), 0);
    const postDeadline = database.prepare(
      "SELECT COUNT(*) AS count FROM foreground_attempts WHERE post_deadline_work_ms > 0"
    ).get();
    return {
      totalCount,
      outcomes,
      deadlineCount: outcomes.deadline_exceeded ?? 0,
      cancellationCount: outcomes.cancelled ?? 0,
      postDeadlineCount: z.number().int().nonnegative().parse(postDeadline?.count),
      maximumPostDeadlineWorkMs
    };
  } finally {
    database.close();
  }
}

export async function recordForegroundAttemptOverflow(request: {
  readonly runtimeRoot: string;
  readonly bucketAt: string;
  readonly outcome: z.infer<typeof outcomeSchema>;
  readonly occurrenceCount: number;
}): Promise<void> {
  const bucketAt = z.iso.datetime().parse(request.bucketAt);
  const outcome = outcomeSchema.parse(request.outcome);
  const occurrenceCount = z.number().int().positive().parse(request.occurrenceCount);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.prepare(
      `INSERT INTO foreground_attempt_overflow(bucket_at, outcome, occurrence_count)
       VALUES (?, ?, ?)
       ON CONFLICT(bucket_at, outcome) DO UPDATE SET
         occurrence_count = occurrence_count + excluded.occurrence_count`
    ).run(bucketAt, outcome, occurrenceCount);
  } finally {
    database.close();
  }
}

export async function pruneForegroundAttempts(request: {
  readonly runtimeRoot: string;
  readonly now: string;
  readonly retentionDays?: number;
  readonly maximumRows?: number;
}): Promise<{ readonly deletedCount: number; readonly nextPruneAt: string }> {
  const now = z.iso.datetime().parse(request.now);
  const retentionDays = z.number().int().min(1).max(365).parse(request.retentionDays ?? 30);
  const maximumRows = z.number().int().min(1).max(10_000).parse(request.maximumRows ?? 1_000);
  const cutoff = new Date(Date.parse(now) - retentionDays * 24 * 60 * 60 * 1_000).toISOString();
  const nextPruneAt = new Date(Date.parse(now) + 24 * 60 * 60 * 1_000).toISOString();
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const attemptIds = database.prepare(
        `SELECT attempt_id FROM foreground_attempts
         WHERE completed_at < ? ORDER BY completed_at, attempt_id LIMIT ?`
      ).all(cutoff, maximumRows).map((row) => z.string().parse(row.attempt_id));
      let deletedCount = 0;
      if (attemptIds.length > 0) {
        const placeholders = attemptIds.map(() => "?").join(", ");
        deletedCount += Number(database.prepare(
          `DELETE FROM foreground_attempts WHERE attempt_id IN (${placeholders})`
        ).run(...attemptIds).changes);
      }
      deletedCount += Number(database.prepare(
        "DELETE FROM foreground_attempt_overflow WHERE bucket_at < ?"
      ).run(cutoff).changes);
      database.prepare(
        "UPDATE foreground_attempt_maintenance SET next_prune_at = ? WHERE singleton = 1"
      ).run(nextPruneAt);
      database.exec("COMMIT");
      return { deletedCount, nextPruneAt };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}
