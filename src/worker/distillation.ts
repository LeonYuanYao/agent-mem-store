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
  readonly preparedAt: string;
}): Promise<PrepareDistillationBatchResult> {
  const preparedAt = z.iso.datetime().parse(request.preparedAt);
  if (
    !Number.isInteger(request.maximumEvents) ||
    request.maximumEvents < 1 ||
    request.maximumEvents > 64
  ) {
    throw new Error("maximumEvents must be between one and 64.");
  }
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const first = database
        .prepare(
          `SELECT event_id, session_id, project_id
           FROM capture_events AS capture
           WHERE capture.state = 'pending'
             AND NOT EXISTS (
               SELECT 1 FROM distillation_batch_events AS assigned
               WHERE assigned.event_id = capture.event_id
             )
           ORDER BY capture.created_at ASC LIMIT 1`
        )
        .get();
      if (first === undefined) {
        database.exec("COMMIT");
        return { state: "empty" };
      }
      const firstEventId = z.string().parse(first.event_id);
      const sessionId =
        typeof first.session_id === "string"
          ? first.session_id
          : `event:${firstEventId}`;
      const rows = database
        .prepare(
          `SELECT capture.event_id, capture.project_id
           FROM capture_events AS capture
           WHERE capture.state = 'pending'
             AND COALESCE(capture.session_id, 'event:' || capture.event_id) = ?
             AND NOT EXISTS (
               SELECT 1 FROM distillation_batch_events AS assigned
               WHERE assigned.event_id = capture.event_id
             )
           ORDER BY capture.created_at ASC LIMIT ?`
        )
        .all(sessionId, request.maximumEvents);
      if (rows.length === 0) throw new Error("Distillation batch selection failed.");
      const projectIds = new Set(
        rows
          .map((row) => row.project_id)
          .filter((value): value is string => typeof value === "string")
      );
      const projectId = projectIds.size === 1 ? [...projectIds][0] ?? null : null;
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
      rows.forEach((row, index) => {
        insertEvent.run(batchId, z.string().parse(row.event_id), index);
      });
      database.exec("COMMIT");
      return {
        state: "queued",
        batchId,
        operationId,
        sessionId,
        eventCount: rows.length
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
    const evidence = distilled.evidenceIds.flatMap((evidenceId) => {
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
        category: distilled.category,
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
): Promise<void> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const summary = database
        .prepare(
          `SELECT COUNT(DISTINCT batch.batch_id) AS batch_count,
                  COUNT(DISTINCT CASE WHEN batch.state = 'completed' THEN batch.batch_id END)
                    AS completed_count,
                  MAX(CASE WHEN event_kind = 'SessionEnd' THEN 1 ELSE 0 END) AS has_session_end
           FROM distillation_batches AS batch
           LEFT JOIN distillation_batch_events AS assigned ON assigned.batch_id = batch.batch_id
           LEFT JOIN capture_events AS capture ON capture.event_id = assigned.event_id
           WHERE batch.session_id = ?`
        )
        .get(sessionId);
      const batchCount = z.number().int().nonnegative().parse(summary?.batch_count);
      const completedCount = z.number().int().nonnegative().parse(summary?.completed_count);
      const hasSessionEnd = summary?.has_session_end === 1;
      if (batchCount > 1 && batchCount === completedCount && hasSessionEnd) {
        const existing = database
          .prepare(
            "SELECT operation_id FROM session_consolidations WHERE session_id = ?"
          )
          .get(sessionId);
        if (existing === undefined) {
          const operationId = `msop_${randomUUID()}`;
          const payload = operationPayloadSource({ sessionId });
          database
            .prepare(
              `INSERT INTO luna_operations(
                 operation_id, operation_kind, idempotency_key, session_id,
                 payload_json, payload_sha256, state, created_at, updated_at
               ) VALUES (?, 'consolidate_session', ?, ?, ?, ?, 'pending', ?, ?)`
            )
            .run(
              operationId,
              `consolidate:${sessionId}`,
              sessionId,
              payload.source,
              payload.sha256,
              completedAt,
              completedAt
            );
          database
          .prepare(
            `INSERT INTO session_consolidations(
               session_id, operation_id, state, created_at
             ) VALUES (?, ?, 'queued', ?)`
          )
          .run(sessionId, operationId, completedAt);
        }
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

async function finalizeCompletedBatch(request: {
  readonly runtimeRoot: string;
  readonly batchId: string;
  readonly completedAt: string;
}): Promise<void> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let sessionId: string;
  let batchCount: number;
  let hasSessionEnd: boolean;
  let output: DistillationOutput | undefined;
  try {
    const batch = database.prepare(
      `SELECT session_id, result_json, source_selector FROM distillation_batches
       WHERE batch_id = ? AND state = 'completed'`
    ).get(request.batchId);
    if (batch === undefined) throw new Error("Completed Batch result is unavailable.");
    sessionId = z.string().parse(batch.session_id);
    const summary = database.prepare(
      `SELECT COUNT(DISTINCT candidate_batch.batch_id) AS batch_count,
              MAX(CASE WHEN capture.event_kind = 'SessionEnd' THEN 1 ELSE 0 END)
                AS has_session_end
       FROM distillation_batches AS candidate_batch
       LEFT JOIN distillation_batch_events AS assigned
         ON assigned.batch_id = candidate_batch.batch_id
       LEFT JOIN capture_events AS capture ON capture.event_id = assigned.event_id
       WHERE candidate_batch.session_id = ?`
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
  }
}

const operationPayloadSchema = z.union([
  z.object({ batchId: z.string().min(1) }),
  z.object({ sessionId: z.string().min(1) })
]);

export type RunNextLunaWorkResult =
  | { readonly state: "empty" }
  | {
      readonly state: "completed" | "retrying" | "blocked";
      readonly operationId: string;
      readonly operationKind: "distill_batch" | "consolidate_session";
    };

export async function runNextLunaWork(request: {
  readonly runtimeRoot: string;
  readonly workerId: string;
  readonly now: string;
  readonly adapter: LunaWorkerAdapter;
}): Promise<RunNextLunaWorkResult> {
  const claimed = await claimLunaOperation({
    runtimeRoot: request.runtimeRoot,
    workerId: request.workerId,
    now: request.now,
    leaseSeconds: 300,
    kinds: ["distill_batch", "consolidate_session"]
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
        .prepare("SELECT state FROM session_consolidations WHERE session_id = ?")
        .get(payload.sessionId);
      alreadyPersisted = consolidation?.state === "completed";
      if (!alreadyPersisted) {
        processingDatabase
          .prepare("UPDATE session_consolidations SET state = 'processing' WHERE session_id = ?")
          .run(payload.sessionId);
      }
    }
  } finally {
    processingDatabase.close();
  }
  if (alreadyPersisted) {
    if (operation.kind === "distill_batch" && "batchId" in payload) {
      await finalizeCompletedBatch({
        runtimeRoot: request.runtimeRoot,
        batchId: payload.batchId,
        completedAt: request.now
      });
    }
    await completeLunaOperation({
      runtimeRoot: request.runtimeRoot,
      operationId: operation.operationId,
      leaseToken: claimed.leaseToken,
      completedAt: request.now
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
            .run(JSON.stringify(output), request.now, payload.batchId);
          database
            .prepare(
              `UPDATE capture_events SET state = 'completed', updated_at = ?
               WHERE event_id IN (
                 SELECT event_id FROM distillation_batch_events WHERE batch_id = ?
               )`
            )
            .run(request.now, payload.batchId);
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
        completedAt: request.now
      });
      await completeLunaOperation({
        runtimeRoot: request.runtimeRoot,
        operationId: operation.operationId,
        leaseToken: claimed.leaseToken,
        completedAt: request.now
      });
    } else {
      if (!("sessionId" in payload)) {
        throw new Error("Consolidation operation payload is invalid.");
      }
      const database = await openRuntimeDatabase(request.runtimeRoot);
      let batchRows: readonly Record<string, unknown>[];
      try {
        batchRows = database
          .prepare(
            `SELECT batch_id, result_json FROM distillation_batches
             WHERE session_id = ? AND state = 'completed'
             ORDER BY batch_ordinal ASC`
          )
          .all(payload.sessionId);
      } finally {
        database.close();
      }
      const batchResults = batchRows.map((row) => {
        const output = JSON.parse(z.string().parse(row.result_json)) as DistillationOutput;
        return {
          batchId: z.string().parse(row.batch_id),
          candidates: output.candidates,
          evidenceIds: [...new Set(output.candidates.flatMap((item) => item.evidenceIds))]
        };
      });
      const output = await request.adapter.consolidateSession({
        operationId: operation.operationId,
        sessionId: payload.sessionId,
        batchResults
      });
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
        createdAt: request.now
      });
      const updateDatabase = await openRuntimeDatabase(request.runtimeRoot);
      try {
        updateDatabase
          .prepare(
            `UPDATE session_consolidations
             SET state = 'completed', result_json = ?, completed_at = ?
             WHERE session_id = ?`
          )
          .run(JSON.stringify(output), request.now, payload.sessionId);
      } finally {
        updateDatabase.close();
      }
      await completeLunaOperation({
        runtimeRoot: request.runtimeRoot,
        operationId: operation.operationId,
        leaseToken: claimed.leaseToken,
        completedAt: request.now
      });
    }
    return {
      state: "completed",
      operationId: operation.operationId,
      operationKind: operation.kind
    };
  } catch (error) {
    const failed =
      error instanceof LunaInvocationError
        ? await failLunaOperation({
            runtimeRoot: request.runtimeRoot,
            operationId: operation.operationId,
            leaseToken: claimed.leaseToken,
            failedAt: request.now,
            error
          })
        : await failLunaOperationLocally({
            runtimeRoot: request.runtimeRoot,
            operationId: operation.operationId,
            leaseToken: claimed.leaseToken,
            failedAt: request.now,
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
          .prepare("UPDATE session_consolidations SET state = ? WHERE session_id = ?")
          .run(failed.state, payload.sessionId);
      }
    } finally {
      failedDatabase.close();
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
         FROM distillation_batches WHERE session_id = ?`
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
