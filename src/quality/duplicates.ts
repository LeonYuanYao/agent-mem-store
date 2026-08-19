import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { LunaInvocationError } from "../luna/index.js";
import { recordLunaWorkFailure, recordLunaWorkSuccess } from "../luna/operations.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import { readCanonicalMemory, type CanonicalMemory } from "../vault/index.js";

const discoveryPageSize = 32;
const assessmentBatchSize = 8;
const defaultSimilarityThreshold = 0.92;
const maximumAttempts = 6;

export interface DuplicateClusterInput {
  readonly clusterId: string;
  readonly similarity: number;
  readonly left: {
    readonly memoryId: string;
    readonly revisionId: string;
    readonly body: string;
    readonly scope: CanonicalMemory["scope"];
    readonly applicability: CanonicalMemory["applicability"];
    readonly semanticContract: CanonicalMemory["semanticContract"];
  };
  readonly right: DuplicateClusterInput["left"];
}

export interface DuplicateAssessmentAdapter {
  assessDuplicateClusters(request: {
    readonly operationId: string;
    readonly clusters: readonly DuplicateClusterInput[];
  }): Promise<{
    readonly schemaVersion: 1;
    readonly kind: "duplicate_assessment";
    readonly items: readonly {
      readonly clusterId: string;
      readonly decision:
        | "equivalent"
        | "left_subsumes_right"
        | "right_subsumes_left"
        | "conflicts"
        | "unrelated"
        | "uncertain";
      readonly reasonCode: string;
    }[];
  }>;
}

interface IndexedDocument {
  readonly memoryId: string;
  readonly revisionId: string;
  readonly ordinal: number;
  readonly scopeKey: string;
  readonly applicabilityKey: string;
}

function dot(
  values: Float32Array,
  leftOrdinal: number,
  rightOrdinal: number,
  dimensions: number
): number {
  let score = 0;
  const leftStart = leftOrdinal * dimensions;
  const rightStart = rightOrdinal * dimensions;
  for (let offset = 0; offset < dimensions; offset += 1) {
    score += (values[leftStart + offset] ?? 0) * (values[rightStart + offset] ?? 0);
  }
  return score;
}

export async function discoverDuplicateClusters(request: {
  readonly runtimeRoot: string;
  readonly requestedAt: string;
  readonly preview: boolean;
  readonly cursor?: string;
  readonly limit?: number;
  readonly similarityThreshold?: number;
}): Promise<{
  readonly state: "preview" | "enqueued";
  readonly scannedCount: number;
  readonly candidatePairCount: number;
  readonly enqueuedCount: number;
  readonly nextCursor?: string;
}> {
  const requestedAt = z.iso.datetime().parse(request.requestedAt);
  const limit = z.number().int().min(1).max(256).parse(request.limit ?? discoveryPageSize);
  const threshold = z.number().min(0.8).max(1).parse(
    request.similarityThreshold ?? defaultSimilarityThreshold
  );
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let index: Record<string, unknown>;
  let rows: readonly Record<string, unknown>[];
  try {
    const found = database.prepare(
      `SELECT revision.index_revision_id, revision.directory_path, revision.dimensions
       FROM active_retrieval_index AS active
       JOIN retrieval_index_revisions AS revision
         ON revision.index_revision_id = active.index_revision_id
       WHERE active.singleton = 1 AND revision.state = 'complete'`
    ).get();
    if (found === undefined) throw new Error("Duplicate discovery requires an active retrieval index.");
    index = found;
    rows = database.prepare(
      `SELECT memory_id, revision_id, vector_ordinal, scope_kind, project_id,
              applicability_summary, applicability_conditions_json
       FROM retrieval_documents
       WHERE index_revision_id = ? AND authority = 'agent_derived'
       ORDER BY memory_id`
    ).all(z.string().parse(index.index_revision_id));
  } finally {
    database.close();
  }
  const documents: IndexedDocument[] = rows.map((row) => ({
    memoryId: z.string().parse(row.memory_id),
    revisionId: z.string().parse(row.revision_id),
    ordinal: z.number().int().nonnegative().parse(row.vector_ordinal),
    scopeKey: row.scope_kind === "global" ? "global" : `project:${z.string().parse(row.project_id)}`,
    applicabilityKey: JSON.stringify({
      summary: z.string().parse(row.applicability_summary),
      conditions: z.array(z.string()).parse(JSON.parse(z.string().parse(row.applicability_conditions_json)))
    })
  }));
  const start = request.cursor === undefined
    ? 0
    : documents.findIndex((document) => document.memoryId === request.cursor) + 1;
  if (request.cursor !== undefined && start === 0) throw new Error("Duplicate discovery cursor is stale.");
  const page = documents.slice(start, start + limit);
  const vectorBytes = await readFile(`${z.string().parse(index.directory_path)}/vectors.f32`);
  const values = new Float32Array(
    vectorBytes.buffer,
    vectorBytes.byteOffset,
    Math.floor(vectorBytes.byteLength / Float32Array.BYTES_PER_ELEMENT)
  );
  const dimensions = z.number().int().positive().parse(index.dimensions);
  const pairs: {
    readonly left: IndexedDocument;
    readonly right: IndexedDocument;
    readonly similarity: number;
  }[] = [];
  for (const left of page) {
    for (const right of documents) {
      if (
        left.memoryId >= right.memoryId ||
        left.scopeKey !== right.scopeKey ||
        left.applicabilityKey !== right.applicabilityKey
      ) continue;
      const similarity = dot(values, left.ordinal, right.ordinal, dimensions);
      if (similarity >= threshold) pairs.push({ left, right, similarity });
    }
  }
  let enqueuedCount = 0;
  if (!request.preview && pairs.length > 0) {
    const writeDatabase = await openRuntimeDatabase(request.runtimeRoot);
    try {
      const insert = writeDatabase.prepare(
        `INSERT OR IGNORE INTO memory_duplicate_clusters(
           cluster_id, index_revision_id, left_memory_id, left_revision_id,
           right_memory_id, right_revision_id, similarity, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      );
      writeDatabase.exec("BEGIN IMMEDIATE");
      for (const pair of pairs) {
        enqueuedCount += Number(insert.run(
          `msdupe_${randomUUID()}`,
          z.string().parse(index.index_revision_id),
          pair.left.memoryId,
          pair.left.revisionId,
          pair.right.memoryId,
          pair.right.revisionId,
          pair.similarity,
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
  const last = page.at(-1);
  const nextCursor = start + page.length < documents.length ? last?.memoryId : undefined;
  return {
    state: request.preview ? "preview" : "enqueued",
    scannedCount: page.length,
    candidatePairCount: pairs.length,
    enqueuedCount,
    ...(nextCursor === undefined ? {} : { nextCursor })
  };
}

export async function advanceDuplicateDiscovery(request: {
  readonly runtimeRoot: string;
  readonly now: string;
}): Promise<{
  readonly state: "idle" | "advanced" | "completed" | "index_unavailable";
  readonly scannedCount?: number;
  readonly enqueuedCount?: number;
}> {
  const now = z.iso.datetime().parse(request.now);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let indexRevisionId: string | undefined;
  let schedule: Record<string, unknown> | undefined;
  try {
    const active = database.prepare(
      "SELECT index_revision_id FROM active_retrieval_index WHERE singleton = 1"
    ).get();
    if (typeof active?.index_revision_id === "string") indexRevisionId = active.index_revision_id;
    schedule = database.prepare(
      "SELECT * FROM duplicate_discovery_schedule WHERE singleton = 1"
    ).get();
  } finally {
    database.close();
  }
  if (indexRevisionId === undefined) return { state: "index_unavailable" };
  const sameIndex = schedule?.index_revision_id === indexRevisionId;
  const cursor = sameIndex && typeof schedule?.cursor_memory_id === "string"
    ? schedule.cursor_memory_id
    : undefined;
  if (
    sameIndex &&
    schedule?.cursor_memory_id === null &&
    typeof schedule.next_scan_at === "string" &&
    schedule.next_scan_at > now
  ) return { state: "idle" };
  const result = await discoverDuplicateClusters({
    runtimeRoot: request.runtimeRoot,
    requestedAt: now,
    preview: false,
    ...(cursor === undefined ? {} : { cursor })
  });
  const completed = result.nextCursor === undefined;
  const nextScanAt = completed
    ? new Date(Date.parse(now) + 7 * 24 * 60 * 60 * 1_000).toISOString()
    : now;
  const writeDatabase = await openRuntimeDatabase(request.runtimeRoot);
  try {
    writeDatabase.prepare(
      `INSERT INTO duplicate_discovery_schedule(
         singleton, index_revision_id, cursor_memory_id, next_scan_at,
         last_completed_at, updated_at
       ) VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         index_revision_id = excluded.index_revision_id,
         cursor_memory_id = excluded.cursor_memory_id,
         next_scan_at = excluded.next_scan_at,
         last_completed_at = excluded.last_completed_at,
         updated_at = excluded.updated_at`
    ).run(
      indexRevisionId,
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
    scannedCount: result.scannedCount,
    enqueuedCount: result.enqueuedCount
  };
}

interface ClaimedCluster {
  readonly clusterId: string;
  readonly leftMemoryId: string;
  readonly leftRevisionId: string;
  readonly rightMemoryId: string;
  readonly rightRevisionId: string;
  readonly similarity: number;
  readonly attemptCount: number;
}

async function claimClusters(request: {
  readonly runtimeRoot: string;
  readonly now: string;
  readonly workerId: string;
}): Promise<{ readonly leaseToken: string; readonly clusters: readonly ClaimedCluster[] }> {
  const leaseToken = `msdupelease_${randomUUID()}`;
  const leaseUntil = new Date(Date.parse(request.now) + 10 * 60 * 1_000).toISOString();
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    const rows = database.prepare(
      `SELECT * FROM memory_duplicate_clusters
       WHERE state = 'pending'
          OR (state = 'retrying' AND next_retry_at <= ?)
          OR (state = 'processing' AND lease_until < ?)
       ORDER BY created_at LIMIT ?`
    ).all(request.now, request.now, assessmentBatchSize);
    const update = database.prepare(
      `UPDATE memory_duplicate_clusters SET state = 'processing',
         attempt_count = attempt_count + 1, lease_token = ?, lease_until = ?, updated_at = ?
       WHERE cluster_id = ?`
    );
    for (const row of rows) {
      update.run(
        leaseToken,
        leaseUntil,
        request.now,
        z.string().parse(row.cluster_id)
      );
    }
    database.exec("COMMIT");
    return {
      leaseToken,
      clusters: rows.map((row) => ({
        clusterId: z.string().parse(row.cluster_id),
        leftMemoryId: z.string().parse(row.left_memory_id),
        leftRevisionId: z.string().parse(row.left_revision_id),
        rightMemoryId: z.string().parse(row.right_memory_id),
        rightRevisionId: z.string().parse(row.right_revision_id),
        similarity: z.number().parse(row.similarity),
        attemptCount: z.number().int().positive().parse(Number(row.attempt_count) + 1)
      }))
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function memorySide(memory: CanonicalMemory): DuplicateClusterInput["left"] {
  return {
    memoryId: memory.memoryId,
    revisionId: memory.revisionId,
    body: memory.body,
    scope: memory.scope,
    applicability: memory.applicability,
    semanticContract: memory.semanticContract
  };
}

async function loadClusterInput(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly cluster: ClaimedCluster;
}): Promise<DuplicateClusterInput | undefined> {
  const [left, right] = await Promise.all([
    readCanonicalMemory({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      memoryId: request.cluster.leftMemoryId
    }),
    readCanonicalMemory({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      memoryId: request.cluster.rightMemoryId
    })
  ]);
  if (
    left === undefined || right === undefined ||
    left.memory.lifecycle !== "active" || right.memory.lifecycle !== "active" ||
    left.memory.authority !== "agent_derived" || right.memory.authority !== "agent_derived" ||
    left.memory.revisionId !== request.cluster.leftRevisionId ||
    right.memory.revisionId !== request.cluster.rightRevisionId ||
    JSON.stringify(left.memory.scope) !== JSON.stringify(right.memory.scope) ||
    JSON.stringify(left.memory.applicability) !== JSON.stringify(right.memory.applicability)
  ) return undefined;
  return {
    clusterId: request.cluster.clusterId,
    similarity: request.cluster.similarity,
    left: memorySide(left.memory),
    right: memorySide(right.memory)
  };
}

export async function runNextDuplicateAssessment(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly workerId: string;
  readonly now: string;
  readonly adapter: DuplicateAssessmentAdapter;
}): Promise<
  | { readonly state: "empty" }
  | { readonly state: "assessed" | "stale" | "retrying" | "blocked"; readonly clusterCount: number }
> {
  const now = z.iso.datetime().parse(request.now);
  const claimed = await claimClusters({
    runtimeRoot: request.runtimeRoot,
    now,
    workerId: request.workerId
  });
  if (claimed.clusters.length === 0) return { state: "empty" };
  const loaded = await Promise.all(claimed.clusters.map(async (cluster) => ({
    cluster,
    input: await loadClusterInput({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      cluster
    })
  })));
  const stale = loaded.filter((entry) => entry.input === undefined);
  if (stale.length > 0) {
    const database = await openRuntimeDatabase(request.runtimeRoot);
    try {
      const update = database.prepare(
        "UPDATE memory_duplicate_clusters SET state = 'stale', completed_at = ?, updated_at = ? WHERE cluster_id = ?"
      );
      database.exec("BEGIN IMMEDIATE");
      for (const entry of stale) update.run(now, now, entry.cluster.clusterId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }
  }
  const current = loaded.filter((entry): entry is { cluster: ClaimedCluster; input: DuplicateClusterInput } =>
    entry.input !== undefined
  );
  if (current.length === 0) return { state: "stale", clusterCount: stale.length };
  try {
    const output = await request.adapter.assessDuplicateClusters({
      operationId: claimed.leaseToken,
      clusters: current.map((entry) => entry.input)
    });
    const byId = new Map(output.items.map((item) => [item.clusterId, item]));
    const database = await openRuntimeDatabase(request.runtimeRoot);
    try {
      const update = database.prepare(
        `UPDATE memory_duplicate_clusters SET state = ?, decision = ?, reason_code = ?,
           completed_at = ?, updated_at = ?, lease_token = NULL, lease_until = NULL
         WHERE cluster_id = ?`
      );
      database.exec("BEGIN IMMEDIATE");
      for (const entry of current) {
        const result = byId.get(entry.cluster.clusterId);
        const decision = result?.decision ?? "uncertain";
        update.run(
          ["unrelated", "uncertain"].includes(decision) ? "rejected" : "completed",
          decision,
          result?.reasonCode ?? "missing_assessment_result",
          now,
          now,
          entry.cluster.clusterId
        );
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }
    await recordLunaWorkSuccess({ runtimeRoot: request.runtimeRoot, completedAt: now });
    return { state: "assessed", clusterCount: current.length };
  } catch (error) {
    if (!(error instanceof LunaInvocationError)) throw error;
    const attemptCount = Math.max(...current.map((entry) => entry.cluster.attemptCount));
    const health = await recordLunaWorkFailure({
      runtimeRoot: request.runtimeRoot,
      workId: current[0]?.cluster.clusterId ?? "duplicate-assessment",
      attemptCount,
      failedAt: now,
      error
    });
    const blocked = !error.retryable || attemptCount >= maximumAttempts;
    const database = await openRuntimeDatabase(request.runtimeRoot);
    try {
      const update = database.prepare(
        `UPDATE memory_duplicate_clusters SET state = ?, next_retry_at = ?,
           last_error_category = ?, updated_at = ?, lease_token = NULL, lease_until = NULL
         WHERE cluster_id = ?`
      );
      database.exec("BEGIN IMMEDIATE");
      for (const entry of current) {
        update.run(
          blocked ? "blocked" : "retrying",
          blocked ? null : health.nextRetryAt,
          error.category,
          now,
          entry.cluster.clusterId
        );
      }
      database.exec("COMMIT");
    } catch (updateError) {
      database.exec("ROLLBACK");
      throw updateError;
    } finally {
      database.close();
    }
    return { state: blocked ? "blocked" : "retrying", clusterCount: current.length };
  }
}

export async function inspectDuplicateClusters(request: {
  readonly runtimeRoot: string;
}): Promise<{
  readonly totalCount: number;
  readonly pendingCount: number;
  readonly completedCount: number;
  readonly rejectedCount: number;
  readonly blockedCount: number;
  readonly staleCount: number;
  readonly decisionCounts: Readonly<Record<string, number>>;
}> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const rows = database.prepare(
      "SELECT state, decision, COUNT(*) AS count FROM memory_duplicate_clusters GROUP BY state, decision"
    ).all();
    const stateCounts = new Map<string, number>();
    const decisionCounts: Record<string, number> = {};
    for (const row of rows) {
      const count = z.number().int().nonnegative().parse(row.count);
      const state = z.string().parse(row.state);
      stateCounts.set(state, (stateCounts.get(state) ?? 0) + count);
      if (typeof row.decision === "string") {
        decisionCounts[row.decision] = (decisionCounts[row.decision] ?? 0) + count;
      }
    }
    const count = (...states: readonly string[]): number =>
      states.reduce((total, state) => total + (stateCounts.get(state) ?? 0), 0);
    return {
      totalCount: [...stateCounts.values()].reduce((total, value) => total + value, 0),
      pendingCount: count("pending", "processing", "retrying"),
      completedCount: count("completed"),
      rejectedCount: count("rejected"),
      blockedCount: count("blocked"),
      staleCount: count("stale"),
      decisionCounts
    };
  } finally {
    database.close();
  }
}
