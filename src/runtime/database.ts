import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly path: URL;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "project_registry",
    path: new URL("../../migrations/0001-project-registry.sql", import.meta.url)
  },
  {
    version: 2,
    name: "durable_outbox",
    path: new URL("../../migrations/0002-durable-outbox.sql", import.meta.url)
  },
  {
    version: 3,
    name: "sensitivity_findings",
    path: new URL("../../migrations/0003-sensitivity-findings.sql", import.meta.url)
  },
  {
    version: 4,
    name: "outbox_leases",
    path: new URL("../../migrations/0004-outbox-leases.sql", import.meta.url)
  },
  {
    version: 5,
    name: "canonical_catalog",
    path: new URL("../../migrations/0005-canonical-catalog.sql", import.meta.url)
  },
  {
    version: 6,
    name: "runtime_identity",
    path: new URL("../../migrations/0006-runtime-identity.sql", import.meta.url)
  },
  {
    version: 7,
    name: "luna_operations",
    path: new URL("../../migrations/0007-luna-operations.sql", import.meta.url)
  },
  {
    version: 8,
    name: "distillation_batches",
    path: new URL("../../migrations/0008-distillation-batches.sql", import.meta.url)
  },
  {
    version: 9,
    name: "candidate_governance",
    path: new URL("../../migrations/0009-candidate-governance.sql", import.meta.url)
  },
  {
    version: 10,
    name: "retrieval_index",
    path: new URL("../../migrations/0010-retrieval-index.sql", import.meta.url)
  },
  {
    version: 11,
    name: "explicit_memory",
    path: new URL("../../migrations/0011-explicit-memory.sql", import.meta.url)
  },
  {
    version: 12,
    name: "governance_scheduling",
    path: new URL("../../migrations/0012-governance-scheduling.sql", import.meta.url)
  },
  {
    version: 13,
    name: "review_operations",
    path: new URL("../../migrations/0013-review-operations.sql", import.meta.url)
  },
  {
    version: 14,
    name: "archive_purge",
    path: new URL("../../migrations/0014-archive-purge.sql", import.meta.url)
  },
  {
    version: 15,
    name: "repair_workflow",
    path: new URL("../../migrations/0015-repair-workflow.sql", import.meta.url)
  },
  {
    version: 16,
    name: "shadow_runtime",
    path: new URL("../../migrations/0016-shadow-runtime.sql", import.meta.url)
  },
  {
    version: 17,
    name: "official_shadow_window",
    path: new URL("../../migrations/0017-official-shadow-window.sql", import.meta.url)
  },
  {
    version: 18,
    name: "candidate_maintenance",
    path: new URL("../../migrations/0018-candidate-maintenance.sql", import.meta.url)
  },
  {
    version: 19,
    name: "controlled_memory_categories",
    path: new URL("../../migrations/0019-controlled-memory-categories.sql", import.meta.url)
  },
  {
    version: 20,
    name: "remove_category_aliases",
    path: new URL("../../migrations/0020-remove-category-aliases.sql", import.meta.url)
  },
  {
    version: 21,
    name: "enforce_category_tag_invariants",
    path: new URL("../../migrations/0021-enforce-category-tag-invariants.sql", import.meta.url)
  },
  {
    version: 22,
    name: "luna_retry_epochs",
    path: new URL("../../migrations/0022-luna-retry-epochs.sql", import.meta.url)
  },
  {
    version: 23,
    name: "luna_safe_diagnostics_and_batch_splits",
    path: new URL("../../migrations/0023-luna-safe-diagnostics-and-batch-splits.sql", import.meta.url)
  },
  {
    version: 24,
    name: "backfill_luna_retry_epoch_attempts",
    path: new URL("../../migrations/0024-backfill-luna-retry-epoch-attempts.sql", import.meta.url)
  },
  {
    version: 25,
    name: "incremental_session_consolidation",
    path: new URL("../../migrations/0025-incremental-session-consolidation.sql", import.meta.url)
  },
  {
    version: 26,
    name: "reevaluate_generic_tool_evidence",
    path: new URL("../../migrations/0026-reevaluate-generic-tool-evidence.sql", import.meta.url)
  },
  {
    version: 27,
    name: "candidate_reevaluation_backfill",
    path: new URL("../../migrations/0027-candidate-reevaluation-backfill.sql", import.meta.url)
  },
  {
    version: 28,
    name: "candidate_durability",
    path: new URL("../../migrations/0028-candidate-durability.sql", import.meta.url)
  }
];

export interface OpenRuntimeDatabaseOptions {
  readonly busyTimeoutMilliseconds?: number;
}

export async function openRuntimeDatabase(
  runtimeRoot: string,
  options: OpenRuntimeDatabaseOptions = {}
): Promise<DatabaseSync> {
  const busyTimeoutMilliseconds = options.busyTimeoutMilliseconds ?? 250;
  if (
    !Number.isInteger(busyTimeoutMilliseconds) ||
    busyTimeoutMilliseconds < 0 ||
    busyTimeoutMilliseconds > 60_000
  ) {
    throw new Error("SQLite busy timeout must be an integer from 0 through 60000 milliseconds.");
  }
  const stateDirectory = join(runtimeRoot, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(join(stateDirectory, "memstore.sqlite"));

  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMilliseconds)}`);
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      source_sha256 TEXT NOT NULL,
      binary_version TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  for (const migration of migrations) {
    const source = await readFile(migration.path, "utf8");
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    const existing = database
      .prepare(
        "SELECT version, source_sha256 FROM schema_migrations WHERE version = ?"
      )
      .get(migration.version);
    if (existing !== undefined) {
      if (existing.source_sha256 !== sourceSha256) {
        database.close();
        throw new Error(
          `Migration ${String(migration.version)} source checksum does not match the applied schema.`
        );
      }
      continue;
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(source);
      database
        .prepare(
          `INSERT INTO schema_migrations(
             version, name, source_sha256, binary_version, applied_at
           ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          migration.version,
          migration.name,
          sourceSha256,
          "0.1.0",
          new Date().toISOString()
        );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      database.close();
      throw error;
    }
  }

  database
    .prepare(
      `INSERT OR IGNORE INTO runtime_identity(
         singleton, runtime_id, created_at
       ) VALUES (1, ?, ?)`
    )
    .run(`msruntime_${randomUUID()}`, new Date().toISOString());

  return database;
}
