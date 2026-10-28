/**
 * Removes data MemStore keeps but no longer uses (ADR-0158):
 *   - purged Memories: the Vault Tombstone file, its catalog row and every runtime row
 *     derived from it (retrieval receipt items, compact quality items, duplicate clusters, ...);
 *   - the retired Luna pipeline's finished work: candidates and their evidence, distillation
 *     batches, Session consolidations, Luna operations, and governance checkpoints, actions and
 *     run members of completed runs. These held copies of purged Memory text.
 * Memory refs stay reserved, so an M:id is never reused. Capture events, dreaming, active and
 * archived Memories are not touched. Unfinished work of any kind is kept.
 *
 *   tsx scripts/prune-retired-data.ts [--runtime DIR] [--vault DIR]                 # preview counts
 *   tsx scripts/prune-retired-data.ts --apply --backup DIR [--runtime DIR] [--vault DIR]
 *
 * Stop the worker before --apply: the run ends with VACUUM. The backup directory receives a
 * consistent copy of the database and of every Tombstone file it removes. Rerunning is safe.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { parse } from "smol-toml";

const { values } = parseArgs({ options: {
  runtime: { type: "string" }, vault: { type: "string" }, apply: { type: "boolean", default: false }, backup: { type: "string" }
} });
const expand = (path: string): string => resolve(path.replace(/^~(?=\/|$)/u, homedir()));
const runtime = expand(values.runtime ?? join(homedir(), "Library", "Application Support", "MemStore"));
const configuredVault = (parse(readFileSync(join(runtime, "config.toml"), "utf8")) as { paths?: { vault_root?: unknown } }).paths?.vault_root;
const vault = expand(values.vault ?? (typeof configuredVault === "string" ? configuredVault : ""));
if (!existsSync(join(vault, "Memories"))) throw new Error(`No Vault at ${vault}; pass --vault.`);
if (values.apply && values.backup === undefined) throw new Error("--apply needs --backup DIR.");
const databasePath = join(runtime, "state", "memstore.sqlite");

// Luna operations newer than this may still belong to background work in flight.
const operationCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
const tombstones = "SELECT memory_id FROM memory_catalog WHERE lifecycle = 'tombstone'";
const completedRuns = "SELECT run_id FROM governance_runs WHERE state = 'completed'";
// Every candidate is finished; one with an open verification request, expiration obligation or capacity wait is kept.
const finishedCandidates = `SELECT candidate_id FROM memory_candidates WHERE state IN ('promoted', 'rejected', 'expired')
  AND (state != 'promoted' OR promoted_memory_id IS NULL OR promoted_memory_id IN (${tombstones})
       OR promoted_memory_id NOT IN (SELECT memory_id FROM memory_catalog))
  AND candidate_id NOT IN (SELECT candidate_id FROM verification_requests WHERE candidate_id IS NOT NULL)
  AND candidate_id NOT IN (SELECT candidate_id FROM candidate_expiration_obligations)
  AND candidate_id NOT IN (SELECT candidate_id FROM active_capacity_waiters)`;

/** In dependency order: children before their parents. */
const steps: readonly { readonly table: string; readonly where: string }[] = [
  { table: "governance_actions", where: `run_id IN (${completedRuns})` },
  { table: "governance_checkpoints", where: `state = 'applied' AND run_id IN (${completedRuns})` },
  { table: "governance_run_members", where: `run_id IN (${completedRuns})` },
  { table: "semantic_assessments", where: `candidate_id IN (${finishedCandidates})` },
  { table: "governance_decisions", where: `candidate_id IN (${finishedCandidates})` },
  { table: "candidate_evidence", where: `candidate_id IN (${finishedCandidates})` },
  { table: "memory_candidates", where: `candidate_id IN (${finishedCandidates})` },
  { table: "distillation_batch_events", where: "batch_id IN (SELECT batch_id FROM distillation_batches WHERE state = 'completed')" },
  { table: "distillation_batches", where: `state = 'completed' AND batch_id NOT IN (
      SELECT split_parent_batch_id FROM distillation_batches WHERE state != 'completed' AND split_parent_batch_id IS NOT NULL)` },
  { table: "session_consolidations", where: "state = 'completed'" },
  { table: "luna_operations", where: `state IN ('completed', 'dead_letter') AND created_at < '${operationCutoff}'
      AND operation_id NOT IN (SELECT operation_id FROM distillation_batches WHERE operation_id IS NOT NULL)
      AND operation_id NOT IN (SELECT operation_id FROM session_consolidations WHERE operation_id IS NOT NULL)
      AND operation_id NOT IN (SELECT operation_id FROM semantic_assessments WHERE operation_id IS NOT NULL)
      AND operation_id NOT IN (SELECT operation_id FROM admission_audit WHERE operation_id IS NOT NULL)
      AND operation_id NOT IN (SELECT operation_id FROM human_conflict_assessments WHERE operation_id IS NOT NULL)` },
  { table: "retrieval_receipt_items", where: `memory_id IN (${tombstones})` },
  { table: "irrelevant_observations", where: `memory_id IN (${tombstones})` },
  { table: "memory_quality_items", where: `memory_id IN (${tombstones})` },
  { table: "memory_summaries", where: `memory_id IN (${tombstones})` },
  { table: "memory_duplicate_clusters", where: `left_memory_id IN (${tombstones}) OR right_memory_id IN (${tombstones})` },
  { table: "memory_ranking_exclusions", where: `memory_id IN (${tombstones})` },
  { table: "governance_review_suggestions", where: `target_memory_id IN (${tombstones}) AND state != 'open'` },
  { table: "vault_conflicts", where: `memory_id IN (${tombstones})` },
  { table: "memory_relationships", where: `source_memory_id IN (${tombstones}) OR target_memory_id IN (${tombstones})` },
  { table: "memory_revisions", where: `memory_id IN (${tombstones})` }
];

function tombstoneFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md") && /^\s*lifecycle: tombstone$/mu.test(readFileSync(path, "utf8").split("\n---\n", 1)[0] ?? "")) files.push(path);
    }
  };
  walk(join(vault, "Memories"));
  return files;
}

const database = new DatabaseSync(databasePath);
database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000");
const sizeBefore = statSync(databasePath).size;
// A purge in progress owns its Memory until it completes.
const purging = Number(database.prepare("SELECT count(*) AS n FROM archive_purge_items WHERE state NOT IN ('completed', 'skipped')").get()?.n);
if (purging > 0) throw new Error(`${String(purging)} purge items are in progress; rerun after they complete.`);
const violationsBefore = database.prepare("PRAGMA foreign_key_check").all().length;
const catalogRows = database.prepare(tombstones).all().map((row) => String(row.memory_id));
/** Runs every step in one transaction; each step sees the rows earlier steps removed. */
function deleteAll(): Record<string, number> {
  const removed: Record<string, number> = {};
  for (const { table, where } of steps) removed[table] = Number(database.prepare(`DELETE FROM ${table} WHERE ${where}`).run().changes);
  removed.memory_catalog = Number(database.prepare(`DELETE FROM memory_catalog WHERE memory_id IN (${tombstones})`).run().changes);
  return removed;
}
// The preview performs the deletion and rolls it back, so its counts are exactly what --apply removes.
database.exec("BEGIN IMMEDIATE");
let counts: Record<string, number>;
try { counts = deleteAll(); } finally { database.exec("ROLLBACK"); }
const pathsByCatalog = new Set(database.prepare("SELECT canonical_path FROM memory_catalog WHERE lifecycle = 'tombstone'").all().map((row) => resolve(String(row.canonical_path))));
const files = tombstoneFiles();
const unknownFiles = files.filter((path) => !pathsByCatalog.has(resolve(path)));
const dreamReferences = Number(database.prepare(`SELECT (SELECT count(*) FROM dream_memories WHERE memory_id IN (${tombstones}))
  + (SELECT count(*) FROM dream_items WHERE apply_memory_id IN (${tombstones})) AS n`).get()?.n);
console.log(JSON.stringify({ runtime, vault, apply: values.apply, rows: counts, tombstoned_memories: catalogRows.length,
  tombstone_files: files.length, tombstone_files_without_catalog_row: unknownFiles.length,
  dream_rows_referencing_tombstones_kept: dreamReferences, foreign_key_violations: violationsBefore, database_bytes: sizeBefore }, null, 1));

if (values.apply) {
  const backup = expand(String(values.backup));
  mkdirSync(join(backup, "vault"), { recursive: true, mode: 0o700 });
  const snapshot = join(backup, "memstore.sqlite");
  if (!existsSync(snapshot)) database.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
  for (const path of files) {
    const target = join(backup, "vault", relative(vault, path));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    cpSync(path, target);
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    deleteAll();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  // The catalog no longer names these files; remove them and the folders they leave empty.
  for (const path of files) rmSync(path, { force: true });
  const prune = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) prune(join(directory, entry.name));
    if (directory !== join(vault, "Memories") && readdirSync(directory).length === 0) rmdirSync(directory);
  };
  prune(join(vault, "Memories"));
  database.exec("INSERT INTO active_fts_memories(active_fts_memories) VALUES ('optimize')");
  database.exec("VACUUM");
  const violations = database.prepare("PRAGMA foreign_key_check").all().length;
  const integrity = String(database.prepare("PRAGMA quick_check").get()?.quick_check);
  console.log(JSON.stringify({ database_bytes_after: statSync(databasePath).size, foreign_key_violations: violations, quick_check: integrity,
    remaining_tombstone_files: tombstoneFiles().length, backup }, null, 1));
}
database.close();
