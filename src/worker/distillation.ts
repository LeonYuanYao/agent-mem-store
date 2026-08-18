import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { readCapturedEvent } from "../capture/index.js";
import { createAgentCandidate } from "../candidates/index.js";
import { recordHumanGlobalAuthorization } from "../candidates/human.js";
import {
  LunaInvocationError,
  type DistillBatchRequest,
  type ConsolidateSessionRequest,
  type ConsolidationOutput,
  type DistillationOutput,
  type LunaEvidence
} from "../luna/index.js";
import {
  claimLunaOperation,
  completeLunaOperation,
  failLunaOperation,
  failLunaOperationLocally
} from "../luna/operations.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import { mapCapturedEventToLunaEvidence } from "./evidence.js";

export interface LunaWorkerAdapter {
  distillBatch(request: DistillBatchRequest): Promise<DistillationOutput>;
  consolidateSession(
    request: ConsolidateSessionRequest
  ): Promise<ConsolidationOutput>;
}

export type PrepareDistillationBatchResult =
  | { readonly state: "empty" }
  | {
      readonly state: "queued";
      readonly batchId: string;
      readonly operationId: string;
      readonly sessionId: string;
      readonly eventCount: number;
    };

function operationPayloadSource(payload: unknown): {
  readonly source: string;
  readonly sha256: string;
} {
  const source = JSON.stringify(payload);
  return {
    source,
    sha256: createHash("sha256").update(source).digest("hex")
  };
}

export async function prepareNextDistillationBatch(request: {
  readonly runtimeRoot: string;
  readonly maximumEvents: number;
  readonly maximumRetainedBytes?: number;
  readonly preparedAt: string;
  readonly minimumEventAgeMilliseconds?: number;
}): Promise<PrepareDistillationBatchResult> {
  const preparedAt = z.iso.datetime().parse(request.preparedAt);
  const minimumEventAgeMilliseconds = z.number().int().min(0).max(86_400_000).parse(
    request.minimumEventAgeMilliseconds ?? 0
  );
  const eligibleBefore = new Date(
    Date.parse(preparedAt) - minimumEventAgeMilliseconds
  ).toISOString();
  if (
    !Number.isInteger(request.maximumEvents) ||
    request.maximumEvents < 1 ||
    request.maximumEvents > 64
  ) {
    throw new Error("maximumEvents must be between one and 64.");
  }
  const maximumRetainedBytes = z.number().int().min(64 * 1024).max(900_000).parse(
    request.maximumRetainedBytes ?? 512 * 1024
  );
  const selectionDatabase = await openRuntimeDatabase(request.runtimeRoot);
  let sessionId: string;
  let selectedRows: readonly Record<string, unknown>[];
  let projectId: string | null;
  try {
    const first = selectionDatabase
      .prepare(
        `WITH pending AS MATERIALIZED (
           SELECT capture.*,
                  COALESCE(capture.session_id, 'event:' || capture.event_id)
                    AS distillation_session_id,
                  COALESCE(capture.turn_id, 'session') AS distillation_turn_id,
                  COUNT(*) OVER (
                    PARTITION BY
                      COALESCE(capture.session_id, 'event:' || capture.event_id),
                      COALESCE(capture.turn_id, 'session')
                  ) AS distillation_event_count,
                  SUM(capture.retained_bytes) OVER (
                    PARTITION BY
                      COALESCE(capture.session_id, 'event:' || capture.event_id),
                      COALESCE(capture.turn_id, 'session')
                  ) AS distillation_retained_bytes
           FROM capture_events AS capture
           WHERE capture.state = 'pending'
             AND NOT EXISTS (
               SELECT 1 FROM distillation_batch_events AS assigned
               WHERE assigned.event_id = capture.event_id
             )
         )
         SELECT event_id, session_id, turn_id, project_id, created_at
         FROM pending AS capture
         WHERE (
               capture.distillation_event_count >= ?
               OR capture.distillation_retained_bytes >= ?
               OR EXISTS (
                 SELECT 1 FROM capture_events AS stopping
                 WHERE stopping.event_kind = 'Stop'
                   AND stopping.session_id = capture.session_id
                   AND stopping.turn_id = capture.turn_id
               )
               OR EXISTS (
                 SELECT 1 FROM capture_events AS ending
                 WHERE ending.event_kind = 'SessionEnd'
                   AND COALESCE(ending.session_id, 'event:' || ending.event_id) =
                     capture.distillation_session_id
                   AND ending.created_at >= capture.created_at
               )
               OR (
                 capture.occurred_at <= ?
                 AND capture.turn_id IS NULL
               )
             )
         ORDER BY capture.created_at ASC LIMIT 1`
      )
      .get(request.maximumEvents, maximumRetainedBytes, eligibleBefore);
    if (first === undefined) return { state: "empty" };
    const firstEventId = z.string().parse(first.event_id);
    sessionId =
      typeof first.session_id === "string"
        ? first.session_id
        : `event:${firstEventId}`;
    const turnId = typeof first.turn_id === "string" ? first.turn_id : null;
    const firstCreatedAt = z.string().parse(first.created_at);
    const ending = selectionDatabase
      .prepare(
        `SELECT created_at FROM capture_events
         WHERE event_kind = 'SessionEnd'
           AND COALESCE(session_id, 'event:' || event_id) = ?
           AND created_at >= ?
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get(sessionId, firstCreatedAt);
    const sessionEndCutoff = typeof ending?.created_at === "string"
      ? ending.created_at
      : null;
    const rows = selectionDatabase
      .prepare(
        `SELECT capture.event_id, capture.project_id, capture.retained_bytes
         FROM capture_events AS capture
         WHERE capture.state = 'pending'
           AND COALESCE(capture.session_id, 'event:' || capture.event_id) = ?
           AND NOT EXISTS (
             SELECT 1 FROM distillation_batch_events AS assigned
             WHERE assigned.event_id = capture.event_id
           )
           AND (
             (? IS NOT NULL AND capture.created_at <= ?)
             OR (? IS NULL AND capture.turn_id = ?)
             OR (? IS NULL AND ? IS NULL AND capture.turn_id IS NULL)
           )
         ORDER BY capture.created_at ASC LIMIT ?`
      )
      .all(
        sessionId,
        sessionEndCutoff,
        sessionEndCutoff,
        sessionEndCutoff,
        turnId,
        sessionEndCutoff,
        turnId,
        request.maximumEvents
      );
    if (rows.length === 0) throw new Error("Distillation batch selection failed.");
    const boundedRows: Record<string, unknown>[] = [];
    let selectedBytes = 0;
    for (const row of rows) {
      const retainedBytes = z.number().int().nonnegative().parse(row.retained_bytes);
      if (
        boundedRows.length > 0 &&
        selectedBytes + retainedBytes > maximumRetainedBytes
      ) {
        break;
      }
      boundedRows.push(row);
      selectedBytes += retainedBytes;
    }
    selectedRows = boundedRows;
    const projectIds = new Set(
      selectedRows
        .map((row) => row.project_id)
        .filter((value): value is string => typeof value === "string")
    );
    projectId = projectIds.size === 1 ? [...projectIds][0] ?? null : null;
  } finally {
    selectionDatabase.close();
  }

  const selectedEventIds = selectedRows.map((row) => z.string().parse(row.event_id));
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const placeholders = selectedEventIds.map(() => "?").join(", ");
      const available = database.prepare(
        `SELECT COUNT(*) AS count
         FROM capture_events AS capture
         WHERE capture.event_id IN (${placeholders})
           AND capture.state = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM distillation_batch_events AS assigned
             WHERE assigned.event_id = capture.event_id
           )`
      ).get(...selectedEventIds);
      if (available?.count !== selectedEventIds.length) {
        database.exec("COMMIT");
        return { state: "empty" };
      }
      const ordinalRow = database
        .prepare(
          `SELECT COALESCE(MAX(batch_ordinal), -1) + 1 AS next_ordinal
           FROM distillation_batches WHERE session_id = ?`
        )
        .get(sessionId);
      const batchOrdinal = z.number().int().nonnegative().parse(ordinalRow?.next_ordinal);
      const batchId = `msbatch_${randomUUID()}`;
      const operationId = `msop_${randomUUID()}`;
      const operationPayload = operationPayloadSource({ batchId });
      database
        .prepare(
          `INSERT INTO luna_operations(
             operation_id, operation_kind, idempotency_key, project_id,
             session_id, payload_json, payload_sha256, state, created_at, updated_at
           ) VALUES (?, 'distill_batch', ?, ?, ?, ?, ?, 'pending', ?, ?)`
        )
        .run(
          operationId,
          `distill:${batchId}`,
          projectId,
          sessionId,
          operationPayload.source,
          operationPayload.sha256,
          preparedAt,
          preparedAt
        );
      database
        .prepare(
          `INSERT INTO distillation_batches(
             batch_id, session_id, project_id, batch_ordinal, state,
             operation_id, created_at
           ) VALUES (?, ?, ?, ?, 'queued', ?, ?)`
        )
        .run(batchId, sessionId, projectId, batchOrdinal, operationId, preparedAt);
      const insertEvent = database.prepare(
        `INSERT INTO distillation_batch_events(batch_id, event_id, event_ordinal)
         VALUES (?, ?, ?)`
      );
      selectedEventIds.forEach((eventId, index) => {
        insertEvent.run(batchId, eventId, index);
      });
      database.exec("COMMIT");
      return {
        state: "queued",
        batchId,
        operationId,
        sessionId,
        eventCount: selectedRows.length
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

async function loadBatchEvidence(
  runtimeRoot: string,
  batchId: string
): Promise<{
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly scope: { readonly kind: "project"; readonly projectId: string } | { readonly kind: "global" } | null;
  readonly startup: "auto" | "always" | "never";
  readonly explicit: boolean;
  readonly evidence: readonly LunaEvidence[];
}> {
  const database = await openRuntimeDatabase(runtimeRoot);
  let sessionId: string;
  let projectId: string | null;
  let scope: { readonly kind: "project"; readonly projectId: string } | { readonly kind: "global" } | null;
  let startup: "auto" | "always" | "never";
  let explicit: boolean;
  let rows: readonly Record<string, unknown>[];
  try {
    const batch = database
      .prepare(
        `SELECT session_id, project_id, requested_scope_kind,
                requested_startup, source_selector
         FROM distillation_batches WHERE batch_id = ?`
      )
      .get(batchId);
    if (batch === undefined) throw new Error("Distillation batch does not exist.");
    sessionId = z.string().parse(batch.session_id);
    projectId = typeof batch.project_id === "string" ? batch.project_id : null;
    scope = batch.requested_scope_kind === "global"
      ? { kind: "global" }
      : projectId === null
        ? null
        : { kind: "project", projectId };
    startup = z.enum(["auto", "always", "never"]).parse(batch.requested_startup);
    explicit = typeof batch.source_selector === "string";
    rows = database
      .prepare(
          `SELECT assigned.event_id, capture.source_truncated,
                  capture.whole_content_sha256
         FROM distillation_batch_events AS assigned
         JOIN capture_events AS capture ON capture.event_id = assigned.event_id
         WHERE assigned.batch_id = ? ORDER BY assigned.event_ordinal ASC`
      )
      .all(batchId);
  } finally {
    database.close();
  }
  const evidence = await Promise.all(
    rows.map(async (row) => {
      const eventId = z.string().parse(row.event_id);
      const event = await readCapturedEvent(runtimeRoot, eventId);
      if (event === undefined) throw new Error("Batch Capture Event is unavailable.");
      return mapCapturedEventToLunaEvidence({
        event,
        sourceTruncated: row.source_truncated === 1,
        evidenceContentIdentity: z.string().parse(row.whole_content_sha256)
      });
    })
  );
  return { sessionId, projectId, scope, startup, explicit, evidence };
}

async function ingestDistilledCandidates(request: {
  readonly runtimeRoot: string;
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly scope?: { readonly kind: "project"; readonly projectId: string } | { readonly kind: "global" };
  readonly startup?: "auto" | "always" | "never";
  readonly explicitGlobalAuthorization?: boolean;
  readonly output: DistillationOutput | ConsolidationOutput;
  readonly evidence: readonly LunaEvidence[];
  readonly createdAt: string;
}): Promise<void> {
  const scope = request.scope ?? (
    request.projectId === null ? undefined : { kind: "project" as const, projectId: request.projectId }
  );
  if (scope === undefined) return;
  const evidenceById = new Map(request.evidence.map((item) => [item.evidenceId, item]));
  for (const distilled of request.output.candidates) {
    const referencedEvidenceIds = [...new Set([
      ...distilled.evidenceIds,
      ...distilled.importanceReasons.flatMap((reason) => reason.evidenceIds)
    ])];
    const evidence = referencedEvidenceIds.flatMap((evidenceId) => {
      const item = evidenceById.get(evidenceId);
      if (item === undefined || item.occurredAt === undefined) return [];
      return [{
        evidenceId: item.evidenceId,
        evidenceClass: item.evidenceClass,
        sourceIdentity: item.sourceIdentity,
        ...(item.projectId === undefined ? {} : { projectId: item.projectId }),
        occurredAt: item.occurredAt,
        integrity: item.sourceTruncated ? "truncated" as const : "intact" as const,
        sourceTruncated: item.sourceTruncated,
        memoryEcho: item.memoryEcho,
        ...(item.repoRevision === undefined ? {} : { repoRevision: item.repoRevision }),
        ...(item.evidenceContentIdentity === undefined
          ? {}
          : { evidenceContentIdentity: item.evidenceContentIdentity }),
        ...(item.fileContentIdentity === undefined
          ? {}
          : { fileContentIdentity: item.fileContentIdentity }),
        ...(item.filePath === undefined ? {} : { filePath: item.filePath }),
        ...(item.repositoryRoot === undefined
          ? {}
          : { repositoryRoot: item.repositoryRoot }),
        ...(item.command === undefined ? {} : { command: item.command }),
        ...(item.commandCwd === undefined ? {} : { commandCwd: item.commandCwd }),
        ...(item.commandResultIdentity === undefined
          ? {}
          : { commandResultIdentity: item.commandResultIdentity }),
        ...(item.commandExitCode === undefined
          ? {}
          : { commandExitCode: item.commandExitCode }),
        ...(item.humanMemoryId === undefined
          ? {}
          : { humanMemoryId: item.humanMemoryId }),
        ...(item.humanRevisionId === undefined
          ? {}
          : { humanRevisionId: item.humanRevisionId }),
        ...(item.humanContentIdentity === undefined
          ? {}
          : { humanContentIdentity: item.humanContentIdentity })
      }];
    });
    if (evidence.length === 0) continue;
    const globalAuthorization = scope.kind === "global" && request.explicitGlobalAuthorization === true
      ? await recordHumanGlobalAuthorization({
          runtimeRoot: request.runtimeRoot,
          statement: distilled.statement,
          maximumSensitivity: distilled.sensitivity === "private" ? "private" : "normal",
          authorizedAt: request.createdAt,
          sourceIdentity: `remember.extract:${request.sessionId}`
        })
      : undefined;
    await createAgentCandidate({
      runtimeRoot: request.runtimeRoot,
      scope,
      candidate: {
        statement: distilled.statement,
        primaryCategory: distilled.primaryCategory,
        categoryTags: distilled.categoryTags,
        applicabilitySummary: distilled.applicabilitySummary,
        conditions: distilled.conditions,
        exclusions: distilled.exclusions,
        preservedNegations: distilled.preservedNegations,
        certainty: distilled.certainty,
        importanceTags: distilled.importanceTags,
        importanceReasons: distilled.importanceReasons,
        sensitivity: distilled.sensitivity
      },
      evidence,
      sourceSessionId: request.sessionId,
      startup: request.startup ?? "auto",
      ...(globalAuthorization === undefined
        ? {}
        : { globalAuthorizationId: globalAuthorization.authorizationId }),
      createdAt: request.createdAt
    });
  }
}

async function queueConsolidationIfReady(
  runtimeRoot: string,
  sessionId: string,
  completedAt: string
): Promise<{
  readonly sessionId: string;
  readonly generation: number;
  readonly fromBatchOrdinal: number;
  readonly throughBatchOrdinal: number;
} | undefined> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const cursor = database
        .prepare(
          `SELECT generation, through_batch_ordinal
           FROM session_distillation_cursors WHERE session_id = ?`
        )
        .get(sessionId);
      const cursorGeneration = cursor === undefined
        ? 0
        : z.number().int().nonnegative().parse(cursor.generation);
      const cursorThrough = cursor === undefined
        ? -1
        : z.number().int().nonnegative().parse(cursor.through_batch_ordinal);
      const cutoff = database.prepare(
        `SELECT MAX(batch.batch_ordinal) AS value
         FROM distillation_batches AS batch
         WHERE batch.session_id = ? AND batch.split_at IS NULL
           AND (
             batch.source_selector IS NOT NULL
             OR EXISTS (
               SELECT 1
               FROM distillation_batch_events AS assigned
               JOIN capture_events AS capture ON capture.event_id = assigned.event_id
               WHERE assigned.batch_id = batch.batch_id
                 AND capture.event_kind = 'SessionEnd'
             )
           )`
      ).get(sessionId);
      if (typeof cutoff?.value !== "number" || cutoff.value <= cursorThrough) {
        database.exec("COMMIT");
        return undefined;
      }
      const throughBatchOrdinal = z.number().int().nonnegative().parse(cutoff.value);
      const summary = database.prepare(
        `SELECT COUNT(*) AS batch_count,
                SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) AS completed_count
         FROM distillation_batches
         WHERE session_id = ? AND split_at IS NULL
           AND batch_ordinal > ? AND batch_ordinal <= ?`
      ).get(sessionId, cursorThrough, throughBatchOrdinal);
      const batchCount = z.number().int().positive().parse(summary?.batch_count);
      const completedCount = z.number().int().nonnegative().parse(summary?.completed_count ?? 0);
      if (batchCount !== completedCount) {
        database.exec("COMMIT");
        return undefined;
      }
      const existing = database.prepare(
        `SELECT state FROM session_consolidations WHERE session_id = ?`
      ).get(sessionId);
      if (existing !== undefined && existing.state !== "completed") {
        database.exec("COMMIT");
        return undefined;
      }
      const generation = cursorGeneration + 1;
      const fromBatchOrdinal = cursorThrough + 1;
      const operationId = `msop_${randomUUID()}`;
      const payload = operationPayloadSource({
        sessionId,
        generation,
        fromBatchOrdinal,
        throughBatchOrdinal
      });
      database.prepare(
        `INSERT INTO luna_operations(
           operation_id, operation_kind, idempotency_key, session_id,
           payload_json, payload_sha256, state, created_at, updated_at
         ) VALUES (?, 'consolidate_session', ?, ?, ?, ?, 'pending', ?, ?)`
      ).run(
        operationId,
        `consolidate:${sessionId}:${String(generation)}:${String(fromBatchOrdinal)}:${String(throughBatchOrdinal)}`,
        sessionId,
        payload.source,
        payload.sha256,
        completedAt,
        completedAt
      );
      if (existing === undefined) {
        database.prepare(
          `INSERT INTO session_consolidations(
             session_id, operation_id, state, created_at, generation,
             from_batch_ordinal, through_batch_ordinal
           ) VALUES (?, ?, 'queued', ?, ?, ?, ?)`
        ).run(
          sessionId,
          operationId,
          completedAt,
          generation,
          fromBatchOrdinal,
          throughBatchOrdinal
        );
      } else {
        database.prepare(
          `UPDATE session_consolidations
           SET operation_id = ?, state = 'queued', result_json = NULL,
               created_at = ?, completed_at = NULL, generation = ?,
               from_batch_ordinal = ?, through_batch_ordinal = ?
           WHERE session_id = ? AND state = 'completed'`
        ).run(
          operationId,
          completedAt,
          generation,
          fromBatchOrdinal,
          throughBatchOrdinal,
          sessionId
        );
      }
      database.exec("COMMIT");
      return {
        sessionId,
        generation,
        fromBatchOrdinal,
        throughBatchOrdinal
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export type PrepareSessionConsolidationResult =
  | { readonly state: "empty" }
  | {
      readonly state: "queued";
      readonly sessionId: string;
      readonly generation: number;
      readonly fromBatchOrdinal: number;
      readonly throughBatchOrdinal: number;
    };

export async function prepareNextSessionConsolidation(request: {
  readonly runtimeRoot: string;
  readonly preparedAt: string;
}): Promise<PrepareSessionConsolidationResult> {
  const preparedAt = z.iso.datetime().parse(request.preparedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let sessionIds: readonly string[];
  try {
    sessionIds = database.prepare(
      `SELECT DISTINCT batch.session_id
       FROM distillation_batches AS batch
       WHERE batch.state = 'completed' AND batch.split_at IS NULL
         AND (
           batch.source_selector IS NOT NULL
           OR EXISTS (
             SELECT 1
             FROM distillation_batch_events AS assigned
             JOIN capture_events AS capture ON capture.event_id = assigned.event_id
             WHERE assigned.batch_id = batch.batch_id
               AND capture.event_kind = 'SessionEnd'
           )
         )
         AND batch.batch_ordinal > COALESCE((
           SELECT cursor.through_batch_ordinal
           FROM session_distillation_cursors AS cursor
           WHERE cursor.session_id = batch.session_id
         ), -1)
       ORDER BY COALESCE(batch.completed_at, batch.created_at), batch.session_id`
    ).all().map((row) => z.string().parse(row.session_id));
  } finally {
    database.close();
  }
  for (const sessionId of sessionIds) {
    const queued = await queueConsolidationIfReady(
      request.runtimeRoot,
      sessionId,
      preparedAt
    );
    if (queued !== undefined) return { state: "queued", ...queued };
  }
  return { state: "empty" };
}

async function splitLargeSchemaInvalidBatch(request: {
  readonly runtimeRoot: string;
  readonly batchId: string;
  readonly operationId: string;
  readonly splitAt: string;
}): Promise<{ readonly state: "not_split" } | { readonly state: "split"; readonly childBatchCount: 2 }> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const batch = database.prepare(
        `SELECT session_id, project_id, requested_scope_kind,
                requested_startup, source_selector, split_at
         FROM distillation_batches
         WHERE batch_id = ? AND operation_id = ?`
      ).get(request.batchId, request.operationId);
      if (batch === undefined || batch.split_at !== null) {
        database.exec("COMMIT");
        return { state: "not_split" };
      }
      const sessionId = z.string().parse(batch.session_id);
      const projectId = z.string().nullable().parse(batch.project_id);
      const requestedScopeKind = z.enum(["project", "global"]).parse(
        batch.requested_scope_kind
      );
      const requestedStartup = z.enum(["auto", "always", "never"]).parse(
        batch.requested_startup
      );
      const sourceSelector = z.string().nullable().parse(batch.source_selector);
      const rows = database.prepare(
        `SELECT assigned.event_id, assigned.event_ordinal, capture.retained_bytes
         FROM distillation_batch_events AS assigned
         JOIN capture_events AS capture ON capture.event_id = assigned.event_id
         WHERE assigned.batch_id = ? ORDER BY assigned.event_ordinal`
      ).all(request.batchId);
      const totalBytes = rows.reduce(
        (sum, row) => sum + z.number().int().nonnegative().parse(row.retained_bytes),
        0
      );
      if (rows.length < 2 || totalBytes < 64 * 1024) {
        database.exec("COMMIT");
        return { state: "not_split" };
      }
      let splitIndex = 1;
      let bytesBeforeSplit = 0;
      let smallestDifference = Number.POSITIVE_INFINITY;
      for (let index = 1; index < rows.length; index += 1) {
        bytesBeforeSplit += z.number().int().nonnegative().parse(rows[index - 1]?.retained_bytes);
        const difference = Math.abs(totalBytes - 2 * bytesBeforeSplit);
        if (difference < smallestDifference) {
          smallestDifference = difference;
          splitIndex = index;
        }
      }
      const childRows = [rows.slice(0, splitIndex), rows.slice(splitIndex)] as const;
      const ordinal = z.number().int().nonnegative().parse(database.prepare(
        `SELECT COALESCE(MAX(batch_ordinal), -1) + 1 AS next_ordinal
         FROM distillation_batches WHERE session_id = ?`
      ).get(sessionId)?.next_ordinal);
      database.prepare(
        `UPDATE luna_operations
         SET state = 'dead_letter', next_retry_at = NULL, updated_at = ?
         WHERE operation_id = ? AND state IN ('retrying', 'blocked')`
      ).run(request.splitAt, request.operationId);
      database.prepare(
        `UPDATE distillation_batches
         SET state = 'blocked', split_at = ?, split_reason = 'schema_invalid_large_batch'
         WHERE batch_id = ?`
      ).run(request.splitAt, request.batchId);
      database.prepare(
        "DELETE FROM distillation_batch_events WHERE batch_id = ?"
      ).run(request.batchId);
      for (const [childIndex, events] of childRows.entries()) {
        const batchId = `msbatch_${randomUUID()}`;
        const operationId = `msop_${randomUUID()}`;
        const payload = operationPayloadSource({ batchId });
        database.prepare(
          `INSERT INTO luna_operations(
             operation_id, operation_kind, idempotency_key, project_id,
             session_id, payload_json, payload_sha256, state, created_at, updated_at
           ) VALUES (?, 'distill_batch', ?, ?, ?, ?, ?, 'pending', ?, ?)`
        ).run(
          operationId,
          `distill:${batchId}`,
          projectId,
          sessionId,
          payload.source,
          payload.sha256,
          request.splitAt,
          request.splitAt
        );
        database.prepare(
          `INSERT INTO distillation_batches(
             batch_id, session_id, project_id, batch_ordinal, state,
             operation_id, created_at, requested_scope_kind,
             requested_startup, source_selector, split_parent_batch_id
           ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`
        ).run(
          batchId,
          sessionId,
          projectId,
          ordinal + childIndex,
          operationId,
          request.splitAt,
          requestedScopeKind,
          requestedStartup,
          sourceSelector,
          request.batchId
        );
        const insertEvent = database.prepare(
          `INSERT INTO distillation_batch_events(batch_id, event_id, event_ordinal)
           VALUES (?, ?, ?)`
        );
        events.forEach((row, eventIndex) => {
          insertEvent.run(batchId, z.string().parse(row.event_id), eventIndex);
        });
      }
      database.exec("COMMIT");
      return { state: "split", childBatchCount: 2 };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

async function finalizeCompletedBatch(request: {
  readonly runtimeRoot: string;
  readonly batchId: string;
  readonly completedAt: string;
}): Promise<void> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let sessionId: string;
  let batchCount: number;
  let batchOrdinal: number;
  let hasSessionEnd: boolean;
  let output: DistillationOutput | undefined;
  try {
    const batch = database.prepare(
      `SELECT session_id, batch_ordinal, result_json, source_selector FROM distillation_batches
       WHERE batch_id = ? AND state = 'completed'`
    ).get(request.batchId);
    if (batch === undefined) throw new Error("Completed Batch result is unavailable.");
    sessionId = z.string().parse(batch.session_id);
    batchOrdinal = z.number().int().nonnegative().parse(batch.batch_ordinal);
    const summary = database.prepare(
      `SELECT COUNT(DISTINCT candidate_batch.batch_id) AS batch_count,
              MAX(CASE WHEN capture.event_kind = 'SessionEnd' THEN 1 ELSE 0 END)
                AS has_session_end
       FROM distillation_batches AS candidate_batch
       LEFT JOIN distillation_batch_events AS assigned
         ON assigned.batch_id = candidate_batch.batch_id
       LEFT JOIN capture_events AS capture ON capture.event_id = assigned.event_id
       WHERE candidate_batch.session_id = ? AND candidate_batch.split_at IS NULL`
    ).get(sessionId);
    batchCount = z.number().int().positive().parse(summary?.batch_count);
    hasSessionEnd = summary?.has_session_end === 1;
    const explicit = typeof batch.source_selector === "string";
    if (batchCount === 1 && (hasSessionEnd || explicit)) {
      output = JSON.parse(z.string().parse(batch.result_json)) as DistillationOutput;
    }
  } finally {
    database.close();
  }
  const loadedBatch = output === undefined
    ? undefined
    : await loadBatchEvidence(request.runtimeRoot, request.batchId);
  if (!hasSessionEnd && loadedBatch?.explicit !== true) return;
  if (batchCount > 1) {
    await queueConsolidationIfReady(
      request.runtimeRoot,
      sessionId,
      request.completedAt
    );
    return;
  }
  if (output !== undefined) {
    const batch = loadedBatch ?? await loadBatchEvidence(request.runtimeRoot, request.batchId);
    await ingestDistilledCandidates({
      runtimeRoot: request.runtimeRoot,
      sessionId,
      projectId: batch.projectId,
      ...(batch.scope === null ? {} : { scope: batch.scope }),
      startup: batch.startup,
      explicitGlobalAuthorization: batch.explicit && batch.scope?.kind === "global",
      output,
      evidence: batch.evidence,
      createdAt: request.completedAt
    });
    const cursorDatabase = await openRuntimeDatabase(request.runtimeRoot);
    try {
      cursorDatabase.prepare(
        `INSERT INTO session_distillation_cursors(
           session_id, generation, through_batch_ordinal, updated_at
         ) VALUES (?, 1, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           generation = session_distillation_cursors.generation + 1,
           through_batch_ordinal = excluded.through_batch_ordinal,
           updated_at = excluded.updated_at
         WHERE session_distillation_cursors.through_batch_ordinal < excluded.through_batch_ordinal`
      ).run(sessionId, batchOrdinal, request.completedAt);
    } finally {
      cursorDatabase.close();
    }
  }
}

const operationPayloadSchema = z.union([
  z.object({ batchId: z.string().min(1) }),
  z.object({
    sessionId: z.string().min(1),
    generation: z.number().int().positive().optional(),
    fromBatchOrdinal: z.number().int().nonnegative().optional(),
    throughBatchOrdinal: z.number().int().nonnegative().optional()
  })
]);

export type RunNextLunaWorkResult =
  | { readonly state: "empty" }
  | {
      readonly state: "completed" | "retrying" | "blocked";
      readonly operationId: string;
      readonly operationKind: "distill_batch" | "consolidate_session";
    }
  | {
      readonly state: "split";
      readonly operationId: string;
      readonly operationKind: "distill_batch";
      readonly childBatchCount: 2;
    };

export async function runNextLunaWork(request: {
  readonly runtimeRoot: string;
  readonly workerId: string;
  readonly now: string;
  readonly currentTime?: () => string;
  readonly adapter: LunaWorkerAdapter;
}): Promise<RunNextLunaWorkResult> {
  const currentTime = request.currentTime ?? (() => new Date().toISOString());
  const claimed = await claimLunaOperation({
    runtimeRoot: request.runtimeRoot,
    workerId: request.workerId,
    now: request.now,
    leaseSeconds: 300,
    kinds: ["consolidate_session", "distill_batch"]
  });
  if (claimed.state === "empty") return { state: "empty" };
  const operation = claimed.operation;
  if (
    operation.kind !== "distill_batch" &&
    operation.kind !== "consolidate_session"
  ) {
    throw new Error(`Unsupported Luna worker operation ${operation.kind}.`);
  }
  const payload = operationPayloadSchema.parse(operation.payload);
  const processingDatabase = await openRuntimeDatabase(request.runtimeRoot);
  let alreadyPersisted = false;
  try {
    if (operation.kind === "distill_batch" && "batchId" in payload) {
      const batch = processingDatabase
        .prepare("SELECT state, session_id FROM distillation_batches WHERE batch_id = ?")
        .get(payload.batchId);
      alreadyPersisted = batch?.state === "completed";
      if (!alreadyPersisted) {
        processingDatabase
          .prepare("UPDATE distillation_batches SET state = 'processing' WHERE batch_id = ?")
          .run(payload.batchId);
      }
    }
    if (operation.kind === "consolidate_session" && "sessionId" in payload) {
      const consolidation = processingDatabase
        .prepare("SELECT state FROM session_consolidations WHERE operation_id = ?")
        .get(operation.operationId);
      if (consolidation === undefined) {
        throw new Error("Consolidation operation is not bound to an active range.");
      }
      alreadyPersisted = consolidation.state === "completed";
      if (!alreadyPersisted) {
        processingDatabase
          .prepare("UPDATE session_consolidations SET state = 'processing' WHERE operation_id = ?")
          .run(operation.operationId);
      }
    }
  } finally {
    processingDatabase.close();
  }
  if (alreadyPersisted) {
    const completedAt = z.iso.datetime().parse(currentTime());
    if (operation.kind === "distill_batch" && "batchId" in payload) {
      await finalizeCompletedBatch({
        runtimeRoot: request.runtimeRoot,
        batchId: payload.batchId,
        completedAt
      });
    }
    await completeLunaOperation({
      runtimeRoot: request.runtimeRoot,
      operationId: operation.operationId,
      leaseToken: claimed.leaseToken,
      completedAt
    });
    return {
      state: "completed",
      operationId: operation.operationId,
      operationKind: operation.kind
    };
  }
  try {
    if (operation.kind === "distill_batch") {
      if (!("batchId" in payload)) throw new Error("Batch operation payload is invalid.");
      const batch = await loadBatchEvidence(request.runtimeRoot, payload.batchId);
      const output = await request.adapter.distillBatch({
        operationId: operation.operationId,
        scope:
          batch.projectId === null
            ? { kind: "unresolved" }
            : { kind: "project", projectId: batch.projectId },
        evidence: batch.evidence
      });
      const completedAt = z.iso.datetime().parse(currentTime());
      const database = await openRuntimeDatabase(request.runtimeRoot);
      try {
        database.exec("BEGIN IMMEDIATE");
        try {
          database
            .prepare(
              `UPDATE distillation_batches
               SET state = 'completed', result_json = ?, completed_at = ?
               WHERE batch_id = ?`
            )
            .run(JSON.stringify(output), completedAt, payload.batchId);
          database
            .prepare(
              `UPDATE capture_events SET state = 'completed', updated_at = ?
               WHERE event_id IN (
                 SELECT event_id FROM distillation_batch_events WHERE batch_id = ?
               )`
            )
            .run(completedAt, payload.batchId);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      } finally {
        database.close();
      }
      await finalizeCompletedBatch({
        runtimeRoot: request.runtimeRoot,
        batchId: payload.batchId,
        completedAt
      });
      await completeLunaOperation({
        runtimeRoot: request.runtimeRoot,
        operationId: operation.operationId,
        leaseToken: claimed.leaseToken,
        completedAt
      });
    } else {
      if (!("sessionId" in payload)) {
        throw new Error("Consolidation operation payload is invalid.");
      }
      const database = await openRuntimeDatabase(request.runtimeRoot);
      let batchRows: readonly Record<string, unknown>[];
      let consolidationGeneration: number;
      let throughBatchOrdinal: number;
      try {
        const consolidation = database.prepare(
          `SELECT session_id, generation, from_batch_ordinal, through_batch_ordinal
           FROM session_consolidations WHERE operation_id = ?`
        ).get(operation.operationId);
        if (consolidation === undefined || consolidation.session_id !== payload.sessionId) {
          throw new Error("Consolidation range is unavailable.");
        }
        consolidationGeneration = z.number().int().positive().parse(consolidation.generation);
        const fromBatchOrdinal = z.number().int().nonnegative().parse(
          consolidation.from_batch_ordinal
        );
        throughBatchOrdinal = z.number().int().nonnegative().parse(
          consolidation.through_batch_ordinal
        );
        batchRows = database
          .prepare(
            `SELECT batch_id, result_json FROM distillation_batches
             WHERE session_id = ? AND state = 'completed' AND split_at IS NULL
               AND batch_ordinal >= ? AND batch_ordinal <= ?
             ORDER BY batch_ordinal ASC`
          )
          .all(payload.sessionId, fromBatchOrdinal, throughBatchOrdinal);
      } finally {
        database.close();
      }
      const batchResults = batchRows.map((row) => {
        const output = JSON.parse(z.string().parse(row.result_json)) as DistillationOutput;
        return {
          batchId: z.string().parse(row.batch_id),
          candidates: output.candidates,
          evidenceIds: [...new Set(output.candidates.flatMap((item) => [
            ...item.evidenceIds,
            ...item.importanceReasons.flatMap((reason) => reason.evidenceIds)
          ]))]
        };
      });
      const output = await request.adapter.consolidateSession({
        operationId: operation.operationId,
        sessionId: payload.sessionId,
        batchResults
      });
      const completedAt = z.iso.datetime().parse(currentTime());
      const sessionEvidence = (
        await Promise.all(
          batchRows.map((row) =>
            loadBatchEvidence(request.runtimeRoot, z.string().parse(row.batch_id))
          )
        )
      );
      const projectIds = new Set(
        sessionEvidence.flatMap((item) => item.projectId === null ? [] : [item.projectId])
      );
      await ingestDistilledCandidates({
        runtimeRoot: request.runtimeRoot,
        sessionId: payload.sessionId,
        projectId: projectIds.size === 1 ? [...projectIds][0] ?? null : null,
        output,
        evidence: sessionEvidence.flatMap((item) => item.evidence),
        createdAt: completedAt
      });
      const updateDatabase = await openRuntimeDatabase(request.runtimeRoot);
      try {
        updateDatabase.exec("BEGIN IMMEDIATE");
        try {
          updateDatabase.prepare(
            `UPDATE session_consolidations
             SET state = 'completed', result_json = ?, completed_at = ?
             WHERE operation_id = ?`
          ).run(JSON.stringify(output), completedAt, operation.operationId);
          updateDatabase.prepare(
            `INSERT INTO session_distillation_cursors(
               session_id, generation, through_batch_ordinal, updated_at
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               generation = excluded.generation,
               through_batch_ordinal = excluded.through_batch_ordinal,
               updated_at = excluded.updated_at`
          ).run(
            payload.sessionId,
            consolidationGeneration,
            throughBatchOrdinal,
            completedAt
          );
          updateDatabase.exec("COMMIT");
        } catch (error) {
          updateDatabase.exec("ROLLBACK");
          throw error;
        }
      } finally {
        updateDatabase.close();
      }
      await completeLunaOperation({
        runtimeRoot: request.runtimeRoot,
        operationId: operation.operationId,
        leaseToken: claimed.leaseToken,
        completedAt
      });
    }
    return {
      state: "completed",
      operationId: operation.operationId,
      operationKind: operation.kind
    };
  } catch (error) {
    const failedAt = z.iso.datetime().parse(currentTime());
    const failed =
      error instanceof LunaInvocationError
        ? await failLunaOperation({
            runtimeRoot: request.runtimeRoot,
            operationId: operation.operationId,
            leaseToken: claimed.leaseToken,
            failedAt,
            error
          })
        : await failLunaOperationLocally({
            runtimeRoot: request.runtimeRoot,
            operationId: operation.operationId,
            leaseToken: claimed.leaseToken,
            failedAt,
            retryable: true
          });
    const failedDatabase = await openRuntimeDatabase(request.runtimeRoot);
    try {
      if (operation.kind === "distill_batch" && "batchId" in payload) {
        failedDatabase
          .prepare("UPDATE distillation_batches SET state = ? WHERE batch_id = ?")
          .run(failed.state, payload.batchId);
      }
      if (operation.kind === "consolidate_session" && "sessionId" in payload) {
        failedDatabase
          .prepare("UPDATE session_consolidations SET state = ? WHERE operation_id = ?")
          .run(failed.state, operation.operationId);
      }
    } finally {
      failedDatabase.close();
    }
    if (
      error instanceof LunaInvocationError &&
      error.category === "schema_invalid" &&
      operation.kind === "distill_batch" &&
      "batchId" in payload
    ) {
      const split = await splitLargeSchemaInvalidBatch({
        runtimeRoot: request.runtimeRoot,
        batchId: payload.batchId,
        operationId: operation.operationId,
        splitAt: failedAt
      });
      if (split.state === "split") {
        return {
          state: "split",
          operationId: operation.operationId,
          operationKind: "distill_batch",
          childBatchCount: split.childBatchCount
        };
      }
    }
    return {
      state: failed.state,
      operationId: operation.operationId,
      operationKind: operation.kind
    };
  }
}

export async function inspectSessionDistillation(request: {
  readonly runtimeRoot: string;
  readonly sessionId: string;
}): Promise<{
  readonly sessionId: string;
  readonly batchCount: number;
  readonly completedBatchCount: number;
  readonly consolidationState: "none" | "queued" | "processing" | "retrying" | "blocked" | "completed";
}> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const batches = database
      .prepare(
        `SELECT COUNT(*) AS batch_count,
                SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) AS completed_count
         FROM distillation_batches WHERE session_id = ? AND split_at IS NULL`
      )
      .get(request.sessionId);
    const consolidation = database
      .prepare("SELECT state FROM session_consolidations WHERE session_id = ?")
      .get(request.sessionId);
    return {
      sessionId: request.sessionId,
      batchCount: z.number().int().nonnegative().parse(batches?.batch_count),
      completedBatchCount: z
        .number()
        .int()
        .nonnegative()
        .parse(batches?.completed_count ?? 0),
      consolidationState:
        consolidation === undefined
          ? "none"
          : z
              .enum(["queued", "processing", "retrying", "blocked", "completed"])
              .parse(consolidation.state)
    };
  } finally {
    database.close();
  }
}
