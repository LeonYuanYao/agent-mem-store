import { z } from "zod";

import { openRuntimeDatabase } from "../runtime/database.js";

const failureCooldownMilliseconds = 5 * 60_000;

const generationRowSchema = z.object({
  dirty_generation: z.number().int().nonnegative(),
  published_generation: z.number().int().nonnegative(),
  building_generation: z.number().int().nonnegative().nullable(),
  quiet_period_ms: z.number().int().min(1_000).max(300_000),
  maximum_staleness_ms: z.number().int().min(30_000).max(3_600_000),
  dirty_at: z.string().nullable(),
  force_due_at: z.string().nullable(),
  last_completed_at: z.string().nullable(),
  last_failed_at: z.string().nullable()
});

export interface RetrievalCatalogGeneration {
  readonly dirtyGeneration: number;
  readonly publishedGeneration: number;
  readonly buildingGeneration: number | null;
  readonly quietPeriodMilliseconds: number;
  readonly maximumStalenessMilliseconds: number;
  readonly dirtyAt: string | null;
  readonly forceDueAt: string | null;
  readonly lastCompletedAt: string | null;
  readonly lastFailedAt: string | null;
}

function view(row: z.infer<typeof generationRowSchema>): RetrievalCatalogGeneration {
  return {
    dirtyGeneration: row.dirty_generation,
    publishedGeneration: row.published_generation,
    buildingGeneration: row.building_generation,
    quietPeriodMilliseconds: row.quiet_period_ms,
    maximumStalenessMilliseconds: row.maximum_staleness_ms,
    dirtyAt: row.dirty_at,
    forceDueAt: row.force_due_at,
    lastCompletedAt: row.last_completed_at,
    lastFailedAt: row.last_failed_at
  };
}

export async function inspectRetrievalCatalogGeneration(
  runtimeRoot: string
): Promise<RetrievalCatalogGeneration> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const row = generationRowSchema.parse(database.prepare(
      "SELECT * FROM retrieval_catalog_generations WHERE singleton = 1"
    ).get());
    return view(row);
  } finally {
    database.close();
  }
}

export type BeginRetrievalIndexBuildResult =
  | {
      readonly state: "started";
      readonly targetGeneration: number;
      readonly reason: "index_unavailable" | "adapter_changed" | "quiet_period" | "force_due";
    }
  | {
      readonly state: "not_due";
      readonly reason: "clean" | "building" | "quiet_period" | "foreground_pressure" |
        "failure_cooldown";
    };

export async function beginRetrievalIndexBuild(request: {
  readonly runtimeRoot: string;
  readonly now: string;
  readonly activeIndexExists: boolean;
  readonly adapterMatches: boolean;
  readonly foregroundPressure: boolean;
}): Promise<BeginRetrievalIndexBuildResult> {
  const now = z.iso.datetime().parse(request.now);
  const nowMilliseconds = Date.parse(now);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const initial = generationRowSchema.parse(database.prepare(
      "SELECT * FROM retrieval_catalog_generations WHERE singleton = 1"
    ).get());
    if (initial.building_generation !== null) {
      const activity = database.prepare(
        `SELECT state, started_at FROM retrieval_index_build_activity WHERE singleton = 1`
      ).get();
      const activeLease = activity?.state === "building" &&
        typeof activity.started_at === "string" &&
        Date.parse(activity.started_at) + failureCooldownMilliseconds > nowMilliseconds;
      if (activeLease) return { state: "not_due", reason: "building" };
    }
    if (
      initial.last_failed_at !== null &&
      nowMilliseconds - Date.parse(initial.last_failed_at) < failureCooldownMilliseconds
    ) return { state: "not_due", reason: "failure_cooldown" };
    if (
      request.activeIndexExists && request.adapterMatches &&
      initial.dirty_generation <= initial.published_generation
    ) return { state: "not_due", reason: "clean" };
    if (request.activeIndexExists && request.adapterMatches) {
      const forceDue = initial.force_due_at !== null &&
        Date.parse(initial.force_due_at) <= nowMilliseconds;
      if (!forceDue && (
        initial.dirty_at === null ||
        Date.parse(initial.dirty_at) + initial.quiet_period_ms > nowMilliseconds
      )) return { state: "not_due", reason: "quiet_period" };
      if (!forceDue && request.foregroundPressure) {
        return { state: "not_due", reason: "foreground_pressure" };
      }
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = generationRowSchema.parse(database.prepare(
        "SELECT * FROM retrieval_catalog_generations WHERE singleton = 1"
      ).get());
      if (row.building_generation !== null) {
        const activity = database.prepare(
          `SELECT state, started_at FROM retrieval_index_build_activity WHERE singleton = 1`
        ).get();
        const activeLease = activity?.state === "building" &&
          typeof activity.started_at === "string" &&
          Date.parse(activity.started_at) + failureCooldownMilliseconds > nowMilliseconds;
        if (activeLease) {
          database.exec("COMMIT");
          return { state: "not_due", reason: "building" };
        }
        database.prepare(
          "UPDATE retrieval_catalog_generations SET building_generation = NULL WHERE singleton = 1"
        ).run();
      }
      if (
        row.last_failed_at !== null &&
        nowMilliseconds - Date.parse(row.last_failed_at) < failureCooldownMilliseconds
      ) {
        database.exec("COMMIT");
        return { state: "not_due", reason: "failure_cooldown" };
      }

      let reason: "index_unavailable" | "adapter_changed" | "quiet_period" | "force_due";
      if (!request.activeIndexExists) reason = "index_unavailable";
      else if (!request.adapterMatches) reason = "adapter_changed";
      else if (row.dirty_generation <= row.published_generation) {
        database.exec("COMMIT");
        return { state: "not_due", reason: "clean" };
      } else if (row.force_due_at !== null && Date.parse(row.force_due_at) <= nowMilliseconds) {
        reason = "force_due";
      } else if (
        row.dirty_at === null ||
        Date.parse(row.dirty_at) + row.quiet_period_ms > nowMilliseconds
      ) {
        database.exec("COMMIT");
        return { state: "not_due", reason: "quiet_period" };
      } else if (request.foregroundPressure) {
        database.exec("COMMIT");
        return { state: "not_due", reason: "foreground_pressure" };
      } else {
        reason = "quiet_period";
      }

      const targetGeneration = row.dirty_generation;
      database.prepare(
        `UPDATE retrieval_catalog_generations SET building_generation = ?
         WHERE singleton = 1 AND building_generation IS NULL`
      ).run(targetGeneration);
      database.exec("COMMIT");
      return { state: "started", targetGeneration, reason };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function configureRetrievalIndexCoordinator(request: {
  readonly runtimeRoot: string;
  readonly quietPeriodSeconds: number;
  readonly maximumStalenessSeconds: number;
}): Promise<void> {
  const quietPeriodMilliseconds = z.number().int().min(1).max(300)
    .parse(request.quietPeriodSeconds) * 1_000;
  const maximumStalenessMilliseconds = z.number().int().min(30).max(3_600)
    .parse(request.maximumStalenessSeconds) * 1_000;
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const row = generationRowSchema.parse(database.prepare(
      "SELECT * FROM retrieval_catalog_generations WHERE singleton = 1"
    ).get());
    const forceDueAt = row.dirty_at === null
      ? null
      : new Date(Date.parse(row.dirty_at) + maximumStalenessMilliseconds).toISOString();
    database.prepare(
      `UPDATE retrieval_catalog_generations
       SET quiet_period_ms = ?, maximum_staleness_ms = ?, force_due_at = ?
       WHERE singleton = 1
         AND (quiet_period_ms != ? OR maximum_staleness_ms != ? OR force_due_at IS NOT ?)`
    ).run(
      quietPeriodMilliseconds,
      maximumStalenessMilliseconds,
      forceDueAt,
      quietPeriodMilliseconds,
      maximumStalenessMilliseconds,
      forceDueAt
    );
  } finally {
    database.close();
  }
}

export async function completeRetrievalIndexBuild(request: {
  readonly runtimeRoot: string;
  readonly targetGeneration: number;
  readonly completedAt: string;
}): Promise<void> {
  const targetGeneration = z.number().int().nonnegative().parse(request.targetGeneration);
  const completedAt = z.iso.datetime().parse(request.completedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = generationRowSchema.parse(database.prepare(
        "SELECT * FROM retrieval_catalog_generations WHERE singleton = 1"
      ).get());
      if (row.building_generation !== targetGeneration) {
        throw new Error("Retrieval index generation lease does not match completion.");
      }
      const caughtUp = targetGeneration >= row.dirty_generation;
      database.prepare(
        `UPDATE retrieval_catalog_generations
         SET published_generation = MAX(published_generation, ?),
             building_generation = NULL,
             dirty_at = CASE WHEN ? THEN NULL ELSE dirty_at END,
             force_due_at = CASE WHEN ? THEN NULL ELSE force_due_at END,
             last_completed_at = ?,
             last_failed_at = NULL
         WHERE singleton = 1`
      ).run(targetGeneration, caughtUp ? 1 : 0, caughtUp ? 1 : 0, completedAt);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function failRetrievalIndexBuild(request: {
  readonly runtimeRoot: string;
  readonly targetGeneration: number;
  readonly failedAt: string;
}): Promise<void> {
  const targetGeneration = z.number().int().nonnegative().parse(request.targetGeneration);
  const failedAt = z.iso.datetime().parse(request.failedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const changed = database.prepare(
      `UPDATE retrieval_catalog_generations
       SET building_generation = NULL, last_failed_at = ?
       WHERE singleton = 1 AND building_generation = ?`
    ).run(failedAt, targetGeneration);
    if (changed.changes !== 1) {
      throw new Error("Retrieval index generation lease does not match failure.");
    }
  } finally {
    database.close();
  }
}

export async function acknowledgeUnleasedIndexPublication(request: {
  readonly runtimeRoot: string;
  readonly targetGeneration: number;
  readonly completedAt: string;
}): Promise<void> {
  const targetGeneration = z.number().int().nonnegative().parse(request.targetGeneration);
  const completedAt = z.iso.datetime().parse(request.completedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const row = generationRowSchema.parse(database.prepare(
      "SELECT * FROM retrieval_catalog_generations WHERE singleton = 1"
    ).get());
    if (row.building_generation !== null) return;
    const caughtUp = targetGeneration >= row.dirty_generation;
    database.prepare(
      `UPDATE retrieval_catalog_generations
       SET published_generation = MAX(published_generation, ?),
           dirty_at = CASE WHEN ? THEN NULL ELSE dirty_at END,
           force_due_at = CASE WHEN ? THEN NULL ELSE force_due_at END,
           last_completed_at = ?,
           last_failed_at = NULL
       WHERE singleton = 1 AND building_generation IS NULL`
    ).run(targetGeneration, caughtUp ? 1 : 0, caughtUp ? 1 : 0, completedAt);
  } finally {
    database.close();
  }
}
