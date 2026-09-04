import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

import { loadConfiguration } from "../configuration/index.js";
import { openRuntimeDatabase } from "../runtime/database.js";

const BATCH_SIZE = 1_000;
const IDLE_INTERVAL_HOURS = 6;
const CATCH_UP_INTERVAL_SECONDS = 30;
const DEFAULT_RETENTION_DAYS = 30;

export type ScheduledInjectionReceiptRetentionResult =
  | {
      readonly state: "not_due";
      readonly deletedReceiptCount: 0;
      readonly deletedItemCount: 0;
      readonly protectedReceiptCount: 0;
      readonly hasMore: false;
      readonly nextCheckAt: string;
    }
  | {
      readonly state: "completed";
      readonly retentionDays: number;
      readonly deletedReceiptCount: number;
      readonly deletedItemCount: number;
      readonly protectedReceiptCount: number;
      readonly hasMore: boolean;
      readonly nextCheckAt: string;
    }
  | {
      readonly state: "failed";
      readonly retentionDays: number;
      readonly deletedReceiptCount: 0;
      readonly deletedItemCount: 0;
      readonly protectedReceiptCount: 0;
      readonly hasMore: false;
      readonly nextCheckAt: string;
      readonly errorCode: string;
    };

export async function loadInjectionReceiptRetentionDays(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
}): Promise<number> {
  let configuration: Awaited<ReturnType<typeof loadConfiguration>>;
  try {
    configuration = await loadConfiguration(request);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
    if (code === "ENOENT") return DEFAULT_RETENTION_DAYS;
    throw error;
  }
  if (configuration.mode !== "read_write") {
    throw new Error("Injection Receipt retention requires writable configuration.");
  }
  return configuration.policy.injectionReceiptDays;
}

export async function runScheduledInjectionReceiptRetention(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly now: string;
}): Promise<ScheduledInjectionReceiptRetentionResult> {
  const now = z.iso.datetime().parse(request.now);
  let retentionDays = DEFAULT_RETENTION_DAYS;
  let nextCheckAt: string | undefined;
  let previousFailures = 0;
  try {
    const initialDatabase = await openRuntimeDatabase(request.runtimeRoot);
    try {
      const maintenance = initialDatabase.prepare(
        `SELECT next_check_at, consecutive_failure_count
         FROM injection_receipt_retention_maintenance WHERE singleton = 1`
      ).get();
      nextCheckAt = typeof maintenance?.next_check_at === "string"
        ? maintenance.next_check_at
        : undefined;
      previousFailures = z.number().int().nonnegative().parse(
        maintenance?.consecutive_failure_count ?? 0
      );
    } finally {
      initialDatabase.close();
    }
    if (
      nextCheckAt !== undefined &&
      Temporal.Instant.compare(Temporal.Instant.from(now), Temporal.Instant.from(nextCheckAt)) < 0
    ) {
      return {
        state: "not_due",
        deletedReceiptCount: 0,
        deletedItemCount: 0,
        protectedReceiptCount: 0,
        hasMore: false,
        nextCheckAt
      };
    }

    retentionDays = await loadInjectionReceiptRetentionDays(request);
    const cutoff = Temporal.Instant.from(now)
      .subtract({ hours: retentionDays * 24 })
      .toString({ smallestUnit: "millisecond" });
    const database = await openRuntimeDatabase(request.runtimeRoot);
    try {
      database.exec("BEGIN IMMEDIATE");
      try {
        const protectedReceiptCount = z.number().int().nonnegative().parse(
          database.prepare(
            `SELECT COUNT(*) AS count
             FROM retrieval_receipts AS receipt
             WHERE receipt.created_at <= ?
               AND EXISTS (
                 SELECT 1 FROM irrelevant_observations AS observation
                 WHERE observation.receipt_id = receipt.receipt_id
               )`
          ).get(cutoff)?.count ?? 0
        );
        const receiptRows = database.prepare(
          `SELECT receipt_id
           FROM retrieval_receipts AS receipt
           WHERE receipt.created_at <= ?
             AND NOT EXISTS (
               SELECT 1 FROM irrelevant_observations AS observation
               WHERE observation.receipt_id = receipt.receipt_id
             )
           ORDER BY receipt.created_at, receipt.receipt_id
           LIMIT ?`
        ).all(cutoff, BATCH_SIZE);
        const receiptIds = receiptRows.map((row) => z.string().parse(row.receipt_id));
        let deletedItemCount = 0;
        if (receiptIds.length > 0) {
          const placeholders = receiptIds.map(() => "?").join(", ");
          const summaries = database.prepare(
            `WITH item_summary AS (
               SELECT receipt_id,
                      SUM(CASE WHEN outcome = 'selected' THEN 1 ELSE 0 END)
                        AS selected_item_count,
                      SUM(CASE WHEN outcome = 'omitted' THEN 1 ELSE 0 END)
                        AS omitted_item_count
               FROM retrieval_receipt_items
               WHERE receipt_id IN (${placeholders})
               GROUP BY receipt_id
             )
             SELECT substr(receipt.created_at, 1, 10) AS summary_date,
                    receipt.caller_kind,
                    COUNT(*) AS receipt_count,
                    SUM(receipt.rendered_token_count) AS rendered_token_count,
                    SUM(receipt.latency_ms) AS latency_ms_total,
                    SUM(COALESCE(item.selected_item_count, 0)) AS selected_item_count,
                    SUM(COALESCE(item.omitted_item_count, 0)) AS omitted_item_count
             FROM retrieval_receipts AS receipt
             LEFT JOIN item_summary AS item
               ON item.receipt_id = receipt.receipt_id
             WHERE receipt.receipt_id IN (${placeholders})
             GROUP BY substr(receipt.created_at, 1, 10), receipt.caller_kind`
          ).all(...receiptIds, ...receiptIds);
          const upsertSummary = database.prepare(
            `INSERT INTO retrieval_receipt_daily_summaries(
               summary_date, caller_kind, receipt_count, rendered_token_count,
               selected_item_count, omitted_item_count, latency_ms_total
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(summary_date, caller_kind) DO UPDATE SET
               receipt_count = receipt_count + excluded.receipt_count,
               rendered_token_count = rendered_token_count + excluded.rendered_token_count,
               selected_item_count = selected_item_count + excluded.selected_item_count,
               omitted_item_count = omitted_item_count + excluded.omitted_item_count,
               latency_ms_total = latency_ms_total + excluded.latency_ms_total`
          );
          for (const summary of summaries) {
            upsertSummary.run(
              z.string().length(10).parse(summary.summary_date),
              z.enum(["session_start", "user_prompt", "explicit"]).parse(summary.caller_kind),
              z.number().int().nonnegative().parse(summary.receipt_count),
              z.number().int().nonnegative().parse(summary.rendered_token_count ?? 0),
              z.number().int().nonnegative().parse(summary.selected_item_count ?? 0),
              z.number().int().nonnegative().parse(summary.omitted_item_count ?? 0),
              z.number().nonnegative().parse(summary.latency_ms_total ?? 0)
            );
          }
          database.prepare(
            `UPDATE foreground_event_reservations SET receipt_id = NULL
             WHERE receipt_id IN (${placeholders}) AND state = 'completed'`
          ).run(...receiptIds);
          database.prepare(
            `UPDATE shadow_event_evaluations SET receipt_id = NULL
             WHERE receipt_id IN (${placeholders})`
          ).run(...receiptIds);
          deletedItemCount = Number(database.prepare(
            `DELETE FROM retrieval_receipt_items WHERE receipt_id IN (${placeholders})`
          ).run(...receiptIds).changes);
          database.prepare(
            `DELETE FROM retrieval_receipts WHERE receipt_id IN (${placeholders})`
          ).run(...receiptIds);
        }

        const hasMore = database.prepare(
          `SELECT 1 AS present FROM retrieval_receipts AS receipt
           WHERE receipt.created_at <= ?
             AND NOT EXISTS (
               SELECT 1 FROM irrelevant_observations AS observation
               WHERE observation.receipt_id = receipt.receipt_id
             )
           LIMIT 1`
        ).get(cutoff) !== undefined;
        const scheduledAt = Temporal.Instant.from(now)
          .add(hasMore ? { seconds: CATCH_UP_INTERVAL_SECONDS } : { hours: IDLE_INTERVAL_HOURS })
          .toString();
        database.prepare(
          `UPDATE injection_receipt_retention_maintenance
           SET next_check_at = ?, last_checked_at = ?, last_completed_at = ?,
               last_error_code = NULL, consecutive_failure_count = 0,
               last_deleted_receipt_count = ?, last_deleted_item_count = ?,
               last_protected_receipt_count = ?,
               total_deleted_receipt_count = total_deleted_receipt_count + ?,
               total_deleted_item_count = total_deleted_item_count + ?
           WHERE singleton = 1`
        ).run(
          scheduledAt,
          now,
          now,
          receiptIds.length,
          deletedItemCount,
          protectedReceiptCount,
          receiptIds.length,
          deletedItemCount
        );
        database.exec("COMMIT");
        return {
          state: "completed",
          retentionDays,
          deletedReceiptCount: receiptIds.length,
          deletedItemCount,
          protectedReceiptCount,
          hasMore,
          nextCheckAt: scheduledAt
        };
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }
  } catch (error) {
    const errorCode = error instanceof Error ? error.name : "unknown_error";
    const failureCount = previousFailures + 1;
    const retryMinutes = Math.min(360, 5 * (2 ** Math.min(failureCount - 1, 7)));
    const retryAt = Temporal.Instant.from(now).add({ minutes: retryMinutes }).toString();
    try {
      const failedDatabase = await openRuntimeDatabase(request.runtimeRoot);
      try {
        failedDatabase.prepare(
          `UPDATE injection_receipt_retention_maintenance
           SET next_check_at = ?, last_checked_at = ?, last_error_code = ?,
               consecutive_failure_count = ?, last_deleted_receipt_count = 0,
               last_deleted_item_count = 0, last_protected_receipt_count = 0
           WHERE singleton = 1`
        ).run(retryAt, now, errorCode, failureCount);
      } finally {
        failedDatabase.close();
      }
    } catch {
      // A locked or unavailable Runtime must not let maintenance stop the Worker.
    }
    return {
      state: "failed",
      retentionDays,
      deletedReceiptCount: 0,
      deletedItemCount: 0,
      protectedReceiptCount: 0,
      hasMore: false,
      nextCheckAt: retryAt,
      errorCode
    };
  }
}
