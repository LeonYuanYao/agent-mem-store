import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { loadRetentionAssessmentCache, matchRetentionAssessment } from "./retention-cache.js";
import { retentionPriority } from "./retention-value.js";
import { basePriorityTier } from "../memories/priority.js";

import { openRuntimeDatabase, openRuntimeDatabaseReadOnly } from "../runtime/database.js";
import { archiveLifecycleDetails, loadArchiveRetentionMonths } from "../lifecycle/archive-retention.js";
import { inspectStandaloneCanonicalFile, readCanonicalMemory, writeCanonicalMemory } from "../vault/index.js";
import { loadInjectionReceiptRetentionDays } from "../retrieval/receipt-retention.js";
import { loadConfiguration } from "../configuration/index.js";
import { corpusRetentionPolicySchema as policySchema, defaultCorpusRetentionPolicy, type CorpusRetentionPolicy, type CorpusRetentionConfiguration } from "../configuration/corpus-retention.js";
export { defaultCorpusRetentionPolicy, type CorpusRetentionPolicy } from "../configuration/corpus-retention.js";

export async function loadCorpusRetentionConfiguration(request: RetentionPaths): Promise<CorpusRetentionConfiguration> {
  try {
    const configuration = await loadConfiguration(request);
    if (configuration.mode !== "read_write" || configuration.recovery !== undefined) {
      throw new Error("Corpus retention requires current valid configuration.");
    }
    return configuration.policy.corpusRetention;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { mode: "off", policy: defaultCorpusRetentionPolicy };
    }
    throw error;
  }
}

interface InventoryMemory {
  readonly memoryId: string;
  readonly revisionId: string;
  readonly contentIdentity: string;
  readonly space: string;
  readonly protected: boolean;
  readonly lastActivityAt: string;
  readonly priority: number;
  readonly retentionRank: number;
}

export interface CorpusRetentionPreview {
  readonly schemaVersion: 1;
  readonly dryRun: true;
  readonly policy: CorpusRetentionPolicy;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly digest: string;
  readonly activeAgentCount: number;
  readonly activeCount?: number | undefined;
  readonly protectedCount: number;
  readonly proposedArchiveCount: number;
  readonly unresolvedExcess: number;
  readonly pressure: { readonly projectSpaces: readonly string[]; readonly aggregate: boolean };
  readonly items: readonly {
    readonly memoryId: string;
    readonly revisionId: string;
    readonly contentIdentity: string;
    readonly space: string;
    readonly reason: "capacity_retention";
  }[];
}

interface RetentionPaths {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
}

// v1 conservatively uses every selected receipt and every revision as activity.
// Missing/expired receipts are not proof of non-use; the minimum window is 14 days.
async function inventory(request: RetentionPaths & { readonly memoryId?: string }): Promise<readonly InventoryMemory[]> {
  const database = await openRuntimeDatabaseReadOnly(request.runtimeRoot, { minimumSchemaVersion: 61 });
  const catalogSchema = z.object({
    memory_id: z.string(), current_revision_id: z.string(),
    canonical_path: z.string(), content_identity: z.string()
  });
  let catalog: z.infer<typeof catalogSchema>[];
  const protectedIds = new Set<string>();
  const activity = new Map<string, string>();
  try {
    database.exec("BEGIN");
    catalog = z.array(catalogSchema).parse(database.prepare(
      "SELECT memory_id, current_revision_id, canonical_path, content_identity FROM memory_catalog WHERE lifecycle='active' AND authority='agent_derived' AND (? IS NULL OR memory_id=?) ORDER BY memory_id"
    ).all(request.memoryId ?? null, request.memoryId ?? null));
    for (const row of database.prepare(
      `SELECT promoted_memory_id AS id FROM memory_candidates WHERE pinned=1
       UNION SELECT target_memory_id AS id FROM governance_review_suggestions WHERE state='open'
       UNION SELECT c.promoted_memory_id AS id FROM verification_requests v
         JOIN memory_candidates c USING(candidate_id) WHERE v.state='open'`
    ).all()) if (typeof row.id === "string") protectedIds.add(row.id);
    for (const row of database.prepare(
      "SELECT proposed_memory_id, conflicting_memory_ids_json FROM human_memory_conflicts WHERE state='open'"
    ).all()) {
      if (typeof row.proposed_memory_id === "string") protectedIds.add(row.proposed_memory_id);
      const ids = z.array(z.string()).parse(JSON.parse(z.string().parse(row.conflicting_memory_ids_json)));
      for (const id of ids) protectedIds.add(id);
    }
    for (const row of database.prepare(
      `SELECT i.memory_id, MAX(r.created_at) AS selected_at FROM retrieval_receipt_items i
       JOIN retrieval_receipts r USING(receipt_id) WHERE i.outcome='selected'
         AND (? IS NULL OR i.memory_id=?) GROUP BY i.memory_id`
    ).all(request.memoryId ?? null, request.memoryId ?? null)) activity.set(z.string().parse(row.memory_id), z.iso.datetime().parse(row.selected_at));
    database.exec("COMMIT");
  } finally {
    database.close();
  }
  const risk = new Set(["safety_data_integrity", "failure_recovery_hazard", "preference_constraint"]);
  const result: InventoryMemory[] = [];
  const retentionCache = await loadRetentionAssessmentCache(request.runtimeRoot);
  for (const row of catalog) {
    const inspected = await inspectStandaloneCanonicalFile(row.canonical_path);
    const memory = inspected.memory;
    if (memory.memoryId !== row.memory_id || memory.revisionId !== row.current_revision_id || memory.contentIdentity !== row.content_identity || memory.lifecycle !== "active" || memory.authority !== "agent_derived") {
      throw new Error("Corpus inventory changed; reconcile and preview again.");
    }
    result.push({
      memoryId: memory.memoryId, revisionId: memory.revisionId, contentIdentity: row.content_identity,
      space: memory.scope.kind === "global" ? "global" : `project:${memory.scope.projectId}`,
      protected: protectedIds.has(memory.memoryId) || memory.lifecycleDetails.pinned === true ||
        memory.lifecycleDetails.retainForever === true || memory.startup === "always" || risk.has(memory.primaryCategory) || memory.sensitivity !== "normal",
      lastActivityAt: [memory.createdAt, memory.revisedAt, activity.get(memory.memoryId) ?? ""].sort().at(-1) ?? memory.revisedAt,
      priority: ({ critical: 3, strong: 2, normal: 1 })[basePriorityTier(memory)] * 100 + Math.min(memory.importanceTags.length, 5),
      retentionRank: ({ low: 0, normal: 1, high: 2 })[retentionPriority(matchRetentionAssessment(retentionCache, memory)?.assessment)]
    });
  }
  return result;
}

const applyResultSchema = z.object({ completed: z.boolean(), archivedMemoryIds: z.array(z.string()), skippedMemoryIds: z.array(z.string()) });

function policyIdentity(policy: CorpusRetentionPolicy): string {
  return createHash("sha256").update(JSON.stringify(policySchema.parse(policy))).digest("hex");
}

async function recordPressure(request: RetentionPaths & { readonly preview: CorpusRetentionPreview }): Promise<void> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  const identity = policyIdentity(request.preview.policy);
  const keys = new Set([...request.preview.pressure.projectSpaces, ...(request.preview.pressure.aggregate ? ["aggregate"] : [])]);
  try {
    database.exec("BEGIN IMMEDIATE");
    for (const row of database.prepare("SELECT space_key FROM corpus_retention_pressure WHERE policy_identity=?").all(identity)) {
      const key = z.string().parse(row.space_key);
      if (!keys.has(key)) database.prepare("DELETE FROM corpus_retention_pressure WHERE policy_identity=? AND space_key=?").run(identity, key);
    }
    for (const key of keys) database.prepare("INSERT OR IGNORE INTO corpus_retention_pressure(policy_identity, space_key, started_at) VALUES (?, ?, ?)")
      .run(identity, key, request.preview.observedAt);
    database.exec("COMMIT");
  } finally { database.close(); }
}

export async function applyCorpusRetention(request: RetentionPaths & {
  readonly preview: CorpusRetentionPreview;
  readonly changedAt: string;
  readonly authorizeCapacityArchive: boolean;
  readonly foregroundPressure?: () => boolean | Promise<boolean>;
}): Promise<z.infer<typeof applyResultSchema>> {
  if (!request.authorizeCapacityArchive) throw new Error("Capacity archival requires explicit policy authorization.");
  const changedAt = z.iso.datetime().parse(request.changedAt);
  let preview: CorpusRetentionPreview;
  try { preview = parseCorpusRetentionPreview(request.preview); }
  catch { throw new Error("Corpus preview is malformed or modified; preview again."); }
  if (Date.parse(changedAt) < Date.parse(preview.observedAt) || Date.parse(changedAt) > Date.parse(preview.expiresAt)) {
    throw new Error("Corpus preview expired or is not yet valid.");
  }
  const source = JSON.stringify(preview);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let recorded: Record<string, unknown> | undefined;
  try {
    recorded = database.prepare("SELECT preview_json, result_json FROM corpus_retention_plans WHERE digest=?").get(preview.digest);
  } finally { database.close(); }
  if (recorded !== undefined && recorded.preview_json !== source) throw new Error("Corpus preview does not match its persisted plan.");
  if (typeof recorded?.result_json === "string") return applyResultSchema.parse(JSON.parse(recorded.result_json));
  if (recorded === undefined) {
    const fresh = await previewCorpusRetention({ ...request, policy: preview.policy, observedAt: preview.observedAt });
    if (JSON.stringify(parseCorpusRetentionPreview(fresh)) !== source) throw new Error("Corpus preview is stale or modified; preview again.");
    const writer = await openRuntimeDatabase(request.runtimeRoot);
    try {
      writer.prepare("INSERT OR IGNORE INTO corpus_retention_plans(digest, preview_json, created_at) VALUES (?, ?, ?)").run(preview.digest, source, changedAt);
    } finally { writer.close(); }
  }
  await recordPressure(request);
  const archivedMemoryIds: string[] = [];
  const skippedMemoryIds: string[] = [];
  const marker = `capacity_retention:${preview.digest}`;
  const months = await loadArchiveRetentionMonths(request);
  const started = performance.now();
  for (const item of preview.items) {
    if (performance.now() - started >= 10_000 || await request.foregroundPressure?.() === true) {
      return { completed: false, archivedMemoryIds, skippedMemoryIds };
    }
    const current = await readCanonicalMemory({ ...request, memoryId: item.memoryId });
    if (current?.memory.lifecycle === "archived" && current.memory.lifecycleDetails.reason === marker) {
      archivedMemoryIds.push(item.memoryId);
      continue;
    }
    const eligible = (await inventory({ ...request, memoryId: item.memoryId }))[0];
    if (current === undefined || eligible === undefined || eligible.protected ||
        eligible.revisionId !== item.revisionId || eligible.contentIdentity !== item.contentIdentity || eligible.space !== item.space ||
        (preview.policy.activeLimit === undefined && Date.parse(eligible.lastActivityAt) >= Date.parse(changedAt) - preview.policy.coldDays * 86_400_000)) {
      skippedMemoryIds.push(item.memoryId);
      continue;
    }
    const counts = await openRuntimeDatabaseReadOnly(request.runtimeRoot);
    let stillNeeded: boolean;
    try {
      const total = z.number().parse(counts.prepare("SELECT COUNT(*) n FROM memory_catalog WHERE lifecycle='active' AND (?=1 OR authority='agent_derived')").get(preview.policy.activeLimit === undefined ? 0 : 1)?.n);
      const local = z.number().parse(counts.prepare("SELECT COUNT(*) n FROM memory_catalog WHERE lifecycle='active' AND authority='agent_derived' AND project_id=?").get(item.space.slice("project:".length))?.n);
      const target = preview.policy.activeLimit === undefined ? preview.policy.aggregateTarget : preview.policy.activeLimit - (preview.policy.activeHeadroom ?? 0);
      stillNeeded = (preview.pressure.aggregate && total > target) ||
        (preview.pressure.projectSpaces.includes(item.space) && local > preview.policy.projectTarget);
    } finally { counts.close(); }
    if (!stillNeeded) { skippedMemoryIds.push(item.memoryId); continue; }
    const revisionId = `msrev_${randomUUID()}`;
    const memory = current.memory;
    await writeCanonicalMemory({
      ...request, actor: "agent", expectedContentIdentity: item.contentIdentity,
      memory: {
        ...memory, revisionId, predecessorRevisionId: memory.revisionId, revisedAt: changedAt,
        lifecycle: "archived", lifecycleDetails: archiveLifecycleDetails({
          previous: memory.lifecycleDetails, archivedAt: changedAt, reason: marker, archiveRetentionMonths: months
        }),
        provenance: [...memory.provenance, marker],
        representations: {
          ...(memory.representations.identity === undefined ? {} : { identity: { ...memory.representations.identity, sourceRevisionId: revisionId } }),
          compact: { ...memory.representations.compact, sourceRevisionId: revisionId },
          standard: { ...memory.representations.standard, sourceRevisionId: revisionId }
        }
      }
    });
    archivedMemoryIds.push(item.memoryId);
  }
  const result = { completed: true, archivedMemoryIds, skippedMemoryIds };
  const writer = await openRuntimeDatabase(request.runtimeRoot);
  try {
    writer.prepare("UPDATE corpus_retention_plans SET completed_at=?, result_json=? WHERE digest=?").run(changedAt, JSON.stringify(result), preview.digest);
  } finally { writer.close(); }
  return result;
}

export async function previewCorpusRetention(request: RetentionPaths & {
  readonly policy?: CorpusRetentionPolicy;
  readonly observedAt: string;
}): Promise<CorpusRetentionPreview> {
  const policy = policySchema.parse(request.policy ?? defaultCorpusRetentionPolicy);
  if (policy.activeLimit === undefined && await loadInjectionReceiptRetentionDays(request) < policy.coldDays) {
    throw new Error("Receipt retention is shorter than the corpus inactivity window.");
  }
  const observedAt = z.iso.datetime().parse(request.observedAt);
  const memories = await inventory(request);
  const counts = new Map<string, number>();
  for (const memory of memories) counts.set(memory.space, (counts.get(memory.space) ?? 0) + 1);
  const reader = await openRuntimeDatabaseReadOnly(request.runtimeRoot, { minimumSchemaVersion: 61 });
  const previousPressure = new Set<string>();
  let activeCount: number;
  try {
    activeCount = z.number().parse(reader.prepare("SELECT COUNT(*) n FROM memory_catalog WHERE lifecycle='active'").get()?.n);
    if (reader.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='corpus_retention_pressure'").get() !== undefined) {
      for (const row of reader.prepare("SELECT space_key FROM corpus_retention_pressure WHERE policy_identity=?").all(policyIdentity(policy))) previousPressure.add(z.string().parse(row.space_key));
    }
  } finally { reader.close(); }
  const pressured = new Set([...counts].filter(([space, count]) => policy.activeLimit === undefined && space !== "global" &&
    (count > policy.projectHighWater || (previousPressure.has(space) && count > policy.projectTarget))).map(([space]) => space));
  const total = policy.activeLimit === undefined ? memories.length : activeCount;
  const target = policy.activeLimit === undefined ? policy.aggregateTarget : policy.activeLimit - (policy.activeHeadroom ?? 0);
  const aggregatePressure = (policy.activeLimit === undefined ? total > policy.aggregateHighWater : total >= policy.activeLimit) ||
    (previousPressure.has("aggregate") && total > target);
  const pressure = { projectSpaces: [...pressured].sort(), aggregate: aggregatePressure };
  const cutoff = Date.parse(observedAt) - policy.coldDays * 86_400_000;
  const eligible = memories.filter((m) => !m.protected && (policy.activeLimit !== undefined || Date.parse(m.lastActivityAt) < cutoff))
    .sort((a, b) => a.retentionRank - b.retentionRank || a.priority - b.priority || a.lastActivityAt.localeCompare(b.lastActivityAt) || a.memoryId.localeCompare(b.memoryId));
  const selected: InventoryMemory[] = [];
  const remaining = new Map(counts);
  const select = (memory: InventoryMemory) => {
    selected.push(memory);
    remaining.set(memory.space, (remaining.get(memory.space) ?? 0) - 1);
  };
  for (const memory of eligible) {
    if (selected.length >= policy.batchSize) break;
    if (pressured.has(memory.space) && (remaining.get(memory.space) ?? 0) > policy.projectTarget) select(memory);
  }
  const selectedIds = new Set(selected.map((m) => m.memoryId));
  for (const memory of eligible) {
    if (selected.length >= policy.batchSize || !aggregatePressure || total - selected.length <= target) break;
    if (!selectedIds.has(memory.memoryId)) select(memory);
  }
  const localExcess = [...pressured].reduce((total, space) => total + Math.max(0, (remaining.get(space) ?? 0) - policy.projectTarget), 0);
  const aggregateExcess = aggregatePressure ? Math.max(0, total - selected.length - target) : 0;
  const items = selected.map((memory) => ({
    memoryId: memory.memoryId, revisionId: memory.revisionId, contentIdentity: memory.contentIdentity,
    space: memory.space, reason: "capacity_retention" as const
  }));
  const expiresAt = new Date(Date.parse(observedAt) + 6 * 3_600_000).toISOString();
  return {
    schemaVersion: 1, dryRun: true, policy, observedAt, expiresAt,
    digest: createHash("sha256").update(JSON.stringify({ policy, observedAt, memories, items, pressure, ...(policy.activeLimit === undefined ? {} : { activeCount }) })).digest("hex"),
    ...(policy.activeLimit === undefined ? {} : { activeCount }),
    activeAgentCount: memories.length, protectedCount: memories.filter((m) => m.protected).length,
    proposedArchiveCount: items.length, unresolvedExcess: Math.max(localExcess, aggregateExcess), items, pressure
  };
}

export async function runScheduledCorpusRetentionPreview(request: RetentionPaths & {
  readonly policy: CorpusRetentionPolicy;
  readonly now: string;
}): Promise<{ readonly state: "waiting" | "deferred" | "preview"; readonly count?: number }> {
  const result = await runScheduledCorpusRetention({ ...request, configuration: { mode: "preview", policy: request.policy } });
  return { ...result, state: result.state === "preview" ? "preview" : result.state === "deferred" ? "deferred" : "waiting" };
}

export async function runScheduledCorpusRetention(request: RetentionPaths & {
  readonly now: string;
  readonly configuration?: CorpusRetentionConfiguration;
  readonly foregroundPressure?: () => boolean | Promise<boolean>;
}): Promise<{ readonly state: "off" | "waiting" | "deferred" | "preview" | "applied"; readonly count?: number }> {
  const now = z.iso.datetime().parse(request.now);
  const configuration = request.configuration ?? await loadCorpusRetentionConfiguration(request);
  if (configuration.mode === "off") return { state: "off" };
  if (await request.foregroundPressure?.() === true) return { state: "waiting" };
  const configurationIdentity = JSON.stringify(configuration);
  const reader = await openRuntimeDatabaseReadOnly(request.runtimeRoot);
  let schedule: Record<string, unknown> | undefined;
  try {
    schedule = reader.prepare("SELECT * FROM corpus_retention_preview_schedule WHERE singleton=1").get();
  } finally { reader.close(); }
  if (typeof schedule?.lease_until === "string" && schedule.lease_until > now) return { state: "waiting" };
  if (schedule?.configuration_identity === configurationIdentity && typeof schedule.next_check_at === "string" && schedule.next_check_at > now) return { state: "waiting" };
  const retryAt = new Date(Date.parse(now) + 5 * 60_000).toISOString();
  const writer = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const claim = writer.prepare(`UPDATE corpus_retention_preview_schedule SET next_check_at=?, lease_until=?, configuration_identity=?
      WHERE singleton=1 AND (lease_until IS NULL OR lease_until<=?) AND
      (next_check_at IS NULL OR next_check_at<=? OR configuration_identity IS NULL OR configuration_identity!=?)`)
      .run(retryAt, retryAt, configurationIdentity, now, now, configurationIdentity);
    if (claim.changes !== 1) return { state: "waiting" };
  } finally { writer.close(); }
  try {
    let preview: CorpusRetentionPreview | undefined;
    if (configuration.mode === "apply" && schedule?.configuration_identity === configurationIdentity && typeof schedule.pending_digest === "string") {
      const pending = await openRuntimeDatabaseReadOnly(request.runtimeRoot);
      try {
        const row = pending.prepare("SELECT preview_json FROM corpus_retention_plans WHERE digest=? AND completed_at IS NULL").get(schedule.pending_digest);
        if (typeof row?.preview_json === "string") {
          const decoded = parseCorpusRetentionPreview(JSON.parse(row.preview_json));
          if (decoded.expiresAt >= now) preview = decoded;
        }
      } finally { pending.close(); }
    }
    preview ??= await previewCorpusRetention({ ...request, policy: configuration.policy, observedAt: now });
    await recordPressure({ ...request, preview });
    const checkpoint = await openRuntimeDatabase(request.runtimeRoot);
    try {
      checkpoint.prepare("UPDATE corpus_retention_preview_schedule SET pending_digest=?, last_preview_json=? WHERE singleton=1")
        .run(configuration.mode === "apply" ? preview.digest : null, JSON.stringify(preview));
    } finally { checkpoint.close(); }
    const result = configuration.mode === "apply" ? await applyCorpusRetention({
      ...request, preview, changedAt: now, authorizeCapacityArchive: true,
      foregroundPressure: async () => await request.foregroundPressure?.() === true ||
        (request.configuration === undefined && JSON.stringify(await loadCorpusRetentionConfiguration(request)) !== configurationIdentity)
    }) : undefined;
    const progress = result !== undefined && (result.archivedMemoryIds.length > 0 || !result.completed);
    const nextCheckAt = new Date(Date.parse(now) + (progress ? 30_000 : 6 * 3_600_000)).toISOString();
    const database = await openRuntimeDatabase(request.runtimeRoot);
    try {
      database.prepare(`UPDATE corpus_retention_preview_schedule SET next_check_at=?, lease_until=NULL,
        last_run_at=?, last_result_json=?, last_error=NULL, pending_digest=? WHERE singleton=1`)
        .run(nextCheckAt, now, result === undefined ? null : JSON.stringify(result), result?.completed === false ? preview.digest : null);
      const cutoff = new Date(Date.parse(now) - 180 * 86_400_000).toISOString();
      database.prepare("DELETE FROM corpus_retention_plans WHERE created_at<? AND digest!=COALESCE((SELECT pending_digest FROM corpus_retention_preview_schedule WHERE singleton=1),'')").run(cutoff);
      database.prepare("DELETE FROM corpus_retention_pressure WHERE policy_identity!=? AND started_at<?").run(policyIdentity(configuration.policy), cutoff);
    } finally { database.close(); }
    return { state: configuration.mode === "preview" ? "preview" : "applied", count: result?.archivedMemoryIds.length ?? preview.proposedArchiveCount };
  } catch {
    const database = await openRuntimeDatabase(request.runtimeRoot);
    try {
      database.prepare("UPDATE corpus_retention_preview_schedule SET next_check_at=?, lease_until=NULL, last_error='corpus_retention_failed' WHERE singleton=1").run(retryAt);
    } finally { database.close(); }
    return { state: "deferred" };
  }
}

export function parseCorpusRetentionPreview(value: unknown): CorpusRetentionPreview {
  return z.object({
    schemaVersion: z.literal(1), dryRun: z.literal(true), policy: policySchema,
    observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), digest: z.string().regex(/^[a-f0-9]{64}$/u),
    activeAgentCount: z.number().int().nonnegative(), protectedCount: z.number().int().nonnegative(),
    activeCount: z.number().int().nonnegative().optional(),
    proposedArchiveCount: z.number().int().nonnegative(), unresolvedExcess: z.number().int().nonnegative(),
    pressure: z.object({ projectSpaces: z.array(z.string()), aggregate: z.boolean() }).strict(),
    items: z.array(z.object({ memoryId: z.string(), revisionId: z.string(), contentIdentity: z.string(),
      space: z.string(), reason: z.literal("capacity_retention") }).strict()).max(200)
  }).strict().parse(value);
}

export async function inspectCorpusRetention(request: RetentionPaths & { readonly now?: string }) {
  let configuration: CorpusRetentionConfiguration;
  try { configuration = await loadCorpusRetentionConfiguration(request); }
  catch { return { state: "configuration_unavailable" as const }; }
  const database = await openRuntimeDatabaseReadOnly(request.runtimeRoot, { minimumSchemaVersion: 61 });
  try {
    const schemaReady = database.prepare("SELECT 1 FROM schema_migrations WHERE version=62").get() !== undefined;
    const rows = database.prepare("SELECT scope_kind, project_id, COUNT(*) n FROM memory_catalog WHERE lifecycle='active' AND authority='agent_derived' GROUP BY scope_kind, project_id").all();
    const schedule = schemaReady ? database.prepare("SELECT * FROM corpus_retention_preview_schedule WHERE singleton=1").get() : undefined;
    const episodes = schemaReady ? database.prepare("SELECT space_key, started_at FROM corpus_retention_pressure WHERE policy_identity=?").all(policyIdentity(configuration.policy)) : [];
    const previous = new Map(episodes.map((r) => [z.string().parse(r.space_key), z.string().parse(r.started_at)]));
    const activeAgentCount = rows.reduce((sum, row) => sum + z.number().parse(row.n), 0);
    const activeCount = z.number().parse(database.prepare("SELECT COUNT(*) n FROM memory_catalog WHERE lifecycle='active'").get()?.n);
    const admissionsReady = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='active_capacity_admissions'").get() !== undefined;
    const pendingAdmissions = admissionsReady ? z.number().parse(database.prepare("SELECT COUNT(*) n FROM active_capacity_admissions").get()?.n) : 0;
    const waitingCandidates = admissionsReady ? z.number().parse(database.prepare("SELECT COUNT(*) n FROM active_capacity_waiters w JOIN memory_candidates c USING(candidate_id) WHERE c.state='waiting'").get()?.n) : 0;
    let projectExcess = 0;
    const activePressureTimes: string[] = [];
    for (const row of rows) {
      if (configuration.policy.activeLimit !== undefined || row.scope_kind !== "project") continue;
      const n = z.number().parse(row.n);
      const startedAt = previous.get(`project:${String(row.project_id)}`);
      if (n > configuration.policy.projectHighWater || startedAt !== undefined) {
        projectExcess += Math.max(0, n - configuration.policy.projectTarget);
        if (n > configuration.policy.projectTarget && startedAt !== undefined) activePressureTimes.push(startedAt);
      }
    }
    const limit = configuration.policy.activeLimit;
    const aggregateExcess = limit === undefined ? (activeAgentCount > configuration.policy.aggregateHighWater || previous.has("aggregate")
      ? Math.max(0, activeAgentCount - configuration.policy.aggregateTarget) : 0) :
      (activeCount >= limit || previous.has("aggregate") ? Math.max(0, activeCount - (limit - (configuration.policy.activeHeadroom ?? 0))) : 0);
    const remainingExcess = Math.max(projectExcess, aggregateExcess);
    const aggregateStartedAt = previous.get("aggregate");
    if (aggregateExcess > 0 && aggregateStartedAt !== undefined) activePressureTimes.push(aggregateStartedAt);
    const oldestPressureAt = activePressureTimes.sort()[0] ?? null;
    return {
      state: "ready" as const, ...configuration, schemaReady, activeAgentCount, activeCount, pendingAdmissions, waitingCandidates, remainingExcess, oldestPressureAt,
      overdue: remainingExcess > 0 && oldestPressureAt !== null && Date.parse(request.now ?? new Date().toISOString()) - Date.parse(oldestPressureAt) >= 12 * 3_600_000,
      nextCheckAt: schedule?.next_check_at ?? null, lastRunAt: schedule?.last_run_at ?? null,
      lastError: schedule?.last_error ?? null, pendingDigest: schedule?.pending_digest ?? null
    };
  } finally { database.close(); }
}
