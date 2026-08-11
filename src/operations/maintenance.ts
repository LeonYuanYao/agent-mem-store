import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "yaml";
import { z } from "zod";

import { loadConfiguration } from "../configuration/index.js";
import { MemStoreCommandError } from "../contracts/envelope.js";

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
}): Promise<{
  readonly state: "healthy" | "degraded" | "error";
  readonly repaired: false;
  readonly checks: readonly DoctorCheck[];
}> {
  const runtimeRoot = resolve(request.runtimeRoot);
  const vaultRoot = resolve(request.vaultRoot);
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
              MIN(created_at) AS oldest_waiting_at
       FROM memory_candidates WHERE state = 'waiting'`
    ).get();
    const semantic = database.prepare(
      `SELECT COUNT(*) AS count FROM luna_operations
       WHERE operation_kind = 'semantic_assessment'
         AND state IN ('pending', 'processing', 'retrying', 'blocked')`
    ).get();
    const waitingCount = z.number().int().nonnegative().parse(candidates?.waiting_count);
    const unevaluatedCount = z.number().int().nonnegative().parse(candidates?.unevaluated_count ?? 0);
    const semanticCount = z.number().int().nonnegative().parse(semantic?.count);
    const oldestWaitingAt = typeof candidates?.oldest_waiting_at === "string"
      ? candidates.oldest_waiting_at
      : null;
    const stale = oldestWaitingAt !== null &&
      Date.now() - Date.parse(oldestWaitingAt) >= 15 * 60 * 1_000;
    checks.push({
      name: "candidate_pipeline",
      state: stale ? "warning" : "ok",
      detail: waitingCount === 0
        ? "No Candidate is waiting."
        : `${String(waitingCount)} Candidates are waiting; ${String(unevaluatedCount)} are unevaluated and ${String(semanticCount)} semantic assessments are active. Oldest: ${oldestWaitingAt ?? "unknown"}.`
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
  | { readonly state: "queued"; readonly operationId: string }
> {
  const requestedAt = z.iso.datetime().parse(request.requestedAt);
  const operationId = z.string().min(1).parse(request.operationId);
  const path = join(resolve(request.runtimeRoot), "state", "memstore.sqlite");
  await access(path);
  const database = new DatabaseSync(path, { readOnly: request.preview });
  try {
    const row = database.prepare(
      "SELECT state FROM luna_operations WHERE operation_id = ?"
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
           leased_by = NULL, lease_until = NULL, updated_at = ?
       WHERE operation_id = ? AND state IN ('blocked', 'retrying')`
    ).run(requestedAt, operationId);
    return { state: "queued", operationId };
  } finally {
    database.close();
  }
}
