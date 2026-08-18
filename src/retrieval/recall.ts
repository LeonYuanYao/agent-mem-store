import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getEncoding } from "js-tiktoken";
import { z } from "zod";

import { openRuntimeDatabase } from "../runtime/database.js";
import { writeFileAtomically } from "../contracts/atomic-file.js";
import {
  readCanonicalMemory,
  readCanonicalRevision,
  type CanonicalMemory
} from "../vault/index.js";
import type { EmbeddingAdapter } from "./index.js";
import { approvedShadowEmbeddingProfile } from "./shadow-profile.js";

const tokenizer = getEncoding("o200k_base");
const scopeSchema = z.enum(["current", "global", "project", "all_projects"]);

export class CursorStaleError extends Error {
  public readonly code = "cursor_stale";

  public constructor() {
    super("Recall cursor no longer matches the query, scope, authorization, or active index.");
    this.name = "CursorStaleError";
  }
}

interface RetrievalDocument {
  readonly indexRevisionId: string;
  readonly vectorOrdinal: number;
  readonly memoryId: string;
  readonly revisionId: string;
  readonly scope:
    | { readonly kind: "project"; readonly projectId: string }
    | { readonly kind: "global" };
  readonly authority: "human_authored" | "agent_derived";
  readonly compactText: string;
  readonly compactValidated: boolean;
  readonly category: string;
  readonly searchableText: string;
}

export interface RecallSearchItem {
  readonly memoryId: string;
  readonly revisionId: string;
  readonly scope: RetrievalDocument["scope"];
  readonly authority: RetrievalDocument["authority"];
  readonly description: string;
  readonly relevanceReasons: readonly string[];
}

interface CursorPayload {
  readonly schemaVersion: 1;
  readonly binding: string;
  readonly lastMemoryId: string;
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/gu, " ").normalize("NFKC").toLocaleLowerCase("en-US");
}

function scopeBinding(request: {
  readonly scope: z.infer<typeof scopeSchema>;
  readonly currentProjectId?: string;
  readonly projectId?: string;
}): string {
  if (request.scope === "current") {
    return `current:${request.currentProjectId ?? "unresolved"}:global`;
  }
  if (request.scope === "project") return `project:${request.projectId ?? "missing"}`;
  return request.scope;
}

function queryBinding(request: {
  readonly normalizedQuery: string;
  readonly scopeBinding: string;
  readonly callerIdentity: string;
  readonly indexRevisionId: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    query: request.normalizedQuery,
    scope: request.scopeBinding,
    caller: request.callerIdentity,
    rankingPolicy: "hybrid-recall-v1",
    indexRevisionId: request.indexRevisionId
  })).digest("hex");
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, expectedBinding: string): CursorPayload {
  try {
    const value = z.object({
      schemaVersion: z.literal(1),
      binding: z.string().regex(/^[0-9a-f]{64}$/u),
      lastMemoryId: z.string().min(1)
    }).parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (value.binding !== expectedBinding) throw new CursorStaleError();
    return value;
  } catch (error) {
    if (error instanceof CursorStaleError) throw error;
    throw new CursorStaleError();
  }
}

function documentFromRow(row: Record<string, unknown>): RetrievalDocument {
  const scope = row.scope_kind === "global"
    ? ({ kind: "global" } as const)
    : ({ kind: "project", projectId: z.string().parse(row.project_id) } as const);
  return {
    indexRevisionId: z.string().parse(row.index_revision_id),
    vectorOrdinal: z.number().int().nonnegative().parse(row.vector_ordinal),
    memoryId: z.string().parse(row.memory_id),
    revisionId: z.string().parse(row.revision_id),
    scope,
    authority: z.enum(["human_authored", "agent_derived"]).parse(row.authority),
    compactText: z.string().parse(row.compact_text),
    compactValidated: row.compact_validated === 1,
    category: z.string().parse(row.category),
    searchableText: z.string().parse(row.searchable_text)
  };
}

function eligibleForScope(
  row: Record<string, unknown>,
  request: {
    readonly scope: z.infer<typeof scopeSchema>;
    readonly currentProjectId?: string;
    readonly projectId?: string;
    readonly requestedAt: string;
  }
): boolean {
  if (
    (typeof row.valid_from === "string" && row.valid_from > request.requestedAt) ||
    (typeof row.valid_until === "string" && row.valid_until < request.requestedAt)
  ) return false;
  if (request.scope === "global") return row.scope_kind === "global";
  if (request.scope === "project") {
    return row.scope_kind === "project" && row.project_id === request.projectId;
  }
  if (request.scope === "current") {
    return row.scope_kind === "global" ||
      (row.scope_kind === "project" && row.project_id === request.currentProjectId);
  }
  return row.sensitivity === "normal";
}

function ftsExpression(query: string): string | undefined {
  const terms = query.match(/[\p{L}\p{N}_]+/gu)?.filter((term) => term.length > 1) ?? [];
  const unique = [...new Set(terms)].slice(0, 24);
  return unique.length === 0
    ? undefined
    : unique.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function queryTerms(query: string): readonly string[] {
  return [...new Set(
    (query.match(/[\p{L}\p{N}_]+/gu) ?? []).filter((term) => term.length > 1)
  )];
}

function lexicalCoverage(terms: readonly string[], text: string): {
  readonly matchedCount: number;
  readonly coverage: number;
} {
  if (terms.length === 0) return { matchedCount: 0, coverage: 0 };
  const normalized = text.normalize("NFKC").toLocaleLowerCase("en-US");
  const documentTerms = new Set(normalized.match(/[\p{L}\p{N}_]+/gu) ?? []);
  const matchedCount = terms.filter((term) =>
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(term)
      ? normalized.includes(term)
      : documentTerms.has(term)
  ).length;
  return { matchedCount, coverage: matchedCount / terms.length };
}

function cosine(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

function readVector(
  values: Float32Array,
  ordinal: number,
  dimensions: number
): readonly number[] {
  const start = ordinal * dimensions;
  return Array.from(values.subarray(start, start + dimensions));
}

function renderSearchItem(item: RecallSearchItem): string {
  const scope = item.scope.kind === "global" ? "Global" : `Project:${item.scope.projectId}`;
  return `[${item.memoryId} ${item.revisionId} ${scope} ${item.authority}] ${item.description}`;
}

export async function recallSearch(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly query: string;
  readonly scope: "current" | "global" | "project" | "all_projects";
  readonly currentProjectId?: string;
  readonly projectId?: string;
  readonly limit?: number;
  readonly targetTokens?: number;
  readonly cursor?: string;
  readonly callerIdentity: string;
  readonly adapter?: EmbeddingAdapter;
  readonly chainId?: string;
  readonly requestedAt: string;
}): Promise<{
  readonly schemaVersion: 1;
  readonly items: readonly RecallSearchItem[];
  readonly nextCursor?: string;
  readonly receiptId: string;
  readonly renderedTokenCount: number;
  readonly semanticStage: "complete" | "lexical_only";
  readonly chainId: string;
  readonly cumulativeTokenCount: number;
  readonly warning?: string;
}> {
  const started = performance.now();
  const requestedAt = z.iso.datetime().parse(request.requestedAt);
  const normalized = normalizeQuery(z.string().min(1).parse(request.query));
  const scope = scopeSchema.parse(request.scope);
  if (scope === "current" && request.currentProjectId === undefined) {
    throw new Error("Current scope requires a resolved Project identity.");
  }
  if (scope === "project" && request.projectId === undefined) {
    throw new Error("Project scope requires projectId.");
  }
  const limit = z.number().int().min(1).max(50).parse(request.limit ?? 16);
  const targetTokens = z.number().int().positive().parse(request.targetTokens ?? 4096);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let active: Record<string, unknown>;
  let rows: readonly Record<string, unknown>[];
  try {
    const found = database.prepare(
      `SELECT revision.* FROM active_retrieval_index AS active
       JOIN retrieval_index_revisions AS revision
         ON revision.index_revision_id = active.index_revision_id
       WHERE active.singleton = 1 AND revision.state = 'complete'`
    ).get();
    if (found === undefined) throw new Error("No completed retrieval index is active.");
    active = found;
    const activeIndexRevisionId = z.string().parse(active.index_revision_id);
    rows = database.prepare(
      "SELECT * FROM retrieval_documents WHERE index_revision_id = ? ORDER BY memory_id"
    ).all(activeIndexRevisionId).filter((row) => eligibleForScope(row, {
      scope,
      requestedAt,
      ...(request.currentProjectId === undefined ? {} : { currentProjectId: request.currentProjectId }),
      ...(request.projectId === undefined ? {} : { projectId: request.projectId })
    }));
  } finally {
    database.close();
  }
  const indexRevisionId = z.string().parse(active.index_revision_id);
  const bindingScope = scopeBinding({
    scope,
    ...(request.currentProjectId === undefined ? {} : { currentProjectId: request.currentProjectId }),
    ...(request.projectId === undefined ? {} : { projectId: request.projectId })
  });
  const binding = queryBinding({
    normalizedQuery: normalized,
    scopeBinding: bindingScope,
    callerIdentity: request.callerIdentity,
    indexRevisionId
  });
  const cursor = request.cursor === undefined ? undefined : decodeCursor(request.cursor, binding);
  const documents = rows.map((row) => documentFromRow(row));
  const terms = queryTerms(normalized);

  const lexicalRanks = new Map<string, number>();
  const expression = ftsExpression(normalized);
  if (expression !== undefined) {
    const lexicalDatabase = await openRuntimeDatabase(request.runtimeRoot);
    try {
      const allowed = new Set(documents.map((item) => item.memoryId));
      const matches = lexicalDatabase.prepare(
        `SELECT memory_id, bm25(fts_memories) AS lexical_score
         FROM fts_memories
         WHERE fts_memories MATCH ? AND index_revision_id = ?
         ORDER BY lexical_score, memory_id`
      ).all(expression, indexRevisionId).filter((row) =>
        allowed.has(z.string().parse(row.memory_id))
      );
      matches.forEach((row, index) => lexicalRanks.set(z.string().parse(row.memory_id), index + 1));
    } finally {
      lexicalDatabase.close();
    }
  }

  const semanticScores = new Map<string, number>();
  let semanticStage: "complete" | "lexical_only" = "lexical_only";
  if (
    request.adapter !== undefined &&
    request.adapter.identity.adapterVersion === active.adapter_version &&
    request.adapter.identity.modelIdentity === active.model_identity &&
    request.adapter.identity.artifactSha256 === active.artifact_sha256 &&
    request.adapter.identity.dimensions === active.dimensions
  ) {
    const embedded = await (request.adapter.embedQuery ?? request.adapter.embed)([normalized]);
    const queryVector = embedded[0];
    if (queryVector !== undefined && queryVector.length === active.dimensions) {
      const magnitude = Math.sqrt(queryVector.reduce((sum, value) => sum + value * value, 0));
      if (magnitude > 0) {
        const normalizedVector = queryVector.map((value) => value / magnitude);
        const bytes = await readFile(z.string().parse(active.directory_path) + "/vectors.f32");
        const values = new Float32Array(
          bytes.buffer,
          bytes.byteOffset,
          Math.floor(bytes.byteLength / Float32Array.BYTES_PER_ELEMENT)
        );
        for (const document of documents) {
          semanticScores.set(
            document.memoryId,
            cosine(
              normalizedVector,
              readVector(values, document.vectorOrdinal, z.number().int().positive().parse(active.dimensions))
            )
          );
        }
        semanticStage = "complete";
      }
    }
  }
  const semanticRanks = new Map(
    [...semanticScores.entries()]
      .filter(([, score]) => score > 0)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([memoryId], index) => [memoryId, index + 1])
  );
  const semanticRanking = [...semanticScores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const leadingSemanticMemoryId = semanticRanking[0]?.[0];
  const leadingSemanticScore = semanticRanking[0]?.[1] ?? 0;
  const secondSemanticScore = semanticRanking[1]?.[1] ?? 0;
  const ranked = documents.map((document) => {
    const lexicalRank = lexicalRanks.get(document.memoryId);
    const semanticRank = semanticRanks.get(document.memoryId);
    const semanticScore = semanticScores.get(document.memoryId) ?? 0;
    const lexical = lexicalCoverage(terms, document.compactText);
    const lexicalAdmitted = lexicalRank !== undefined && (
      terms.length <= 2
        ? lexical.coverage >= 0.5
        : lexical.matchedCount >= 2 && lexical.coverage >= 0.3
    );
    const directIdentity = normalized.includes(document.memoryId.toLocaleLowerCase("en-US")) ||
      normalized.includes(document.revisionId.toLocaleLowerCase("en-US"));
    const standaloneSemantic = document.memoryId === leadingSemanticMemoryId &&
      leadingSemanticScore >= approvedShadowEmbeddingProfile.semanticOnlyMinimumScore &&
      leadingSemanticScore - secondSemanticScore >=
        approvedShadowEmbeddingProfile.semanticOnlyMinimumTop1Margin;
    const semanticCorroborated = semanticScore >= 0.58 && lexicalAdmitted;
    const rrf = (lexicalRank === undefined ? 0 : 1 / (60 + lexicalRank)) +
      (semanticRank === undefined ? 0 : 1 / (60 + semanticRank));
    const scopePriority = document.scope.kind === "project" &&
      document.scope.projectId === request.currentProjectId ? 1 : 0;
    const reasons = [
      ...(directIdentity ? ["memory_identity"] : []),
      ...(lexicalAdmitted ? ["lexical_match"] : []),
      ...(standaloneSemantic || semanticCorroborated ? ["semantic_match"] : []),
      ...(scopePriority === 0 ? [] : ["current_project"])
    ];
    return {
      document,
      rrf,
      scopePriority,
      reasons,
      admitted: directIdentity || lexicalAdmitted || standaloneSemantic || semanticCorroborated
    };
  }).filter((item) => item.admitted)
    .sort((left, right) =>
      right.rrf - left.rrf ||
      right.scopePriority - left.scopePriority ||
      (left.document.authority === right.document.authority
        ? 0
        : left.document.authority === "human_authored" ? -1 : 1) ||
      left.document.memoryId.localeCompare(right.document.memoryId)
    );
  const startIndex = cursor === undefined
    ? 0
    : ranked.findIndex((item) => item.document.memoryId === cursor.lastMemoryId) + 1;
  if (cursor !== undefined && startIndex === 0) throw new CursorStaleError();
  const selected: RecallSearchItem[] = [];
  let renderedTokenCount = 0;
  let lastConsumedIndex = startIndex - 1;
  for (let index = startIndex; index < ranked.length && selected.length < limit; index += 1) {
    const rankedItem = ranked[index];
    if (rankedItem === undefined) break;
    const item: RecallSearchItem = {
      memoryId: rankedItem.document.memoryId,
      revisionId: rankedItem.document.revisionId,
      scope: rankedItem.document.scope,
      authority: rankedItem.document.authority,
      description: rankedItem.document.compactValidated && rankedItem.document.compactText.length > 0
        ? rankedItem.document.compactText
        : `No validated compact description; read ${rankedItem.document.memoryId} by identity.`,
      relevanceReasons: rankedItem.reasons.slice(0, 3)
    };
    const itemTokens = tokenizer.encode(renderSearchItem(item)).length;
    if (selected.length > 0 && renderedTokenCount + itemTokens > targetTokens) break;
    selected.push(item);
    renderedTokenCount += itemTokens;
    lastConsumedIndex = index;
  }
  const nextCursor = lastConsumedIndex >= startIndex && lastConsumedIndex < ranked.length - 1
    ? encodeCursor({
        schemaVersion: 1,
        binding,
        lastMemoryId: ranked[lastConsumedIndex]?.document.memoryId ?? ""
      })
    : undefined;
  const receiptId = `msreceipt_${randomUUID()}`;
  const receiptDatabase = await openRuntimeDatabase(request.runtimeRoot);
  try {
    receiptDatabase.exec("BEGIN IMMEDIATE");
    receiptDatabase.prepare(
      `INSERT INTO retrieval_receipts(
         receipt_id, caller_kind, caller_identity, query_identity, normalized_query,
         scope_binding, project_id, index_revision_id, epoch_id,
         rendered_token_count, automatic_epoch_total, budget_tier,
         semantic_stage, empty_reason, latency_ms, created_at
       ) VALUES (?, 'explicit', ?, ?, ?, ?, ?, ?, NULL, ?, NULL, 'explicit_page', ?, ?, ?, ?)`
    ).run(
      receiptId,
      request.callerIdentity,
      createHash("sha256").update(normalized).digest("hex"),
      normalized,
      bindingScope,
      request.currentProjectId ?? request.projectId ?? null,
      indexRevisionId,
      renderedTokenCount,
      semanticStage,
      selected.length === 0 ? "no_match" : null,
      Math.max(0, performance.now() - started),
      requestedAt
    );
    const insertItem = receiptDatabase.prepare(
      `INSERT INTO retrieval_receipt_items(
         receipt_id, memory_id, revision_id, rank_ordinal, relevance_band,
         representation_kind, rendered_token_count, score, reasons_json,
         outcome, omission_reason
       ) VALUES (?, ?, ?, ?, 'weak', 'compact', ?, 0, ?, 'selected', NULL)`
    );
    selected.forEach((item, index) => insertItem.run(
      receiptId,
      item.memoryId,
      item.revisionId,
      index,
      tokenizer.encode(renderSearchItem(item)).length,
      JSON.stringify(item.relevanceReasons)
    ));
    receiptDatabase.exec("COMMIT");
  } catch (error) {
    receiptDatabase.exec("ROLLBACK");
    throw error;
  } finally {
    receiptDatabase.close();
  }
  const chain = await updateExplicitRetrievalChain({
    runtimeRoot: request.runtimeRoot,
    callerIdentity: request.callerIdentity,
    renderedTokenCount,
    requestedAt,
    ...(request.chainId === undefined ? {} : { chainId: request.chainId })
  });
  return {
    schemaVersion: 1,
    items: selected,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    receiptId,
    renderedTokenCount,
    semanticStage,
    ...chain
  };
}

interface PagedIdentityResult<T> {
  readonly schemaVersion: 1;
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly receiptId: string;
  readonly renderedTokenCount: number;
  readonly chainId: string;
  readonly cumulativeTokenCount: number;
  readonly warning?: string;
}

function simpleCursorBinding(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function pageIdentityItems<T>(request: {
  readonly items: readonly T[];
  readonly identityOf: (item: T) => string;
  readonly render: (item: T) => string;
  readonly binding: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly targetTokens?: number;
}): {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly renderedTokenCount: number;
} {
  const limit = z.number().int().min(1).max(50).parse(request.limit ?? 16);
  const targetTokens = z.number().int().positive().parse(request.targetTokens ?? 4096);
  const cursor = request.cursor === undefined
    ? undefined
    : decodeCursor(request.cursor, request.binding);
  const start = cursor === undefined
    ? 0
    : request.items.findIndex((item) => request.identityOf(item) === cursor.lastMemoryId) + 1;
  if (cursor !== undefined && start === 0) throw new CursorStaleError();
  const selected: T[] = [];
  let renderedTokenCount = 0;
  let last = start - 1;
  for (let index = start; index < request.items.length && selected.length < limit; index += 1) {
    const item = request.items[index];
    if (item === undefined) break;
    const count = tokenizer.encode(request.render(item)).length;
    if (selected.length > 0 && renderedTokenCount + count > targetTokens) break;
    selected.push(item);
    renderedTokenCount += count;
    last = index;
  }
  return {
    items: selected,
    ...(last >= start && last < request.items.length - 1
      ? {
          nextCursor: encodeCursor({
            schemaVersion: 1,
            binding: request.binding,
            lastMemoryId: request.identityOf(request.items[last] as T)
          })
        }
      : {}),
    renderedTokenCount
  };
}

async function recordExplicitReadReceipt(request: {
  readonly runtimeRoot: string;
  readonly callerIdentity: string;
  readonly memoryId: string;
  readonly revisionId: string;
  readonly operation: "show" | "provenance" | "related";
  readonly representationKind?: "compact" | "standard" | "identity" | "full";
  readonly renderedTokenCount: number;
  readonly requestedAt: string;
}): Promise<string> {
  const receiptId = `msreceipt_${randomUUID()}`;
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    database.prepare(
      `INSERT INTO retrieval_receipts(
         receipt_id, caller_kind, caller_identity, query_identity,
         normalized_query, scope_binding, project_id, index_revision_id,
         epoch_id, rendered_token_count, automatic_epoch_total, budget_tier,
         semantic_stage, empty_reason, latency_ms, created_at
       ) VALUES (?, 'explicit', ?, ?, ?, 'identity', NULL,
                 (SELECT index_revision_id FROM active_retrieval_index WHERE singleton = 1),
                 NULL, ?, NULL, 'explicit_page', 'not_applicable', NULL, 0, ?)`
    ).run(
      receiptId,
      request.callerIdentity,
      createHash("sha256").update(`${request.operation}:${request.memoryId}:${request.revisionId}`).digest("hex"),
      request.operation,
      request.renderedTokenCount,
      z.iso.datetime().parse(request.requestedAt)
    );
    database.prepare(
      `INSERT INTO retrieval_receipt_items(
         receipt_id, memory_id, revision_id, rank_ordinal, relevance_band,
         representation_kind, rendered_token_count, score, reasons_json,
         outcome, omission_reason
       ) VALUES (?, ?, ?, 0, 'weak', ?, ?, 0, ?, 'selected', NULL)`
    ).run(
      receiptId,
      request.memoryId,
      request.revisionId,
      request.representationKind ?? "identity",
      request.renderedTokenCount,
      JSON.stringify([`${request.operation}_read`])
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  return receiptId;
}

async function updateExplicitRetrievalChain(request: {
  readonly runtimeRoot: string;
  readonly callerIdentity: string;
  readonly renderedTokenCount: number;
  readonly requestedAt: string;
  readonly chainId?: string;
}): Promise<{
  readonly chainId: string;
  readonly cumulativeTokenCount: number;
  readonly warning?: string;
}> {
  const chainId = request.chainId ?? `mschain_${randomUUID()}`;
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    const existing = database.prepare(
      "SELECT caller_identity, cumulative_token_count, warning_band FROM explicit_retrieval_chains WHERE chain_id = ?"
    ).get(chainId);
    let previousTotal = 0;
    let previousBand = 0;
    if (existing === undefined) {
      database.prepare(
        `INSERT INTO explicit_retrieval_chains(
           chain_id, caller_identity, cumulative_token_count, warning_band,
           created_at, updated_at
         ) VALUES (?, ?, 0, 0, ?, ?)`
      ).run(chainId, request.callerIdentity, request.requestedAt, request.requestedAt);
    } else {
      if (existing.caller_identity !== request.callerIdentity) {
        throw new Error("Explicit retrieval chain belongs to another caller.");
      }
      previousTotal = z.number().int().nonnegative().parse(existing.cumulative_token_count);
      previousBand = z.number().int().nonnegative().parse(existing.warning_band);
    }
    const cumulativeTokenCount = previousTotal + request.renderedTokenCount;
    const warningBand = Math.floor(Math.max(0, cumulativeTokenCount - 1) / 8192);
    database.prepare(
      `UPDATE explicit_retrieval_chains
       SET cumulative_token_count = ?, warning_band = ?, updated_at = ?
       WHERE chain_id = ?`
    ).run(cumulativeTokenCount, Math.max(previousBand, warningBand), request.requestedAt, chainId);
    database.exec("COMMIT");
    return {
      chainId,
      cumulativeTokenCount,
      ...(warningBand > previousBand
        ? {
            warning: `Explicit retrieval chain exceeded ${(warningBand * 8192).toLocaleString("en-US")} rendered tokens; continued retrieval remains allowed but consumes host context.`
          }
        : {})
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

export async function recallProvenance(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly memoryId: string;
  readonly revision?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly targetTokens?: number;
  readonly callerIdentity: string;
  readonly requestedAt: string;
  readonly chainId?: string;
}): Promise<PagedIdentityResult<{ readonly sourceIdentity: string }>> {
  const loaded = request.revision === undefined
    ? await readCanonicalMemory(request)
    : await readCanonicalRevision({
        runtimeRoot: request.runtimeRoot,
        vaultRoot: request.vaultRoot,
        memoryId: request.memoryId,
        revisionId: request.revision
      });
  if (loaded === undefined || loaded.memory.lifecycle === "tombstone") {
    throw new Error("Memory provenance is unavailable.");
  }
  const items = [...loaded.memory.provenance]
    .sort()
    .map((sourceIdentity) => ({ sourceIdentity }));
  const page = pageIdentityItems({
    items,
    identityOf: (item) => item.sourceIdentity,
    render: (item) => `source:${item.sourceIdentity}`,
    binding: simpleCursorBinding([
      "provenance-v1",
      loaded.memory.memoryId,
      loaded.memory.revisionId,
      request.callerIdentity
    ]),
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.targetTokens === undefined ? {} : { targetTokens: request.targetTokens })
  });
  const receiptId = await recordExplicitReadReceipt({
    runtimeRoot: request.runtimeRoot,
    callerIdentity: request.callerIdentity,
    memoryId: loaded.memory.memoryId,
    revisionId: loaded.memory.revisionId,
    operation: "provenance",
    renderedTokenCount: page.renderedTokenCount,
    requestedAt: request.requestedAt
  });
  const chain = await updateExplicitRetrievalChain({
    runtimeRoot: request.runtimeRoot,
    callerIdentity: request.callerIdentity,
    renderedTokenCount: page.renderedTokenCount,
    requestedAt: request.requestedAt,
    ...(request.chainId === undefined ? {} : { chainId: request.chainId })
  });
  return { schemaVersion: 1, ...page, receiptId, ...chain };
}

export interface RelatedRecallItem {
  readonly direction: "incoming" | "outgoing";
  readonly relationshipType: string;
  readonly memoryId: string;
  readonly revisionId: string;
  readonly scope: CanonicalMemory["scope"];
  readonly authority: CanonicalMemory["authority"];
  readonly description: string;
}

export async function recallRelated(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly memoryId: string;
  readonly revision?: string;
  readonly direction?: "incoming" | "outgoing" | "both";
  readonly limit?: number;
  readonly cursor?: string;
  readonly targetTokens?: number;
  readonly currentProjectId?: string;
  readonly callerIdentity: string;
  readonly requestedAt: string;
  readonly chainId?: string;
}): Promise<PagedIdentityResult<RelatedRecallItem>> {
  const source = request.revision === undefined
    ? await readCanonicalMemory(request)
    : await readCanonicalRevision({
        runtimeRoot: request.runtimeRoot,
        vaultRoot: request.vaultRoot,
        memoryId: request.memoryId,
        revisionId: request.revision
      });
  if (source === undefined || source.memory.lifecycle !== "active") {
    throw new Error("Memory relationships are unavailable.");
  }
  const direction = z.enum(["incoming", "outgoing", "both"]).parse(request.direction ?? "both");
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let rows: readonly Record<string, unknown>[];
  try {
    rows = database.prepare(
      `SELECT relationship.source_memory_id, relationship.target_memory_id,
              relationship.relationship_type, document.*
       FROM memory_relationships AS relationship
       JOIN active_retrieval_index AS active ON active.singleton = 1
       JOIN retrieval_documents AS document
         ON document.index_revision_id = active.index_revision_id
        AND document.memory_id = CASE
          WHEN relationship.source_memory_id = ? THEN relationship.target_memory_id
          ELSE relationship.source_memory_id END
       WHERE (relationship.source_memory_id = ? OR relationship.target_memory_id = ?)
       ORDER BY relationship.relationship_type, document.memory_id`
    ).all(request.memoryId, request.memoryId, request.memoryId);
  } finally {
    database.close();
  }
  const items = rows.flatMap((row): readonly RelatedRecallItem[] => {
    const itemDirection = row.source_memory_id === request.memoryId ? "outgoing" : "incoming";
    if (direction !== "both" && direction !== itemDirection) return [];
    if (
      row.sensitivity === "private" &&
      row.scope_kind === "project" &&
      row.project_id !== request.currentProjectId
    ) return [];
    const document = documentFromRow(row);
    return [{
      direction: itemDirection,
      relationshipType: z.string().parse(row.relationship_type),
      memoryId: document.memoryId,
      revisionId: document.revisionId,
      scope: document.scope,
      authority: document.authority,
      description: document.compactValidated && document.compactText.length > 0
        ? document.compactText
        : `No validated compact description; read ${document.memoryId} by identity.`
    }];
  });
  const page = pageIdentityItems({
    items,
    identityOf: (item) => `${item.direction}:${item.relationshipType}:${item.memoryId}`,
    render: (item) => `${item.direction}:${item.relationshipType}:${item.memoryId}:${item.description}`,
    binding: simpleCursorBinding([
      "related-v1",
      source.memory.memoryId,
      source.memory.revisionId,
      direction,
      request.currentProjectId ?? "unresolved",
      request.callerIdentity
    ]),
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.targetTokens === undefined ? {} : { targetTokens: request.targetTokens })
  });
  const receiptId = await recordExplicitReadReceipt({
    runtimeRoot: request.runtimeRoot,
    callerIdentity: request.callerIdentity,
    memoryId: source.memory.memoryId,
    revisionId: source.memory.revisionId,
    operation: "related",
    renderedTokenCount: page.renderedTokenCount,
    requestedAt: request.requestedAt
  });
  const chain = await updateExplicitRetrievalChain({
    runtimeRoot: request.runtimeRoot,
    callerIdentity: request.callerIdentity,
    renderedTokenCount: page.renderedTokenCount,
    requestedAt: request.requestedAt,
    ...(request.chainId === undefined ? {} : { chainId: request.chainId })
  });
  return { schemaVersion: 1, ...page, receiptId, ...chain };
}

interface BadCaseBundle {
  readonly schemaVersion: 1;
  readonly badCaseId: string;
  readonly kind: "irrelevant_retrieval";
  readonly signature: string;
  readonly samples: readonly {
    readonly receiptId: string;
    readonly memoryId: string;
    readonly revisionId: string;
    readonly indexRevisionId: string;
    readonly scopeBinding: string;
    readonly reasons: readonly string[];
    readonly observedAt: string;
  }[];
}

export async function reportIrrelevant(request: {
  readonly runtimeRoot: string;
  readonly receiptId: string;
  readonly memoryId: string;
  readonly callerIdentity: string;
  readonly observedAt: string;
}): Promise<{
  readonly badCaseId: string;
  readonly occurrenceCount: number;
  readonly repairState: "open" | "repairing" | "resolved" | "dismissed" | "stale";
  readonly diagnosticBundlePath: string;
}> {
  const observedAt = z.iso.datetime().parse(request.observedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    const returned = database.prepare(
      `SELECT receipt.caller_identity, receipt.index_revision_id,
              receipt.scope_binding, receipt.project_id,
              item.revision_id, item.reasons_json
       FROM retrieval_receipts AS receipt
       JOIN retrieval_receipt_items AS item ON item.receipt_id = receipt.receipt_id
       WHERE receipt.receipt_id = ? AND item.memory_id = ? AND item.outcome = 'selected'`
    ).get(request.receiptId, request.memoryId);
    if (returned === undefined || returned.caller_identity !== request.callerIdentity) {
      throw new Error("Receipt does not prove this caller received the Memory revision.");
    }
    const returnedRevisionId = z.string().parse(returned.revision_id);
    const returnedProjectId = typeof returned.project_id === "string" ? returned.project_id : null;
    const duplicate = database.prepare(
      `SELECT bad_case.bad_case_id, bad_case.occurrence_count, bad_case.state,
              bad_case.diagnostic_bundle_path
       FROM irrelevant_observations AS observation
       JOIN bad_cases AS bad_case ON bad_case.bad_case_id = observation.bad_case_id
       WHERE observation.receipt_id = ? AND observation.memory_id = ?
         AND observation.revision_id = ? AND observation.caller_identity = ?`
    ).get(
      request.receiptId,
      request.memoryId,
      returnedRevisionId,
      request.callerIdentity
    );
    if (duplicate !== undefined) {
      database.exec("COMMIT");
      return {
        badCaseId: z.string().parse(duplicate.bad_case_id),
        occurrenceCount: z.number().int().positive().parse(duplicate.occurrence_count),
        repairState: z.enum(["open", "repairing", "resolved", "dismissed", "stale"]).parse(duplicate.state),
        diagnosticBundlePath: z.string().parse(duplicate.diagnostic_bundle_path)
      };
    }
    const signature = createHash("sha256").update(JSON.stringify({
      kind: "irrelevant_retrieval",
      component: "hybrid-recall-v1",
      memoryId: request.memoryId,
      projectId: returnedProjectId,
      scopeBinding: returned.scope_binding,
      indexAdapter: returned.index_revision_id === null ? "none" : "indexed"
    })).digest("hex");
    const existing = database.prepare("SELECT * FROM bad_cases WHERE signature = ?").get(signature);
    const badCaseId = existing === undefined
      ? `msbadcase_${randomUUID()}`
      : z.string().parse(existing.bad_case_id);
    const diagnosticBundlePath = existing === undefined
      ? join(request.runtimeRoot, "badcases", `bc_${badCaseId}.json`)
      : z.string().parse(existing.diagnostic_bundle_path);
    let previousSamples: BadCaseBundle["samples"] = [];
    if (existing !== undefined) {
      try {
        const parsed = JSON.parse(await readFile(diagnosticBundlePath, "utf8")) as BadCaseBundle;
        previousSamples = parsed.samples;
      } catch {
        previousSamples = [];
      }
    }
    const sample = {
      receiptId: request.receiptId,
      memoryId: request.memoryId,
      revisionId: returnedRevisionId,
      indexRevisionId: z.string().parse(returned.index_revision_id),
      scopeBinding: z.string().parse(returned.scope_binding),
      reasons: z.array(z.string()).parse(JSON.parse(z.string().parse(returned.reasons_json))),
      observedAt
    };
    const samples = [...previousSamples, sample].slice(-20);
    const bundle: BadCaseBundle = {
      schemaVersion: 1,
      badCaseId,
      kind: "irrelevant_retrieval",
      signature,
      samples
    };
    const bundleSource = `${JSON.stringify(bundle, null, 2)}\n`;
    const bundleSha256 = createHash("sha256").update(bundleSource).digest("hex");
    await mkdir(dirname(diagnosticBundlePath), { recursive: true, mode: 0o700 });
    await writeFileAtomically(diagnosticBundlePath, bundleSource, 0o600);
    if (existing === undefined) {
      database.prepare(
        `INSERT INTO bad_cases(
           bad_case_id, signature, kind, component, project_id, severity,
           occurrence_count, first_seen_at, last_seen_at, state,
           reminder_state, diagnostic_bundle_path, diagnostic_bundle_sha256
         ) VALUES (?, ?, 'irrelevant_retrieval', 'hybrid-recall-v1', ?, 'normal',
                   1, ?, ?, 'open', 'pending', ?, ?)`
      ).run(
        badCaseId,
        signature,
        returnedProjectId,
        observedAt,
        observedAt,
        diagnosticBundlePath,
        bundleSha256
      );
    } else {
      database.prepare(
        `UPDATE bad_cases
         SET occurrence_count = occurrence_count + 1, last_seen_at = ?,
             diagnostic_bundle_sha256 = ?,
             state = CASE WHEN state = 'stale' THEN 'open' ELSE state END
         WHERE bad_case_id = ?`
      ).run(observedAt, bundleSha256, badCaseId);
    }
    database.prepare(
      `INSERT INTO irrelevant_observations(
         observation_id, receipt_id, memory_id, revision_id,
         caller_identity, bad_case_id, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `msirrelevant_${randomUUID()}`,
      request.receiptId,
      request.memoryId,
      returnedRevisionId,
      request.callerIdentity,
      badCaseId,
      observedAt
    );
    const result = database.prepare(
      `SELECT occurrence_count, state, diagnostic_bundle_path
       FROM bad_cases WHERE bad_case_id = ?`
    ).get(badCaseId);
    database.exec("COMMIT");
    return {
      badCaseId,
      occurrenceCount: z.number().int().positive().parse(result?.occurrence_count),
      repairState: z.enum(["open", "repairing", "resolved", "dismissed", "stale"]).parse(result?.state),
      diagnosticBundlePath: z.string().parse(result?.diagnostic_bundle_path)
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function validRepresentation(
  memory: CanonicalMemory,
  detail: "compact" | "standard"
): string | undefined {
  const representation = memory.representations[detail];
  return representation.validated && representation.sourceRevisionId === memory.revisionId
    ? representation.text
    : undefined;
}

export async function recallShow(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly memoryId: string;
  readonly revision?: string;
  readonly detail?: "compact" | "standard" | "full";
  readonly currentProjectId?: string;
  readonly callerIdentity: string;
  readonly requestedAt: string;
  readonly chainId?: string;
}): Promise<{
  readonly memoryId: string;
  readonly revisionId: string;
  readonly scope: CanonicalMemory["scope"];
  readonly authority: CanonicalMemory["authority"];
  readonly detail: "compact" | "standard" | "full";
  readonly body: string;
  readonly receiptId: string;
  readonly chainId: string;
  readonly renderedTokenCount: number;
  readonly cumulativeTokenCount: number;
  readonly warning?: string;
}> {
  const loaded = request.revision === undefined
    ? await readCanonicalMemory(request)
    : await readCanonicalRevision({
        runtimeRoot: request.runtimeRoot,
        vaultRoot: request.vaultRoot,
        memoryId: request.memoryId,
        revisionId: request.revision
      });
  if (loaded === undefined || loaded.memory.lifecycle !== "active") {
    throw new Error("Memory is not eligible for explicit recall.");
  }
  const memory = loaded.memory;
  if (
    memory.sensitivity === "private" &&
    memory.scope.kind === "project" &&
    memory.scope.projectId !== request.currentProjectId
  ) {
    throw new Error("Private Project Memory cannot cross Project boundaries.");
  }
  const detail = z.enum(["compact", "standard", "full"]).parse(request.detail ?? "standard");
  const body = detail === "full" ? memory.body : validRepresentation(memory, detail);
  if (body === undefined) throw new Error(`Validated ${detail} representation is unavailable.`);
  const renderedTokenCount = tokenizer.encode(
    `[${memory.memoryId} ${memory.revisionId} ${detail}]\n${body}`
  ).length;
  const receiptId = await recordExplicitReadReceipt({
    runtimeRoot: request.runtimeRoot,
    callerIdentity: request.callerIdentity,
    memoryId: memory.memoryId,
    revisionId: memory.revisionId,
    operation: "show",
    representationKind: detail,
    renderedTokenCount,
    requestedAt: request.requestedAt
  });
  const chain = await updateExplicitRetrievalChain({
    runtimeRoot: request.runtimeRoot,
    callerIdentity: request.callerIdentity,
    renderedTokenCount,
    requestedAt: request.requestedAt,
    ...(request.chainId === undefined ? {} : { chainId: request.chainId })
  });
  return {
    memoryId: memory.memoryId,
    revisionId: memory.revisionId,
    scope: memory.scope,
    authority: memory.authority,
    detail,
    body,
    receiptId,
    renderedTokenCount,
    ...chain
  };
}
