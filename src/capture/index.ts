import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { openRuntimeDatabase } from "../runtime/database.js";
import {
  classifyLocalSensitivity,
  type LocalSensitivityFinding
} from "../contracts/sensitivity.js";

export const captureEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  deduplicationKey: z.string().min(1),
  agent: z.literal("codex"),
  eventKind: z.enum([
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "Stop",
    "SessionEnd"
  ]),
  occurredAt: z.iso.datetime(),
  projectId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  payload: z.unknown()
});

export type CaptureEvent = z.infer<typeof captureEventSchema>;

export interface CaptureRequest {
  readonly runtimeRoot: string;
  readonly event: CaptureEvent;
  readonly recoverHealthCategory?: "hook_capture";
  readonly busyTimeoutMilliseconds?: number;
}

export type CaptureResult =
  | {
      readonly state: "captured";
      readonly eventId: string;
      readonly segmentCount: number;
      readonly sourceBytes: number;
      readonly retainedBytes: number;
      readonly sourceTruncated: boolean;
    }
  | {
      readonly state: "duplicate";
      readonly eventId: string;
    }
  | {
      readonly state: "blocked_secret";
      readonly findingId: string;
      readonly category: "authorization_header" | "private_key" | "credential_field";
    }
  | {
      readonly state: "quarantined";
      readonly findingId: string;
      readonly category: "contextual_credential";
    };

const segmentBytes = 64 * 1024;
const maximumTurnBytes = 1024 * 1024;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fingerprintKey(runtimeRoot: string): Promise<Buffer> {
  const stateDirectory = join(runtimeRoot, "state");
  const keyPath = join(stateDirectory, "fingerprint.key");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  try {
    const key = randomBytes(32);
    const file = await open(keyPath, "wx", 0o600);
    try {
      await file.writeFile(key);
      await file.sync();
    } finally {
      await file.close();
    }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    return readFile(keyPath);
  }
}

async function recordSensitivityFinding(
  runtimeRoot: string,
  event: CaptureEvent,
  finding: Exclude<LocalSensitivityFinding, { readonly state: "normal" }>,
  state: "blocked_secret" | "quarantined",
  busyTimeoutMilliseconds?: number
): Promise<
  Extract<CaptureResult, { readonly state: "blocked_secret" | "quarantined" }>
> {
  const key = await fingerprintKey(runtimeRoot);
  const fingerprint = createHmac("sha256", key)
    .update(finding.category)
    .update("\0")
    .update(finding.matchedValue)
    .digest("hex");
  const sourceIdentity = createHmac("sha256", key)
    .update(event.deduplicationKey)
    .digest("hex");
  const database = await openRuntimeDatabase(
    runtimeRoot,
    busyTimeoutMilliseconds === undefined ? {} : { busyTimeoutMilliseconds }
  );
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = database
        .prepare(
          `SELECT finding_id FROM sensitivity_findings WHERE fingerprint = ?`
        )
        .get(fingerprint);
      const findingId =
        existing === undefined
          ? `msfinding_${randomUUID()}`
          : existing.finding_id;
      if (typeof findingId !== "string") {
        throw new Error("Sensitivity finding contains an invalid identity.");
      }
      if (existing === undefined) {
        database
          .prepare(
            `INSERT INTO sensitivity_findings(
               finding_id, fingerprint, state, category, first_seen_at,
               last_seen_at, occurrence_count, body_retained
             ) VALUES (?, ?, ?, ?, ?, ?, 1, 0)`
          )
          .run(
            findingId,
            fingerprint,
            state,
            finding.category,
            event.occurredAt,
            event.occurredAt
          );
      }
      const observation = database
        .prepare(
          `INSERT OR IGNORE INTO sensitivity_observations(
             fingerprint, source_identity, observed_at, source_kind
           ) VALUES (?, ?, ?, ?)`
        )
        .run(fingerprint, sourceIdentity, event.occurredAt, `${event.agent}:${event.eventKind}`);
      if (existing !== undefined && observation.changes === 1) {
        database
          .prepare(
            `UPDATE sensitivity_findings
             SET last_seen_at = ?, occurrence_count = occurrence_count + 1
             WHERE fingerprint = ?`
          )
          .run(event.occurredAt, fingerprint);
      }
      database.exec("COMMIT");
      return {
        state,
        findingId,
        category: finding.category
      } as Extract<
        CaptureResult,
        { readonly state: "blocked_secret" | "quarantined" }
      >;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function recordBodyFreeSensitivityDisposition(request: {
  readonly runtimeRoot: string;
  readonly findingId: string;
  readonly fingerprint: string;
  readonly sourceIdentity: string;
  readonly state: "blocked_secret" | "quarantined";
  readonly category: "authorization_header" | "private_key" | "credential_field" | "contextual_credential";
  readonly observedAt: string;
  readonly sourceKind: string;
  readonly busyTimeoutMilliseconds?: number;
}): Promise<Extract<CaptureResult, { readonly state: "blocked_secret" | "quarantined" }>> {
  const findingId = z.string().regex(/^msfinding_[0-9a-f-]+$/u).parse(request.findingId);
  const fingerprint = z.string().regex(/^[0-9a-f]{64}$/u).parse(request.fingerprint);
  const sourceIdentity = z.string().regex(/^[0-9a-f]{64}$/u).parse(request.sourceIdentity);
  const observedAt = z.iso.datetime().parse(request.observedAt);
  const sourceKind = z.string().min(1).max(128).parse(request.sourceKind);
  const database = await openRuntimeDatabase(
    request.runtimeRoot,
    request.busyTimeoutMilliseconds === undefined
      ? {}
      : { busyTimeoutMilliseconds: request.busyTimeoutMilliseconds }
  );
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = database.prepare(
        "SELECT finding_id FROM sensitivity_findings WHERE fingerprint = ?"
      ).get(fingerprint);
      const durableFindingId = existing === undefined
        ? findingId
        : z.string().parse(existing.finding_id);
      if (existing === undefined) {
        database.prepare(
          `INSERT INTO sensitivity_findings(
             finding_id, fingerprint, state, category, first_seen_at,
             last_seen_at, occurrence_count, body_retained
           ) VALUES (?, ?, ?, ?, ?, ?, 1, 0)`
        ).run(
          durableFindingId,
          fingerprint,
          request.state,
          request.category,
          observedAt,
          observedAt
        );
      }
      const observation = database.prepare(
        `INSERT OR IGNORE INTO sensitivity_observations(
           fingerprint, source_identity, observed_at, source_kind
         ) VALUES (?, ?, ?, ?)`
      ).run(fingerprint, sourceIdentity, observedAt, sourceKind);
      if (existing !== undefined && observation.changes === 1) {
        database.prepare(
          `UPDATE sensitivity_findings
           SET last_seen_at = ?, occurrence_count = occurrence_count + 1
           WHERE fingerprint = ?`
        ).run(observedAt, fingerprint);
      }
      database.exec("COMMIT");
      return request.state === "blocked_secret"
        ? {
            state: "blocked_secret",
            findingId: durableFindingId,
            category: z.enum([
              "authorization_header",
              "private_key",
              "credential_field"
            ]).parse(request.category)
          }
        : {
            state: "quarantined",
            findingId: durableFindingId,
            category: z.literal("contextual_credential").parse(request.category)
          };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function segment(value: Uint8Array): readonly Uint8Array[] {
  const segments: Uint8Array[] = [];
  for (let offset = 0; offset < value.byteLength; offset += segmentBytes) {
    segments.push(value.slice(offset, Math.min(offset + segmentBytes, value.byteLength)));
  }
  return segments.length === 0 ? [new Uint8Array()] : segments;
}

function retainBoundedPayload(serializedPayload: Buffer): {
  readonly payload: Buffer;
  readonly truncated: boolean;
} {
  if (serializedPayload.byteLength <= maximumTurnBytes) {
    return { payload: serializedPayload, truncated: false };
  }

  let prefixBytes = maximumTurnBytes - 256;
  while (prefixBytes >= 0) {
    const retainedJsonPrefix = new TextDecoder().decode(
      serializedPayload.subarray(0, prefixBytes)
    );
    const payload = Buffer.from(
      JSON.stringify({
        memstoreTruncated: true,
        originalBytes: serializedPayload.byteLength,
        retainedJsonPrefix
      }),
      "utf8"
    );
    if (payload.byteLength <= maximumTurnBytes) {
      return { payload, truncated: true };
    }
    prefixBytes -= payload.byteLength - maximumTurnBytes + 16;
  }

  throw new Error("Unable to construct a bounded Capture Event payload.");
}

export type PreparedCaptureEvent =
  | {
      readonly state: "normal";
      readonly event: CaptureEvent;
      readonly retainedPayload: Buffer;
      readonly sourceBytes: number;
      readonly sourceTruncated: boolean;
    }
  | {
      readonly state: "secret" | "uncertain";
      readonly event: CaptureEvent;
      readonly finding: Exclude<LocalSensitivityFinding, { readonly state: "normal" }>;
    };

export function prepareCaptureEventForPersistence(eventSource: unknown): PreparedCaptureEvent {
  const event = captureEventSchema.parse(eventSource);
  const serializedPayload = Buffer.from(JSON.stringify(event.payload), "utf8");
  const sensitivity = classifyLocalSensitivity(serializedPayload.toString("utf8"));
  if (sensitivity.state !== "normal") {
    return { state: sensitivity.state, event, finding: sensitivity };
  }
  const retained = retainBoundedPayload(serializedPayload);
  return {
    state: "normal",
    event,
    retainedPayload: retained.payload,
    sourceBytes: serializedPayload.byteLength,
    sourceTruncated: retained.truncated
  };
}

async function persistPreparedCaptureEvent(
  request: CaptureRequest,
  prepared: Extract<PreparedCaptureEvent, { readonly state: "normal" }>
): Promise<CaptureResult> {
  const { event, retainedPayload, sourceBytes, sourceTruncated } = prepared;
  const segments = segment(retainedPayload);
  const database = await openRuntimeDatabase(
    request.runtimeRoot,
    request.busyTimeoutMilliseconds === undefined
      ? {}
      : { busyTimeoutMilliseconds: request.busyTimeoutMilliseconds }
  );
  const captureSucceededAt = new Date().toISOString();

  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = database
        .prepare(
          "SELECT event_id FROM capture_events WHERE deduplication_key = ?"
        )
        .get(event.deduplicationKey);
      if (duplicate !== undefined) {
        const duplicateEventId = duplicate.event_id;
        if (typeof duplicateEventId !== "string") {
          throw new Error("Outbox contains an invalid event identity.");
        }
        if (request.recoverHealthCategory !== undefined) {
          database.prepare(
            `UPDATE capture_health_incidents
             SET ended_at = ?
             WHERE category = ? AND ended_at IS NULL`
          ).run(captureSucceededAt, request.recoverHealthCategory);
        }
        database.exec("COMMIT");
        return { state: "duplicate", eventId: duplicateEventId };
      }

      database
        .prepare(
          `INSERT INTO capture_events(
             event_id, deduplication_key, schema_version, agent, event_kind,
             occurred_at, project_id, session_id, turn_id, whole_content_sha256,
             segment_count, source_bytes, retained_bytes, source_truncated,
             state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        )
        .run(
          event.eventId,
          event.deduplicationKey,
          event.schemaVersion,
          event.agent,
          event.eventKind,
          event.occurredAt,
          event.projectId ?? null,
          event.sessionId ?? null,
          event.turnId ?? null,
          sha256(retainedPayload),
          segments.length,
          sourceBytes,
          retainedPayload.byteLength,
          sourceTruncated ? 1 : 0,
          captureSucceededAt,
          captureSucceededAt
        );
      const insertSegment = database.prepare(
        `INSERT INTO capture_segments(event_id, segment_index, payload, payload_sha256)
         VALUES (?, ?, ?, ?)`
      );
      for (const [index, payload] of segments.entries()) {
        insertSegment.run(event.eventId, index, payload, sha256(payload));
      }
      if (request.recoverHealthCategory !== undefined) {
        database.prepare(
          `UPDATE capture_health_incidents
           SET ended_at = ?
           WHERE category = ? AND ended_at IS NULL`
        ).run(captureSucceededAt, request.recoverHealthCategory);
      }
      database.exec("COMMIT");

      return {
        state: "captured",
        eventId: event.eventId,
        segmentCount: segments.length,
        sourceBytes,
        retainedBytes: retainedPayload.byteLength,
        sourceTruncated
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function captureEvent(request: CaptureRequest): Promise<CaptureResult> {
  const prepared = prepareCaptureEventForPersistence(request.event);
  if (prepared.state !== "normal") {
    return recordSensitivityFinding(
      request.runtimeRoot,
      prepared.event,
      prepared.finding,
      prepared.state === "secret" ? "blocked_secret" : "quarantined",
      request.busyTimeoutMilliseconds
    );
  }
  return persistPreparedCaptureEvent(request, prepared);
}

export async function captureRecoveredEvent(request: CaptureRequest & {
  readonly originalSourceBytes: number;
  readonly sourceTruncated: boolean;
}): Promise<CaptureResult> {
  const prepared = prepareCaptureEventForPersistence(request.event);
  if (prepared.state !== "normal") {
    throw new Error("Recovered Capture Event is no longer safe to persist.");
  }
  const originalSourceBytes = z.number().int().nonnegative().parse(
    request.originalSourceBytes
  );
  if (
    (!request.sourceTruncated && originalSourceBytes !== prepared.sourceBytes) ||
    (request.sourceTruncated && originalSourceBytes <= prepared.sourceBytes)
  ) {
    throw new Error("Recovered Capture Event source metadata is inconsistent.");
  }
  return persistPreparedCaptureEvent(request, {
    ...prepared,
    sourceBytes: originalSourceBytes,
    sourceTruncated: request.sourceTruncated
  });
}

export interface SensitivityFindingView {
  readonly findingId: string;
  readonly state: "blocked_secret" | "quarantined";
  readonly category: string;
  readonly bodyRetained: false;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly occurrenceCount: number;
}

export async function inspectSensitivityFinding(
  runtimeRoot: string,
  findingId: string
): Promise<SensitivityFindingView | undefined> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const row = database
      .prepare(
        `SELECT finding_id, state, category, body_retained, first_seen_at,
                last_seen_at, occurrence_count
         FROM sensitivity_findings WHERE finding_id = ?`
      )
      .get(findingId);
    if (row === undefined) {
      return undefined;
    }
    if (
      typeof row.finding_id !== "string" ||
      (row.state !== "blocked_secret" && row.state !== "quarantined") ||
      typeof row.category !== "string" ||
      row.body_retained !== 0 ||
      typeof row.first_seen_at !== "string" ||
      typeof row.last_seen_at !== "string" ||
      typeof row.occurrence_count !== "number"
    ) {
      throw new Error("Sensitivity finding contains invalid data.");
    }
    return {
      findingId: row.finding_id,
      state: row.state,
      category: row.category,
      bodyRetained: false,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      occurrenceCount: row.occurrence_count
    };
  } finally {
    database.close();
  }
}

export interface ClaimCaptureRequest {
  readonly runtimeRoot: string;
  readonly workerId: string;
  readonly now: string;
  readonly leaseSeconds: number;
}

export type ClaimCaptureResult =
  | { readonly state: "empty" }
  | {
      readonly state: "claimed";
      readonly eventId: string;
      readonly leaseToken: string;
      readonly attempt: number;
    };

export async function claimCaptureEvent(
  request: ClaimCaptureRequest
): Promise<ClaimCaptureResult> {
  const now = z.iso.datetime().parse(request.now);
  if (!Number.isInteger(request.leaseSeconds) || request.leaseSeconds <= 0) {
    throw new Error("leaseSeconds must be a positive integer.");
  }
  const leaseUntil = new Date(
    Date.parse(now) + request.leaseSeconds * 1000
  ).toISOString();
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = database
        .prepare(
          `SELECT event_id, attempt_count
           FROM capture_events
           WHERE state = 'pending'
              OR (state = 'processing' AND lease_until < ?)
              OR (state = 'retrying' AND next_retry_at <= ?)
           ORDER BY created_at ASC
           LIMIT 1`
        )
        .get(now, now);
      if (row === undefined) {
        database.exec("COMMIT");
        return { state: "empty" };
      }
      if (
        typeof row.event_id !== "string" ||
        typeof row.attempt_count !== "number"
      ) {
        throw new Error("Outbox claim contains invalid data.");
      }
      const leaseToken = `mslease_${randomUUID()}`;
      const attempt = row.attempt_count + 1;
      database
        .prepare(
          `UPDATE capture_events
           SET state = 'processing', attempt_count = ?, lease_token = ?,
               leased_by = ?, lease_until = ?, updated_at = ?
           WHERE event_id = ?`
        )
        .run(
          attempt,
          leaseToken,
          request.workerId,
          leaseUntil,
          now,
          row.event_id
        );
      database
        .prepare(
          `INSERT INTO capture_attempts(
             attempt_id, event_id, started_at, completed_at, outcome, error_code
           ) VALUES (?, ?, ?, NULL, NULL, NULL)`
        )
        .run(leaseToken, row.event_id, now);
      database.exec("COMMIT");
      return { state: "claimed", eventId: row.event_id, leaseToken, attempt };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export interface CompleteCaptureRequest {
  readonly runtimeRoot: string;
  readonly eventId: string;
  readonly leaseToken: string;
  readonly completedAt: string;
}

export type CompleteCaptureResult = {
  readonly state: "completed" | "already_completed";
  readonly eventId: string;
};

export async function completeCaptureEvent(
  request: CompleteCaptureRequest
): Promise<CompleteCaptureResult> {
  const completedAt = z.iso.datetime().parse(request.completedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = database
        .prepare("SELECT state, lease_token FROM capture_events WHERE event_id = ?")
        .get(request.eventId);
      if (row === undefined) {
        throw new Error("Capture Event does not exist.");
      }
      if (row.state === "completed") {
        database.exec("COMMIT");
        return { state: "already_completed", eventId: request.eventId };
      }
      if (row.state !== "processing" || row.lease_token !== request.leaseToken) {
        throw new Error("Capture Event lease is no longer owned by this Worker.");
      }
      database
        .prepare(
          `UPDATE capture_events
           SET state = 'completed', lease_token = NULL, leased_by = NULL,
               lease_until = NULL, updated_at = ?
           WHERE event_id = ?`
        )
        .run(completedAt, request.eventId);
      database
        .prepare(
          `UPDATE capture_attempts
           SET completed_at = ?, outcome = 'completed'
           WHERE attempt_id = ?`
        )
        .run(completedAt, request.leaseToken);
      database.exec("COMMIT");
      return { state: "completed", eventId: request.eventId };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export interface FailCaptureRequest {
  readonly runtimeRoot: string;
  readonly eventId: string;
  readonly leaseToken: string;
  readonly failedAt: string;
  readonly retryAt: string;
  readonly retryable: boolean;
  readonly maximumAttempts: number;
  readonly errorCode: string;
}

export type FailCaptureResult = {
  readonly state: "retry_scheduled" | "dead_letter";
  readonly eventId: string;
};

export async function failCaptureEvent(
  request: FailCaptureRequest
): Promise<FailCaptureResult> {
  const failedAt = z.iso.datetime().parse(request.failedAt);
  const retryAt = z.iso.datetime().parse(request.retryAt);
  const errorCode = z.string().regex(/^[a-z0-9_]{1,64}$/u).parse(request.errorCode);
  if (!Number.isInteger(request.maximumAttempts) || request.maximumAttempts <= 0) {
    throw new Error("maximumAttempts must be a positive integer.");
  }
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = database
        .prepare(
          `SELECT state, lease_token, attempt_count
           FROM capture_events WHERE event_id = ?`
        )
        .get(request.eventId);
      if (
        row === undefined ||
        row.state !== "processing" ||
        row.lease_token !== request.leaseToken ||
        typeof row.attempt_count !== "number"
      ) {
        throw new Error("Capture Event lease is no longer owned by this Worker.");
      }
      const isDeadLetter =
        !request.retryable || row.attempt_count >= request.maximumAttempts;
      database
        .prepare(
          `UPDATE capture_events
           SET state = ?, lease_token = NULL, leased_by = NULL,
               lease_until = NULL, next_retry_at = ?, last_error_code = ?,
               updated_at = ?
           WHERE event_id = ?`
        )
        .run(
          isDeadLetter ? "dead_letter" : "retrying",
          isDeadLetter ? null : retryAt,
          errorCode,
          failedAt,
          request.eventId
        );
      database
        .prepare(
          `UPDATE capture_attempts
           SET completed_at = ?, outcome = ?, error_code = ?
           WHERE attempt_id = ?`
        )
        .run(
          failedAt,
          isDeadLetter ? "dead_letter" : "retry_scheduled",
          errorCode,
          request.leaseToken
        );
      const incident = database
        .prepare(
          `SELECT incident_id FROM capture_health_incidents
           WHERE category = 'capture_processing' AND ended_at IS NULL
           LIMIT 1`
        )
        .get();
      if (incident === undefined) {
        database
          .prepare(
            `INSERT INTO capture_health_incidents(
               incident_id, category, started_at, ended_at,
               occurrence_count, last_error_code
             ) VALUES (?, 'capture_processing', ?, NULL, 1, ?)`
          )
          .run(`msincident_${randomUUID()}`, failedAt, errorCode);
      } else {
        if (typeof incident.incident_id !== "string") {
          throw new Error("Capture health incident contains invalid data.");
        }
        database
          .prepare(
            `UPDATE capture_health_incidents
             SET occurrence_count = occurrence_count + 1, last_error_code = ?
             WHERE incident_id = ?`
          )
          .run(errorCode, incident.incident_id);
      }
      database.exec("COMMIT");
      return {
        state: isDeadLetter ? "dead_letter" : "retry_scheduled",
        eventId: request.eventId
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export interface CaptureEventStateView {
  readonly eventId: string;
  readonly state: "pending" | "processing" | "completed" | "retrying" | "dead_letter";
  readonly attemptCount: number;
  readonly lastErrorCode: string | null;
}

export interface RecordCaptureHealthIncidentRequest {
  readonly runtimeRoot: string;
  readonly category: "hook_capture" | "capture_processing" | "worker_loop";
  readonly errorCode: string;
  readonly occurredAt: string;
}

const hookSqliteBusyDiagnosticV1Schema = z.object({
  schemaVersion: z.literal(1),
  occurredAt: z.iso.datetime(),
  eventKind: z.enum([
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "Stop",
    "SessionEnd"
  ]),
  errorCode: z.literal("sqlite_busy")
});

const hookSqliteBusyDiagnosticV2Schema = hookSqliteBusyDiagnosticV1Schema.extend({
  schemaVersion: z.literal(2),
  outcome: z.enum(["spooled", "lost"])
});

const hookSqliteBusyDiagnosticSchema = z.union([
  hookSqliteBusyDiagnosticV1Schema,
  hookSqliteBusyDiagnosticV2Schema
]);

export interface HookSqliteBusyDiagnosticSummary {
  readonly count: number;
  readonly recoveredCount: number;
  readonly lostCount: number;
  readonly lastOccurredAt: string | null;
  readonly lastEventKind: string | null;
  readonly lastOutcome: "spooled" | "lost" | null;
}

function hookSqliteBusyDiagnosticPath(runtimeRoot: string): string {
  return join(runtimeRoot, "state", "hook-sqlite-busy.ndjson");
}

export async function recordHookSqliteBusyDiagnostic(request: {
  readonly runtimeRoot: string;
  readonly occurredAt: string;
  readonly eventKind: string;
  readonly outcome: "spooled" | "lost";
}): Promise<void> {
  const diagnostic = hookSqliteBusyDiagnosticSchema.parse({
    schemaVersion: 2,
    occurredAt: request.occurredAt,
    eventKind: request.eventKind,
    errorCode: "sqlite_busy",
    outcome: request.outcome
  });
  await mkdir(join(request.runtimeRoot, "state"), { recursive: true, mode: 0o700 });
  await appendFile(
    hookSqliteBusyDiagnosticPath(request.runtimeRoot),
    `${JSON.stringify(diagnostic)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

export async function inspectHookSqliteBusyDiagnostics(
  runtimeRoot: string
): Promise<HookSqliteBusyDiagnosticSummary> {
  let source: string;
  try {
    source = await readFile(hookSqliteBusyDiagnosticPath(runtimeRoot), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        count: 0,
        recoveredCount: 0,
        lostCount: 0,
        lastOccurredAt: null,
        lastEventKind: null,
        lastOutcome: null
      };
    }
    throw error;
  }
  const diagnostics = source
    .split("\n")
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed = hookSqliteBusyDiagnosticSchema.safeParse(JSON.parse(line) as unknown);
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  const last = diagnostics.at(-1);
  return {
    count: diagnostics.length,
    recoveredCount: diagnostics.filter(
      (diagnostic) => diagnostic.schemaVersion === 2 && diagnostic.outcome === "spooled"
    ).length,
    lostCount: diagnostics.filter(
      (diagnostic) => diagnostic.schemaVersion === 1 || diagnostic.outcome === "lost"
    ).length,
    lastOccurredAt: last?.occurredAt ?? null,
    lastEventKind: last?.eventKind ?? null,
    lastOutcome: last === undefined
      ? null
      : last.schemaVersion === 1
        ? "lost"
        : last.outcome
  };
}

export async function recordCaptureHealthIncident(
  request: RecordCaptureHealthIncidentRequest
): Promise<void> {
  const occurredAt = z.iso.datetime().parse(request.occurredAt);
  const errorCode = z.string().regex(/^[a-z0-9_]{1,64}$/u).parse(request.errorCode);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = database
        .prepare(
          `SELECT incident_id FROM capture_health_incidents
           WHERE category = ? AND ended_at IS NULL LIMIT 1`
        )
        .get(request.category);
      if (existing === undefined) {
        database
          .prepare(
            `INSERT INTO capture_health_incidents(
               incident_id, category, started_at, ended_at,
               occurrence_count, last_error_code
             ) VALUES (?, ?, ?, NULL, 1, ?)`
          )
          .run(
            `msincident_${randomUUID()}`,
            request.category,
            occurredAt,
            errorCode
          );
      } else {
        if (typeof existing.incident_id !== "string") {
          throw new Error("Capture health incident contains invalid data.");
        }
        database
          .prepare(
            `UPDATE capture_health_incidents
             SET occurrence_count = occurrence_count + 1, last_error_code = ?
             WHERE incident_id = ?`
          )
          .run(errorCode, existing.incident_id);
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

export async function recoverCaptureHealthIncident(request: {
  readonly runtimeRoot: string;
  readonly category: RecordCaptureHealthIncidentRequest["category"];
  readonly recoveredAt: string;
}): Promise<void> {
  const recoveredAt = z.iso.datetime().parse(request.recoveredAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.prepare(
      `UPDATE capture_health_incidents SET ended_at = ?
       WHERE category = ? AND ended_at IS NULL`
    ).run(recoveredAt, request.category);
  } finally {
    database.close();
  }
}

export interface CaptureHealthIncidentView {
  readonly category: string;
  readonly occurrenceCount: number;
  readonly lastErrorCode: string | null;
  readonly bodyRetained: false;
}

export async function listOpenCaptureHealthIncidents(
  runtimeRoot: string
): Promise<readonly CaptureHealthIncidentView[]> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    return database
      .prepare(
        `SELECT category, occurrence_count, last_error_code
         FROM capture_health_incidents
         WHERE ended_at IS NULL ORDER BY started_at ASC`
      )
      .all()
      .map((row) => {
        if (
          typeof row.category !== "string" ||
          typeof row.occurrence_count !== "number" ||
          (row.last_error_code !== null && typeof row.last_error_code !== "string")
        ) {
          throw new Error("Capture health incident contains invalid data.");
        }
        return {
          category: row.category,
          occurrenceCount: row.occurrence_count,
          lastErrorCode: row.last_error_code,
          bodyRetained: false
        };
      });
  } finally {
    database.close();
  }
}

export async function inspectCaptureEventState(
  runtimeRoot: string,
  eventId: string
): Promise<CaptureEventStateView | undefined> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const row = database
      .prepare(
        `SELECT event_id, state, attempt_count, last_error_code
         FROM capture_events WHERE event_id = ?`
      )
      .get(eventId);
    if (row === undefined) return undefined;
    const state = z
      .enum(["pending", "processing", "completed", "retrying", "dead_letter"])
      .parse(row.state);
    if (
      typeof row.event_id !== "string" ||
      typeof row.attempt_count !== "number" ||
      (row.last_error_code !== null && typeof row.last_error_code !== "string")
    ) {
      throw new Error("Capture Event state contains invalid data.");
    }
    return {
      eventId: row.event_id,
      state,
      attemptCount: row.attempt_count,
      lastErrorCode: row.last_error_code
    };
  } finally {
    database.close();
  }
}

export async function readCapturedEvent(
  runtimeRoot: string,
  eventId: string
): Promise<CaptureEvent | undefined> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const event = database
      .prepare(
        `SELECT schema_version, event_id, deduplication_key, agent, event_kind,
                occurred_at, project_id, session_id, turn_id, segment_count,
                whole_content_sha256
         FROM capture_events WHERE event_id = ?`
      )
      .get(eventId);
    if (event === undefined) {
      return undefined;
    }
    const segments = database
      .prepare(
        `SELECT payload, payload_sha256 FROM capture_segments
         WHERE event_id = ? ORDER BY segment_index ASC`
      )
      .all(eventId);
    const payloadBuffers = segments.map((row) => {
      if (!(row.payload instanceof Uint8Array)) {
        throw new Error("Outbox segment contains invalid payload data.");
      }
      if (sha256(row.payload) !== row.payload_sha256) {
        throw new Error("Outbox segment checksum mismatch.");
      }
      return Buffer.from(row.payload);
    });
    const payloadBuffer = Buffer.concat(payloadBuffers);
    if (sha256(payloadBuffer) !== event.whole_content_sha256) {
      throw new Error("Outbox whole-content checksum mismatch.");
    }
    if (segments.length !== event.segment_count) {
      throw new Error("Outbox event is missing one or more segments.");
    }

    const candidate = {
      schemaVersion: event.schema_version,
      eventId: event.event_id,
      deduplicationKey: event.deduplication_key,
      agent: event.agent,
      eventKind: event.event_kind,
      occurredAt: event.occurred_at,
      ...(event.project_id === null ? {} : { projectId: event.project_id }),
      ...(event.session_id === null ? {} : { sessionId: event.session_id }),
      ...(event.turn_id === null ? {} : { turnId: event.turn_id }),
      payload: JSON.parse(payloadBuffer.toString("utf8")) as unknown
    };
    return captureEventSchema.parse(candidate);
  } finally {
    database.close();
  }
}
