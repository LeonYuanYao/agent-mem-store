import { createHash, randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

import { openRuntimeDatabase } from "../runtime/database.js";

const cadenceSchema = z.enum(["weekly", "monthly"]);
type Cadence = z.infer<typeof cadenceSchema>;

export interface InitializeGovernanceScheduleRequest {
  readonly runtimeRoot: string;
  readonly timeZone: string;
  readonly registeredAt: string;
  readonly startupDelaySeconds?: number;
  readonly pageSize?: number;
}

function validateTimeZone(timeZone: string, instant: string): void {
  Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone);
}

export async function initializeGovernanceSchedule(
  request: InitializeGovernanceScheduleRequest
): Promise<{ readonly state: "initialized" | "existing" }> {
  const registeredAt = z.iso.datetime().parse(request.registeredAt);
  const timeZone = z.string().min(1).parse(request.timeZone);
  const startupDelaySeconds = z.number().int().min(600).parse(
    request.startupDelaySeconds ?? 600
  );
  const pageSize = z.number().int().min(1).max(500).parse(request.pageSize ?? 50);
  validateTimeZone(timeZone, registeredAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const inserted = database.prepare(
        `INSERT OR IGNORE INTO governance_schedule(
           singleton, time_zone, registered_at, startup_delay_seconds, page_size
         ) VALUES (1, ?, ?, ?, ?)`
      ).run(timeZone, registeredAt, startupDelaySeconds, pageSize);
      const existing = database.prepare(
        "SELECT time_zone FROM governance_schedule WHERE singleton = 1"
      ).get();
      if (existing?.time_zone !== timeZone) {
        throw new Error("Governance time zone is already configured differently.");
      }
      for (const cadence of cadenceSchema.options) {
        database.prepare(
          `INSERT OR IGNORE INTO governance_cursors(
             cadence, successful_through, updated_at
           ) VALUES (?, ?, ?)`
        ).run(cadence, registeredAt, registeredAt);
      }
      database.exec("COMMIT");
      return { state: inserted.changes === 1 ? "initialized" : "existing" };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function instantIso(value: Temporal.Instant): string {
  return new Date(value.epochMilliseconds).toISOString();
}

function dueOccurrences(
  cadence: Cadence,
  fromExclusive: string,
  throughInclusive: string,
  timeZone: string
): readonly string[] {
  const from = Temporal.Instant.from(fromExclusive);
  const through = Temporal.Instant.from(throughInclusive);
  let date = from.toZonedDateTimeISO(timeZone).toPlainDate();
  const lastDate = through.toZonedDateTimeISO(timeZone).toPlainDate();
  const due: string[] = [];
  while (Temporal.PlainDate.compare(date, lastDate) <= 0) {
    const firstMonday = date.dayOfWeek === 1 && date.day <= 7;
    const cadenceMatches = date.dayOfWeek === 1 &&
      (cadence === "weekly" || firstMonday);
    if (cadenceMatches) {
      const occurrence = date.toZonedDateTime({
        timeZone,
        plainTime: Temporal.PlainTime.from("19:00")
      }).toInstant();
      if (Temporal.Instant.compare(occurrence, from) > 0 &&
          Temporal.Instant.compare(occurrence, through) <= 0) {
        due.push(instantIso(occurrence));
      }
    }
    date = date.add({ days: 1 });
  }
  return due;
}

function obligationId(cadence: Cadence, dueAt: string): string {
  return `msgovob_${createHash("sha256").update(`${cadence}:${dueAt}`).digest("hex").slice(0, 32)}`;
}

export type ScheduleGovernanceResult =
  | { readonly state: "idle" }
  | { readonly state: "deferred"; readonly reason: "startup_delay" | "foreground_backlog" }
  | { readonly state: "active_run"; readonly runId: string }
  | {
      readonly state: "scheduled";
      readonly runId: string;
      readonly kind: Cadence;
      readonly includesWeekly: boolean;
      readonly coverageThrough: string;
      readonly recoveredOccurrenceCount: number;
    };

export async function scheduleDueGovernance(request: {
  readonly runtimeRoot: string;
  readonly now: string;
  readonly workerStartedAt: string;
}): Promise<ScheduleGovernanceResult> {
  const now = z.iso.datetime().parse(request.now);
  const workerStartedAt = z.iso.datetime().parse(request.workerStartedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const preflightSchedule = database.prepare(
      "SELECT * FROM governance_schedule WHERE singleton = 1"
    ).get();
    if (preflightSchedule === undefined) {
      throw new Error("Governance schedule is not initialized.");
    }
    const timeZone = z.string().min(1).parse(preflightSchedule.time_zone);
    const cursors = database.prepare(
      "SELECT cadence, successful_through FROM governance_cursors"
    ).all();
    const occurrenceIsDue = cadenceSchema.options.some((cadence) => {
      const cursor = cursors.find((row) => row.cadence === cadence);
      if (typeof cursor?.successful_through !== "string") {
        throw new Error(`Governance ${cadence} cursor is missing.`);
      }
      return dueOccurrences(cadence, cursor.successful_through, now, timeZone).length > 0;
    });
    const active = database.prepare(
      `SELECT run_id FROM governance_runs
       WHERE state IN ('pending', 'processing', 'retrying', 'blocked') LIMIT 1`
    ).get();
    if (typeof active?.run_id === "string" && !occurrenceIsDue) {
      return { state: "active_run", runId: active.run_id };
    }
    const pendingObligation = database.prepare(
      "SELECT 1 AS present FROM governance_obligations WHERE state = 'pending' LIMIT 1"
    ).get();
    if (pendingObligation === undefined && !occurrenceIsDue) {
      return { state: "idle" };
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      const schedule = database.prepare(
        "SELECT * FROM governance_schedule WHERE singleton = 1"
      ).get();
      if (schedule === undefined) {
        throw new Error("Governance schedule is not initialized.");
      }
      const timeZone = z.string().min(1).parse(schedule.time_zone);
      const cursors = database.prepare(
        "SELECT cadence, successful_through FROM governance_cursors"
      ).all();
      for (const cadence of cadenceSchema.options) {
        const cursor = cursors.find((row) => row.cadence === cadence);
        if (cursor === undefined || typeof cursor.successful_through !== "string") {
          throw new Error(`Governance ${cadence} cursor is missing.`);
        }
        for (const dueAt of dueOccurrences(cadence, cursor.successful_through, now, timeZone)) {
          database.prepare(
            `INSERT OR IGNORE INTO governance_obligations(
               obligation_id, cadence, due_at, state, created_at
             ) VALUES (?, ?, ?, 'pending', ?)`
          ).run(obligationId(cadence, dueAt), cadence, dueAt, now);
        }
      }

      const active = database.prepare(
        `SELECT run_id FROM governance_runs
         WHERE state IN ('pending', 'processing', 'retrying', 'blocked') LIMIT 1`
      ).get();
      if (typeof active?.run_id === "string") {
        database.exec("COMMIT");
        return { state: "active_run", runId: active.run_id };
      }
      const pendingCount = database.prepare(
        "SELECT COUNT(*) AS count FROM governance_obligations WHERE state = 'pending'"
      ).get();
      if (pendingCount?.count === 0) {
        database.exec("COMMIT");
        return { state: "idle" };
      }
      const startupDelaySeconds = z.number().int().nonnegative().parse(
        schedule.startup_delay_seconds
      );
      if (Date.parse(now) - Date.parse(workerStartedAt) < startupDelaySeconds * 1000) {
        database.exec("COMMIT");
        return { state: "deferred", reason: "startup_delay" };
      }
      const captureBacklog = database.prepare(
        `SELECT 1 FROM capture_events
         WHERE state IN ('pending', 'processing', 'retrying') LIMIT 1`
      ).get();
      const indexBacklog = database.prepare(
        `SELECT 1 FROM retrieval_index_build_activity
         WHERE singleton = 1 AND state = 'building' AND lease_until > ?`
      ).get(now);
      if (indexBacklog !== undefined || captureBacklog !== undefined) {
        database.exec("COMMIT");
        return { state: "deferred", reason: "foreground_backlog" };
      }

      const hasMonthly = database.prepare(
        "SELECT 1 FROM governance_obligations WHERE state = 'pending' AND cadence = 'monthly' LIMIT 1"
      ).get() !== undefined;
      const kind: Cadence = hasMonthly ? "monthly" : "weekly";
      const linked = database.prepare(
        `SELECT obligation_id, cadence FROM governance_obligations
         WHERE state = 'pending' AND due_at <= ?
           AND (? = 'monthly' OR cadence = 'weekly')
         ORDER BY due_at, cadence`
      ).all(now, kind);
      const recoveredOccurrenceCount = linked.length;
      if (recoveredOccurrenceCount === 0) {
        database.exec("COMMIT");
        return { state: "idle" };
      }
      const weeklyCursor = cursors.find((row) => row.cadence === "weekly");
      const monthlyCursor = cursors.find((row) => row.cadence === "monthly");
      if (typeof weeklyCursor?.successful_through !== "string" ||
          typeof monthlyCursor?.successful_through !== "string") {
        throw new Error("Governance cursors are invalid.");
      }
      const includesWeekly = linked.some((row) => row.cadence === "weekly");
      const runId = `msgovrun_${randomUUID()}`;
      database.prepare(
        `INSERT INTO governance_runs(
           run_id, run_kind, state, includes_weekly, weekly_from, monthly_from,
           coverage_through, recovered_occurrence_count, current_phase,
           created_at, updated_at, capacity_triggered
         ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        runId,
        kind,
        includesWeekly ? 1 : 0,
        includesWeekly ? weeklyCursor.successful_through : now,
        kind === "monthly" ? monthlyCursor.successful_through : null,
        now,
        recoveredOccurrenceCount,
        includesWeekly ? "weekly" : "monthly",
        now,
        now,
        0
      );
      if (includesWeekly) {
        database.prepare(
          `INSERT INTO governance_run_members(
             run_id, phase, memory_id, revision_id, member_ordinal
           )
           WITH changed(memory_id) AS (
             SELECT memory_id FROM memory_catalog
             WHERE revised_at > ? AND revised_at <= ?
           ), selected(memory_id) AS (
             SELECT memory_id FROM changed
             UNION
             SELECT relationship.target_memory_id
             FROM memory_relationships AS relationship
             JOIN changed ON changed.memory_id = relationship.source_memory_id
             UNION
             SELECT relationship.source_memory_id
             FROM memory_relationships AS relationship
             JOIN changed ON changed.memory_id = relationship.target_memory_id
           )
           SELECT ?, 'weekly', catalog.memory_id, catalog.current_revision_id,
                  ROW_NUMBER() OVER (ORDER BY catalog.memory_id) - 1
           FROM selected
           JOIN memory_catalog AS catalog ON catalog.memory_id = selected.memory_id
           WHERE catalog.lifecycle IN ('active', 'archived')
           ORDER BY catalog.memory_id`
        ).run(weeklyCursor.successful_through, now, runId);
      }
      if (kind === "monthly") {
        database.prepare(
          `INSERT INTO governance_run_members(
             run_id, phase, memory_id, revision_id, member_ordinal
           )
           SELECT ?, 'monthly', memory_id, current_revision_id,
                  ROW_NUMBER() OVER (ORDER BY memory_id) - 1
           FROM memory_catalog WHERE lifecycle IN ('active', 'archived')
           ORDER BY memory_id`
        ).run(runId);
      }
      for (const obligation of linked) {
        const selectedObligationId = z.string().min(1).parse(obligation.obligation_id);
        database.prepare(
          `UPDATE governance_obligations
           SET state = 'linked', run_id = ? WHERE obligation_id = ? AND state = 'pending'`
        ).run(runId, selectedObligationId);
      }
      database.exec("COMMIT");
      return {
        state: "scheduled",
        runId,
        kind,
        includesWeekly,
        coverageThrough: now,
        recoveredOccurrenceCount
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}
