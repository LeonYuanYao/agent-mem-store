import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { parse } from "yaml";
import { z } from "zod";

import { loadConfiguration } from "../configuration/index.js";
import { MemStoreCommandError } from "../contracts/envelope.js";
import { inspectCaptureInbox } from "../capture/inbox.js";
import { inspectForegroundAttempts } from "../retrieval/foreground-attempts.js";
import { inspectForegroundHealth } from "../health/foreground.js";
import { foregroundRetrievalSocketPath } from "../retrieval/foreground-protocol.js";
import { inspectIndexHealth } from "../health/index.js";
import { connectionRecoveryCandidateSql, connectionRecoveryCooldownMilliseconds } from "../luna/recovery-policy.js";

export interface DoctorCheck {
  readonly name: string;
  readonly state: "ok" | "info" | "warning" | "error";
  readonly detail: string;
  readonly recoveryCondition?: string;
  readonly nextEvaluationAt?: string | null;
}

const recoveryConditions: Readonly<Record<string, string>> = {
  configuration: "A supported, path-bound read/write configuration loads without last-known-good fallback.",
  managed_worker: "The managed foreground Worker endpoint accepts local connections again.",
  capture_inbox: "The inbox is within capacity, has no quarantined files, and no pending capture older than 15 minutes.",
  sqlite_integrity: "The runtime database opens and SQLite integrity_check returns ok.",
  candidate_pipeline: "No unevaluated waiting Candidate is older than 15 minutes; already evaluated waiting Candidates do not block health.",
  luna_operations: "Actionable blocked operations complete, retry successfully, or receive an explicit resolution; connectivity pauses remain separately visible.",
  governance: "Resolve the reported failure, explicitly retry the blocked run, and complete a successful page review. Capture and recall remain independently available.",
  vault_catalog: "Every current catalog entry resolves to a valid Canonical Memory with the expected identity and revision."
};

function doctorState(checks: readonly DoctorCheck[]): "healthy" | "observing" | "degraded" | "error" {
  if (checks.some((check) => check.state === "error")) return "error";
  if (checks.some((check) => check.state === "warning")) return "degraded";
  if (checks.some((check) => check.state === "info")) return "observing";
  return "healthy";
}

async function foregroundEndpointAcceptsConnections(runtimeRoot: string): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    const socket = createConnection(foregroundRetrievalSocketPath(runtimeRoot));
    let complete = false;
    const finish = (available: boolean): void => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(available);
    };
    const timer = setTimeout(() => { finish(false); }, 50);
    socket.once("connect", () => { finish(true); });
    socket.once("error", () => { finish(false); });
  });
}

async function inspectManagedWorker(runtimeRoot: string): Promise<DoctorCheck | null> {
  const manifestPath = join(runtimeRoot, "install", "ownership-manifest.json");
  let source: string;
  try {
    source = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const manifest = z.object({ state: z.string() }).parse(JSON.parse(source));
  if (manifest.state !== "installed") return null;
  const available = await foregroundEndpointAcceptsConnections(runtimeRoot);
  return available
    ? {
        name: "managed_worker",
        state: "ok",
        detail: "Managed installation exists and the foreground Worker socket is available."
      }
    : {
        name: "managed_worker",
        state: "warning",
        detail: "Managed installation exists, but the foreground Worker socket is unavailable."
      };
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
  readonly state: "healthy" | "observing" | "degraded" | "error";
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

  if (request.deep) {
    try {
      const managedWorker = await inspectManagedWorker(runtimeRoot);
      if (managedWorker !== null) checks.push(managedWorker);
    } catch (error) {
      checks.push({
        name: "managed_worker",
        state: "error",
        detail: error instanceof Error ? error.message : "Managed Worker inspection failed."
      });
    }
  }

  try {
    const attempts = await inspectForegroundAttempts(runtimeRoot);
    const health = await inspectForegroundHealth(runtimeRoot, now);
    checks.push({
      name: "foreground_retrieval",
      state: health.severity,
      recoveryCondition: health.recoveryCondition,
      nextEvaluationAt: health.quietUntil !== null && health.quietUntil > now ? health.quietUntil : null,
      detail: `${health.state}; ${String(health.recentFailureCount)} failures in 15 minutes; ${String(health.successSinceFailure)} completed requests since last failure (${health.lastFailureAt ?? "none"}). ${health.recoveryCondition} ${String(attempts.deadlineCount)} lifetime deadlines across ${String(attempts.totalCount)} retained attempts.`
    });
  } catch (error) {
    checks.push({
      name: "foreground_retrieval",
      state: "error",
      detail: error instanceof Error ? error.message : "Foreground retrieval inspection failed."
    });
  }

  try {
    const health = await inspectIndexHealth(runtimeRoot, now);
    const generation = health.generation;
    checks.push({
      name: "retrieval_catalog_generation",
      state: health.severity,
      recoveryCondition: health.recoveryCondition,
      nextEvaluationAt: health.expectedAt,
      detail: `${health.state}: Retrieval catalog generation ${String(generation.publishedGeneration)}/${String(generation.dirtyGeneration)} published; expected by ${health.expectedAt ?? "not scheduled"}. ${health.recoveryCondition}`
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
      Date.parse(now) - Date.parse(inbox.oldestPendingAt) >= 15 * 60 * 1_000;
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
              SUM(CASE WHEN ${connectionRecoveryCandidateSql} THEN 1 ELSE 0 END)
                AS offline_blocked_count,
              MIN(CASE WHEN ${connectionRecoveryCandidateSql} THEN updated_at END)
                AS earliest_recovery_failure_at
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
      Date.parse(now) - Date.parse(oldestUnevaluatedAt) >= 15 * 60 * 1_000;
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
    const actionableBlockedLunaOperationCount = blockedLunaOperationCount - offlineBlockedLunaOperationCount;
    const recoveryAfter = typeof lunaOperations?.earliest_recovery_failure_at === "string"
      ? new Date(Date.parse(lunaOperations.earliest_recovery_failure_at) + connectionRecoveryCooldownMilliseconds).toISOString()
      : null;
    checks.push({
      name: "luna_operations",
      state: actionableBlockedLunaOperationCount > 0 ? "warning" : offlineBlockedLunaOperationCount > 0 ? "info" : "ok",
      ...(offlineBlockedLunaOperationCount > 0 ? {
        nextEvaluationAt: recoveryAfter !== null && recoveryAfter > now ? recoveryAfter : null,
        recoveryCondition: "A successful model operation after the failure, healthy model state, and six-hour cooldown; at most two single-attempt recovery probes."
      } : {}),
      detail: actionableBlockedLunaOperationCount > 0
        ? `${String(actionableBlockedLunaOperationCount)} blocked actionable of ${String(activeLunaOperationCount)} active Luna operations; automatic retries stopped and explicit handling is required.`
        : offlineBlockedLunaOperationCount > 0
          ? `${String(offlineBlockedLunaOperationCount)} Luna operations await recovery evidence and cooldown (not before ${recoveryAfter ?? "unknown"}); timeout alone does not prove a network outage. Local capture and recall remain available.`
          : blockedLunaOperationCount > 0
            ? `${String(blockedLunaOperationCount)} blocked Luna operations require classification.`
        : `${String(activeLunaOperationCount)} active Luna operations; none blocked.`
    });
    const governance = database.prepare(
      `SELECT run_id, current_phase, state, last_error_category, next_retry_at
       FROM governance_runs WHERE state IN ('pending', 'processing', 'retrying', 'blocked')
       ORDER BY CASE state WHEN 'blocked' THEN 0 WHEN 'retrying' THEN 1 ELSE 2 END, created_at LIMIT 1`
    ).get();
    const governanceRecovering = governance !== undefined &&
      (governance.state === "retrying" || governance.last_error_category !== null);
    checks.push({
      name: "governance",
      state: governance?.state === "blocked" ? "warning" : governanceRecovering ? "info" : "ok",
      detail: governance === undefined ? "No outstanding governance run."
        : `Governance ${String(governance.run_id)} (${String(governance.current_phase)}) is ${String(governance.state)}; last failure: ${String(governance.last_error_category ?? "none")}. Capture and recall are checked independently.`,
      ...(governanceRecovering && governance.state !== "blocked" ? {
        nextEvaluationAt: z.string().nullable().parse(governance.next_retry_at),
        recoveryCondition: "The scheduled governance retry must complete a successful page review; requeueing alone does not establish recovery."
      } : {})
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
  return { state: doctorState(checks), repaired: false, checks: checks.map(check => {
    const condition = recoveryConditions[check.name];
    return check.state !== "ok" && check.recoveryCondition === undefined && condition !== undefined
      ? { ...check, recoveryCondition: condition } : check;
  }) };
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
  | { readonly state: "queued"; readonly kind: "governance"; readonly operationId: string; readonly lifetimeAttemptCount: number }
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
      const run = database.prepare("SELECT state, attempt_count FROM governance_runs WHERE run_id = ?").get(operationId);
      if (run === undefined) throw new MemStoreCommandError("operation_not_found", "Operation does not exist.");
      if (run.state !== "blocked" && run.state !== "retrying") {
        throw new MemStoreCommandError("operation_not_retryable", "Only blocked or retrying governance runs can be manually retried.");
      }
      if (request.preview) return { state: "preview", dryRun: true, wouldRetry: true, operationId };
      const updated = database.prepare(
        `UPDATE governance_runs SET state = 'pending', consecutive_failure_count = 0,
           next_retry_at = NULL, updated_at = ?
         WHERE run_id = ? AND state IN ('blocked', 'retrying')`
      ).run(requestedAt, operationId);
      if (updated.changes !== 1) throw new MemStoreCommandError("operation_not_retryable", "Governance state changed before retry.");
      // Keep frozen inputs, applied pages, coverage and lifetime attempts intact.
      return { state: "queued", kind: "governance", operationId,
        lifetimeAttemptCount: z.number().int().nonnegative().parse(run.attempt_count) };
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
           retry_epoch = retry_epoch + 1, epoch_attempt_count = 0, connection_recovery_count = 0,
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
