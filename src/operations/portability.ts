import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backup } from "node:sqlite";
import { parse } from "yaml";
import { z } from "zod";

import { generateReviewInbox } from "../review/inbox.js";
import {
  buildRetrievalIndex,
  type EmbeddingAdapter
} from "../retrieval/index.js";
import { recallSearch } from "../retrieval/recall.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import { rebuildCanonicalCatalog } from "../vault/index.js";

export interface MigrationPendingCounts {
  readonly capture: number;
  readonly luna: number;
  readonly governance: number;
  readonly reminders: number;
  readonly verificationRequests: number;
  readonly humanConflicts: number;
}

export async function inspectMigrationReadiness(request: {
  readonly runtimeRoot: string;
}): Promise<{
  readonly state: "ready" | "blocked";
  readonly paused: boolean;
  readonly pending: MigrationPendingCounts;
}> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const count = (sql: string): number => z.number().int().nonnegative().parse(
      database.prepare(sql).get()?.count
    );
    const pending = {
      capture: count("SELECT COUNT(*) AS count FROM capture_events WHERE state IN ('pending', 'processing', 'retrying')"),
      luna: count("SELECT COUNT(*) AS count FROM luna_operations WHERE state IN ('pending', 'processing', 'retrying', 'blocked')"),
      governance: count("SELECT COUNT(*) AS count FROM governance_runs WHERE state IN ('pending', 'processing', 'retrying', 'blocked')"),
      reminders: count("SELECT COUNT(*) AS count FROM reminder_obligations WHERE state IN ('pending', 'delivering', 'failed', 'fallback')"),
      verificationRequests: count("SELECT COUNT(*) AS count FROM verification_requests WHERE state = 'open'"),
      humanConflicts: count("SELECT COUNT(*) AS count FROM human_memory_conflicts WHERE state = 'open'")
    };
    const control = database.prepare("SELECT * FROM worker_control WHERE singleton = 1").get();
    const paused = control?.capture_paused === 1 && control.worker_paused === 1;
    const unfinished = Object.values(pending).reduce((sum, value) => sum + value, 0);
    return { state: unfinished === 0 && paused ? "ready" : "blocked", paused, pending };
  } finally {
    database.close();
  }
}

export async function pauseForMigration(request: {
  readonly runtimeRoot: string;
  readonly pausedAt: string;
}): Promise<{ readonly state: "paused"; readonly pending: MigrationPendingCounts }> {
  const pausedAt = z.iso.datetime().parse(request.pausedAt);
  const readiness = await inspectMigrationReadiness(request);
  const unfinished = readiness.pending.capture + readiness.pending.luna +
    readiness.pending.governance + readiness.pending.reminders +
    readiness.pending.verificationRequests + readiness.pending.humanConflicts;
  if (unfinished > 0) throw new Error("Migration cannot pause with unfinished work.");
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.prepare(
      `INSERT INTO worker_control(
         singleton, capture_paused, worker_paused, updated_at, reason
       ) VALUES (1, 1, 1, ?, 'vault_migration')
       ON CONFLICT(singleton) DO UPDATE SET
         capture_paused = 1, worker_paused = 1,
         updated_at = excluded.updated_at, reason = excluded.reason`
    ).run(pausedAt);
  } finally {
    database.close();
  }
  return { state: "paused", pending: readiness.pending };
}

export async function resumeAfterMigration(request: {
  readonly runtimeRoot: string;
  readonly resumedAt: string;
}): Promise<{ readonly state: "running" }> {
  const resumedAt = z.iso.datetime().parse(request.resumedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.prepare(
      `INSERT INTO worker_control(
         singleton, capture_paused, worker_paused, updated_at, reason
       ) VALUES (1, 0, 0, ?, NULL)
       ON CONFLICT(singleton) DO UPDATE SET
         capture_paused = 0, worker_paused = 0,
         updated_at = excluded.updated_at, reason = NULL`
    ).run(resumedAt);
  } finally {
    database.close();
  }
  return { state: "running" };
}

export async function createRuntimeBackup(request: {
  readonly runtimeRoot: string;
  readonly destinationPath: string;
  readonly createdAt: string;
}): Promise<{
  readonly state: "complete";
  readonly backupId: string;
  readonly path: string;
  readonly sha256: string;
}> {
  const createdAt = z.iso.datetime().parse(request.createdAt);
  const path = resolve(request.destinationPath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let runtimeId: string;
  let schemaVersion: number;
  try {
    runtimeId = z.string().parse(
      database.prepare("SELECT runtime_id FROM runtime_identity WHERE singleton = 1").get()?.runtime_id
    );
    schemaVersion = z.number().int().positive().parse(
      database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version
    );
    await backup(database, path);
  } finally {
    database.close();
  }
  const sha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  const backupId = `msbackup_${randomUUID()}`;
  const recordDatabase = await openRuntimeDatabase(request.runtimeRoot);
  try {
    recordDatabase.prepare(
      `INSERT INTO runtime_backups(
         backup_id, path, source_runtime_id, source_schema_version,
         state, sha256, created_at
       ) VALUES (?, ?, ?, ?, 'complete', ?, ?)`
    ).run(backupId, path, runtimeId, schemaVersion, sha256, createdAt);
  } finally {
    recordDatabase.close();
  }
  return { state: "complete", backupId, path, sha256 };
}

export async function validatePortableVault(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
}): Promise<{
  readonly state: "valid";
  readonly memoryCount: number;
  readonly revisionCount: number;
  readonly brokenRelationshipTargets: readonly string[];
}> {
  const runtimeRoot = resolve(request.runtimeRoot);
  const vaultRoot = resolve(request.vaultRoot);
  const database = new DatabaseSync(
    resolve(runtimeRoot, "state", "memstore.sqlite"),
    { readOnly: true }
  );
  try {
    const rows = database.prepare(
      "SELECT memory_id, current_revision_id, canonical_path FROM memory_catalog ORDER BY memory_id"
    ).all();
    for (const row of rows) {
      const memoryId = z.string().parse(row.memory_id);
      const revisionId = z.string().parse(row.current_revision_id);
      const path = resolve(z.string().parse(row.canonical_path));
      const relative = path.slice(vaultRoot.length + 1);
      if (relative.startsWith("..") || path === vaultRoot) {
        throw new Error(`Canonical path escapes the portable Vault for ${memoryId}.`);
      }
      const source = await readFile(path, "utf8");
      const match = /^---\n([\s\S]*?)\n---\n/u.exec(source);
      if (match?.[1] === undefined) {
        throw new Error(`Canonical Memory frontmatter is missing for ${memoryId}.`);
      }
      z.object({
        memstore: z.object({
          memory_id: z.literal(memoryId),
          revision_id: z.literal(revisionId)
        })
      }).parse(parse(match[1]));
    }
    const revisionCount = z.number().int().nonnegative().parse(
      database.prepare("SELECT COUNT(*) AS count FROM memory_revisions").get()?.count
    );
    const brokenRelationshipTargets = database.prepare(
      `SELECT DISTINCT relationship.target_memory_id
       FROM memory_relationships AS relationship
       LEFT JOIN memory_catalog AS target
         ON target.memory_id = relationship.target_memory_id
       WHERE target.memory_id IS NULL
       ORDER BY relationship.target_memory_id`
    ).all().map((row) => z.string().parse(row.target_memory_id));
    if (brokenRelationshipTargets.length > 0) {
      throw new Error("Portable Vault contains broken Memory relationship targets.");
    }
    return {
      state: "valid",
      memoryCount: rows.length,
      revisionCount,
      brokenRelationshipTargets
    };
  } finally {
    database.close();
  }
}

export async function rebuildDestination(request: {
  readonly vaultRoot: string;
  readonly destinationRuntimeRoot: string;
  readonly adapter: EmbeddingAdapter;
  readonly rebuiltAt: string;
}): Promise<{
  readonly state: "rebuilt";
  readonly memoryCount: number;
  readonly revisionCount: number;
  readonly indexRevisionId: string;
  readonly sourceRuntimeStateImported: false;
}> {
  const rebuiltAt = z.iso.datetime().parse(request.rebuiltAt);
  const catalog = await rebuildCanonicalCatalog({
    vaultRoot: request.vaultRoot,
    runtimeRoot: request.destinationRuntimeRoot
  });
  const index = await buildRetrievalIndex({
    vaultRoot: request.vaultRoot,
    runtimeRoot: request.destinationRuntimeRoot,
    adapter: request.adapter,
    builtAt: rebuiltAt
  });
  await generateReviewInbox({
    vaultRoot: request.vaultRoot,
    runtimeRoot: request.destinationRuntimeRoot,
    generatedAt: rebuiltAt
  });
  return {
    state: "rebuilt",
    memoryCount: catalog.memoryCount,
    revisionCount: catalog.revisionCount,
    indexRevisionId: index.indexRevisionId,
    sourceRuntimeStateImported: false
  };
}

export async function verifyDestinationRetrieval(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly adapter: EmbeddingAdapter;
  readonly query: string;
  readonly verifiedAt: string;
}): Promise<{ readonly state: "verified"; readonly matchedMemoryIds: readonly string[] }> {
  const result = await recallSearch({
    runtimeRoot: request.runtimeRoot,
    vaultRoot: request.vaultRoot,
    adapter: request.adapter,
    query: request.query,
    scope: "all_projects",
    callerIdentity: "portability:destination-verification",
    requestedAt: z.iso.datetime().parse(request.verifiedAt)
  });
  if (result.items.length === 0) throw new Error("Destination retrieval verification returned no Memory.");
  return { state: "verified", matchedMemoryIds: result.items.map((item) => item.memoryId) };
}
