import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getEncoding } from "js-tiktoken";
import { z } from "zod";

import { openRuntimeDatabase } from "../runtime/database.js";
import type { EmbeddingAdapter } from "./index.js";
import { approvedShadowEmbeddingProfile } from "./shadow-profile.js";

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

type PriorityTier = "critical" | "strong" | "normal";
type RelevanceBand = "high" | "probable" | "weak";
type RepresentationKind = "compact" | "standard" | "identity";

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

interface IndexedMemory {
  readonly indexRevisionId: string;
  readonly memoryId: string;
  readonly revisionId: string;
  readonly scope: { readonly kind: "global" } | { readonly kind: "project"; readonly projectId: string };
  readonly authority: "human_authored" | "agent_derived";
  readonly category: string;
  readonly basePriorityTier: PriorityTier;
  readonly sessionOrderKey: string;
  readonly importanceTags: readonly string[];
  readonly startup: "auto" | "always" | "never";
  readonly applicabilitySummary: string;
  readonly applicabilityConditions: readonly string[];
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly validityState: "valid" | "review_due";
  readonly identityLabel?: string;
  readonly identityValidated: boolean;
  readonly identityTokenCount: number;
  readonly compactText: string;
  readonly compactValidated: boolean;
  readonly compactTokenCount: number;
  readonly standardText: string;
  readonly standardValidated: boolean;
  readonly standardTokenCount: number;
  readonly searchableText: string;
  readonly vectorOrdinal: number;
}

export interface ShadowPackItem {
  readonly memoryId: string;
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
  readonly epochId: string;
  readonly emptyReason?: string;
  readonly semanticStage: "complete" | "lexical_only" | "not_applicable";
}

function rowToMemory(row: Record<string, unknown>): IndexedMemory {
  return {
    indexRevisionId: z.string().parse(row.index_revision_id),
    memoryId: z.string().parse(row.memory_id),
    revisionId: z.string().parse(row.revision_id),
    scope: row.scope_kind === "global"
      ? { kind: "global" }
      : { kind: "project", projectId: z.string().parse(row.project_id) },
    authority: z.enum(["human_authored", "agent_derived"]).parse(row.authority),
    category: z.string().parse(row.category),
    basePriorityTier: z.enum(["critical", "strong", "normal"]).parse(row.base_priority_tier),
    sessionOrderKey: z.string().min(1).parse(row.session_order_key),
    importanceTags: z.array(z.string()).parse(JSON.parse(z.string().parse(row.importance_tags_json))),
    startup: z.enum(["auto", "always", "never"]).parse(row.startup),
    applicabilitySummary: z.string().parse(row.applicability_summary),
    applicabilityConditions: z.array(z.string()).parse(
      JSON.parse(z.string().parse(row.applicability_conditions_json))
    ),
    ...(typeof row.valid_from === "string" ? { validFrom: row.valid_from } : {}),
    ...(typeof row.valid_until === "string" ? { validUntil: row.valid_until } : {}),
    validityState: z.enum(["valid", "review_due"]).parse(row.validity_state),
    ...(typeof row.identity_label === "string" ? { identityLabel: row.identity_label } : {}),
    identityValidated: row.identity_validated === 1,
    identityTokenCount: z.number().int().nonnegative().parse(row.identity_token_count),
    compactText: z.string().parse(row.compact_text),
    compactValidated: row.compact_validated === 1,
    compactTokenCount: z.number().int().nonnegative().parse(row.compact_token_count),
    standardText: z.string().parse(row.standard_text),
    standardValidated: row.standard_validated === 1,
    standardTokenCount: z.number().int().nonnegative().parse(row.standard_token_count),
    searchableText: z.string().parse(row.searchable_text),
    vectorOrdinal: z.number().int().nonnegative().parse(row.vector_ordinal)
  };
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
}): Promise<SessionPageStats> {
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
            bucket.queue.push(...pageRows.map((row) => rowToMemory(row)).filter(eligibleForAutomaticRecall));
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
  return scope.kind === "global" ? "G" : `P:${scope.projectId}`;
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
      text: `${memory.identityLabel}; body is incomplete; read ${memory.memoryId} by identity before reliance.`
    };
  }
  return undefined;
}

function renderItem(
  memory: IndexedMemory,
  representationKind: RepresentationKind,
  text: string
): string {
  return `[M:${memory.memoryId} S:${scopeLabel(memory.scope)} A:${authorityLabel(memory.authority)} R:${representationKind}] ${text}`;
}

const standardHeader =
  "<memstore-context>historical long-term memory. Apply only when relevant; current explicit instructions and verified workspace state take precedence.</memstore-context>";
const probableHeader =
  "<memstore-context>possibly relevant historical long-term memory. Verify applicability and read by identity when more detail is needed.</memstore-context>";

function renderPack(items: readonly ShadowPackItem[], probableOnly = false): {
  readonly text: string;
  readonly renderedTokenCount: number;
} {
  if (items.length === 0) return { text: "", renderedTokenCount: 0 };
  const text = [probableOnly ? probableHeader : standardHeader, ...items.map((item) => item.text)].join("\n");
  return { text, renderedTokenCount: tokenizer.encode(text).length };
}

async function loadActiveScope(request: {
  readonly runtimeRoot: string;
  readonly projectId: string;
  readonly requestedAt: string;
}): Promise<{
  readonly active: Record<string, unknown>;
  readonly memories: readonly IndexedMemory[];
}> {
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
      `SELECT * FROM retrieval_documents
       WHERE index_revision_id = ? AND
         (scope_kind = 'global' OR (scope_kind = 'project' AND project_id = ?))
       ORDER BY memory_id`
    ).all(indexRevisionId, request.projectId);
    const memories = rows.map((row) => rowToMemory(row)).filter((memory) =>
      eligibleForAutomaticRecall(memory) &&
      (memory.validFrom === undefined || memory.validFrom <= request.requestedAt) &&
      (memory.validUntil === undefined || memory.validUntil >= request.requestedAt)
    );
    return { active, memories };
  } finally {
    database.close();
  }
}

async function loadActiveIndex(runtimeRoot: string): Promise<Record<string, unknown>> {
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

async function startEpoch(request: {
  readonly runtimeRoot: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly requestedAt: string;
}): Promise<string> {
  const epochId = `msepoch_${randomUUID()}`;
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    database.prepare(
      "UPDATE context_epochs SET state = 'closed', closed_at = ? WHERE session_id = ? AND state = 'active'"
    ).run(request.requestedAt, request.sessionId);
    database.prepare(
      `INSERT INTO context_epochs(
         epoch_id, session_id, project_id, state, automatic_token_total, started_at
       ) VALUES (?, ?, ?, 'active', 0, ?)`
    ).run(epochId, request.sessionId, request.projectId, request.requestedAt);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  return epochId;
}

async function loadEpoch(runtimeRoot: string, sessionId: string): Promise<{
  readonly epochId: string;
  readonly tokenTotal: number;
  readonly injectedRevisions: ReadonlySet<string>;
}> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const row = database.prepare(
      "SELECT epoch_id, automatic_token_total FROM context_epochs WHERE session_id = ? AND state = 'active'"
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
}): Promise<{ readonly receiptId: string; readonly epochTotal: number }> {
  const receiptId = `msreceipt_${randomUUID()}`;
  const receiptStarted = performance.now();
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    const epoch = database.prepare(
      "SELECT automatic_token_total FROM context_epochs WHERE epoch_id = ? AND state = 'active'"
    ).get(request.epochId);
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
    database.prepare(
      "UPDATE context_epochs SET automatic_token_total = ? WHERE epoch_id = ? AND state = 'active'"
    ).run(epochTotal, request.epochId);
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
    database.exec("COMMIT");
    return { receiptId, epochTotal };
  } catch (error) {
    database.exec("ROLLBACK");
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
}

async function prepareSessionStartShadowPackCore(
  request: SessionStartShadowPackRequest
): Promise<ShadowPack> {
  const started = performance.now();
  const requestedAt = z.iso.datetime().parse(request.requestedAt);
  const epochId = await startEpoch({ ...request, requestedAt });
  let active: Record<string, unknown>;
  try {
    active = await loadActiveIndex(request.runtimeRoot);
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
      requestedAt
    });
    return {
      mode: "shadow",
      injected: false,
      kind: "session_start",
      text: "",
      items: [],
      renderedTokenCount: 0,
      receiptId: receipt.receiptId,
      epochId,
      emptyReason: "index_unavailable",
      semanticStage: "not_applicable"
    };
  }
  const selected: ShadowPackItem[] = [];
  const examined: IndexedMemory[] = [];
  let identityCount = 0;
  let alwaysTokens = 0;
  const trySelect = (memory: IndexedMemory, always: boolean): boolean => {
    examined.push(memory);
    if (selected.length >= SESSION_ITEM_LIMIT) return true;
    const tier = tierFor(memory, request.projectId);
    const representation = representationFor(memory, tier, always || tier !== "normal");
    if (representation === undefined) return false;
    if (representation.kind === "identity" && identityCount >= SESSION_IDENTITY_LIMIT) return false;
    const text = renderItem(memory, representation.kind, representation.text);
    const itemTokens = tokenizer.encode(text).length;
    if (always && alwaysTokens + itemTokens > ALWAYS_TOKEN_LIMIT) return false;
    const trial = renderPack([...selected, {
      memoryId: memory.memoryId,
      revisionId: memory.revisionId,
      scope: memory.scope,
      authority: memory.authority,
      representationKind: representation.kind,
      priorityTier: tier,
      score: 0,
      reasons: [always ? "startup_always" : "startup_ranked"],
      text,
      renderedTokenCount: itemTokens
    }]);
    if (trial.renderedTokenCount > SESSION_TOKEN_LIMIT) return false;
    selected.push({
      memoryId: memory.memoryId,
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
    visit: (memory) => trySelect(memory, true)
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
        visit: (memory) => trySelect(memory, false)
      });
  const rendered = renderPack(selected);
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
    budgetTier: "session_start_1200",
    semanticStage: "not_applicable",
    rowsExamined: alwaysStats.rowsExamined + dynamicStats.rowsExamined,
    bucketPageCount: alwaysStats.bucketPageCount + dynamicStats.bucketPageCount,
    terminalStopReason: dynamicStats.terminalStopReason,
    ...(selected.length === 0 ? { emptyReason: "no_eligible_memory" } : {}),
    latencyMs: Math.max(0, performance.now() - started),
    requestedAt
  });
  return {
    mode: "shadow",
    injected: false,
    kind: "session_start",
    text: rendered.text,
    items: selected,
    renderedTokenCount: rendered.renderedTokenCount,
    receiptId: receipt.receiptId,
    epochId,
    ...(selected.length === 0 ? { emptyReason: "no_eligible_memory" } : {}),
    semanticStage: "not_applicable"
  };
}

function queryTerms(text: string): readonly string[] {
  return [...new Set(
    (text.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_./:-]+/gu) ?? [])
      .filter((term) => term.length > 1)
  )];
}

function lexicalCoverage(query: readonly string[], text: string): number {
  if (query.length === 0) return 0;
  const normalized = text.normalize("NFKC").toLocaleLowerCase("en-US");
  return query.filter((term) => normalized.includes(term)).length / query.length;
}

function exactDistinctiveMatch(prompt: string, memory: IndexedMemory): boolean {
  const candidates = prompt.match(/[A-Za-z][A-Za-z0-9_.:/-]{3,}|[A-Z]{2,}[0-9-]*/gu) ?? [];
  const text = memory.searchableText.toLocaleLowerCase("en-US");
  return candidates.some((candidate) => text.includes(candidate.toLocaleLowerCase("en-US")));
}

function normalizeVector(vector: readonly number[]): readonly number[] | undefined {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude === 0 || vector.some((value) => !Number.isFinite(value))
    ? undefined
    : vector.map((value) => value / magnitude);
}

function dot(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

async function semanticScores(request: {
  readonly active: Record<string, unknown>;
  readonly memories: readonly IndexedMemory[];
  readonly query: string;
  readonly adapter?: EmbeddingAdapter;
  readonly deadlineAt: number;
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
  const bytes = await readFile(`${String(request.active.directory_path)}/vectors.f32`);
  const values = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const dimensions = z.number().int().positive().parse(request.active.dimensions);
  return {
    stage: "complete",
    embeddingMs,
    vectorScanMs: Math.max(0, performance.now() - vectorScanStarted),
    scores: new Map(request.memories.map((memory) => {
      const start = memory.vectorOrdinal * dimensions;
      return [memory.memoryId, dot(normalized, Array.from(values.subarray(start, start + dimensions)))] as const;
    }))
  };
}

function isContinuationOnly(prompt: string): boolean {
  const normalized = prompt.trim().toLocaleLowerCase("en-US");
  return normalized.length <= 12 && /^(ok|okay|yes|sure|continue|好的?|可以|同意|继续|行了?|没问题)[。.!！]?$/u.test(normalized);
}

async function relationshipBoosts(
  runtimeRoot: string,
  seedMemoryIds: readonly string[]
): Promise<ReadonlySet<string>> {
  if (seedMemoryIds.length === 0) return new Set();
  const seeds = new Set(seedMemoryIds);
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
      requestedAt
    });
    return {
      mode: "shadow",
      injected: false,
      kind: "user_prompt",
      text: "",
      items: [],
      renderedTokenCount: 0,
      receiptId: receipt.receiptId,
      epochId: epoch.epochId,
      emptyReason: "index_unavailable",
      semanticStage: "not_applicable"
    };
  }
  const scopeLoadMs = Math.max(0, performance.now() - scopeLoadStarted);
  const { active, memories } = loaded;
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
        ...(request.adapter === undefined ? {} : { adapter: request.adapter })
      });
  const rankingAndRelationshipStarted = performance.now();
  const terms = queryTerms(normalizedPrompt);
  const lexical = memories.map((memory) => ({ memory, coverage: lexicalCoverage(terms, memory.searchableText) }))
    .filter((item) => item.coverage > 0)
    .sort((left, right) => right.coverage - left.coverage || left.memory.memoryId.localeCompare(right.memory.memoryId));
  const lexicalRank = new Map(lexical.map((item, index) => [item.memory.memoryId, index + 1]));
  const semanticRanking = [...semantic.scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const semanticRank = new Map(semanticRanking.map(([memoryId], index) => [memoryId, index + 1]));
  const secondSemanticScore = semanticRanking[1]?.[1] ?? 0;
  const signalValues = [...request.signals.files, ...request.signals.symbols,
    ...request.signals.errors, ...request.signals.commands].filter((item) => item.length > 0);
  const baseScored = memories.map((memory) => {
    const directIdentity = normalizedPrompt.includes(memory.memoryId);
    const exact = exactDistinctiveMatch(normalizedPrompt, memory) || signalValues.some((signal) =>
      memory.searchableText.toLocaleLowerCase("en-US").includes(signal.toLocaleLowerCase("en-US"))
    );
    const signalMatch = signalValues.some((signal) =>
      memory.searchableText.toLocaleLowerCase("en-US").includes(signal.toLocaleLowerCase("en-US"))
    );
    const applicability = terms.some((term) =>
      memory.applicabilitySummary.toLocaleLowerCase("en-US").includes(term) ||
      memory.applicabilityConditions.some((condition) => condition.toLocaleLowerCase("en-US").includes(term))
    );
    const similarity = semantic.scores.get(memory.memoryId) ?? 0;
    const rank = lexicalRank.get(memory.memoryId);
    const coverage = lexical.find((item) => item.memory.memoryId === memory.memoryId)?.coverage ?? 0;
    const corroborated = exact || signalMatch || applicability || coverage >= 0.3;
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
      (similarity >= 0.82 && (applicability || signalMatch || coverage >= 0.3));
    const reasons = [
      ...(directIdentity ? ["memory_identity"] : []),
      ...(exact ? ["exact_metadata"] : []),
      ...(standaloneSemantic ? ["semantic_top1_margin"]
        : similarity >= 0.82 && corroborated ? ["semantic_very_strong_corroborated"]
          : similarity >= 0.58 && corroborated ? ["semantic_corroborated"] : []),
      ...(rank === undefined ? [] : [coverage >= 0.6 ? "lexical_strong" : "lexical_moderate"]),
      ...(signalMatch ? ["session_signal"] : []),
      ...(applicability ? ["applicability"] : [])
    ];
    return { memory, score, band, primaryAnchor, exact, directIdentity, reasons, similarity };
  });
  const boostedMemoryIds = await relationshipBoosts(
    request.runtimeRoot,
    baseScored.filter((item) => item.score >= 4).map((item) => item.memory.memoryId)
  );
  const scored = baseScored.map((item) => {
    if (!boostedMemoryIds.has(item.memory.memoryId) || item.score < 2) return item;
    const score = item.score + 1;
    return {
      ...item,
      score,
      band: (score >= 4 ? "high" : score >= 2 ? "probable" : "weak") as RelevanceBand,
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
      const trial = renderPack([...selected, candidate],
        selected.length === 0 && item.band === "probable");
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
      if (renderPack(trialItems).renderedTokenCount <= limit) selected[index] = upgraded;
    }
  }
  const rendered = renderPack(selected,
    selected.length > 0 && selected.every((item) => item.relevanceBand === "probable"));
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
    requestedAt
  });
  return {
    mode: "shadow",
    injected: false,
    kind: "user_prompt",
    text: rendered.text,
    items: selected,
    renderedTokenCount: rendered.renderedTokenCount,
    receiptId: receipt.receiptId,
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
  } catch {
    return failOpenPack("session_start", "runtime_unavailable");
  }
}

export async function prepareUserPromptShadowPack(
  request: UserPromptShadowPackRequest
): Promise<ShadowPack> {
  try {
    return await prepareUserPromptShadowPackCore(request);
  } catch {
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
