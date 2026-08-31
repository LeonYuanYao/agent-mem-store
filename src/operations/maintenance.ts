import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "yaml";
import { z } from "zod";

import { loadConfiguration } from "../configuration/index.js";
import { MemStoreCommandError } from "../contracts/envelope.js";
import { inspectCaptureInbox } from "../capture/inbox.js";
import { inspectForegroundAttempts } from "../retrieval/foreground-attempts.js";
import { inspectRetrievalCatalogGeneration } from "../retrieval/index-coordinator.js";
import { inspectBackgroundRecovery } from "../worker/recovery-policy.js";

export interface DoctorCheck {
  readonly name: string;
  readonly state: "ok" | "warning" | "error";
  readonly detail: string;
}

function doctorState(checks: readonly DoctorCheck[]): "healthy" | "degraded" | "error" {
  if (checks.some((check) => check.state === "error")) return "error";
  if (checks.some((check) => check.state === "warning")) return "degraded";
  return "healthy";
}

async function inspectCatalogFiles(database: DatabaseSync, vaultRoot: string): Promise<DoctorCheck> {
  const rows = database.prepare(
    "SELECT memory_id, current_revision_id, canonical_path FROM memory_catalog ORDER BY memory_id"
  ).all();
  for (const row of rows) {
    const memoryId = z.string().parse(row.memory_id);
    const path = resolve(z.string().parse(row.canonical_path));
    const relative = path.slice(resolve(vaultRoot).length + 1);
    if (relative.startsWith("..") || path === resolve(vaultRoot)) {
      return { name: "vault_catalog", state: "error", detail: `Catalog path escapes Vault for ${memoryId}.` };
    }
    try {
      const source = await readFile(path, "utf8");
      const match = /^---\n([\s\S]*?)\n---\n/u.exec(source);
      if (match?.[1] === undefined) throw new Error("frontmatter_missing");
      const frontmatter = z.object({
        memstore: z.object({
          memory_id: z.literal(memoryId),
          revision_id: z.literal(z.string().parse(row.current_revision_id))
        })
      }).parse(parse(match[1]));
      void frontmatter;
    } catch {
      return { name: "vault_catalog", state: "error", detail: `Canonical Memory is unavailable or invalid for ${memoryId}.` };
    }
  }
  return { name: "vault_catalog", state: "ok", detail: `${String(rows.length)} catalog entries validated.` };
}

export async function inspectDoctor(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly deep: boolean;
  readonly now?: string;
}): Promise<{
  readonly state: "healthy" | "degraded" | "error";
  readonly repaired: false;
  readonly checks: readonly DoctorCheck[];
}> {
  const runtimeRoot = resolve(request.runtimeRoot);
  const vaultRoot = resolve(request.vaultRoot);
  const now = request.now === undefined
    ? new Date().toISOString()
    : z.iso.datetime().parse(request.now);
  const checks: DoctorCheck[] = [];
  try {
    const configuration = await loadConfiguration({ runtimeRoot, vaultRoot });
    checks.push(configuration.mode === "read_write"
      ? {
          name: "configuration",
          state: configuration.recovery === undefined ? "ok" : "warning",
          detail: configuration.recovery === undefined
            ? "Configuration is supported and path-bound."
            : "Configuration is using last-known-good recovery."
        }
      : { name: "configuration", state: "warning", detail: "Configuration requires a newer MemStore version." });
  } catch (error) {
    checks.push({
      name: "configuration",
      state: "error",
      detail: error instanceof Error ? error.message : "Configuration inspection failed."
    });
  }

  try {
    const attempts = await inspectForegroundAttempts(runtimeRoot);
    const recent = await inspectForegroundAttempts(runtimeRoot, {
      since: new Date(Date.parse(now) - 6 * 60 * 60 * 1_000).toISOString()
    });
    const recentDeadlineRate = recent.totalCount === 0
      ? 0
      : recent.deadlineCount / recent.totalCount;
    const warning = recent.deadlineCount >= 3 ||
      recent.postDeadlineCount >= 3 ||
      (recent.totalCount >= 20 && recentDeadlineRate >= 0.02);
    checks.push({
      name: "foreground_retrieval",
      state: warning ? "warning" : "ok",
      detail: `${String(recent.totalCount)} recent six-hour attempts; ${String(recent.deadlineCount)} recent deadlines; ${String(recent.postDeadlineCount)} with recent post-deadline work; ${String(attempts.deadlineCount)} lifetime deadlines across ${String(attempts.totalCount)} retained attempts.`
    });
  } catch (error) {
    checks.push({
      name: "foreground_retrieval",
      state: "error",
      detail: error instanceof Error ? error.message : "Foreground retrieval inspection failed."
    });
  }

  try {
    const generation = await inspectRetrievalCatalogGeneration(runtimeRoot);
    const recovery = await inspectBackgroundRecovery(runtimeRoot);
    const forceOverdue = generation.forceDueAt !== null &&
      Date.parse(generation.forceDueAt) <= Date.parse(now) &&
      generation.dirtyGeneration > generation.publishedGeneration;
    checks.push({
      name: "retrieval_catalog_generation",
      state: forceOverdue && !recovery.active ? "warning" : "ok",
      detail: `Retrieval catalog generation ${String(generation.publishedGeneration)}/${String(generation.dirtyGeneration)} published; building: ${generation.buildingGeneration === null ? "none" : String(generation.buildingGeneration)}${recovery.active ? "; recovery coalescing active" : ""}.`
    });
  } catch (error) {
    checks.push({
      name: "retrieval_catalog_generation",
      state: "error",
      detail: error instanceof Error ? error.message : "Retrieval catalog generation inspection failed."
    });
  }

  try {
    const inbox = await inspectCaptureInbox(runtimeRoot);
    const stale = inbox.oldestPendingAt !== null &&
      Date.now() - Date.parse(inbox.oldestPendingAt) >= 15 * 60 * 1_000;
    const warning = inbox.quarantineCount > 0 || stale ||
      inbox.capacityState !== "available";
    checks.push({
      name: "capture_inbox",
      state: warning ? "warning" : "ok",
      detail: `${String(inbox.pendingCount)}/${String(inbox.maximumPendingCount)} pending Capture dispositions using ${String(inbox.pendingBytes)}/${String(inbox.maximumPendingBytes)} bytes; ${String(inbox.quarantineCount)} quarantined; oldest pending: ${inbox.oldestPendingAt ?? "none"}.`
    });
  } catch (error) {
    checks.push({
      name: "capture_inbox",
      state: "error",
      detail: error instanceof Error ? error.message : "Capture Inbox inspection failed."
    });
  }

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(join(runtimeRoot, "state", "memstore.sqlite"), { readOnly: true });
    const integrity = z.string().parse(database.prepare("PRAGMA integrity_check").get()?.integrity_check);
    checks.push({
      name: "sqlite_integrity",
      state: integrity === "ok" ? "ok" : "error",
      detail: integrity
    });
    const candidates = database.prepare(
      `SELECT COUNT(*) AS waiting_count,
              SUM(CASE WHEN successful_evaluation_at IS NULL THEN 1 ELSE 0 END)
                AS unevaluated_count,
              MIN(CASE WHEN successful_evaluation_at IS NULL THEN created_at END)
                AS oldest_unevaluated_at
       FROM memory_candidates WHERE state = 'waiting'`
    ).get();
    const semantic = database.prepare(
      `SELECT COUNT(*) AS count FROM luna_operations
       WHERE operation_kind = 'semantic_assessment'
         AND state IN ('pending', 'processing', 'retrying', 'blocked')`
    ).get();
    const lunaOperations = database.prepare(
      `SELECT COUNT(*) AS active_count,
              SUM(CASE WHEN state = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
              SUM(CASE WHEN state = 'blocked' AND last_error_category IN
                ('timeout', 'unavailable', 'rate_limited') THEN 1 ELSE 0 END)
                AS offline_blocked_count,
              SUM(CASE WHEN state = 'blocked' AND (last_error_category IS NULL OR
                last_error_category NOT IN ('timeout', 'unavailable', 'rate_limited'))
                THEN 1 ELSE 0 END)
                AS actionable_blocked_count
       FROM luna_operations
       WHERE state IN ('pending', 'processing', 'retrying', 'blocked')`
    ).get();
    const waitingCount = z.number().int().nonnegative().parse(candidates?.waiting_count);
    const unevaluatedCount = z.number().int().nonnegative().parse(candidates?.unevaluated_count ?? 0);
    const semanticCount = z.number().int().nonnegative().parse(semantic?.count);
    const oldestUnevaluatedAt = typeof candidates?.oldest_unevaluated_at === "string"
      ? candidates.oldest_unevaluated_at
      : null;
    const stale = oldestUnevaluatedAt !== null &&
      Date.now() - Date.parse(oldestUnevaluatedAt) >= 15 * 60 * 1_000;
    checks.push({
      name: "candidate_pipeline",
      state: stale ? "warning" : "ok",
      detail: waitingCount === 0
        ? "No Candidate is waiting."
        : `${String(waitingCount)} Candidates are waiting; ${String(unevaluatedCount)} are unevaluated and ${String(semanticCount)} semantic assessments are active. Oldest unevaluated: ${oldestUnevaluatedAt ?? "none"}.`
    });
    const activeLunaOperationCount = z.number().int().nonnegative().parse(
      lunaOperations?.active_count
    );
    const blockedLunaOperationCount = z.number().int().nonnegative().parse(
      lunaOperations?.blocked_count ?? 0
    );
    const offlineBlockedLunaOperationCount = z.number().int().nonnegative().parse(
      lunaOperations?.offline_blocked_count ?? 0
    );
    const actionableBlockedLunaOperationCount = z.number().int().nonnegative().parse(
      lunaOperations?.actionable_blocked_count ?? 0
    );
    checks.push({
      name: "luna_operations",
      state: actionableBlockedLunaOperationCount > 0 ? "warning" : "ok",
      detail: actionableBlockedLunaOperationCount > 0
        ? `${String(actionableBlockedLunaOperationCount)} blocked actionable of ${String(activeLunaOperationCount)} active Luna operations.`
        : offlineBlockedLunaOperationCount > 0
          ? `${String(offlineBlockedLunaOperationCount)} Luna operations have background work paused by connectivity; local capture and recall remain available.`
          : blockedLunaOperationCount > 0
            ? `${String(blockedLunaOperationCount)} blocked Luna operations require classification.`
        : `${String(activeLunaOperationCount)} active Luna operations; none blocked.`
    });
    if (request.deep) checks.push(await inspectCatalogFiles(database, vaultRoot));
  } catch (error) {
    checks.push({
      name: "sqlite_integrity",
      state: "error",
      detail: error instanceof Error ? error.message : "Runtime database inspection failed."
    });
  } finally {
    database?.close();
  }
  return { state: doctorState(checks), repaired: false, checks };
}

export async function retryOperation(request: {
  readonly runtimeRoot: string;
  readonly operationId: string;
  readonly requestedAt: string;
  readonly preview: boolean;
}): Promise<
  | { readonly state: "preview"; readonly dryRun: true; readonly wouldRetry: true; readonly operationId: string }
  | {
      readonly state: "queued";
      readonly operationId: string;
      readonly retryEpoch: number;
      readonly lifetimeAttemptCount: number;
    }
> {
  const requestedAt = z.iso.datetime().parse(request.requestedAt);
  const operationId = z.string().min(1).parse(request.operationId);
  const path = join(resolve(request.runtimeRoot), "state", "memstore.sqlite");
  await access(path);
  const database = new DatabaseSync(path, { readOnly: request.preview });
  try {
    const row = database.prepare(
      "SELECT state, retry_epoch, attempt_count FROM luna_operations WHERE operation_id = ?"
    ).get(operationId);
    if (row === undefined) {
      throw new MemStoreCommandError("operation_not_found", "Operation does not exist.");
    }
    const state = z.string().parse(row.state);
    if (state !== "blocked" && state !== "retrying") {
      throw new MemStoreCommandError(
        "operation_not_retryable",
        "Only blocked or retrying Luna operations can be manually retried."
      );
    }
    if (request.preview) {
      return { state: "preview", dryRun: true, wouldRetry: true, operationId };
    }
    database.prepare(
      `UPDATE luna_operations
       SET state = 'pending', next_retry_at = NULL, lease_token = NULL,
           leased_by = NULL, lease_until = NULL,
           retry_epoch = retry_epoch + 1, epoch_attempt_count = 0,
           updated_at = ?
       WHERE operation_id = ? AND state IN ('blocked', 'retrying')`
    ).run(requestedAt, operationId);
    return {
      state: "queued",
      operationId,
      retryEpoch: z.number().int().nonnegative().parse(row.retry_epoch) + 1,
      lifetimeAttemptCount: z.number().int().nonnegative().parse(row.attempt_count)
    };
  } finally {
    database.close();
  }
}
