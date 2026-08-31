import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getEncoding } from "js-tiktoken";
import { z } from "zod";

import { openRuntimeDatabase } from "../runtime/database.js";
import type { EmbeddingAdapter } from "./index.js";
import { approvedShadowEmbeddingProfile } from "./shadow-profile.js";
import {
  ForegroundExecutionAborted,
  type ForegroundExecutionControl
} from "./foreground-lane.js";
import {
  buildRetrievalSearchIndex,
  rowToIndexedMemory,
  snapshotMemoriesForProject,
  tokenizeSearchText,
  type IndexedMemory,
  type RetrievalSearchIndex,
  type RetrievalSnapshot
} from "./snapshot.js";

const tokenizer = getEncoding("o200k_base");
const SESSION_TOKEN_LIMIT = 1200;
const ALWAYS_TOKEN_LIMIT = 600;
const SESSION_ITEM_LIMIT = 12;
const SESSION_IDENTITY_LIMIT = 4;
const PROMPT_TARGET_LIMIT = 600;
const PROMPT_HARD_LIMIT = 1024;
const PROMPT_ITEM_LIMIT = 6;
const PROBABLE_ITEM_LIMIT = 2;
const SESSION_BUCKET_PAGE_SIZE = 16;
const RECEIPT_OMISSION_DETAIL_LIMIT = 128;
const AUTOMATIC_SEMANTIC_DEADLINE_MS = 300;
const AUTOMATIC_QUERY_TERM_LIMIT = 64;
const AUTOMATIC_LEXICAL_CANDIDATE_LIMIT = 128;
const AUTOMATIC_SEMANTIC_CANDIDATE_LIMIT = 64;
const AUTOMATIC_SIGNAL_TERM_LIMIT = 16;
const AUTOMATIC_SIGNAL_CANDIDATE_LIMIT = 64;
const AUTOMATIC_RARE_TERM_FRACTION = 0.01;
const AUTOMATIC_SINGLE_RARE_TERM_MINIMUM_LENGTH = 3;
const AUTOMATIC_STRONG_EXACT_COVERAGE = 0.5;
const AUTOMATIC_STRONG_APPLICABILITY_COVERAGE = 0.25;
const AUTOMATIC_RARE_APPLICABILITY_COVERAGE = 0.15;
const MEMORY_LEGEND_VERSION = 1;
const MINIMUM_SESSION_ITEM_INCREMENT = tokenizer.encode(
  "\n[M:1 S:G A:H R:C] x"
).length;

type PriorityTier = "critical" | "strong" | "normal";
type RelevanceBand = "high" | "probable" | "weak";
type RepresentationKind = "compact" | "standard" | "identity";

interface ScoredMemory {
  readonly memory: IndexedMemory;
  readonly score: number;
  readonly band: RelevanceBand;
  readonly primaryAnchor: boolean;
  readonly exact: boolean;
  readonly directIdentity: boolean;
  readonly reasons: readonly string[];
  readonly similarity: number;
}

interface TermEvidence {
  readonly matchedCount: number;
  readonly matchedWeight: number;
  readonly totalWeight: number;
  readonly weightedCoverage: number;
  readonly rareMatch: boolean;
}

const EMPTY_TERM_EVIDENCE: TermEvidence = {
  matchedCount: 0,
  matchedWeight: 0,
  totalWeight: 0,
  weightedCoverage: 0,
  rareMatch: false
};

interface RetrievalStageTimings {
  readonly epochLoadMs: number;
  readonly scopeLoadMs: number;
  readonly embeddingMs: number;
  readonly vectorScanMs: number;
  readonly rankingAndRelationshipMs: number;
  readonly receiptWriteMs: number;
  readonly totalMs: number;
}

type RetrievalPreReceiptTimings = Omit<RetrievalStageTimings, "receiptWriteMs" | "totalMs">;

const retrievalStageTimingsSchema = z.object({
  epochLoadMs: z.number().nonnegative(),
  scopeLoadMs: z.number().nonnegative(),
  embeddingMs: z.number().nonnegative(),
  vectorScanMs: z.number().nonnegative(),
  rankingAndRelationshipMs: z.number().nonnegative(),
  receiptWriteMs: z.number().nonnegative(),
  totalMs: z.number().nonnegative()
});

export interface ShadowPackItem {
  readonly memoryId: string;
  readonly memoryRef: number;
  readonly revisionId: string;
  readonly scope: IndexedMemory["scope"];
  readonly authority: IndexedMemory["authority"];
  readonly representationKind: RepresentationKind;
  readonly relevanceBand?: RelevanceBand;
  readonly priorityTier: PriorityTier;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly text: string;
  readonly renderedTokenCount: number;
}

export interface ShadowPack {
  readonly mode: "shadow";
  readonly injected: false;
  readonly kind: "session_start" | "user_prompt";
  readonly text: string;
  readonly items: readonly ShadowPackItem[];
  readonly renderedTokenCount: number;
  readonly receiptId: string;
  readonly receiptCommitMs: number;
  readonly epochId: string;
  readonly emptyReason?: string;
  readonly semanticStage: "complete" | "lexical_only" | "not_applicable";
}

function eligibleForAutomaticRecall(memory: IndexedMemory): boolean {
  return !(memory.authority === "agent_derived" && memory.validityState === "review_due");
}

function tierFor(memory: IndexedMemory, projectId: string): PriorityTier {
  const tier = memory.basePriorityTier;
  if (memory.scope.kind === "project" && memory.scope.projectId === projectId) {
    if (tier === "normal") return "strong";
    if (tier === "strong") return "critical";
  }
  return tier;
}

function effectiveTierSql(): string {
  return `CASE
    WHEN scope_kind = 'project' AND project_id = ? THEN
      CASE base_priority_tier
        WHEN 'normal' THEN 'strong'
        ELSE 'critical'
      END
    ELSE base_priority_tier
  END`;
}

interface SessionPageStats {
  rowsExamined: number;
  bucketPageCount: number;
  terminalStopReason: string;
}

async function visitPagedSessionCandidates(request: {
  readonly runtimeRoot: string;
  readonly indexRevisionId: string;
  readonly projectId: string;
  readonly requestedAt: string;
  readonly deadlineAt: number;
  readonly startup: "always" | "auto";
  readonly visit: (memory: IndexedMemory) => boolean;
  readonly snapshot?: RetrievalSnapshot;
}): Promise<SessionPageStats> {
  if (request.snapshot !== undefined) {
    const orderedBuckets = request.snapshot.sessionBuckets
      .filter((bucket) => bucket.startup === request.startup &&
        (bucket.projectId === null || bucket.projectId === request.projectId))
      .map((bucket) => ({
        tier: bucket.tier,
        category: bucket.category,
        candidates: bucket.ordinals
          .map((ordinal) => request.snapshot?.documents[ordinal])
          .filter((memory): memory is IndexedMemory => memory !== undefined)
          .filter((memory) => eligibleForAutomaticRecall(memory) &&
            (memory.validFrom === undefined || memory.validFrom <= request.requestedAt) &&
            (memory.validUntil === undefined || memory.validUntil >= request.requestedAt)),
        cursor: 0
      }))
      .sort((left, right) =>
        (["critical", "strong", "normal"].indexOf(left.tier) -
          ["critical", "strong", "normal"].indexOf(right.tier)) ||
        left.category.localeCompare(right.category)
      );
    let rowsExamined = 0;
    for (const tier of ["critical", "strong", "normal"] as const) {
      const tierBuckets = orderedBuckets.filter((bucket) => bucket.tier === tier);
      while (tierBuckets.some((bucket) => bucket.cursor < bucket.candidates.length)) {
        for (const bucket of tierBuckets) {
          const memory = bucket.candidates[bucket.cursor];
          if (memory === undefined) continue;
          bucket.cursor += 1;
          rowsExamined += 1;
          if (request.visit(memory)) {
            return { rowsExamined, bucketPageCount: 0, terminalStopReason: "pack_limit_reached" };
          }
        }
      }
    }
    return { rowsExamined, bucketPageCount: 0, terminalStopReason: "candidates_exhausted" };
  }
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let rowsExamined = 0;
  let bucketPageCount = 0;
  try {
    const tierExpression = effectiveTierSql();
    const bucketRows = database.prepare(
      `SELECT DISTINCT ${tierExpression} AS effective_tier, category
       FROM retrieval_documents
       WHERE index_revision_id = ? AND startup = ?
         AND (scope_kind = 'global' OR (scope_kind = 'project' AND project_id = ?))
         AND NOT EXISTS (
           SELECT 1 FROM memory_ranking_exclusions AS exclusion
           WHERE exclusion.memory_id = retrieval_documents.memory_id
             AND exclusion.revision_id = retrieval_documents.revision_id
             AND exclusion.space_key = CASE
               WHEN retrieval_documents.scope_kind = 'global' THEN 'global'
               ELSE 'project:' || retrieval_documents.project_id END
         )
         AND (valid_from IS NULL OR valid_from <= ?)
         AND (valid_until IS NULL OR valid_until >= ?)
       ORDER BY CASE ${tierExpression}
         WHEN 'critical' THEN 0 WHEN 'strong' THEN 1 ELSE 2 END, category`
    ).all(
      request.projectId,
      request.indexRevisionId,
      request.startup,
      request.projectId,
      request.requestedAt,
      request.requestedAt,
      request.projectId
    );
    const buckets = bucketRows.map((row) => ({
      tier: z.enum(["critical", "strong", "normal"]).parse(row.effective_tier),
      category: z.string().parse(row.category),
      cursor: "",
      exhausted: false,
      queue: [] as IndexedMemory[]
    }));
    for (const tier of ["critical", "strong", "normal"] as const) {
      const tierBuckets = buckets.filter((bucket) => bucket.tier === tier);
      while (tierBuckets.some((bucket) => !bucket.exhausted || bucket.queue.length > 0)) {
        let progressed = false;
        for (const bucket of tierBuckets) {
          if (bucket.queue.length === 0 && !bucket.exhausted) {
            if (performance.now() >= request.deadlineAt) {
              return {
                rowsExamined,
                bucketPageCount,
                terminalStopReason: "deadline_optional_work_stopped"
              };
            }
            const pageRows = database.prepare(
              `SELECT * FROM retrieval_documents
               WHERE index_revision_id = ? AND startup = ? AND category = ?
                 AND (scope_kind = 'global' OR (scope_kind = 'project' AND project_id = ?))
                 AND NOT EXISTS (
                   SELECT 1 FROM memory_ranking_exclusions AS exclusion
                   WHERE exclusion.memory_id = retrieval_documents.memory_id
                     AND exclusion.revision_id = retrieval_documents.revision_id
                     AND exclusion.space_key = CASE
                       WHEN retrieval_documents.scope_kind = 'global' THEN 'global'
                       ELSE 'project:' || retrieval_documents.project_id END
                 )
                 AND (valid_from IS NULL OR valid_from <= ?)
                 AND (valid_until IS NULL OR valid_until >= ?)
                 AND ${tierExpression} = ? AND session_order_key > ?
               ORDER BY session_order_key
               LIMIT ?`
            ).all(
              request.indexRevisionId,
              request.startup,
              bucket.category,
              request.projectId,
              request.requestedAt,
              request.requestedAt,
              request.projectId,
              tier,
              bucket.cursor,
              SESSION_BUCKET_PAGE_SIZE
            );
            bucketPageCount += 1;
            rowsExamined += pageRows.length;
            bucket.queue.push(...pageRows.map((row) =>
              rowToIndexedMemory(row)
            ).filter(eligibleForAutomaticRecall));
            bucket.exhausted = pageRows.length < SESSION_BUCKET_PAGE_SIZE;
            const last = pageRows.at(-1);
            if (last !== undefined) bucket.cursor = z.string().parse(last.session_order_key);
          }
          const memory = bucket.queue.shift();
          if (memory === undefined) continue;
          progressed = true;
          if (request.visit(memory)) {
            return { rowsExamined, bucketPageCount, terminalStopReason: "pack_limit_reached" };
          }
        }
        if (!progressed) break;
      }
    }
    return { rowsExamined, bucketPageCount, terminalStopReason: "candidates_exhausted" };
  } finally {
    database.close();
  }
}

function scopeLabel(scope: IndexedMemory["scope"]): string {
  return scope.kind === "global" ? "G" : "P";
}

function authorityLabel(authority: IndexedMemory["authority"]): string {
  return authority === "human_authored" ? "H" : "A";
}

function representationFor(
  memory: IndexedMemory,
  tier: PriorityTier,
  allowIdentity: boolean
): { readonly kind: "compact" | "identity"; readonly text: string } | undefined {
  if (memory.compactValidated && memory.compactTokenCount <= 96) {
    return { kind: "compact", text: memory.compactText };
  }
  if (
    allowIdentity &&
    tier !== "normal" &&
    memory.identityValidated &&
    memory.identityTokenCount <= 48 &&
    memory.identityLabel !== undefined
  ) {
    return {
      kind: "identity",
      text: `${memory.identityLabel}; body is incomplete; read M:${String(memory.memoryRef)} by identity before reliance.`
    };
  }
  return undefined;
}

function renderItem(
  memory: IndexedMemory,
  representationKind: RepresentationKind,
  text: string
): string {
  const representationLabel = representationKind === "compact"
    ? "C"
    : representationKind === "standard"
      ? "S"
      : "I";
  return `[M:${String(memory.memoryRef)} S:${scopeLabel(memory.scope)} A:${authorityLabel(memory.authority)} R:${representationLabel}] ${text}`;
}

const standardHeader =
  "<memstore-context>Automatically retrieved historical long-term memory. Retrieval may include false positives. Use only items clearly applicable to the current request and ignore unrelated items. Current explicit instructions and verified workspace state take precedence.</memstore-context>";
const probableHeader =
  "<memstore-context>Automatically retrieved, possibly relevant historical long-term memory. Treat these items as candidates: verify applicability, ignore unrelated items, and read by M:<id> when more detail is needed. Current explicit instructions and verified workspace state take precedence.</memstore-context>";
const sessionStartHeader =
  "<memstore-context>Automatically selected long-term project background for session startup. It is not necessarily relevant to the current task. Use only clearly applicable items and ignore the rest. Current explicit instructions and verified workspace state take precedence.</memstore-context>";
const memoryLegend =
  "Legend: M=memory ref; S=P(current project)/G(global); A=H(human)/A(agent); R=C(compact)/S(standard)/I(identity).";

type PackHeaderKind = "session_start" | "relevant" | "probable";

function renderPack(
  items: readonly ShadowPackItem[],
  headerKind: PackHeaderKind,
  includeLegend = false
): {
  readonly text: string;
  readonly renderedTokenCount: number;
} {
  if (items.length === 0) return { text: "", renderedTokenCount: 0 };
  const text = [
    headerKind === "session_start"
      ? sessionStartHeader
      : headerKind === "probable" ? probableHeader : standardHeader,
    ...(includeLegend ? [memoryLegend] : []),
    ...items.map((item) => item.text)
  ].join("\n");
  return { text, renderedTokenCount: tokenizer.encode(text).length };
}

async function loadActiveScope(request: {
  readonly runtimeRoot: string;
  readonly projectId: string;
  readonly requestedAt: string;
  readonly snapshot?: RetrievalSnapshot;
}): Promise<{
  readonly active: Record<string, unknown>;
  readonly memories: readonly IndexedMemory[];
}> {
  if (request.snapshot !== undefined) {
    return {
      active: {
        index_revision_id: request.snapshot.indexRevisionId,
        directory_path: request.snapshot.directoryPath,
        adapter_version: request.snapshot.adapterVersion,
        model_identity: request.snapshot.modelIdentity,
        artifact_sha256: request.snapshot.artifactSha256,
        dimensions: request.snapshot.dimensions
      },
      memories: snapshotMemoriesForProject({
        snapshot: request.snapshot,
        projectId: request.projectId,
        requestedAt: request.requestedAt
      })
    };
  }
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const active = database.prepare(
      `SELECT revision.* FROM active_retrieval_index AS active
       JOIN retrieval_index_revisions AS revision
         ON revision.index_revision_id = active.index_revision_id
       WHERE active.singleton = 1 AND revision.state = 'complete'`
    ).get();
    if (active === undefined) throw new Error("No completed retrieval index is active.");
    const indexRevisionId = z.string().parse(active.index_revision_id);
    const rows = database.prepare(
      `SELECT document.* FROM retrieval_documents AS document
       WHERE index_revision_id = ? AND
         (scope_kind = 'global' OR (scope_kind = 'project' AND project_id = ?))
         AND NOT EXISTS (
           SELECT 1 FROM memory_ranking_exclusions AS exclusion
           WHERE exclusion.memory_id = document.memory_id
             AND exclusion.revision_id = document.revision_id
             AND exclusion.space_key = CASE
               WHEN document.scope_kind = 'global' THEN 'global'
               ELSE 'project:' || document.project_id END
         )
       ORDER BY memory_id`
    ).all(indexRevisionId, request.projectId);
    const memories = rows.map((row) => rowToIndexedMemory(row)).filter((memory) =>
      eligibleForAutomaticRecall(memory) &&
      (memory.validFrom === undefined || memory.validFrom <= request.requestedAt) &&
      (memory.validUntil === undefined || memory.validUntil >= request.requestedAt)
    );
    return { active, memories };
  } finally {
    database.close();
  }
}

async function loadActiveIndex(
  runtimeRoot: string,
  snapshot?: RetrievalSnapshot
): Promise<Record<string, unknown>> {
  if (snapshot !== undefined) {
    return { index_revision_id: snapshot.indexRevisionId };
  }
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const active = database.prepare(
      `SELECT revision.* FROM active_retrieval_index AS active
       JOIN retrieval_index_revisions AS revision
         ON revision.index_revision_id = active.index_revision_id
       WHERE active.singleton = 1 AND revision.state = 'complete'`
    ).get();
    if (active === undefined) throw new Error("No completed retrieval index is active.");
    return active;
  } finally {
    database.close();
  }
}

async function loadEpoch(runtimeRoot: string, sessionId: string): Promise<{
  readonly epochId: string;
  readonly tokenTotal: number;
  readonly memoryLegendVersion: number;
  readonly injectedRevisions: ReadonlySet<string>;
}> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const row = database.prepare(
      `SELECT epoch_id, automatic_token_total, memory_legend_version
       FROM context_epochs WHERE session_id = ? AND state = 'active'`
    ).get(sessionId);
    if (row === undefined) throw new Error("UserPromptSubmit requires an active Context Epoch.");
    const epochId = z.string().parse(row.epoch_id);
    const revisions = database.prepare(
      `SELECT item.memory_id, item.revision_id
       FROM retrieval_receipts AS receipt
       JOIN retrieval_receipt_items AS item ON item.receipt_id = receipt.receipt_id
       WHERE receipt.epoch_id = ? AND item.outcome = 'selected'`
    ).all(epochId);
    return {
      epochId,
      tokenTotal: z.number().int().nonnegative().parse(row.automatic_token_total),
      memoryLegendVersion: z.number().int().nonnegative().parse(row.memory_legend_version),
      injectedRevisions: new Set(revisions.map((item) => `${String(item.memory_id)}:${String(item.revision_id)}`))
    };
  } finally {
    database.close();
  }
}

async function recordAutomaticReceipt(request: {
  readonly runtimeRoot: string;
  readonly callerKind: "session_start" | "user_prompt";
  readonly callerIdentity: string;
  readonly normalizedQuery: string;
  readonly projectId: string;
  readonly indexRevisionId?: string;
  readonly epochId: string;
  readonly items: readonly ShadowPackItem[];
  readonly omittedItems?: readonly {
    readonly memoryId: string;
    readonly revisionId: string;
    readonly relevanceBand: "high" | "probable" | "weak" | "startup";
    readonly score: number;
    readonly reasons: readonly string[];
    readonly omissionReason: string;
  }[];
  readonly renderedTokenCount: number;
  readonly memoryLegendVersion?: number;
  readonly budgetTier: string;
  readonly semanticStage: "complete" | "lexical_only" | "not_applicable";
  readonly emptyReason?: string;
  readonly softTargetRestricted?: boolean;
  readonly hardLimitBlocked?: boolean;
  readonly rowsExamined?: number;
  readonly bucketPageCount?: number;
  readonly terminalStopReason?: string;
  readonly latencyMs: number;
  readonly timingStartedAt?: number;
  readonly preReceiptTimings?: RetrievalPreReceiptTimings;
  readonly requestedAt: string;
  readonly eventId?: string;
  readonly startSessionEpoch?: {
    readonly sessionId: string;
  };
  readonly foregroundControl?: ForegroundExecutionControl;
}): Promise<{
  readonly receiptId: string;
  readonly epochTotal: number;
  readonly receiptCommitMs: number;
}> {
  const receiptId = `msreceipt_${randomUUID()}`;
  const receiptStarted = performance.now();
  await request.foregroundControl?.checkpoint("before_receipt_transaction", 100);
  const database = await openRuntimeDatabase(request.runtimeRoot, {
    busyTimeoutMilliseconds: 50
  });
  try {
    await request.foregroundControl?.checkpoint("receipt_database_opened", 100);
    database.exec("BEGIN IMMEDIATE");
    let epoch: Record<string, unknown> | undefined;
    if (request.startSessionEpoch !== undefined) {
      database.prepare(
        "UPDATE context_epochs SET state = 'closed', closed_at = ? WHERE session_id = ? AND state = 'active'"
      ).run(request.requestedAt, request.startSessionEpoch.sessionId);
      database.prepare(
        `INSERT INTO context_epochs(
           epoch_id, session_id, project_id, state, automatic_token_total, started_at
         ) VALUES (?, ?, ?, 'active', 0, ?)`
      ).run(
        request.epochId,
        request.startSessionEpoch.sessionId,
        request.projectId,
        request.requestedAt
      );
      epoch = { automatic_token_total: 0, memory_legend_version: 0 };
    } else {
      epoch = database.prepare(
        `SELECT automatic_token_total, memory_legend_version
         FROM context_epochs WHERE epoch_id = ? AND state = 'active'`
      ).get(request.epochId);
    }
    if (epoch === undefined) throw new Error("Context Epoch changed before Receipt commit.");
    const previousTotal = z.number().int().nonnegative().parse(epoch.automatic_token_total);
    const epochTotal = previousTotal + request.renderedTokenCount;
    database.prepare(
      `INSERT INTO retrieval_receipts(
         receipt_id, caller_kind, caller_identity, query_identity,
         normalized_query, scope_binding, project_id, index_revision_id,
         epoch_id, rendered_token_count, automatic_epoch_total, budget_tier,
         semantic_stage, empty_reason, soft_target_restricted,
         hard_limit_blocked, rows_examined, bucket_page_count,
         terminal_stop_reason, omitted_item_count,
         omission_details_truncated, latency_ms, created_at
       ) VALUES (?, ?, ?, ?, ?, 'current+global', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      receiptId,
      request.callerKind,
      request.callerIdentity,
      createHash("sha256").update(request.normalizedQuery).digest("hex"),
      request.normalizedQuery,
      request.projectId,
      request.indexRevisionId ?? null,
      request.epochId,
      request.renderedTokenCount,
      epochTotal,
      request.budgetTier,
      request.semanticStage,
      request.emptyReason ?? null,
      request.softTargetRestricted === true ? 1 : 0,
      request.hardLimitBlocked === true ? 1 : 0,
      request.rowsExamined ?? 0,
      request.bucketPageCount ?? 0,
      request.terminalStopReason ?? null,
      request.omittedItems?.length ?? 0,
      (request.omittedItems?.length ?? 0) > RECEIPT_OMISSION_DETAIL_LIMIT ? 1 : 0,
      request.latencyMs,
      request.requestedAt
    );
    const insert = database.prepare(
      `INSERT INTO retrieval_receipt_items(
         receipt_id, memory_id, revision_id, rank_ordinal, relevance_band,
         representation_kind, rendered_token_count, score, reasons_json,
         outcome, omission_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'selected', NULL)`
    );
    request.items.forEach((item, index) => insert.run(
      receiptId,
      item.memoryId,
      item.revisionId,
      index,
      request.callerKind === "session_start"
        ? "startup"
        : z.enum(["high", "probable", "weak"]).parse(item.relevanceBand),
      item.representationKind,
      item.renderedTokenCount,
      item.score,
      JSON.stringify(item.reasons)
    ));
    const insertOmitted = database.prepare(
      `INSERT INTO retrieval_receipt_items(
         receipt_id, memory_id, revision_id, rank_ordinal, relevance_band,
         representation_kind, rendered_token_count, score, reasons_json,
         outcome, omission_reason
       ) VALUES (?, ?, ?, ?, ?, 'identity', 0, ?, ?, 'omitted', ?)`
    );
    request.omittedItems?.slice(0, RECEIPT_OMISSION_DETAIL_LIMIT).forEach((item, index) => insertOmitted.run(
      receiptId,
      item.memoryId,
      item.revisionId,
      request.items.length + index,
      item.relevanceBand,
      item.score,
      JSON.stringify(item.reasons),
      item.omissionReason
    ));
    const previousLegendVersion = z.number().int().nonnegative().parse(epoch.memory_legend_version);
    const memoryLegendVersion = Math.max(
      previousLegendVersion,
      request.items.length === 0 ? 0 : request.memoryLegendVersion ?? 0
    );
    database.prepare(
      `UPDATE context_epochs
       SET automatic_token_total = ?, memory_legend_version = ?
       WHERE epoch_id = ? AND state = 'active'`
    ).run(epochTotal, memoryLegendVersion, request.epochId);
    if (request.timingStartedAt !== undefined && request.preReceiptTimings !== undefined) {
      const receiptWriteMs = Math.max(0, performance.now() - receiptStarted);
      const totalMs = Math.max(0, performance.now() - request.timingStartedAt);
      const timings: RetrievalStageTimings = {
        ...request.preReceiptTimings,
        receiptWriteMs,
        totalMs
      };
      database.prepare(
        "UPDATE retrieval_receipts SET latency_ms = ?, timing_json = ? WHERE receipt_id = ?"
      ).run(totalMs, JSON.stringify(timings), receiptId);
    }
    if (request.eventId !== undefined) {
      const reservation = database.prepare(
        `UPDATE foreground_event_reservations
         SET state = 'completed', receipt_id = ?, last_error_code = NULL,
             next_retry_at = NULL, updated_at = ?
         WHERE event_id = ? AND state = 'processing'`
      ).run(receiptId, request.requestedAt, request.eventId);
      if (reservation.changes !== 1) {
        throw new Error("Foreground event reservation changed before Receipt commit.");
      }
    }
    await request.foregroundControl?.checkpoint("before_receipt_commit", 100);
    database.exec("COMMIT");
    return {
      receiptId,
      epochTotal,
      receiptCommitMs: Math.max(0, performance.now() - receiptStarted)
    };
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

export interface SessionStartShadowPackRequest {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly requestedAt: string;
  readonly eventId?: string;
  readonly snapshot?: RetrievalSnapshot;
  readonly foregroundControl?: ForegroundExecutionControl;
}

async function prepareSessionStartShadowPackCore(
  request: SessionStartShadowPackRequest
): Promise<ShadowPack> {
  const started = performance.now();
  const requestedAt = z.iso.datetime().parse(request.requestedAt);
  const epochId = `msepoch_${randomUUID()}`;
  let active: Record<string, unknown>;
  try {
    active = await loadActiveIndex(request.runtimeRoot, request.snapshot);
  } catch {
    const receipt = await recordAutomaticReceipt({
      runtimeRoot: request.runtimeRoot,
      callerKind: "session_start",
      callerIdentity: `session:${request.sessionId}`,
      normalizedQuery: "session_start",
      projectId: request.projectId,
      epochId,
      items: [],
      renderedTokenCount: 0,
      budgetTier: "session_start_1200",
      semanticStage: "not_applicable",
      emptyReason: "index_unavailable",
      latencyMs: Math.max(0, performance.now() - started),
      requestedAt,
      startSessionEpoch: { sessionId: request.sessionId },
      ...(request.eventId === undefined ? {} : { eventId: request.eventId }),
      ...(request.foregroundControl === undefined
        ? {}
        : { foregroundControl: request.foregroundControl })
    });
    return {
      mode: "shadow",
      injected: false,
      kind: "session_start",
      text: "",
      items: [],
      renderedTokenCount: 0,
      receiptId: receipt.receiptId,
      receiptCommitMs: receipt.receiptCommitMs,
      epochId,
      emptyReason: "index_unavailable",
      semanticStage: "not_applicable"
    };
  }
  const selected: ShadowPackItem[] = [];
  const examined: IndexedMemory[] = [];
  let identityCount = 0;
  let alwaysTokens = 0;
  let selectedRenderedTokenCount = 0;
  const trySelect = (memory: IndexedMemory, always: boolean): boolean => {
    if (selected.length >= SESSION_ITEM_LIMIT) return true;
    if (selectedRenderedTokenCount > 0 &&
        SESSION_TOKEN_LIMIT - selectedRenderedTokenCount < MINIMUM_SESSION_ITEM_INCREMENT) {
      return true;
    }
    examined.push(memory);
    const tier = tierFor(memory, request.projectId);
    const representation = representationFor(memory, tier, always || tier !== "normal");
    if (representation === undefined) return false;
    if (representation.kind === "identity" && identityCount >= SESSION_IDENTITY_LIMIT) return false;
    const text = renderItem(memory, representation.kind, representation.text);
    const itemTokens = tokenizer.encode(text).length;
    if (always && alwaysTokens + itemTokens > ALWAYS_TOKEN_LIMIT) return false;
    const trial = renderPack([...selected, {
      memoryId: memory.memoryId,
      memoryRef: memory.memoryRef,
      revisionId: memory.revisionId,
      scope: memory.scope,
      authority: memory.authority,
      representationKind: representation.kind,
      priorityTier: tier,
      score: 0,
      reasons: [always ? "startup_always" : "startup_ranked"],
      text,
      renderedTokenCount: itemTokens
    }], "session_start", true);
    if (trial.renderedTokenCount > SESSION_TOKEN_LIMIT) return false;
    selected.push({
      memoryId: memory.memoryId,
      memoryRef: memory.memoryRef,
      revisionId: memory.revisionId,
      scope: memory.scope,
      authority: memory.authority,
      representationKind: representation.kind,
      priorityTier: tier,
      score: 0,
      reasons: [always ? "startup_always" : "startup_ranked"],
      text,
      renderedTokenCount: itemTokens
    });
    selectedRenderedTokenCount = trial.renderedTokenCount;
    if (always) alwaysTokens += itemTokens;
    if (representation.kind === "identity") identityCount += 1;
    return selected.length >= SESSION_ITEM_LIMIT;
  };
  const indexRevisionId = z.string().parse(active.index_revision_id);
  const alwaysStats = await visitPagedSessionCandidates({
    runtimeRoot: request.runtimeRoot,
    indexRevisionId,
    projectId: request.projectId,
    requestedAt,
    deadlineAt: started + 450,
    startup: "always",
    visit: (memory) => trySelect(memory, true),
    ...(request.snapshot === undefined ? {} : { snapshot: request.snapshot })
  });
  const dynamicStats = selected.length >= SESSION_ITEM_LIMIT
    ? { rowsExamined: 0, bucketPageCount: 0, terminalStopReason: "pack_limit_reached" }
    : await visitPagedSessionCandidates({
        runtimeRoot: request.runtimeRoot,
        indexRevisionId,
        projectId: request.projectId,
        requestedAt,
        deadlineAt: started + 450,
        startup: "auto",
        visit: (memory) => trySelect(memory, false),
        ...(request.snapshot === undefined ? {} : { snapshot: request.snapshot })
      });
  const rendered = renderPack(selected, "session_start", true);
  const selectedIds = new Set(selected.map((item) => item.memoryId));
  const omittedItems = examined.filter((memory) => !selectedIds.has(memory.memoryId)).map((memory) => {
    const tier = tierFor(memory, request.projectId);
    const representation = representationFor(memory, tier, memory.startup === "always" || tier !== "normal");
    return {
      memoryId: memory.memoryId,
      revisionId: memory.revisionId,
      relevanceBand: "startup" as const,
      score: 0,
      reasons: ["session_start_candidate"],
      omissionReason: representation === undefined
          ? "representation_unavailable"
          : "budget_or_item_limit"
    };
  });
  await request.foregroundControl?.checkpoint("before_session_receipt");
  const receipt = await recordAutomaticReceipt({
    runtimeRoot: request.runtimeRoot,
    callerKind: "session_start",
    callerIdentity: `session:${request.sessionId}`,
    normalizedQuery: "session_start",
    projectId: request.projectId,
    indexRevisionId: z.string().parse(active.index_revision_id),
    epochId,
    items: selected,
    omittedItems,
    renderedTokenCount: rendered.renderedTokenCount,
    memoryLegendVersion: MEMORY_LEGEND_VERSION,
    budgetTier: "session_start_1200",
    semanticStage: "not_applicable",
    rowsExamined: alwaysStats.rowsExamined + dynamicStats.rowsExamined,
    bucketPageCount: alwaysStats.bucketPageCount + dynamicStats.bucketPageCount,
    terminalStopReason: dynamicStats.terminalStopReason,
    ...(selected.length === 0 ? { emptyReason: "no_eligible_memory" } : {}),
    latencyMs: Math.max(0, performance.now() - started),
    requestedAt,
    startSessionEpoch: { sessionId: request.sessionId },
    ...(request.eventId === undefined ? {} : { eventId: request.eventId }),
    ...(request.foregroundControl === undefined
      ? {}
      : { foregroundControl: request.foregroundControl })
  });
  return {
    mode: "shadow",
    injected: false,
    kind: "session_start",
    text: rendered.text,
    items: selected,
    renderedTokenCount: rendered.renderedTokenCount,
    receiptId: receipt.receiptId,
    receiptCommitMs: receipt.receiptCommitMs,
    epochId,
    ...(selected.length === 0 ? { emptyReason: "no_eligible_memory" } : {}),
    semanticStage: "not_applicable"
  };
}

function queryTerms(text: string): readonly string[] {
  return [...tokenizeSearchText(text)];
}

function termMatches(
  term: string,
  terms: ReadonlySet<string>,
  normalizedText: string
): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(term)
    ? normalizedText.includes(term)
    : terms.has(term);
}

function weightedTermEvidence(
  query: readonly string[],
  termWeights: ReadonlyMap<string, number>,
  rareTerms: ReadonlySet<string>,
  terms: ReadonlySet<string>,
  normalizedText: string
): TermEvidence {
  let matchedCount = 0;
  let matchedWeight = 0;
  let totalWeight = 0;
  let rareMatch = false;
  for (const term of query) {
    const weight = termWeights.get(term) ?? 0;
    totalWeight += weight;
    if (!termMatches(term, terms, normalizedText)) continue;
    matchedCount += 1;
    matchedWeight += weight;
    rareMatch ||= rareTerms.has(term);
  }
  return {
    matchedCount,
    matchedWeight,
    totalWeight,
    weightedCoverage: totalWeight === 0 ? 0 : matchedWeight / totalWeight,
    rareMatch
  };
}

function directMemoryReferences(
  prompt: string,
  searchIndex: RetrievalSearchIndex
): ReadonlySet<string> {
  const direct = new Set<string>();
  const normalizedIds = new Map(
    [...searchIndex.documentsByMemoryId.keys()].map((memoryId) => [
      memoryId.toLocaleLowerCase("en-US"),
      memoryId
    ] as const)
  );
  for (const match of prompt.matchAll(/msmem_[A-Za-z0-9-]+/gu)) {
    const memoryId = normalizedIds.get(match[0].toLocaleLowerCase("en-US"));
    if (memoryId !== undefined) direct.add(memoryId);
  }
  for (const match of prompt.matchAll(/(?:^|[^A-Za-z0-9_])M:(\d+)(?![0-9])/giu)) {
    const memoryRef = Number(match[1]);
    if (!Number.isSafeInteger(memoryRef)) continue;
    const memoryId = searchIndex.memoryIdByRef.get(memoryRef);
    if (memoryId !== undefined) direct.add(memoryId);
  }
  return direct;
}

async function automaticCandidates(request: {
  readonly memories: readonly IndexedMemory[];
  readonly searchIndex: RetrievalSearchIndex;
  readonly terms: readonly string[];
  readonly prompt: string;
  readonly signals: readonly string[];
  readonly semanticScores: ReadonlyMap<string, number>;
  readonly foregroundControl?: ForegroundExecutionControl;
}): Promise<{
  readonly memories: readonly IndexedMemory[];
  readonly exactTerms: readonly string[];
  readonly exactTermWeights: ReadonlyMap<string, number>;
  readonly rareExactTerms: ReadonlySet<string>;
  readonly directMemoryIds: ReadonlySet<string>;
  readonly rankingTerms: readonly string[];
  readonly rankingTermWeights: ReadonlyMap<string, number>;
  readonly rareRankingTerms: ReadonlySet<string>;
}> {
  const eligibleIds = new Set(request.memories.map((memory) => memory.memoryId));
  const scopedPostingsByTerm = new Map<string, readonly string[]>();
  const scopedPostings = (term: string): readonly string[] => {
    const existing = scopedPostingsByTerm.get(term);
    if (existing !== undefined) return existing;
    const postings = (request.searchIndex.postingsByTerm.get(term) ?? [])
      .filter((memoryId) => eligibleIds.has(memoryId));
    scopedPostingsByTerm.set(term, postings);
    return postings;
  };
  const documentFrequency = (term: string): number => scopedPostings(term).length;
  const rareTermMaximumDocumentFrequency = Math.max(
    1,
    Math.floor(request.memories.length * AUTOMATIC_RARE_TERM_FRACTION)
  );
  const termWeight = (term: string): number =>
    Math.log1p(request.memories.length / Math.max(1, documentFrequency(term)));
  const coverageTermWeight = (term: string): number => documentFrequency(term) === 0
    ? Math.log1p(1)
    : termWeight(term);
  const retrievalTerms = request.terms
    .filter((term) => documentFrequency(term) > 0)
    .sort((left, right) => documentFrequency(left) - documentFrequency(right) ||
      right.length - left.length || left.localeCompare(right))
    .slice(0, AUTOMATIC_QUERY_TERM_LIMIT);
  const selectedRetrievalTerms = new Set(retrievalTerms);
  const rankingTerms = [
    ...retrievalTerms,
    ...request.terms.filter((term) => !selectedRetrievalTerms.has(term))
  ].slice(0, AUTOMATIC_QUERY_TERM_LIMIT);
  const rankingTermWeights = new Map(
    rankingTerms.map((term) => [term, coverageTermWeight(term)] as const)
  );
  const rareRankingTerms = new Set(
    rankingTerms.filter((term) =>
      Array.from(term).length >= AUTOMATIC_SINGLE_RARE_TERM_MINIMUM_LENGTH &&
      documentFrequency(term) > 0 &&
      documentFrequency(term) <= rareTermMaximumDocumentFrequency
    )
  );
  const lexicalScores = new Map<string, { matchedCount: number; idf: number }>();
  let postingVisits = 0;
  for (const term of retrievalTerms) {
    const postings = scopedPostings(term);
    const idf = termWeight(term);
    for (const memoryId of postings) {
      if (!eligibleIds.has(memoryId)) continue;
      const current = lexicalScores.get(memoryId) ?? { matchedCount: 0, idf: 0 };
      lexicalScores.set(memoryId, {
        matchedCount: current.matchedCount + 1,
        idf: current.idf + idf
      });
      postingVisits += 1;
      if (postingVisits % 4_096 === 0) {
        await request.foregroundControl?.checkpoint("prompt_lexical_recall");
      }
    }
  }
  const candidateIds = new Set(
    [...lexicalScores.entries()]
      .sort((left, right) => right[1].idf - left[1].idf ||
        right[1].matchedCount - left[1].matchedCount || left[0].localeCompare(right[0]))
      .slice(0, AUTOMATIC_LEXICAL_CANDIDATE_LIMIT)
      .map(([memoryId]) => memoryId)
  );
  for (const [memoryId] of [...request.semanticScores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, AUTOMATIC_SEMANTIC_CANDIDATE_LIMIT)) {
    candidateIds.add(memoryId);
  }
  const signalScores = new Map<string, number>();
  const signalTerms = queryTerms(request.signals.join("\n"))
    .filter((term) => documentFrequency(term) > 0)
    .sort((left, right) => documentFrequency(left) - documentFrequency(right) ||
      right.length - left.length || left.localeCompare(right))
    .slice(0, AUTOMATIC_SIGNAL_TERM_LIMIT);
  for (const term of signalTerms) {
    const postings = scopedPostings(term);
    const idf = termWeight(term);
    for (const memoryId of postings) {
      if (!eligibleIds.has(memoryId)) continue;
      signalScores.set(memoryId, (signalScores.get(memoryId) ?? 0) + idf);
      postingVisits += 1;
      if (postingVisits % 4_096 === 0) {
        await request.foregroundControl?.checkpoint("prompt_signal_recall");
      }
    }
  }
  for (const [memoryId] of [...signalScores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, AUTOMATIC_SIGNAL_CANDIDATE_LIMIT)) {
    candidateIds.add(memoryId);
  }
  const directMemoryIds = directMemoryReferences(request.prompt, request.searchIndex);
  for (const memoryId of directMemoryIds) {
    if (eligibleIds.has(memoryId)) candidateIds.add(memoryId);
  }
  const exactTerms = [...new Set(
    (request.prompt.match(/[A-Za-z][A-Za-z0-9_.:/-]{3,}|[A-Z]{2,}[0-9-]*/gu) ?? [])
      .map((term) => term.normalize("NFKC").toLocaleLowerCase("en-US"))
  )].filter((term) => documentFrequency(term) > 0);
  const exactTermWeights = new Map(
    exactTerms.map((term) => [term, termWeight(term)] as const)
  );
  const rareExactTerms = new Set(
    exactTerms.filter((term) =>
      Array.from(term).length >= AUTOMATIC_SINGLE_RARE_TERM_MINIMUM_LENGTH &&
      documentFrequency(term) <= rareTermMaximumDocumentFrequency
    )
  );
  for (const term of exactTerms) {
    const postings = scopedPostings(term);
    for (const memoryId of postings) {
      candidateIds.add(memoryId);
    }
  }
  const memoryById = new Map(request.memories.map((memory) => [memory.memoryId, memory] as const));
  return {
    memories: [...candidateIds]
      .map((memoryId) => memoryById.get(memoryId))
      .filter((memory): memory is IndexedMemory => memory !== undefined),
    exactTerms,
    exactTermWeights,
    rareExactTerms,
    directMemoryIds,
    rankingTerms,
    rankingTermWeights,
    rareRankingTerms
  };
}

function normalizeVector(vector: readonly number[]): readonly number[] | undefined {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude === 0 || vector.some((value) => !Number.isFinite(value))
    ? undefined
    : vector.map((value) => value / magnitude);
}

function dotVector(
  query: readonly number[],
  values: Float32Array,
  start: number,
  dimensions: number
): number {
  let score = 0;
  for (let index = 0; index < dimensions; index += 1) {
    score += (query[index] ?? 0) * (values[start + index] ?? 0);
  }
  return score;
}

async function semanticScores(request: {
  readonly active: Record<string, unknown>;
  readonly memories: readonly IndexedMemory[];
  readonly query: string;
  readonly adapter?: EmbeddingAdapter;
  readonly deadlineAt: number;
  readonly snapshot?: RetrievalSnapshot;
  readonly foregroundControl?: ForegroundExecutionControl;
}): Promise<{
  readonly stage: "complete" | "lexical_only";
  readonly scores: ReadonlyMap<string, number>;
  readonly embeddingMs: number;
  readonly vectorScanMs: number;
}> {
  if (
    request.adapter === undefined ||
    request.adapter.identity.adapterVersion !== request.active.adapter_version ||
    request.adapter.identity.modelIdentity !== request.active.model_identity ||
    request.adapter.identity.artifactSha256 !== request.active.artifact_sha256 ||
    request.adapter.identity.dimensions !== request.active.dimensions
  ) return { stage: "lexical_only", scores: new Map(), embeddingMs: 0, vectorScanMs: 0 };
  const remaining = request.deadlineAt - performance.now();
  if (remaining <= 0) {
    return { stage: "lexical_only", scores: new Map(), embeddingMs: 0, vectorScanMs: 0 };
  }
  const embeddingStarted = performance.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const embedded = await Promise.race([
    (request.adapter.embedQuery ?? request.adapter.embed)([request.query]),
    new Promise<undefined>((resolve) => {
      timeout = setTimeout(() => {
        resolve(undefined);
      }, remaining);
    })
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  const embeddingMs = Math.max(0, performance.now() - embeddingStarted);
  if (embedded === undefined) {
    return { stage: "lexical_only", scores: new Map(), embeddingMs, vectorScanMs: 0 };
  }
  const queryEmbedding = embedded[0];
  const normalized = queryEmbedding === undefined ? undefined : normalizeVector(queryEmbedding);
  if (normalized === undefined) {
    return { stage: "lexical_only", scores: new Map(), embeddingMs, vectorScanMs: 0 };
  }
  const vectorScanStarted = performance.now();
  let resolvedValues: Float32Array;
  if (request.snapshot !== undefined) resolvedValues = request.snapshot.vectors;
  else {
    const bytes = await readFile(`${String(request.active.directory_path)}/vectors.f32`);
    resolvedValues = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }
  const dimensions = z.number().int().positive().parse(request.active.dimensions);
  const scores = new Map<string, number>();
  for (const [index, memory] of request.memories.entries()) {
    if (index > 0 && index % 128 === 0) {
      await request.foregroundControl?.checkpoint("prompt_vector_scan");
    }
    scores.set(memory.memoryId, dotVector(
      normalized,
      resolvedValues,
      memory.vectorOrdinal * dimensions,
      dimensions
    ));
  }
  return {
    stage: "complete",
    embeddingMs,
    vectorScanMs: Math.max(0, performance.now() - vectorScanStarted),
    scores
  };
}

function isContinuationOnly(prompt: string): boolean {
  const normalized = prompt.trim().toLocaleLowerCase("en-US");
  return normalized.length <= 12 && /^(ok|okay|yes|sure|continue|好的?|可以|同意|继续|行了?|没问题)[。.!！]?$/u.test(normalized);
}

async function relationshipBoosts(
  runtimeRoot: string,
  seedMemoryIds: readonly string[],
  snapshot?: RetrievalSnapshot
): Promise<ReadonlySet<string>> {
  if (seedMemoryIds.length === 0) return new Set();
  const seeds = new Set(seedMemoryIds);
  if (snapshot !== undefined) {
    const adjacent = new Set<string>();
    for (const relationship of snapshot.relationships) {
      if (seeds.has(relationship.sourceMemoryId) && !seeds.has(relationship.targetMemoryId)) {
        adjacent.add(relationship.targetMemoryId);
      }
      if (seeds.has(relationship.targetMemoryId) && !seeds.has(relationship.sourceMemoryId)) {
        adjacent.add(relationship.sourceMemoryId);
      }
    }
    return adjacent;
  }
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const rows = database.prepare(
      "SELECT source_memory_id, target_memory_id FROM memory_relationships"
    ).all();
    const adjacent = new Set<string>();
    for (const row of rows) {
      const source = z.string().parse(row.source_memory_id);
      const target = z.string().parse(row.target_memory_id);
      if (seeds.has(source) && !seeds.has(target)) adjacent.add(target);
      if (seeds.has(target) && !seeds.has(source)) adjacent.add(source);
    }
    return adjacent;
  } finally {
    database.close();
  }
}

export interface UserPromptShadowPackRequest {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly signals: {
    readonly files: readonly string[];
    readonly symbols: readonly string[];
    readonly errors: readonly string[];
    readonly commands: readonly string[];
  };
  readonly adapter?: EmbeddingAdapter;
  readonly requestedAt: string;
  readonly eventId?: string;
  readonly snapshot?: RetrievalSnapshot;
  readonly foregroundControl?: ForegroundExecutionControl;
  readonly policy?: {
    readonly epochSoftTarget?: number;
    readonly epochHardLimit?: number;
  };
}

async function prepareUserPromptShadowPackCore(
  request: UserPromptShadowPackRequest
): Promise<ShadowPack> {
  const started = performance.now();
  const requestedAt = z.iso.datetime().parse(request.requestedAt);
  const normalizedPrompt = request.prompt.trim().replace(/\s+/gu, " ");
  const epochLoadStarted = performance.now();
  const epoch = await loadEpoch(request.runtimeRoot, request.sessionId);
  const includeMemoryLegend = epoch.memoryLegendVersion < MEMORY_LEGEND_VERSION;
  await request.foregroundControl?.checkpoint("prompt_epoch_loaded");
  const epochLoadMs = Math.max(0, performance.now() - epochLoadStarted);
  let loaded: Awaited<ReturnType<typeof loadActiveScope>>;
  const scopeLoadStarted = performance.now();
  try {
    loaded = await loadActiveScope({ ...request, requestedAt });
  } catch {
    const scopeLoadMs = Math.max(0, performance.now() - scopeLoadStarted);
    const receipt = await recordAutomaticReceipt({
      runtimeRoot: request.runtimeRoot,
      callerKind: "user_prompt",
      callerIdentity: `session:${request.sessionId}`,
      normalizedQuery: normalizedPrompt,
      projectId: request.projectId,
      epochId: epoch.epochId,
      items: [],
      renderedTokenCount: 0,
      budgetTier: "normal",
      semanticStage: "not_applicable",
      emptyReason: "index_unavailable",
      latencyMs: Math.max(0, performance.now() - started),
      timingStartedAt: started,
      preReceiptTimings: {
        epochLoadMs,
        scopeLoadMs,
        embeddingMs: 0,
        vectorScanMs: 0,
        rankingAndRelationshipMs: 0
      },
      requestedAt,
      ...(request.eventId === undefined ? {} : { eventId: request.eventId }),
      ...(request.foregroundControl === undefined
        ? {}
        : { foregroundControl: request.foregroundControl })
    });
    return {
      mode: "shadow",
      injected: false,
      kind: "user_prompt",
      text: "",
      items: [],
      renderedTokenCount: 0,
      receiptId: receipt.receiptId,
      receiptCommitMs: receipt.receiptCommitMs,
      epochId: epoch.epochId,
      emptyReason: "index_unavailable",
      semanticStage: "not_applicable"
    };
  }
  const scopeLoadMs = Math.max(0, performance.now() - scopeLoadStarted);
  const { active, memories } = loaded;
  await request.foregroundControl?.checkpoint("prompt_scope_loaded");
  const softTarget = z.number().int().positive().parse(request.policy?.epochSoftTarget ?? 8192);
  const hardLimit = z.number().int().positive().parse(request.policy?.epochHardLimit ?? 12288);
  const postSoft = epoch.tokenTotal >= softTarget;
  const query = [normalizedPrompt, ...request.signals.files, ...request.signals.symbols,
    ...request.signals.errors, ...request.signals.commands].join("\n");
  const semantic = isContinuationOnly(normalizedPrompt)
    ? {
        stage: "lexical_only" as const,
        scores: new Map<string, number>(),
        embeddingMs: 0,
        vectorScanMs: 0
      }
    : await semanticScores({
        active,
        memories,
        query,
        deadlineAt: started + AUTOMATIC_SEMANTIC_DEADLINE_MS,
        ...(request.foregroundControl === undefined
          ? {}
          : { foregroundControl: request.foregroundControl }),
        ...(request.snapshot === undefined ? {} : { snapshot: request.snapshot }),
        ...(request.adapter === undefined ? {} : { adapter: request.adapter })
      });
  await request.foregroundControl?.checkpoint("prompt_semantic_complete");
  const rankingAndRelationshipStarted = performance.now();
  const terms = queryTerms(normalizedPrompt);
  const signalValues = [...request.signals.files, ...request.signals.symbols,
    ...request.signals.errors, ...request.signals.commands].filter((item) => item.length > 0);
  const searchIndex = request.snapshot?.searchIndex ?? buildRetrievalSearchIndex(memories);
  const candidates = await automaticCandidates({
    memories,
    searchIndex,
    terms,
    prompt: normalizedPrompt,
    signals: signalValues,
    semanticScores: semantic.scores,
    ...(request.foregroundControl === undefined
      ? {}
      : { foregroundControl: request.foregroundControl })
  });
  await request.foregroundControl?.checkpoint("prompt_candidate_recall_complete");
  const lexical = candidates.memories.map((memory) => {
    const document = searchIndex.documentsByMemoryId.get(memory.memoryId);
    return {
      memory,
      evidence: document === undefined
        ? EMPTY_TERM_EVIDENCE
        : weightedTermEvidence(
            candidates.rankingTerms,
            candidates.rankingTermWeights,
            candidates.rareRankingTerms,
            document.searchableTerms,
            document.normalizedSearchableText
          )
    };
  })
    .filter((item) => item.evidence.weightedCoverage > 0)
    .sort((left, right) =>
      right.evidence.weightedCoverage - left.evidence.weightedCoverage ||
      right.evidence.matchedWeight - left.evidence.matchedWeight ||
      left.memory.memoryId.localeCompare(right.memory.memoryId)
    );
  const lexicalRank = new Map(lexical.map((item, index) => [item.memory.memoryId, index + 1]));
  const lexicalEvidenceByMemoryId = new Map(
    lexical.map((item) => [item.memory.memoryId, item.evidence] as const)
  );
  const semanticRanking = [...semantic.scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const semanticRank = new Map(semanticRanking.map(([memoryId], index) => [memoryId, index + 1]));
  const secondSemanticScore = semanticRanking[1]?.[1] ?? 0;
  const normalizedSignalValues = signalValues.map((signal) =>
    signal.normalize("NFKC").toLocaleLowerCase("en-US")
  );
  const baseScored: ScoredMemory[] = [];
  for (const [index, memory] of candidates.memories.entries()) {
    if (index > 0 && index % 64 === 0) {
      await request.foregroundControl?.checkpoint("prompt_candidate_scoring");
    }
    const document = searchIndex.documentsByMemoryId.get(memory.memoryId);
    if (document === undefined) continue;
    const directIdentity = candidates.directMemoryIds.has(memory.memoryId);
    const signalMatch = normalizedSignalValues.some((signal) =>
      document.normalizedSearchableText.includes(signal)
    );
    const exactEvidence = weightedTermEvidence(
      candidates.exactTerms,
      candidates.exactTermWeights,
      candidates.rareExactTerms,
      document.searchableTerms,
      document.normalizedSearchableText
    );
    const strongExact = exactEvidence.rareMatch || (
      exactEvidence.matchedCount >= 2 &&
      exactEvidence.weightedCoverage >= AUTOMATIC_STRONG_EXACT_COVERAGE
    );
    const exact = strongExact || signalMatch;
    const applicabilityEvidence = weightedTermEvidence(
      candidates.rankingTerms,
      candidates.rankingTermWeights,
      candidates.rareRankingTerms,
      document.applicabilityTerms,
      document.normalizedApplicabilityText
    );
    const applicability = (
      applicabilityEvidence.matchedCount >= 2 &&
      applicabilityEvidence.weightedCoverage >= AUTOMATIC_STRONG_APPLICABILITY_COVERAGE
    ) || (
      applicabilityEvidence.rareMatch &&
      applicabilityEvidence.weightedCoverage >= AUTOMATIC_RARE_APPLICABILITY_COVERAGE
    );
    const similarity = semantic.scores.get(memory.memoryId) ?? 0;
    const rank = lexicalRank.get(memory.memoryId);
    const lexicalEvidence = lexicalEvidenceByMemoryId.get(memory.memoryId) ?? EMPTY_TERM_EVIDENCE;
    const coverage = lexicalEvidence.weightedCoverage;
    const corroborated = exact || applicability || coverage >= 0.3;
    const standaloneSemantic = semanticRank.get(memory.memoryId) === 1 &&
      similarity >= approvedShadowEmbeddingProfile.semanticOnlyMinimumScore &&
      similarity - secondSemanticScore >=
        approvedShadowEmbeddingProfile.semanticOnlyMinimumTop1Margin;
    let score = directIdentity ? 5 : 0;
    if (exact) score += 4;
    if (standaloneSemantic) score += 4;
    else if (similarity >= 0.82 && corroborated) score += 2;
    else if (similarity >= 0.58 && corroborated) score += 1;
    if (rank !== undefined && rank <= 3 && coverage >= 0.6) score += 2;
    else if (rank !== undefined && rank <= 10 && coverage >= 0.3) score += 1;
    if (signalMatch) score += 1;
    if (applicability) score += 1;
    const band: RelevanceBand = score >= 4 ? "high" : score >= 2 ? "probable" : "weak";
    const primaryAnchor = directIdentity || exact || standaloneSemantic ||
      (similarity >= 0.82 && (applicability || coverage >= 0.3));
    const reasons = [
      ...(directIdentity ? ["memory_identity"] : []),
      ...(exact ? ["exact_metadata"] : []),
      ...(standaloneSemantic ? ["semantic_top1_margin"]
        : similarity >= 0.82 && corroborated ? ["semantic_very_strong_corroborated"]
          : similarity >= 0.58 && corroborated ? ["semantic_corroborated"] : []),
      ...(rank === undefined || coverage < 0.3
        ? []
        : [coverage >= 0.6 ? "lexical_strong" : "lexical_moderate"]),
      ...(signalMatch ? ["session_signal"] : []),
      ...(applicability ? ["applicability"] : [])
    ];
    baseScored.push({ memory, score, band, primaryAnchor, exact, directIdentity, reasons, similarity });
  }
  const boostedMemoryIds = await relationshipBoosts(
    request.runtimeRoot,
    baseScored.filter((item) => item.score >= 4).map((item) => item.memory.memoryId),
    request.snapshot
  );
  const scored = baseScored.map((item) => {
    if (!boostedMemoryIds.has(item.memory.memoryId) || item.score < 2) return item;
    const score = item.score + 1;
    return {
      ...item,
      score,
      reasons: [...item.reasons, "one_hop_relationship"]
    };
  });
  const ranked = scored.filter((item) => item.band !== "weak")
    .filter((item) => !epoch.injectedRevisions.has(`${item.memory.memoryId}:${item.memory.revisionId}`))
    .filter((item) => !postSoft || (
      item.score >= 5 && item.primaryAnchor &&
      (item.memory.authority === "human_authored" || tierFor(item.memory, request.projectId) !== "normal")
    ))
    .sort((left, right) =>
      (left.band === right.band ? 0 : left.band === "high" ? -1 : 1) ||
      right.score - left.score ||
      right.similarity - left.similarity ||
      (left.memory.scope.kind === right.memory.scope.kind ? 0 : left.memory.scope.kind === "project" ? -1 : 1) ||
      left.memory.memoryId.localeCompare(right.memory.memoryId)
    );
  const relevantBeforeRepeat = scored.some((item) => item.band !== "weak");
  const selected: ShadowPackItem[] = [];
  let probableCount = 0;
  if (!isContinuationOnly(normalizedPrompt)) {
    for (const item of ranked) {
      if (selected.length >= (postSoft ? 2 : PROMPT_ITEM_LIMIT)) break;
      if (item.band === "probable" && probableCount >= PROBABLE_ITEM_LIMIT) continue;
      const tier = tierFor(item.memory, request.projectId);
      const representation = representationFor(item.memory, tier, item.band === "high");
      if (representation === undefined || (item.band === "probable" && representation.kind !== "compact")) continue;
      const text = renderItem(item.memory, representation.kind, representation.text);
      const candidate: ShadowPackItem = {
        memoryId: item.memory.memoryId,
        memoryRef: item.memory.memoryRef,
        revisionId: item.memory.revisionId,
        scope: item.memory.scope,
        authority: item.memory.authority,
        representationKind: representation.kind,
        relevanceBand: item.band,
        priorityTier: tier,
        score: item.score,
        reasons: item.reasons,
        text,
        renderedTokenCount: tokenizer.encode(text).length
      };
      const trial = renderPack(
        [...selected, candidate],
        selected.length === 0 && item.band === "probable" ? "probable" : "relevant",
        includeMemoryLegend
      );
      if (trial.renderedTokenCount > PROMPT_HARD_LIMIT ||
        epoch.tokenTotal + trial.renderedTokenCount > hardLimit) continue;
      selected.push(candidate);
      if (item.band === "probable") probableCount += 1;
    }
  }
  if (!postSoft) {
    for (let index = 0; index < selected.length; index += 1) {
      const selectedItem = selected[index];
      if (selectedItem === undefined || selectedItem.relevanceBand !== "high") continue;
      const rankedItem = ranked.find((item) => item.memory.memoryId === selectedItem.memoryId);
      if (
        rankedItem === undefined ||
        !rankedItem.memory.standardValidated ||
        rankedItem.memory.standardTokenCount > 192 ||
        (!rankedItem.exact && !rankedItem.directIdentity)
      ) continue;
      const text = renderItem(rankedItem.memory, "standard", rankedItem.memory.standardText);
      const upgraded: ShadowPackItem = {
        ...selectedItem,
        representationKind: "standard",
        text,
        renderedTokenCount: tokenizer.encode(text).length
      };
      const trialItems = selected.map((item, itemIndex) => itemIndex === index ? upgraded : item);
      const limit = rankedItem.directIdentity ? PROMPT_HARD_LIMIT : PROMPT_TARGET_LIMIT;
      if (renderPack(trialItems, "relevant", includeMemoryLegend).renderedTokenCount <= limit) {
        selected[index] = upgraded;
      }
    }
  }
  const rendered = renderPack(
    selected,
    selected.length > 0 && selected.every((item) => item.relevanceBand === "probable")
      ? "probable"
      : "relevant",
    includeMemoryLegend
  );
  const selectedIds = new Set(selected.map((item) => item.memoryId));
  const omittedItems = scored.filter((item) => !selectedIds.has(item.memory.memoryId)).map((item) => ({
    memoryId: item.memory.memoryId,
    revisionId: item.memory.revisionId,
    relevanceBand: item.band,
    score: item.score,
    reasons: item.reasons,
    omissionReason: item.band === "weak"
      ? "weak_relevance"
      : epoch.injectedRevisions.has(`${item.memory.memoryId}:${item.memory.revisionId}`)
        ? "already_present"
        : postSoft && !(item.score >= 5 && item.primaryAnchor &&
          (item.memory.authority === "human_authored" || tierFor(item.memory, request.projectId) !== "normal"))
          ? "post_soft_ineligible"
          : "budget_or_item_limit"
  }));
  const emptyReason = selected.length > 0
    ? undefined
    : isContinuationOnly(normalizedPrompt)
      ? "continuation_only"
      : epoch.tokenTotal >= hardLimit
        ? "hard_limit_blocked"
      : relevantBeforeRepeat && epoch.injectedRevisions.size > 0
        ? "already_present"
        : postSoft ? "soft_target_restricted" : "no_relevant_memory";
  await request.foregroundControl?.checkpoint("before_prompt_receipt");
  const receipt = await recordAutomaticReceipt({
    runtimeRoot: request.runtimeRoot,
    callerKind: "user_prompt",
    callerIdentity: `session:${request.sessionId}`,
    normalizedQuery: query,
    projectId: request.projectId,
    indexRevisionId: z.string().parse(active.index_revision_id),
    epochId: epoch.epochId,
    items: selected,
    omittedItems,
    renderedTokenCount: rendered.renderedTokenCount,
    ...(includeMemoryLegend ? { memoryLegendVersion: MEMORY_LEGEND_VERSION } : {}),
    budgetTier: postSoft ? "post_soft" : "normal",
    semanticStage: semantic.stage,
    rowsExamined: memories.length,
    terminalStopReason: semantic.stage === "lexical_only"
      ? "semantic_unavailable_or_deadline"
      : "candidate_ranking_complete",
    ...(emptyReason === undefined ? {} : { emptyReason }),
    softTargetRestricted: postSoft,
    hardLimitBlocked: epoch.tokenTotal >= hardLimit,
    latencyMs: Math.max(0, performance.now() - started),
    timingStartedAt: started,
    preReceiptTimings: {
      epochLoadMs,
      scopeLoadMs,
      embeddingMs: semantic.embeddingMs,
      vectorScanMs: semantic.vectorScanMs,
      rankingAndRelationshipMs: Math.max(0, performance.now() - rankingAndRelationshipStarted)
    },
    requestedAt,
    ...(request.eventId === undefined ? {} : { eventId: request.eventId }),
    ...(request.foregroundControl === undefined
      ? {}
      : { foregroundControl: request.foregroundControl })
  });
  return {
    mode: "shadow",
    injected: false,
    kind: "user_prompt",
    text: rendered.text,
    items: selected,
    renderedTokenCount: rendered.renderedTokenCount,
    receiptId: receipt.receiptId,
    receiptCommitMs: receipt.receiptCommitMs,
    epochId: epoch.epochId,
    ...(emptyReason === undefined ? {} : { emptyReason }),
    semanticStage: semantic.stage
  };
}

function failOpenPack(
  kind: "session_start" | "user_prompt",
  reason: "runtime_unavailable"
): ShadowPack {
  return {
    mode: "shadow",
    injected: false,
    kind,
    text: "",
    items: [],
    renderedTokenCount: 0,
    receiptId: `msreceipt_unrecorded_${randomUUID()}`,
    receiptCommitMs: 0,
    epochId: `msepoch_unrecorded_${randomUUID()}`,
    emptyReason: reason,
    semanticStage: "not_applicable"
  };
}

export async function prepareSessionStartShadowPack(
  request: SessionStartShadowPackRequest
): Promise<ShadowPack> {
  try {
    return await prepareSessionStartShadowPackCore(request);
  } catch (error) {
    if (error instanceof ForegroundExecutionAborted) throw error;
    return failOpenPack("session_start", "runtime_unavailable");
  }
}

export async function prepareUserPromptShadowPack(
  request: UserPromptShadowPackRequest
): Promise<ShadowPack> {
  try {
    return await prepareUserPromptShadowPackCore(request);
  } catch (error) {
    if (error instanceof ForegroundExecutionAborted) throw error;
    return failOpenPack("user_prompt", "runtime_unavailable");
  }
}

export async function inspectRetrievalReceipt(
  runtimeRoot: string,
  receiptId: string
): Promise<{
  readonly receiptId: string;
  readonly budgetTier: string;
  readonly renderedTokenCount: number;
  readonly automaticEpochTotal?: number;
  readonly softTargetRestricted: boolean;
  readonly hardLimitBlocked: boolean;
  readonly rowsExamined: number;
  readonly bucketPageCount: number;
  readonly terminalStopReason?: string;
  readonly omittedItemCount: number;
  readonly omissionDetailsTruncated: boolean;
  readonly timings?: RetrievalStageTimings;
  readonly selectedMemoryIds: readonly string[];
  readonly omittedMemoryIds: readonly string[];
} | undefined> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const receipt = database.prepare(
      `SELECT receipt_id, budget_tier, rendered_token_count,
              automatic_epoch_total, soft_target_restricted, hard_limit_blocked,
              rows_examined, bucket_page_count, terminal_stop_reason
              , omitted_item_count, omission_details_truncated, timing_json
       FROM retrieval_receipts WHERE receipt_id = ?`
    ).get(receiptId);
    if (receipt === undefined) return undefined;
    const items = database.prepare(
      `SELECT memory_id, outcome FROM retrieval_receipt_items
       WHERE receipt_id = ? ORDER BY rank_ordinal, memory_id`
    ).all(receiptId);
    return {
      receiptId: z.string().parse(receipt.receipt_id),
      budgetTier: z.string().parse(receipt.budget_tier),
      renderedTokenCount: z.number().int().nonnegative().parse(receipt.rendered_token_count),
      ...(typeof receipt.automatic_epoch_total === "number"
        ? { automaticEpochTotal: receipt.automatic_epoch_total }
        : {}),
      softTargetRestricted: receipt.soft_target_restricted === 1,
      hardLimitBlocked: receipt.hard_limit_blocked === 1,
      rowsExamined: z.number().int().nonnegative().parse(receipt.rows_examined),
      bucketPageCount: z.number().int().nonnegative().parse(receipt.bucket_page_count),
      ...(typeof receipt.terminal_stop_reason === "string"
        ? { terminalStopReason: receipt.terminal_stop_reason }
        : {}),
      omittedItemCount: z.number().int().nonnegative().parse(receipt.omitted_item_count),
      omissionDetailsTruncated: receipt.omission_details_truncated === 1,
      ...(() => {
        const parsed = retrievalStageTimingsSchema.safeParse(
          JSON.parse(z.string().parse(receipt.timing_json))
        );
        return parsed.success ? { timings: parsed.data } : {};
      })(),
      selectedMemoryIds: items.flatMap((item) =>
        item.outcome === "selected" ? [z.string().parse(item.memory_id)] : []
      ),
      omittedMemoryIds: items.flatMap((item) =>
        item.outcome === "omitted" ? [z.string().parse(item.memory_id)] : []
      )
    };
  } finally {
    database.close();
  }
}
