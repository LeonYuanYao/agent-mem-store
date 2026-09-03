import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

import { loadConfiguration } from "../configuration/index.js";
import { openRuntimeDatabase } from "../runtime/database.js";

const BATCH_SIZE = 500;
const IDLE_INTERVAL_HOURS = 6;
const CATCH_UP_INTERVAL_SECONDS = 30;
const DEFAULT_RETENTION_DAYS = 15;

export type ScheduledSensitivityRetentionResult =
  | {
      readonly state: "not_due";
      readonly deletedFindingCount: 0;
      readonly deletedObservationCount: 0;
      readonly hasMore: false;
      readonly nextCheckAt: string;
    }
  | {
      readonly state: "completed";
      readonly retentionDays: number;
      readonly deletedFindingCount: number;
      readonly deletedObservationCount: number;
      readonly hasMore: boolean;
      readonly nextCheckAt: string;
    }
  | {
      readonly state: "failed";
      readonly retentionDays: number;
      readonly deletedFindingCount: 0;
      readonly deletedObservationCount: 0;
      readonly hasMore: false;
      readonly nextCheckAt: string;
      readonly errorCode: string;
    };

export async function loadSensitivityMetadataDays(request: {
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
    throw new Error("Sensitivity retention requires writable configuration.");
  }
  return configuration.policy.sensitivityMetadataDays;
}

export async function runScheduledSensitivityRetention(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly now: string;
}): Promise<ScheduledSensitivityRetentionResult> {
  const now = z.iso.datetime().parse(request.now);
  let retentionDays = DEFAULT_RETENTION_DAYS;
  let nextCheckAt: string | undefined;
  let previousFailures = 0;
  try {
    const initialDatabase = await openRuntimeDatabase(request.runtimeRoot);
    try {
      const maintenance = initialDatabase.prepare(
        `SELECT next_check_at, consecutive_failure_count
         FROM sensitivity_retention_maintenance WHERE singleton = 1`
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
        deletedFindingCount: 0,
        deletedObservationCount: 0,
        hasMore: false,
        nextCheckAt
      };
    }

    retentionDays = await loadSensitivityMetadataDays(request);
    const cutoff = Temporal.Instant.from(now)
      .subtract({ hours: retentionDays * 24 })
      .toString({ smallestUnit: "millisecond" });
    const database = await openRuntimeDatabase(request.runtimeRoot);
    try {
      database.exec("BEGIN IMMEDIATE");
      try {
        const observationRows = database.prepare(
          `SELECT fingerprint, source_identity
           FROM sensitivity_observations
           WHERE observed_at <= ?
           ORDER BY observed_at, fingerprint, source_identity
           LIMIT ?`
        ).all(cutoff, BATCH_SIZE);
        const deleteObservation = database.prepare(
          `DELETE FROM sensitivity_observations
           WHERE fingerprint = ? AND source_identity = ?`
        );
        for (const row of observationRows) {
          deleteObservation.run(
            z.string().parse(row.fingerprint),
            z.string().parse(row.source_identity)
          );
        }

        const findingRows = database.prepare(
          `SELECT fingerprint
           FROM sensitivity_findings AS finding
           WHERE finding.last_seen_at <= ?
             AND NOT EXISTS (
               SELECT 1 FROM sensitivity_observations AS observation
               WHERE observation.fingerprint = finding.fingerprint
             )
           ORDER BY finding.last_seen_at, finding.fingerprint
           LIMIT ?`
        ).all(cutoff, BATCH_SIZE);
        const deleteFinding = database.prepare(
          "DELETE FROM sensitivity_findings WHERE fingerprint = ?"
        );
        for (const row of findingRows) {
          deleteFinding.run(z.string().parse(row.fingerprint));
        }

        const hasMore = database.prepare(
          `SELECT 1 AS present
           WHERE EXISTS (
             SELECT 1 FROM sensitivity_observations WHERE observed_at <= ?
           ) OR EXISTS (
             SELECT 1 FROM sensitivity_findings WHERE last_seen_at <= ?
           )`
        ).get(cutoff, cutoff) !== undefined;
        const scheduledAt = Temporal.Instant.from(now)
          .add(hasMore ? { seconds: CATCH_UP_INTERVAL_SECONDS } : { hours: IDLE_INTERVAL_HOURS })
          .toString();
        database.prepare(
          `UPDATE sensitivity_retention_maintenance
           SET next_check_at = ?, last_checked_at = ?, last_completed_at = ?,
               last_error_code = NULL, consecutive_failure_count = 0,
               last_deleted_finding_count = ?, last_deleted_observation_count = ?,
               total_deleted_finding_count = total_deleted_finding_count + ?,
               total_deleted_observation_count = total_deleted_observation_count + ?
           WHERE singleton = 1`
        ).run(
          scheduledAt,
          now,
          now,
          findingRows.length,
          observationRows.length,
          findingRows.length,
          observationRows.length
        );
        database.exec("COMMIT");
        return {
          state: "completed",
          retentionDays,
          deletedFindingCount: findingRows.length,
          deletedObservationCount: observationRows.length,
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
          `UPDATE sensitivity_retention_maintenance
           SET next_check_at = ?, last_checked_at = ?, last_error_code = ?,
               consecutive_failure_count = ?, last_deleted_finding_count = 0,
               last_deleted_observation_count = 0
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
      deletedFindingCount: 0,
      deletedObservationCount: 0,
      hasMore: false,
      nextCheckAt: retryAt,
      errorCode
    };
  }
}
