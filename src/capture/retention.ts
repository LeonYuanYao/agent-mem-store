import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

import { loadConfiguration } from "../configuration/index.js";
import { readDreamingConfiguration } from "../dreaming/config.js";
import { openRuntimeDatabase, openRuntimeDatabaseReadOnly } from "../runtime/database.js";

/**
 * Removes captured payload bodies once they can no longer be needed (ADR-0071):
 * completed events after `capture_payload_days`, dead letters after
 * `capture_dead_letter_payload_days`. Pending, processing and retrying work is
 * never touched. Event rows stay as body-free history with `payload_removed_at`.
 * While dreaming is enabled the terminal period never drops below its lookback,
 * so a nightly run always finds the Sessions it may still claim.
 */

const BATCH_EVENTS = 500;
const IDLE_INTERVAL_HOURS = 6;
const CATCH_UP_INTERVAL_SECONDS = 30;
const DEFAULT_PAYLOAD_DAYS = 30;
const DEFAULT_DEAD_LETTER_DAYS = 90;

export type CapturePayloadRetentionResult =
  | { readonly state: "not_due"; readonly nextCheckAt: string }
  | {
      readonly state: "completed";
      readonly removedEventCount: number;
      readonly removedBytes: number;
      readonly hasMore: boolean;
      readonly nextCheckAt: string;
    }
  | { readonly state: "failed"; readonly errorCode: string; readonly nextCheckAt: string };

async function retentionPeriods(request: { readonly runtimeRoot: string; readonly vaultRoot: string }): Promise<{
  readonly payloadDays: number;
  readonly deadLetterDays: number;
}> {
  let payloadDays = DEFAULT_PAYLOAD_DAYS;
  let deadLetterDays = DEFAULT_DEAD_LETTER_DAYS;
  try {
    const configuration = await loadConfiguration(request);
    if (configuration.mode === "read_write") {
      payloadDays = configuration.policy.capturePayloadDays;
      deadLetterDays = configuration.policy.captureDeadLetterPayloadDays;
    }
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
  const dreaming = await readDreamingConfiguration(request.runtimeRoot);
  if (dreaming.enabled) payloadDays = Math.max(payloadDays, dreaming.lookback_days + 1);
  return { payloadDays, deadLetterDays: Math.max(deadLetterDays, payloadDays) };
}

export async function runScheduledCapturePayloadRetention(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly now: string;
}): Promise<CapturePayloadRetentionResult> {
  const now = z.iso.datetime().parse(request.now);
  const instant = Temporal.Instant.from(now);
  let previousFailures = 0;
  try {
    const check = await openRuntimeDatabase(request.runtimeRoot);
    try {
      const row = check.prepare(
        "SELECT next_check_at, consecutive_failure_count FROM capture_payload_retention_maintenance WHERE singleton = 1"
      ).get();
      previousFailures = z.number().int().nonnegative().parse(row?.consecutive_failure_count ?? 0);
      if (typeof row?.next_check_at === "string" && Temporal.Instant.compare(instant, Temporal.Instant.from(row.next_check_at)) < 0) {
        return { state: "not_due", nextCheckAt: row.next_check_at };
      }
    } finally {
      check.close();
    }
    const { payloadDays, deadLetterDays } = await retentionPeriods(request);
    const terminalCutoff = instant.subtract({ hours: payloadDays * 24 }).toString({ smallestUnit: "millisecond" });
    const deadLetterCutoff = instant.subtract({ hours: deadLetterDays * 24 }).toString({ smallestUnit: "millisecond" });
    const database = await openRuntimeDatabase(request.runtimeRoot);
    try {
      database.exec("BEGIN IMMEDIATE");
      try {
        const eligible = `payload_removed_at IS NULL AND (lease_until IS NULL OR lease_until <= ?) AND (
            (state = 'completed' AND updated_at <= ?) OR (state = 'dead_letter' AND updated_at <= ?))`;
        const events = database.prepare(
          `SELECT event_id FROM capture_events WHERE ${eligible} ORDER BY updated_at, event_id LIMIT ?`
        ).all(now, terminalCutoff, deadLetterCutoff, BATCH_EVENTS).map((row) => z.string().parse(row.event_id));
        let removedBytes = 0;
        const size = database.prepare("SELECT COALESCE(SUM(LENGTH(payload)), 0) AS bytes FROM capture_segments WHERE event_id = ?");
        const removeSegments = database.prepare("DELETE FROM capture_segments WHERE event_id = ?");
        const markRemoved = database.prepare("UPDATE capture_events SET payload_removed_at = ? WHERE event_id = ?");
        for (const eventId of events) {
          removedBytes += Number(size.get(eventId)?.bytes ?? 0);
          removeSegments.run(eventId);
          markRemoved.run(now, eventId);
        }
        const hasMore = database.prepare(`SELECT 1 AS present FROM capture_events WHERE ${eligible} LIMIT 1`)
          .get(now, terminalCutoff, deadLetterCutoff) !== undefined;
        const nextCheckAt = instant.add(hasMore ? { seconds: CATCH_UP_INTERVAL_SECONDS } : { hours: IDLE_INTERVAL_HOURS }).toString();
        database.prepare(
          `UPDATE capture_payload_retention_maintenance
           SET next_check_at = ?, last_checked_at = ?, last_completed_at = ?, last_error_code = NULL,
               consecutive_failure_count = 0, last_removed_event_count = ?,
               total_removed_event_count = total_removed_event_count + ?, total_removed_bytes = total_removed_bytes + ?
           WHERE singleton = 1`
        ).run(nextCheckAt, now, now, events.length, events.length, removedBytes);
        database.exec("COMMIT");
        return { state: "completed", removedEventCount: events.length, removedBytes, hasMore, nextCheckAt };
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }
  } catch (error) {
    const errorCode = error instanceof Error ? error.name : "unknown_error";
    const failures = previousFailures + 1;
    const nextCheckAt = instant.add({ minutes: Math.min(360, 5 * (2 ** Math.min(failures - 1, 7))) }).toString();
    try {
      const failed = await openRuntimeDatabase(request.runtimeRoot);
      try {
        failed.prepare(
          `UPDATE capture_payload_retention_maintenance
           SET next_check_at = ?, last_checked_at = ?, last_error_code = ?, consecutive_failure_count = ?, last_removed_event_count = 0
           WHERE singleton = 1`
        ).run(nextCheckAt, now, errorCode.slice(0, 64), failures);
      } finally {
        failed.close();
      }
    } catch {
      // Recording the failure is best-effort; the next iteration retries.
    }
    return { state: "failed", errorCode, nextCheckAt };
  }
}

export async function inspectCapturePayloadRetention(runtimeRoot: string): Promise<Record<string, unknown>> {
  const database = await openRuntimeDatabaseReadOnly(runtimeRoot);
  try {
    const maintenance = database.prepare(
      `SELECT next_check_at, last_checked_at, last_completed_at, last_error_code, consecutive_failure_count,
              last_removed_event_count, total_removed_event_count, total_removed_bytes
       FROM capture_payload_retention_maintenance WHERE singleton = 1`
    ).get() ?? {};
    const retained = database.prepare(
      `SELECT COUNT(*) AS events, COALESCE(SUM(retained_bytes), 0) AS bytes, MIN(updated_at) AS oldest
       FROM capture_events WHERE payload_removed_at IS NULL AND state IN ('completed', 'dead_letter')`
    ).get();
    return { ...maintenance, retained_terminal_event_count: retained?.events, retained_terminal_bytes: retained?.bytes, oldest_retained_terminal_at: retained?.oldest };
  } finally {
    database.close();
  }
}
