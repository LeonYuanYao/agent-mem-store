import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

import { openRuntimeDatabase } from "../runtime/database.js";
import {
  inspectStandaloneCanonicalFile,
  purgeArchivedCanonicalBody,
  readCanonicalMemory,
  type CanonicalMemory,
  type CanonicalPurgeCheckpoint
} from "../vault/index.js";

const DEFAULT_BODY_LIMIT = 25;
const DEFAULT_BYTE_LIMIT = 16 * 1024 * 1024;
const DEFAULT_DURATION_LIMIT_MS = 10_000;
const MAX_BODY_LIMIT = 200;
const MAX_BYTE_LIMIT = 128 * 1024 * 1024;
const MAX_DURATION_LIMIT_MS = 60_000;

export interface ArchivePurgeLimits {
  readonly bodies?: number;
  readonly bytes?: number;
  readonly destructiveMilliseconds?: number;
}

export interface ArchivePurgeRequest {
  readonly vaultRoot: string;
  readonly runtimeRoot: string;
  readonly backupRoot: string;
  readonly now: string;
  readonly archiveRetentionMonths?: number;
  readonly limits?: ArchivePurgeLimits;
  readonly foregroundPressure?: () => Promise<boolean>;
  readonly onCheckpoint?: (
    checkpoint: CanonicalPurgeCheckpoint,
    memoryId: string
  ) => Promise<void>;
}

export interface ArchivePurgePreviewItem {
  readonly memoryId: string;
  readonly revisionId: string;
  readonly expectedContentIdentity: string;
  readonly purgeAfter: string;
  readonly canonicalPath: string;
  readonly backupPath: string;
  readonly backupSha256: string;
  readonly removableBytes: number;
}

interface NormalizedLimits {
  readonly bodies: number;
  readonly bytes: number;
  readonly destructiveMilliseconds: number;
}

interface PreviewCandidate extends ArchivePurgePreviewItem {
  readonly archivedAt: string;
}

function normalizeLimits(limits?: ArchivePurgeLimits): NormalizedLimits {
  return {
    bodies: z.number().int().min(1).max(MAX_BODY_LIMIT).parse(
      limits?.bodies ?? DEFAULT_BODY_LIMIT
    ),
    bytes: z.number().int().min(1).max(MAX_BYTE_LIMIT).parse(
      limits?.bytes ?? DEFAULT_BYTE_LIMIT
    ),
    destructiveMilliseconds: z.number().int().min(1).max(MAX_DURATION_LIMIT_MS).parse(
      limits?.destructiveMilliseconds ?? DEFAULT_DURATION_LIMIT_MS
    )
  };
}

function isWithin(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function validateRoots(vaultRoot: string, runtimeRoot: string, backupRoot: string): void {
  if (isWithin(vaultRoot, backupRoot) || isWithin(runtimeRoot, backupRoot)) {
    throw new Error("Purge backup must be outside both the Vault and Runtime roots.");
  }
  if (resolve(vaultRoot) === resolve(runtimeRoot)) {
    throw new Error("Purge requires separate Vault and Runtime roots.");
  }
}

function addCalendarMonths(instant: string, months: number): string {
  return Temporal.Instant.from(instant)
    .toZonedDateTimeISO("UTC")
    .add({ months })
    .toInstant()
    .toString({ smallestUnit: "millisecond" });
}

async function hasForegroundPressure(request: ArchivePurgeRequest): Promise<boolean> {
  if (await request.foregroundPressure?.() === true) return true;
  const database = new DatabaseSync(
    join(resolve(request.runtimeRoot), "state", "memstore.sqlite"),
    { readOnly: true }
  );
  try {
    const capture = database.prepare(
      `SELECT 1 FROM capture_events
       WHERE state IN ('pending', 'processing', 'retrying') LIMIT 1`
    ).get();
    const index = database.prepare(
      `SELECT 1 FROM retrieval_index_build_activity
       WHERE singleton = 1 AND state = 'building' AND lease_until > ?`
    ).get(request.now);
    return capture !== undefined || index !== undefined;
  } finally {
    database.close();
  }
}

function resolvePurgeAfter(
  memory: CanonicalMemory,
  archiveRetentionMonths: number
): { readonly state: "eligible"; readonly purgeAfter: string } |
  { readonly state: "protected"; readonly reason: string } {
  if (memory.lifecycleDetails.retainForever === true) {
    return { state: "protected", reason: "retain_forever" };
  }
  if (memory.lifecycleDetails.purgeAfter !== undefined) {
    return { state: "eligible", purgeAfter: memory.lifecycleDetails.purgeAfter };
  }
  if (memory.lifecycleDetails.pinned === true) {
    return { state: "protected", reason: "pinned" };
  }
  if (memory.authority === "human_authored") {
    return { state: "protected", reason: "human_default_no_automatic_purge" };
  }
  const archivedAt = z.iso.datetime().parse(memory.lifecycleDetails.archivedAt);
  return {
    state: "eligible",
    purgeAfter: addCalendarMonths(archivedAt, archiveRetentionMonths)
  };
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function verifyBackup(request: {
  readonly vaultRoot: string;
  readonly backupRoot: string;
  readonly canonicalPath: string;
  readonly expectedContentIdentity: string;
  readonly revisionPaths: readonly string[];
}): Promise<{ readonly backupPath: string; readonly backupSha256: string }> {
  const canonicalRelativePath = relative(request.vaultRoot, request.canonicalPath);
  if (canonicalRelativePath.startsWith("..") || canonicalRelativePath.length === 0) {
    throw new Error("Purge target is outside the Vault root.");
  }
  const backupPath = resolve(request.backupRoot, canonicalRelativePath);
  if (!isWithin(request.backupRoot, backupPath)) {
    throw new Error("Purge backup target escaped the backup root.");
  }
  const backup = await inspectStandaloneCanonicalFile(backupPath);
  if (backup.contentIdentity !== request.expectedContentIdentity) {
    throw new Error("Purge backup content identity does not match the target.");
  }
  const identities = [await sha256File(backupPath)];
  for (const revisionPath of request.revisionPaths) {
    const revisionRelativePath = relative(request.vaultRoot, revisionPath);
    if (revisionRelativePath.startsWith("..") || revisionRelativePath.length === 0) {
      throw new Error("Purge revision path is outside the Vault root.");
    }
    const backupRevisionPath = resolve(request.backupRoot, revisionRelativePath);
    if (await sha256File(backupRevisionPath) !== await sha256File(revisionPath)) {
      throw new Error("Purge backup revision identity does not match the target.");
    }
    identities.push(await sha256File(backupRevisionPath));
  }
  return {
    backupPath,
    backupSha256: createHash("sha256").update(identities.join("\n")).digest("hex")
  };
}

async function collectPreview(request: ArchivePurgeRequest): Promise<{
  readonly items: readonly PreviewCandidate[];
  readonly protectedItems: readonly { memoryId: string; reason: string }[];
  readonly hasMore: boolean;
  readonly limits: NormalizedLimits;
}> {
  const vaultRoot = resolve(request.vaultRoot);
  const runtimeRoot = resolve(request.runtimeRoot);
  const backupRoot = resolve(request.backupRoot);
  validateRoots(vaultRoot, runtimeRoot, backupRoot);
  const now = Temporal.Instant.from(z.iso.datetime().parse(request.now));
  const archiveRetentionMonths = z.number().int().positive().parse(
    request.archiveRetentionMonths ?? 6
  );
  const limits = normalizeLimits(request.limits);
  const databasePath = join(runtimeRoot, "state", "memstore.sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let rows: readonly Record<string, unknown>[];
  try {
    rows = database.prepare(
      `SELECT memory_id, current_revision_id, canonical_path, content_identity
       FROM memory_catalog WHERE lifecycle = 'archived'
       ORDER BY revised_at, memory_id`
    ).all();
  } finally {
    database.close();
  }
  const items: PreviewCandidate[] = [];
  const protectedItems: { memoryId: string; reason: string }[] = [];
  let selectedBytes = 0;
  let hasMore = false;
  for (const row of rows) {
    const memoryId = z.string().parse(row.memory_id);
    const canonicalPath = resolve(z.string().parse(row.canonical_path));
    if (!isWithin(join(vaultRoot, "Memories"), canonicalPath)) {
      throw new Error("Purge target path is outside the Canonical Memory directory.");
    }
    const current = await inspectStandaloneCanonicalFile(canonicalPath);
    const expectedRevisionId = z.string().parse(row.current_revision_id);
    const expectedContentIdentity = z.string().parse(row.content_identity);
    if (
      current.memory.memoryId !== memoryId ||
      current.memory.revisionId !== expectedRevisionId ||
      current.contentIdentity !== expectedContentIdentity ||
      current.memory.lifecycle !== "archived"
    ) {
      throw new Error("Purge target requires Canonical reconciliation before preview.");
    }
    const retention = resolvePurgeAfter(current.memory, archiveRetentionMonths);
    if (retention.state === "protected") {
      protectedItems.push({ memoryId, reason: retention.reason });
      continue;
    }
    if (Temporal.Instant.compare(Temporal.Instant.from(retention.purgeAfter), now) > 0) continue;
    const revisionDatabase = new DatabaseSync(databasePath, { readOnly: true });
    let revisionPaths: string[];
    try {
      revisionPaths = revisionDatabase.prepare(
        `SELECT revision_path FROM memory_revisions
         WHERE memory_id = ? ORDER BY created_at, revision_id`
      ).all(memoryId).map((revision) => resolve(z.string().parse(revision.revision_path)));
    } finally {
      revisionDatabase.close();
    }
    for (const revisionPath of revisionPaths) {
      if (!isWithin(join(vaultRoot, "_MemStore", "Revisions", memoryId), revisionPath)) {
        throw new Error("Purge revision path is outside its derived Vault directory.");
      }
    }
    const removableBytes = (await stat(canonicalPath)).size +
      (await Promise.all(revisionPaths.map((path) => stat(path)))).reduce(
        (total, metadata) => total + metadata.size,
        0
      );
    const backup = await verifyBackup({
      vaultRoot,
      backupRoot,
      canonicalPath,
      expectedContentIdentity,
      revisionPaths
    });
    if (items.length >= limits.bodies || selectedBytes + removableBytes > limits.bytes) {
      hasMore = true;
      continue;
    }
    selectedBytes += removableBytes;
    items.push({
      memoryId,
      revisionId: expectedRevisionId,
      expectedContentIdentity,
      purgeAfter: retention.purgeAfter,
      archivedAt: z.iso.datetime().parse(current.memory.lifecycleDetails.archivedAt),
      canonicalPath,
      backupPath: backup.backupPath,
      backupSha256: backup.backupSha256,
      removableBytes
    });
  }
  return { items, protectedItems, hasMore, limits };
}

export async function previewArchivePurge(request: ArchivePurgeRequest): Promise<{
  readonly schemaVersion: 1;
  readonly dryRun: true;
  readonly state: "preview";
  readonly eligibleCount: number;
  readonly items: readonly ArchivePurgePreviewItem[];
  readonly protectedItems: readonly { memoryId: string; reason: string }[];
  readonly hasMore: boolean;
}> {
  const preview = await collectPreview(request);
  return {
    schemaVersion: 1,
    dryRun: true,
    state: "preview",
    eligibleCount: preview.items.length,
    items: preview.items.map((item) => ({
      memoryId: item.memoryId,
      revisionId: item.revisionId,
      expectedContentIdentity: item.expectedContentIdentity,
      purgeAfter: item.purgeAfter,
      canonicalPath: item.canonicalPath,
      backupPath: item.backupPath,
      backupSha256: item.backupSha256,
      removableBytes: item.removableBytes
    })),
    protectedItems: preview.protectedItems,
    hasMore: preview.hasMore
  };
}

async function resumeInterruptedPurge(request: ArchivePurgeRequest): Promise<{
  readonly schemaVersion: 1;
  readonly dryRun: false;
  readonly state: "completed" | "yielded";
  readonly runId: string;
  readonly purgedMemoryIds: readonly string[];
  readonly skipped: readonly { memoryId: string; reason: string }[];
  readonly hasMore: boolean;
  readonly nextEligibleAt?: string;
} | undefined> {
  const databasePath = join(resolve(request.runtimeRoot), "state", "memstore.sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let rows: readonly Record<string, unknown>[];
  try {
    rows = database.prepare(
      `SELECT item.*, run.state AS run_state, run.next_eligible_at
       FROM archive_purge_items AS item
       JOIN archive_purge_runs AS run ON run.run_id = item.run_id
       WHERE item.state NOT IN ('completed', 'skipped')
         AND run.state IN ('processing', 'yielded', 'failed')
       ORDER BY run.started_at, item.created_at, item.memory_id`
    ).all();
  } finally {
    database.close();
  }
  const first = rows[0];
  if (first === undefined) return undefined;
  const runId = z.string().parse(first.run_id);
  const runRows = rows.filter((row) => row.run_id === runId);
  const nextEligibleAt = typeof first.next_eligible_at === "string"
    ? first.next_eligible_at
    : undefined;
  if (
    first.run_state === "yielded" &&
    nextEligibleAt !== undefined &&
    Temporal.Instant.compare(
      Temporal.Instant.from(request.now),
      Temporal.Instant.from(nextEligibleAt)
    ) < 0
  ) {
    return {
      schemaVersion: 1,
      dryRun: false,
      state: "yielded",
      runId,
      purgedMemoryIds: [],
      skipped: [],
      hasMore: true,
      nextEligibleAt
    };
  }
  const startDatabase = await openRuntimeDatabase(request.runtimeRoot);
  try {
    startDatabase.prepare(
      `UPDATE archive_purge_runs
       SET state = 'processing', next_eligible_at = NULL, last_error_code = NULL
       WHERE run_id = ?`
    ).run(runId);
  } finally {
    startDatabase.close();
  }
  const purgedMemoryIds: string[] = [];
  const skipped: { memoryId: string; reason: string }[] = [];
  let removedBytes = 0;
  try {
    for (const row of runRows) {
      if (await hasForegroundPressure(request)) {
        const pressureNextEligibleAt = Temporal.Instant.from(request.now)
          .add({ seconds: 300 })
          .toString();
        const yieldDatabase = await openRuntimeDatabase(request.runtimeRoot);
        try {
          yieldDatabase.prepare(
            `UPDATE archive_purge_runs
             SET state = 'yielded', next_eligible_at = ?,
                 purged_count = purged_count + ?, removed_bytes = removed_bytes + ?
             WHERE run_id = ?`
          ).run(pressureNextEligibleAt, purgedMemoryIds.length, removedBytes, runId);
        } finally {
          yieldDatabase.close();
        }
        return {
          schemaVersion: 1,
          dryRun: false,
          state: "yielded",
          runId,
          purgedMemoryIds,
          skipped,
          hasMore: true,
          nextEligibleAt: pressureNextEligibleAt
        };
      }
      const memoryId = z.string().parse(row.memory_id);
      const itemId = z.string().parse(row.item_id);
      const expectedContentIdentity = z.string().parse(row.expected_content_identity);
      const originalPurgedAt = z.string().parse(row.purged_at ?? request.now);
      const current = await readCanonicalMemory({
        vaultRoot: request.vaultRoot,
        runtimeRoot: request.runtimeRoot,
        memoryId
      });
      if (current?.memory.lifecycle === "active") {
        const skipDatabase = await openRuntimeDatabase(request.runtimeRoot);
        try {
          skipDatabase.prepare(
            `UPDATE archive_purge_items
             SET state = 'skipped', skip_reason = 'restored', updated_at = ?
             WHERE item_id = ?`
          ).run(request.now, itemId);
        } finally {
          skipDatabase.close();
        }
        skipped.push({ memoryId, reason: "restored" });
        continue;
      }
      const resumable = current !== undefined && (
        (current.memory.lifecycle === "archived" &&
          current.contentIdentity === expectedContentIdentity) ||
        (current.memory.lifecycle === "tombstone" &&
          current.memory.lifecycleDetails.purgedContentIdentity === expectedContentIdentity)
      );
      if (!resumable) {
        throw new Error("Interrupted purge target changed; refusing recovery deletion.");
      }
      const backup = await inspectStandaloneCanonicalFile(z.string().parse(row.backup_path));
      if (backup.contentIdentity !== expectedContentIdentity) {
        throw new Error("Interrupted purge backup changed; refusing recovery deletion.");
      }
      await purgeArchivedCanonicalBody({
        vaultRoot: request.vaultRoot,
        runtimeRoot: request.runtimeRoot,
        memoryId,
        expectedContentIdentity,
        purgedAt: originalPurgedAt,
        reason: "archive_retention_elapsed",
        onCheckpoint: async (checkpoint, checkpointResult) => {
          const checkpointDatabase = await openRuntimeDatabase(request.runtimeRoot);
          try {
            checkpointDatabase.prepare(
              `UPDATE archive_purge_items
               SET state = ?, tombstone_content_identity = ?, purged_at = ?, updated_at = ?
               WHERE item_id = ?`
            ).run(
              checkpoint === "derived_indexes_removed" ? "completed" : checkpoint,
              checkpointResult.tombstoneContentIdentity,
              originalPurgedAt,
              request.now,
              itemId
            );
          } finally {
            checkpointDatabase.close();
          }
          await request.onCheckpoint?.(checkpoint, memoryId);
        }
      });
      purgedMemoryIds.push(memoryId);
      removedBytes += z.number().int().nonnegative().parse(row.removable_bytes);
    }
    const completedDatabase = await openRuntimeDatabase(request.runtimeRoot);
    try {
      completedDatabase.prepare(
        `UPDATE archive_purge_runs
         SET state = 'completed', completed_at = ?, next_eligible_at = NULL,
             purged_count = purged_count + ?, removed_bytes = removed_bytes + ?
         WHERE run_id = ?`
      ).run(request.now, purgedMemoryIds.length, removedBytes, runId);
    } finally {
      completedDatabase.close();
    }
    return {
      schemaVersion: 1,
      dryRun: false,
      state: "completed",
      runId,
      purgedMemoryIds,
      skipped,
      hasMore: false
    };
  } catch (error) {
    const failedDatabase = await openRuntimeDatabase(request.runtimeRoot);
    try {
      failedDatabase.prepare(
        `UPDATE archive_purge_runs
         SET state = 'failed', last_error_code = ? WHERE run_id = ?`
      ).run(error instanceof Error ? error.name : "unknown_error", runId);
    } finally {
      failedDatabase.close();
    }
    throw error;
  }
}

export async function runArchivePurgeBatch(request: ArchivePurgeRequest): Promise<{
  readonly schemaVersion: 1;
  readonly dryRun: false;
  readonly state: "completed" | "yielded";
  readonly runId?: string;
  readonly purgedMemoryIds: readonly string[];
  readonly skipped: readonly { memoryId: string; reason: string }[];
  readonly hasMore: boolean;
  readonly nextEligibleAt?: string;
}> {
  const resumed = await resumeInterruptedPurge(request);
  if (resumed !== undefined) return resumed;
  const cooldownDatabase = new DatabaseSync(
    join(resolve(request.runtimeRoot), "state", "memstore.sqlite"),
    { readOnly: true }
  );
  let cooldown: Record<string, unknown> | undefined;
  try {
    cooldown = cooldownDatabase.prepare(
      `SELECT run_id, next_eligible_at FROM archive_purge_runs
       WHERE next_eligible_at IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`
    ).get();
  } finally {
    cooldownDatabase.close();
  }
  if (
    cooldown !== undefined &&
    typeof cooldown.next_eligible_at === "string" &&
    Temporal.Instant.compare(
      Temporal.Instant.from(request.now),
      Temporal.Instant.from(cooldown.next_eligible_at)
    ) < 0
  ) {
    return {
      schemaVersion: 1,
      dryRun: false,
      state: "yielded",
      runId: z.string().parse(cooldown.run_id),
      purgedMemoryIds: [],
      skipped: [],
      hasMore: true,
      nextEligibleAt: cooldown.next_eligible_at
    };
  }
  const preview = await collectPreview(request);
  if (preview.items.length === 0) {
    return {
      schemaVersion: 1,
      dryRun: false,
      state: "completed",
      purgedMemoryIds: [],
      skipped: [],
      hasMore: preview.hasMore
    };
  }
  const started = performance.now();
  const runId = `mspurgerun_${randomUUID()}`;
  const database = await openRuntimeDatabase(request.runtimeRoot);
  const itemIds = new Map<string, string>();
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(
        `INSERT INTO archive_purge_runs(
           run_id, state, started_at, body_limit, byte_limit, duration_limit_ms
         ) VALUES (?, 'processing', ?, ?, ?, ?)`
      ).run(
        runId,
        request.now,
        preview.limits.bodies,
        preview.limits.bytes,
        preview.limits.destructiveMilliseconds
      );
      const insertItem = database.prepare(
        `INSERT INTO archive_purge_items(
           item_id, run_id, memory_id, expected_revision_id,
           expected_content_identity, backup_path, backup_sha256,
           purge_after, removable_bytes, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`
      );
      for (const item of preview.items) {
        const itemId = `mspurgeitem_${randomUUID()}`;
        insertItem.run(
          itemId,
          runId,
          item.memoryId,
          item.revisionId,
          item.expectedContentIdentity,
          item.backupPath,
          item.backupSha256,
          item.purgeAfter,
          item.removableBytes,
          request.now,
          request.now
        );
        itemIds.set(item.memoryId, itemId);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
  const purgedMemoryIds: string[] = [];
  const skipped: { memoryId: string; reason: string }[] = [];
  let removedBytes = 0;
  let yielded = false;
  try {
    for (const item of preview.items) {
      if (
        performance.now() - started >= preview.limits.destructiveMilliseconds ||
        await hasForegroundPressure(request)
      ) {
        yielded = true;
        break;
      }
      const current = await readCanonicalMemory({
        vaultRoot: request.vaultRoot,
        runtimeRoot: request.runtimeRoot,
        memoryId: item.memoryId
      });
      if (
        current === undefined ||
        current.memory.lifecycle !== "archived" ||
        current.memory.revisionId !== item.revisionId ||
        current.contentIdentity !== item.expectedContentIdentity
      ) {
        throw new Error("Purge target changed after preview; refusing deletion.");
      }
      const backup = await inspectStandaloneCanonicalFile(item.backupPath);
      if (backup.contentIdentity !== item.expectedContentIdentity) {
        throw new Error("Purge backup changed after preview; refusing deletion.");
      }
      const itemId = z.string().parse(itemIds.get(item.memoryId));
      await purgeArchivedCanonicalBody({
        vaultRoot: request.vaultRoot,
        runtimeRoot: request.runtimeRoot,
        memoryId: item.memoryId,
        expectedContentIdentity: item.expectedContentIdentity,
        purgedAt: request.now,
        reason: "archive_retention_elapsed",
        onCheckpoint: async (checkpoint, checkpointResult) => {
          const checkpointDatabase = await openRuntimeDatabase(request.runtimeRoot);
          try {
            const state = checkpoint === "derived_indexes_removed"
              ? "completed"
              : checkpoint;
            checkpointDatabase.prepare(
              `UPDATE archive_purge_items
               SET state = ?, tombstone_content_identity = ?, purged_at = ?, updated_at = ?
               WHERE item_id = ?`
            ).run(
              state,
              checkpointResult.tombstoneContentIdentity,
              request.now,
              request.now,
              itemId
            );
          } finally {
            checkpointDatabase.close();
          }
          await request.onCheckpoint?.(checkpoint, item.memoryId);
        }
      });
      purgedMemoryIds.push(item.memoryId);
      removedBytes += item.removableBytes;
    }
    const hasMore = yielded || preview.hasMore || purgedMemoryIds.length < preview.items.length;
    const nextEligibleAt = hasMore
      ? Temporal.Instant.from(request.now).add({ seconds: yielded ? 300 : 30 }).toString()
      : undefined;
    const completedDatabase = await openRuntimeDatabase(request.runtimeRoot);
    try {
      completedDatabase.prepare(
        `UPDATE archive_purge_runs
         SET state = ?, completed_at = ?, next_eligible_at = ?,
             purged_count = ?, removed_bytes = ?
         WHERE run_id = ?`
      ).run(
        yielded ? "yielded" : "completed",
        yielded ? null : request.now,
        nextEligibleAt ?? null,
        purgedMemoryIds.length,
        removedBytes,
        runId
      );
    } finally {
      completedDatabase.close();
    }
    return {
      schemaVersion: 1,
      dryRun: false,
      state: yielded ? "yielded" : "completed",
      runId,
      purgedMemoryIds,
      skipped,
      hasMore,
      ...(nextEligibleAt === undefined ? {} : { nextEligibleAt })
    };
  } catch (error) {
    const failedDatabase = await openRuntimeDatabase(request.runtimeRoot);
    try {
      failedDatabase.prepare(
        `UPDATE archive_purge_runs
         SET state = 'failed', last_error_code = ? WHERE run_id = ?`
      ).run(error instanceof Error ? error.name : "unknown_error", runId);
    } finally {
      failedDatabase.close();
    }
    throw error;
  }
}
