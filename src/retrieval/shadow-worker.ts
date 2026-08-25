import { z } from "zod";

import { readCapturedEvent } from "../capture/index.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import type { EmbeddingAdapter } from "./index.js";
import {
  prepareSessionStartShadowPack,
  prepareUserPromptShadowPack
} from "./packs.js";

type ShadowEvaluationResult =
  | { readonly state: "empty" }
  | { readonly state: "completed"; readonly eventId: string; readonly receiptId: string }
  | { readonly state: "skipped"; readonly eventId: string; readonly reason: string }
  | { readonly state: "retrying"; readonly eventId: string; readonly errorCode: string };

export async function reserveForegroundEvaluation(request: {
  readonly runtimeRoot: string;
  readonly eventId: string;
  readonly eventKind: "SessionStart" | "UserPromptSubmit";
  readonly reservedAt: string;
}): Promise<boolean> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const result = database.prepare(
      `INSERT OR IGNORE INTO shadow_event_evaluations(
         event_id, event_kind, state, receipt_id, attempt_count, last_error_code,
         next_retry_at, created_at, updated_at
       ) VALUES (?, ?, 'processing', NULL, 1, 'foreground_reserved', NULL, ?, ?)`
    ).run(
      request.eventId,
      request.eventKind,
      request.reservedAt,
      request.reservedAt
    );
    return result.changes === 1;
  } finally {
    database.close();
  }
}

export async function finishForegroundEvaluation(request: {
  readonly runtimeRoot: string;
  readonly eventId: string;
  readonly state: "completed" | "retrying";
  readonly updatedAt: string;
  readonly receiptId?: string;
  readonly errorCode?: string;
}): Promise<void> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.prepare(
      `UPDATE shadow_event_evaluations
       SET state = ?, receipt_id = ?, last_error_code = ?, next_retry_at = ?, updated_at = ?
       WHERE event_id = ? AND state = 'processing' AND last_error_code = 'foreground_reserved'`
    ).run(
      request.state,
      request.receiptId ?? null,
      request.errorCode ?? null,
      request.state === "retrying"
        ? new Date(Date.parse(request.updatedAt) + 60_000).toISOString()
        : null,
      request.updatedAt,
      request.eventId
    );
  } finally {
    database.close();
  }
}

async function claimNextShadowEvent(runtimeRoot: string, now: string): Promise<string | undefined> {
  const staleBefore = new Date(Date.parse(now) - 5 * 60 * 1000).toISOString();
  const selectionSql = `SELECT capture.event_id, capture.event_kind
    FROM capture_events AS capture
    LEFT JOIN shadow_event_evaluations AS evaluation
      ON evaluation.event_id = capture.event_id
    WHERE capture.event_kind IN ('SessionStart', 'UserPromptSubmit')
      AND (
        evaluation.event_id IS NULL OR
        (evaluation.state = 'retrying' AND evaluation.next_retry_at <= ?) OR
        (evaluation.state = 'processing' AND evaluation.updated_at <= ?)
      )
    ORDER BY capture.created_at, capture.event_id
    LIMIT 1`;
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    if (database.prepare(selectionSql).get(now, staleBefore) === undefined) {
      return undefined;
    }
    database.exec("BEGIN IMMEDIATE");
    const row = database.prepare(selectionSql).get(now, staleBefore);
    if (row === undefined) {
      database.exec("COMMIT");
      return undefined;
    }
    const eventId = z.string().parse(row.event_id);
    const eventKind = z.enum(["SessionStart", "UserPromptSubmit"]).parse(row.event_kind);
    database.prepare(
      `INSERT INTO shadow_event_evaluations(
         event_id, event_kind, state, receipt_id, attempt_count, last_error_code,
         next_retry_at, created_at, updated_at
       ) VALUES (?, ?, 'processing', NULL, 1, NULL, NULL, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         state = 'processing', attempt_count = attempt_count + 1,
         last_error_code = NULL, next_retry_at = NULL, updated_at = excluded.updated_at`
    ).run(eventId, eventKind, now, now);
    database.exec("COMMIT");
    return eventId;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

async function finishShadowEvaluation(request: {
  readonly runtimeRoot: string;
  readonly eventId: string;
  readonly state: "completed" | "skipped" | "retrying";
  readonly updatedAt: string;
  readonly receiptId?: string;
  readonly errorCode?: string;
  readonly nextRetryAt?: string;
}): Promise<void> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.prepare(
      `UPDATE shadow_event_evaluations
       SET state = ?, receipt_id = ?, last_error_code = ?, next_retry_at = ?, updated_at = ?
       WHERE event_id = ?`
    ).run(
      request.state,
      request.receiptId ?? null,
      request.errorCode ?? null,
      request.nextRetryAt ?? null,
      request.updatedAt,
      request.eventId
    );
  } finally {
    database.close();
  }
}

async function hasActiveEpoch(runtimeRoot: string, sessionId: string): Promise<boolean> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    return database.prepare(
      "SELECT 1 AS present FROM context_epochs WHERE session_id = ? AND state = 'active'"
    ).get(sessionId) !== undefined;
  } finally {
    database.close();
  }
}

function failureCode(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return createCompactCode(error.message);
  }
  return "shadow_evaluation_failed";
}

function createCompactCode(message: string): string {
  const normalized = message.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  return normalized.length === 0 ? "shadow_evaluation_failed" : normalized.slice(0, 80);
}

export async function runNextShadowEvaluation(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly adapter: EmbeddingAdapter;
  readonly now: string;
}): Promise<ShadowEvaluationResult> {
  const now = z.iso.datetime().parse(request.now);
  const eventId = await claimNextShadowEvent(request.runtimeRoot, now);
  if (eventId === undefined) return { state: "empty" };
  try {
    const event = await readCapturedEvent(request.runtimeRoot, eventId);
    if (event === undefined) throw new Error("Captured event disappeared before Shadow evaluation.");
    if (event.projectId === undefined || event.sessionId === undefined) {
      const reason = event.projectId === undefined ? "project_unresolved" : "session_unavailable";
      await finishShadowEvaluation({
        runtimeRoot: request.runtimeRoot,
        eventId,
        state: "skipped",
        errorCode: reason,
        updatedAt: now
      });
      return { state: "skipped", eventId, reason };
    }

    let receiptId: string;
    if (event.eventKind === "SessionStart") {
      const pack = await prepareSessionStartShadowPack({
        runtimeRoot: request.runtimeRoot,
        vaultRoot: request.vaultRoot,
        projectId: event.projectId,
        sessionId: event.sessionId,
        requestedAt: event.occurredAt
      });
      receiptId = pack.receiptId;
    } else if (event.eventKind === "UserPromptSubmit") {
      if (!(await hasActiveEpoch(request.runtimeRoot, event.sessionId))) {
        const startup = await prepareSessionStartShadowPack({
          runtimeRoot: request.runtimeRoot,
          vaultRoot: request.vaultRoot,
          projectId: event.projectId,
          sessionId: event.sessionId,
          requestedAt: event.occurredAt
        });
        if (startup.receiptId.startsWith("msreceipt_unrecorded_")) {
          throw new Error("Shadow startup receipt was not recorded.");
        }
      }
      const payload = z.object({ prompt: z.string() }).parse(event.payload);
      const pack = await prepareUserPromptShadowPack({
        runtimeRoot: request.runtimeRoot,
        vaultRoot: request.vaultRoot,
        projectId: event.projectId,
        sessionId: event.sessionId,
        prompt: payload.prompt,
        signals: { files: [], symbols: [], errors: [], commands: [] },
        adapter: request.adapter,
        requestedAt: event.occurredAt
      });
      receiptId = pack.receiptId;
    } else {
      throw new Error("Claimed event is not Shadow eligible.");
    }
    if (receiptId.startsWith("msreceipt_unrecorded_")) {
      throw new Error("Shadow retrieval receipt was not recorded.");
    }
    await finishShadowEvaluation({
      runtimeRoot: request.runtimeRoot,
      eventId,
      state: "completed",
      receiptId,
      updatedAt: now
    });
    return { state: "completed", eventId, receiptId };
  } catch (error) {
    const errorCode = failureCode(error);
    await finishShadowEvaluation({
      runtimeRoot: request.runtimeRoot,
      eventId,
      state: "retrying",
      errorCode,
      nextRetryAt: new Date(Date.parse(now) + 60_000).toISOString(),
      updatedAt: now
    });
    return { state: "retrying", eventId, errorCode };
  }
}

export async function inspectShadowEvaluation(runtimeRoot: string, eventId: string): Promise<{
  readonly state: "processing" | "completed" | "skipped" | "retrying";
  readonly receiptId?: string;
  readonly attemptCount: number;
  readonly lastErrorCode?: string;
} | undefined> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const row = database.prepare(
      `SELECT state, receipt_id, attempt_count, last_error_code
       FROM shadow_event_evaluations WHERE event_id = ?`
    ).get(eventId);
    if (row === undefined) return undefined;
    return {
      state: z.enum(["processing", "completed", "skipped", "retrying"]).parse(row.state),
      ...(row.receipt_id === null ? {} : { receiptId: z.string().parse(row.receipt_id) }),
      attemptCount: z.number().int().nonnegative().parse(row.attempt_count),
      ...(row.last_error_code === null
        ? {}
        : { lastErrorCode: z.string().parse(row.last_error_code) })
    };
  } finally {
    database.close();
  }
}
