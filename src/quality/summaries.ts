import type { DatabaseSync } from "node:sqlite";
import { getEncoding } from "js-tiktoken";
import { z } from "zod";

const tokenizer = getEncoding("o200k_base");

/**
 * Whether a compact fits injection as the retrieval index counts it (o200k tokens,
 * at most 96). A write-time estimate can pass a compact the index then rejects.
 */
export function compactFitsInjection(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && tokenizer.encode(trimmed).length <= 96;
}

/**
 * Summaries of Human-authored Memory (ADR-0155): an Agent never revises such a
 * Memory, so the validated summary that lets it be injected is derived data,
 * keyed by the revision it summarizes and used only by the retrieval index.
 */
export interface MemorySummary {
  readonly summary: string;
  readonly renderedTokenCount: number;
  readonly generatorIdentity: string;
}

export function summaryKey(memoryId: string, revisionId: string): string {
  return `${memoryId}\u0000${revisionId}`;
}

export function readMemorySummaries(database: DatabaseSync): ReadonlyMap<string, MemorySummary> {
  return new Map(database.prepare(
    "SELECT memory_id, revision_id, summary, rendered_token_count, generator_identity FROM memory_summaries"
  ).all().map((row) => [summaryKey(z.string().parse(row.memory_id), z.string().parse(row.revision_id)), {
    summary: z.string().parse(row.summary),
    renderedTokenCount: z.number().int().positive().parse(row.rendered_token_count),
    generatorIdentity: z.string().parse(row.generator_identity)
  }]));
}

export function hasMemorySummary(database: DatabaseSync, memoryId: string, revisionId: string): boolean {
  return database.prepare("SELECT 1 FROM memory_summaries WHERE memory_id = ? AND revision_id = ?").get(memoryId, revisionId) !== undefined;
}

/** Stores a validated summary and marks the retrieval catalog dirty, as a catalog revision would. */
export function storeMemorySummary(database: DatabaseSync, request: {
  readonly memoryId: string;
  readonly revisionId: string;
  readonly summary: string;
  readonly renderedTokenCount: number;
  readonly generatorIdentity: string;
  readonly validationReasonCode: string;
  readonly now: string;
}): void {
  database.prepare(
    `INSERT OR REPLACE INTO memory_summaries(memory_id, revision_id, summary, rendered_token_count,
       generator_identity, validation_reason_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(request.memoryId, request.revisionId, request.summary, request.renderedTokenCount,
    request.generatorIdentity, request.validationReasonCode, request.now);
  database.prepare(
    `UPDATE retrieval_catalog_generations
     SET dirty_generation = dirty_generation + 1,
         dirty_at = ?,
         force_due_at = COALESCE(force_due_at,
           strftime('%Y-%m-%dT%H:%M:%fZ', ?, printf('+%f seconds', maximum_staleness_ms / 1000.0)))
     WHERE singleton = 1`
  ).run(request.now, request.now);
}
