import { randomUUID } from "node:crypto";
import { getEncoding } from "js-tiktoken";
import { z } from "zod";

import { classifyLocalSensitivity } from "../contracts/sensitivity.js";
import {
  LunaInvocationError,
  type LunaSafeDiagnostic
} from "../luna/index.js";
import { recordLunaWorkFailure, recordLunaWorkSuccess } from "../luna/operations.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import {
  readCanonicalMemory,
  writeCanonicalMemory,
  VaultRevisionConflictError,
  type CanonicalMemory
} from "../vault/index.js";

const tokenizer = getEncoding("o200k_base");
const batchSize = 16;
const leaseMilliseconds = 10 * 60 * 1_000;
const maximumEpochAttempts = 7;
const lunaSafeDiagnosticSchema = z.object({
  stage: z.enum([
    "invocation",
    "output_decode",
    "output_schema",
    "evidence_binding",
    "importance_validation",
    "local_processing"
  ]),
  code: z.string().min(1),
  path: z.string().min(1).optional()
});

function parseLunaSafeDiagnostic(value: unknown): LunaSafeDiagnostic {
  const parsed = lunaSafeDiagnosticSchema.parse(value);
  return {
    stage: parsed.stage,
    code: parsed.code,
    ...(parsed.path === undefined ? {} : { path: parsed.path })
  };
}

export interface CompactGenerationMemory {
  readonly memoryId: string;
  readonly revisionId: string;
  readonly body: string;
  readonly applicability: CanonicalMemory["applicability"];
  readonly semanticContract: CanonicalMemory["semanticContract"];
}

export interface CompactValidationMemory extends CompactGenerationMemory {
  readonly compactText: string;
}

export interface MemoryQualityAdapter {
  generateCompacts(request: {
    readonly operationId: string;
    readonly memories: readonly CompactGenerationMemory[];
  }): Promise<{
    readonly schemaVersion: 1;
    readonly kind: "compact_generation";
    readonly items: readonly {
      readonly memoryId: string;
      readonly compactText: string;
    }[];
  }>;
  validateCompacts(request: {
    readonly operationId: string;
    readonly memories: readonly CompactValidationMemory[];
  }): Promise<{
    readonly schemaVersion: 1;
    readonly kind: "compact_validation";
    readonly items: readonly {
      readonly memoryId: string;
      readonly state: "preserves" | "lossy" | "uncertain";
      readonly reasonCode: string;
    }[];
  }>;
}

interface QualityItem {
  readonly itemId: string;
  readonly memoryId: string;
  readonly sourceRevisionId: string;
  readonly sourceContentIdentity: string;
  readonly state:
    | "processing_generation"
    | "processing_validation";
  readonly attemptCount: number;
  readonly epochAttemptCount: number;
  readonly proposedCompact?: string;
}

function generationInput(memory: CanonicalMemory): CompactGenerationMemory {
  return {
    memoryId: memory.memoryId,
    revisionId: memory.revisionId,
    body: memory.body,
    applicability: memory.applicability,
    semanticContract: memory.semanticContract
  };
}

function compactLocallyValid(compactText: string): {
  readonly valid: boolean;
  readonly renderedTokenCount: number;
  readonly failureCode?: "compact_empty" | "compact_over_token_limit" | "compact_sensitive";
} {
  const normalized = compactText.trim();
  const renderedTokenCount = tokenizer.encode(normalized).length;
  const sensitivity = classifyLocalSensitivity(normalized);
  const failureCode = normalized.length === 0
    ? "compact_empty"
    : renderedTokenCount > 96
      ? "compact_over_token_limit"
      : sensitivity.state !== "normal"
        ? "compact_sensitive"
        : undefined;
  return {
    valid: failureCode === undefined,
    renderedTokenCount,
    ...(failureCode === undefined ? {} : { failureCode })
  };
}

async function activeSourceMemory(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly item: QualityItem;
}): Promise<CanonicalMemory | undefined> {
  const current = await readCanonicalMemory({
    runtimeRoot: request.runtimeRoot,
    vaultRoot: request.vaultRoot,
    memoryId: request.item.memoryId
  });
  if (
    current === undefined ||
    current.memory.lifecycle !== "active" ||
    current.memory.authority !== "agent_derived" ||
    current.memory.revisionId !== request.item.sourceRevisionId ||
    current.contentIdentity !== request.item.sourceContentIdentity
  ) return undefined;
  return current.memory;
}

export async function enqueueCompactBackfill(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly requestedAt: string;
  readonly preview: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}): Promise<{
  readonly state: "preview" | "enqueued";
  readonly eligibleCount: number;
  readonly enqueuedCount: number;
  readonly memoryIds: readonly string[];
  readonly nextCursor?: string;
}> {
  const requestedAt = z.iso.datetime().parse(request.requestedAt);
  const limit = z.number().int().min(1).max(1000).parse(request.limit ?? 200);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let rows: readonly Record<string, unknown>[];
  try {
    rows = database.prepare(
      `SELECT memory_id FROM memory_catalog
       WHERE authority = 'agent_derived' AND lifecycle = 'active' AND memory_id > ?
       ORDER BY memory_id LIMIT ?`
    ).all(request.cursor ?? "", limit + 1);
  } finally {
    database.close();
  }
  const selectedRows = rows.slice(0, limit);
  const memories = (await Promise.all(selectedRows.map(async (row) => {
    const loaded = await readCanonicalMemory({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      memoryId: z.string().parse(row.memory_id)
    });
    return loaded?.memory;
  }))).filter((memory): memory is CanonicalMemory => memory !== undefined);
  const eligible = memories.filter((memory) => !(
    memory.representations.compact.validated &&
    memory.representations.compact.sourceRevisionId === memory.revisionId &&
    memory.representations.compact.text.trim().length > 0
  ));
  let enqueuedCount = 0;
  if (!request.preview && eligible.length > 0) {
    const writeDatabase = await openRuntimeDatabase(request.runtimeRoot);
    try {
      writeDatabase.exec("BEGIN IMMEDIATE");
      const insert = writeDatabase.prepare(
        `INSERT OR IGNORE INTO memory_quality_items(
           item_id, memory_id, source_revision_id, source_content_identity,
           state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'pending_generation', ?, ?)`
      );
      for (const memory of eligible) {
        enqueuedCount += Number(insert.run(
          `msquality_${randomUUID()}`,
          memory.memoryId,
          memory.revisionId,
          memory.contentIdentity,
          requestedAt,
          requestedAt
        ).changes);
      }
      writeDatabase.exec("COMMIT");
    } catch (error) {
      writeDatabase.exec("ROLLBACK");
      throw error;
    } finally {
      writeDatabase.close();
    }
  }
  const nextCursor = rows.length > limit
    ? z.string().parse(selectedRows.at(-1)?.memory_id)
    : undefined;
  return {
    state: request.preview ? "preview" : "enqueued",
    eligibleCount: eligible.length,
    enqueuedCount,
    memoryIds: eligible.map((memory) => memory.memoryId),
    ...(nextCursor === undefined ? {} : { nextCursor })
  };
}

export async function scheduleCompactQuality(request: {
  readonly runtimeRoot: string;
  readonly requestedAt: string;
  readonly preview: boolean;
}): Promise<{
  readonly state: "preview" | "scheduled";
  readonly enabled: boolean;
  readonly nextScanAt: string;
}> {
  const requestedAt = z.iso.datetime().parse(request.requestedAt);
  if (!request.preview) {
    const database = await openRuntimeDatabase(request.runtimeRoot);
    try {
      database.prepare(
        `INSERT INTO memory_quality_schedule(
           singleton, enabled, cursor_memory_id, next_scan_at, last_completed_at, updated_at
         ) VALUES (1, 1, NULL, ?, NULL, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           enabled = 1, cursor_memory_id = NULL, next_scan_at = excluded.next_scan_at,
           last_completed_at = NULL, updated_at = excluded.updated_at`
      ).run(requestedAt, requestedAt);
    } finally {
      database.close();
    }
  }
  return {
    state: request.preview ? "preview" : "scheduled",
    enabled: !request.preview,
    nextScanAt: requestedAt
  };
}

export async function retryRepairableMemoryQuality(request: {
  readonly runtimeRoot: string;
  readonly retriedAt: string;
  readonly preview: boolean;
}): Promise<{
  readonly state: "preview" | "retried";
  readonly dryRun: boolean;
  readonly eligibleCount: number;
  readonly eligibleCounts: {
    readonly blockedSchemaInvalid: number;
    readonly localGateRejected: number;
  };
  readonly restartCounts: {
    readonly generation: number;
    readonly validation: number;
  };
  readonly changedCount: number;
}> {
  const retriedAt = z.iso.datetime().parse(request.retriedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const rows = database.prepare(
      `SELECT item_id, state, proposed_compact FROM memory_quality_items
       WHERE (state = 'blocked' AND last_error_category = 'schema_invalid')
          OR (state = 'rejected' AND validation_reason_code = 'local_gate_failed')
       ORDER BY created_at, item_id`
    ).all();
    const blockedSchemaInvalid = rows.filter((row) => row.state === "blocked").length;
    const localGateRejected = rows.length - blockedSchemaInvalid;
    const eligibleCount = blockedSchemaInvalid + localGateRejected;
    const validationItemIds = rows.flatMap((row) =>
      row.state === "rejected" &&
      typeof row.proposed_compact === "string" &&
      compactLocallyValid(row.proposed_compact).valid
        ? [z.string().parse(row.item_id)]
        : []
    );
    const validationItemIdSet = new Set(validationItemIds);
    const generationItemIds = rows
      .map((row) => z.string().parse(row.item_id))
      .filter((itemId) => !validationItemIdSet.has(itemId));
    let changedCount = 0;
    if (!request.preview && eligibleCount > 0) {
      const restartGeneration = database.prepare(
        `UPDATE memory_quality_items SET
           state = 'pending_generation', proposed_compact = NULL,
           rendered_token_count = NULL, generator_identity = NULL,
           validation_state = NULL, validation_reason_code = NULL,
           next_retry_at = NULL, last_error_category = NULL,
           last_error_diagnostic_json = NULL, lease_token = NULL,
           lease_until = NULL, completed_at = NULL,
           retry_epoch = retry_epoch + 1, epoch_attempt_count = 0,
           updated_at = ?
         WHERE item_id = ?`
      );
      const restartValidation = database.prepare(
        `UPDATE memory_quality_items SET
           state = 'pending_validation', validation_state = NULL,
           validation_reason_code = NULL, next_retry_at = NULL,
           last_error_category = NULL, last_error_diagnostic_json = NULL,
           lease_token = NULL, lease_until = NULL, completed_at = NULL,
           retry_epoch = retry_epoch + 1, epoch_attempt_count = 0,
           updated_at = ?
         WHERE item_id = ?`
      );
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const itemId of generationItemIds) {
          changedCount += Number(restartGeneration.run(retriedAt, itemId).changes);
        }
        for (const itemId of validationItemIds) {
          changedCount += Number(restartValidation.run(retriedAt, itemId).changes);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
    return {
      state: request.preview ? "preview" : "retried",
      dryRun: request.preview,
      eligibleCount,
      eligibleCounts: { blockedSchemaInvalid, localGateRejected },
      restartCounts: {
        generation: generationItemIds.length,
        validation: validationItemIds.length
      },
      changedCount
    };
  } finally {
    database.close();
  }
}

export async function advanceCompactQualityDiscovery(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly now: string;
}): Promise<{
  readonly state: "idle" | "advanced" | "completed";
  readonly scannedCount?: number;
  readonly enqueuedCount?: number;
}> {
  const now = z.iso.datetime().parse(request.now);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let schedule: Record<string, unknown> | undefined;
  try {
    schedule = database.prepare(
      "SELECT * FROM memory_quality_schedule WHERE singleton = 1"
    ).get();
  } finally {
    database.close();
  }
  if (
    schedule === undefined ||
    schedule.enabled !== 1 ||
    typeof schedule.next_scan_at !== "string" ||
    schedule.next_scan_at > now
  ) return { state: "idle" };
  const result = await enqueueCompactBackfill({
    runtimeRoot: request.runtimeRoot,
    vaultRoot: request.vaultRoot,
    requestedAt: now,
    preview: false,
    ...(typeof schedule.cursor_memory_id === "string"
      ? { cursor: schedule.cursor_memory_id }
      : {}),
    limit: batchSize
  });
  const completed = result.nextCursor === undefined;
  const nextScanAt = completed
    ? new Date(Date.parse(now) + 7 * 24 * 60 * 60 * 1_000).toISOString()
    : now;
  const writeDatabase = await openRuntimeDatabase(request.runtimeRoot);
  try {
    writeDatabase.prepare(
      `UPDATE memory_quality_schedule SET cursor_memory_id = ?, next_scan_at = ?,
         last_completed_at = ?, updated_at = ? WHERE singleton = 1`
    ).run(
      result.nextCursor ?? null,
      nextScanAt,
      completed ? now : null,
      now
    );
  } finally {
    writeDatabase.close();
  }
  return {
    state: completed ? "completed" : "advanced",
    scannedCount: result.eligibleCount,
    enqueuedCount: result.enqueuedCount
  };
}

function parseQualityItem(row: Record<string, unknown>): QualityItem {
  return {
    itemId: z.string().parse(row.item_id),
    memoryId: z.string().parse(row.memory_id),
    sourceRevisionId: z.string().parse(row.source_revision_id),
    sourceContentIdentity: z.string().parse(row.source_content_identity),
    state: z.enum(["processing_generation", "processing_validation"]).parse(row.state),
    attemptCount: z.number().int().positive().parse(row.attempt_count),
    epochAttemptCount: z.number().int().positive().parse(row.epoch_attempt_count),
    ...(typeof row.proposed_compact === "string" ? { proposedCompact: row.proposed_compact } : {})
  };
}

async function claimBatch(request: {
  readonly runtimeRoot: string;
  readonly workerId: string;
  readonly now: string;
}): Promise<{ readonly leaseToken: string; readonly items: readonly QualityItem[] }> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  const leaseToken = `msqualitylease_${randomUUID()}`;
  const leaseUntil = new Date(Date.parse(request.now) + leaseMilliseconds).toISOString();
  try {
    database.exec("BEGIN IMMEDIATE");
    const first = database.prepare(
      `SELECT state, last_error_category, epoch_attempt_count FROM memory_quality_items
       WHERE state IN ('pending_generation', 'pending_validation')
          OR (state IN ('retrying_generation', 'retrying_validation') AND next_retry_at <= ?)
          OR (state IN ('processing_generation', 'processing_validation') AND lease_until < ?)
       ORDER BY CASE WHEN state LIKE '%generation' THEN 0 ELSE 1 END,
         epoch_attempt_count DESC, created_at, item_id LIMIT 1`
    ).get(request.now, request.now);
    if (first === undefined) {
      database.exec("COMMIT");
      return { leaseToken, items: [] };
    }
    const generation = String(first.state).includes("generation");
    const pendingState = generation ? "pending_generation" : "pending_validation";
    const retryingState = generation ? "retrying_generation" : "retrying_validation";
    const previousProcessingState = generation ? "processing_generation" : "processing_validation";
    const processingState = generation ? "processing_generation" : "processing_validation";
    const structuralRetry = first.last_error_category === "schema_invalid" &&
      first.state !== pendingState;
    const claimLimit = structuralRetry
      ? Math.max(
          1,
          Math.floor(
            batchSize / 2 ** z.number().int().nonnegative().parse(first.epoch_attempt_count)
          )
        )
      : batchSize;
    const rows = database.prepare(
      `SELECT * FROM memory_quality_items
       WHERE state = ?
          OR (state = ? AND next_retry_at <= ?)
          OR (state = ? AND lease_until < ?)
       ORDER BY epoch_attempt_count DESC, created_at, item_id LIMIT ?`
    ).all(
      pendingState,
      retryingState,
      request.now,
      previousProcessingState,
      request.now,
      claimLimit
    );
    const update = database.prepare(
      `UPDATE memory_quality_items SET state = ?, attempt_count = attempt_count + 1,
         epoch_attempt_count = epoch_attempt_count + 1,
         lease_token = ?, lease_until = ?, updated_at = ? WHERE item_id = ?`
    );
    for (const row of rows) {
      update.run(
        processingState,
        leaseToken,
        leaseUntil,
        request.now,
        z.string().parse(row.item_id)
      );
    }
    database.exec("COMMIT");
    return {
      leaseToken,
      items: rows.map((row) => parseQualityItem({
        ...row,
        state: processingState,
        attempt_count: Number(row.attempt_count) + 1,
        epoch_attempt_count: Number(row.epoch_attempt_count) + 1
      }))
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

async function markStale(runtimeRoot: string, itemIds: readonly string[], now: string): Promise<void> {
  if (itemIds.length === 0) return;
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const update = database.prepare(
      `UPDATE memory_quality_items SET state = 'stale', completed_at = ?, updated_at = ?,
         last_error_category = NULL, last_error_diagnostic_json = NULL WHERE item_id = ?`
    );
    database.exec("BEGIN IMMEDIATE");
    for (const itemId of itemIds) update.run(now, now, itemId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

async function failBatch(request: {
  readonly runtimeRoot: string;
  readonly items: readonly QualityItem[];
  readonly failedAt: string;
  readonly error: LunaInvocationError;
}): Promise<"retrying" | "blocked"> {
  const maximumAttempt = Math.max(...request.items.map((item) => item.epochAttemptCount));
  const health = await recordLunaWorkFailure({
    runtimeRoot: request.runtimeRoot,
    workId: request.items[0]?.itemId ?? "memory-quality",
    attemptCount: maximumAttempt,
    failedAt: request.failedAt,
    error: request.error
  });
  const blocked = !request.error.retryable || maximumAttempt >= maximumEpochAttempts;
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const update = database.prepare(
      `UPDATE memory_quality_items SET state = ?, next_retry_at = ?,
         last_error_category = ?, last_error_diagnostic_json = ?,
         lease_token = NULL, lease_until = NULL, updated_at = ?
       WHERE item_id = ?`
    );
    database.exec("BEGIN IMMEDIATE");
    for (const item of request.items) {
      const retryState = item.state === "processing_generation"
        ? "retrying_generation"
        : "retrying_validation";
      update.run(
        blocked ? "blocked" : retryState,
        blocked ? null : health.nextRetryAt,
        request.error.category,
        request.error.diagnostic === undefined
          ? null
          : JSON.stringify(request.error.diagnostic),
        request.failedAt,
        item.itemId
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  return blocked ? "blocked" : "retrying";
}

function nextRepresentations(
  memory: CanonicalMemory,
  revisionId: string,
  compactText: string,
  tokenCount: number
): CanonicalMemory["representations"] {
  return {
    ...(memory.representations.identity === undefined ? {} : {
      identity: { ...memory.representations.identity, sourceRevisionId: revisionId }
    }),
    compact: {
      text: compactText,
      validated: true,
      generatorIdentity: "gpt-5.6-luna:compact-generation-v3+fidelity-v2",
      sourceRevisionId: revisionId,
      renderedTokenCount: tokenCount
    },
    standard: { ...memory.representations.standard, sourceRevisionId: revisionId }
  };
}

export type MemoryQualityStepResult =
  | { readonly state: "empty" }
  | { readonly state: "generated" | "published" | "rejected" | "stale"; readonly itemCount: number }
  | { readonly state: "retrying" | "blocked"; readonly itemCount: number };

export async function runNextMemoryQualityStep(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly workerId: string;
  readonly now: string;
  readonly adapter: MemoryQualityAdapter;
}): Promise<MemoryQualityStepResult> {
  const now = z.iso.datetime().parse(request.now);
  const claimed = await claimBatch({
    runtimeRoot: request.runtimeRoot,
    workerId: request.workerId,
    now
  });
  if (claimed.items.length === 0) return { state: "empty" };
  const loaded = await Promise.all(claimed.items.map(async (item) => ({
    item,
    memory: await activeSourceMemory({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      item
    })
  })));
  const stale = loaded.filter((entry) => entry.memory === undefined).map((entry) => entry.item.itemId);
  await markStale(request.runtimeRoot, stale, now);
  const current = loaded.filter((entry): entry is { item: QualityItem; memory: CanonicalMemory } =>
    entry.memory !== undefined
  );
  if (current.length === 0) return { state: "stale", itemCount: stale.length };
  try {
    if (current[0]?.item.state === "processing_generation") {
      const output = await request.adapter.generateCompacts({
        operationId: claimed.leaseToken,
        memories: current.map((entry) => generationInput(entry.memory))
      });
      const byMemory = new Map(output.items.map((item) => [item.memoryId, item]));
      const database = await openRuntimeDatabase(request.runtimeRoot);
      let generatedCount = 0;
      try {
        const update = database.prepare(
          `UPDATE memory_quality_items SET state = ?, proposed_compact = ?,
             rendered_token_count = ?, generator_identity = ?, validation_state = NULL,
             validation_reason_code = ?, last_error_category = NULL,
             last_error_diagnostic_json = NULL, lease_token = NULL,
             lease_until = NULL, completed_at = ?, updated_at = ?
           WHERE item_id = ? AND state = 'processing_generation'`
        );
        database.exec("BEGIN IMMEDIATE");
        for (const entry of current) {
          const generated = byMemory.get(entry.memory.memoryId);
          const compactText = generated?.compactText.trim() ?? "";
          const local = compactLocallyValid(compactText);
          const rejectionReason = local.failureCode === "compact_over_token_limit"
            ? "compact_over_token_limit_after_repair"
            : local.failureCode === "compact_empty"
              ? "compact_empty_after_generation"
              : local.failureCode === "compact_sensitive"
                ? "compact_sensitive_output"
                : "compact_local_contract_failed";
          update.run(
            local.valid ? "pending_validation" : "rejected",
            compactText || null,
            local.renderedTokenCount,
            "gpt-5.6-luna:compact-generation-v3",
            local.valid ? null : rejectionReason,
            local.valid ? null : now,
            now,
            entry.item.itemId
          );
          if (local.valid) generatedCount += 1;
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      } finally {
        database.close();
      }
      await recordLunaWorkSuccess({ runtimeRoot: request.runtimeRoot, completedAt: now });
      return generatedCount > 0
        ? { state: "generated", itemCount: generatedCount }
        : { state: "rejected", itemCount: current.length };
    }

    const output = await request.adapter.validateCompacts({
      operationId: claimed.leaseToken,
      memories: current.map((entry) => ({
        ...generationInput(entry.memory),
        compactText: z.string().min(1).parse(entry.item.proposedCompact)
      }))
    });
    const byMemory = new Map(output.items.map((item) => [item.memoryId, item]));
    let publishedCount = 0;
    let rejectedCount = 0;
    let staleCount = stale.length;
    for (const entry of current) {
      const validation = byMemory.get(entry.memory.memoryId);
      if (validation?.state !== "preserves") {
        const database = await openRuntimeDatabase(request.runtimeRoot);
        try {
          database.prepare(
            `UPDATE memory_quality_items SET state = 'rejected', validation_state = ?,
               validation_reason_code = ?, completed_at = ?, updated_at = ?,
               last_error_category = NULL, last_error_diagnostic_json = NULL,
               lease_token = NULL, lease_until = NULL WHERE item_id = ?`
          ).run(
            validation?.state ?? "uncertain",
            validation?.reasonCode ?? "missing_validation_result",
            now,
            now,
            entry.item.itemId
          );
        } finally {
          database.close();
        }
        rejectedCount += 1;
        continue;
      }
      const compactText = z.string().min(1).parse(entry.item.proposedCompact);
      const local = compactLocallyValid(compactText);
      if (!local.valid) {
        await markStale(request.runtimeRoot, [entry.item.itemId], now);
        staleCount += 1;
        continue;
      }
      const revisionId = `msrev_${randomUUID()}`;
      try {
        await writeCanonicalMemory({
          runtimeRoot: request.runtimeRoot,
          vaultRoot: request.vaultRoot,
          actor: "agent",
          expectedContentIdentity: entry.item.sourceContentIdentity,
          memory: {
            ...entry.memory,
            revisionId,
            predecessorRevisionId: entry.memory.revisionId,
            revisedAt: now,
            representations: nextRepresentations(entry.memory, revisionId, compactText, local.renderedTokenCount),
            provenance: entry.memory.provenance.includes("quality:luna-compact-backfill-v3")
              ? entry.memory.provenance
              : [...entry.memory.provenance, "quality:luna-compact-backfill-v3"]
          }
        });
      } catch (error) {
        if (error instanceof VaultRevisionConflictError) {
          await markStale(request.runtimeRoot, [entry.item.itemId], now);
          staleCount += 1;
          continue;
        }
        throw error;
      }
      const database = await openRuntimeDatabase(request.runtimeRoot);
      try {
        database.prepare(
          `UPDATE memory_quality_items SET state = 'completed', validation_state = 'preserves',
             validation_reason_code = ?, completed_at = ?, updated_at = ?,
             last_error_category = NULL, last_error_diagnostic_json = NULL,
             lease_token = NULL, lease_until = NULL WHERE item_id = ?`
        ).run(validation.reasonCode, now, now, entry.item.itemId);
      } finally {
        database.close();
      }
      publishedCount += 1;
    }
    await recordLunaWorkSuccess({ runtimeRoot: request.runtimeRoot, completedAt: now });
    if (publishedCount > 0) return { state: "published", itemCount: publishedCount };
    if (rejectedCount > 0) return { state: "rejected", itemCount: rejectedCount };
    return { state: "stale", itemCount: staleCount };
  } catch (error) {
    if (!(error instanceof LunaInvocationError)) throw error;
    const state = await failBatch({
      runtimeRoot: request.runtimeRoot,
      items: current.map((entry) => entry.item),
      failedAt: now,
      error
    });
    return { state, itemCount: current.length };
  }
}

export async function inspectMemoryQualityPipeline(request: {
  readonly runtimeRoot: string;
}): Promise<{
  readonly totalCount: number;
  readonly pendingCount: number;
  readonly completedCount: number;
  readonly pendingGenerationCount: number;
  readonly pendingValidationCount: number;
  readonly rejectedCount: number;
  readonly blockedCount: number;
  readonly staleCount: number;
  readonly failureDiagnostics: readonly {
    readonly state: string;
    readonly category: string;
    readonly diagnostic?: LunaSafeDiagnostic;
    readonly count: number;
  }[];
  readonly rejectionReasons: readonly {
    readonly reasonCode: string;
    readonly count: number;
  }[];
  readonly schedule: {
    readonly enabled: boolean;
    readonly nextScanAt?: string;
    readonly cursorMemoryId?: string;
    readonly lastCompletedAt?: string;
  };
}> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const rows = database.prepare(
      "SELECT state, COUNT(*) AS count FROM memory_quality_items GROUP BY state"
    ).all();
    const counts = new Map(rows.map((row) => [
      z.string().parse(row.state),
      z.number().int().nonnegative().parse(row.count)
    ]));
    const count = (...states: readonly string[]): number =>
      states.reduce((total, state) => total + (counts.get(state) ?? 0), 0);
    const scheduleRow = database.prepare(
      "SELECT * FROM memory_quality_schedule WHERE singleton = 1"
    ).get();
    const diagnosticRows = database.prepare(
      `SELECT state, last_error_category, last_error_diagnostic_json, COUNT(*) AS count
       FROM memory_quality_items WHERE last_error_category IS NOT NULL
         AND state IN (
           'processing_generation', 'retrying_generation',
           'processing_validation', 'retrying_validation', 'blocked'
         )
       GROUP BY state, last_error_category, last_error_diagnostic_json
       ORDER BY state, last_error_category, last_error_diagnostic_json`
    ).all();
    const rejectionRows = database.prepare(
      `SELECT validation_reason_code, COUNT(*) AS count
       FROM memory_quality_items
       WHERE state = 'rejected' AND validation_reason_code IS NOT NULL
       GROUP BY validation_reason_code ORDER BY validation_reason_code`
    ).all();
    return {
      totalCount: count(...counts.keys()),
      pendingCount: count(
        "pending_generation", "processing_generation", "retrying_generation",
        "pending_validation", "processing_validation", "retrying_validation"
      ),
      pendingGenerationCount: count(
        "pending_generation", "processing_generation", "retrying_generation"
      ),
      pendingValidationCount: count(
        "pending_validation", "processing_validation", "retrying_validation"
      ),
      completedCount: count("completed"),
      rejectedCount: count("rejected"),
      blockedCount: count("blocked"),
      staleCount: count("stale"),
      failureDiagnostics: diagnosticRows.map((row) => ({
        state: z.string().parse(row.state),
        category: z.string().parse(row.last_error_category),
        ...(typeof row.last_error_diagnostic_json === "string"
          ? {
              diagnostic: parseLunaSafeDiagnostic(
                JSON.parse(row.last_error_diagnostic_json) as unknown
              )
            }
          : {}),
        count: z.number().int().nonnegative().parse(row.count)
      })),
      rejectionReasons: rejectionRows.map((row) => ({
        reasonCode: z.string().parse(row.validation_reason_code),
        count: z.number().int().nonnegative().parse(row.count)
      })),
      schedule: {
        enabled: scheduleRow?.enabled === 1,
        ...(typeof scheduleRow?.next_scan_at === "string"
          ? { nextScanAt: scheduleRow.next_scan_at }
          : {}),
        ...(typeof scheduleRow?.cursor_memory_id === "string"
          ? { cursorMemoryId: scheduleRow.cursor_memory_id }
          : {}),
        ...(typeof scheduleRow?.last_completed_at === "string"
          ? { lastCompletedAt: scheduleRow.last_completed_at }
          : {})
      }
    };
  } finally {
    database.close();
  }
}
