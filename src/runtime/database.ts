import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly path: URL;
}

interface LoadedMigration extends Migration {
  readonly source: string;
  readonly sourceSha256: string;
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
  },
  {
    version: 29,
    name: "distillation_selection_indexes",
    path: new URL("../../migrations/0029-distillation-selection-indexes.sql", import.meta.url)
  },
  {
    version: 30,
    name: "memory_quality_pipeline",
    path: new URL("../../migrations/0030-memory-quality-pipeline.sql", import.meta.url)
  },
  {
    version: 31,
    name: "memory_duplicate_clusters",
    path: new URL("../../migrations/0031-memory-duplicate-clusters.sql", import.meta.url)
  },
  {
    version: 32,
    name: "duplicate_discovery_schedule",
    path: new URL("../../migrations/0032-duplicate-discovery-schedule.sql", import.meta.url)
  },
  {
    version: 33,
    name: "governance_review_due_action",
    path: new URL("../../migrations/0033-governance-review-due-action.sql", import.meta.url)
  },
  {
    version: 34,
    name: "memory_quality_schedule",
    path: new URL("../../migrations/0034-memory-quality-schedule.sql", import.meta.url)
  },
  {
    version: 35,
    name: "governance_retry_epochs",
    path: new URL("../../migrations/0035-governance-retry-epochs.sql", import.meta.url)
  },
  {
    version: 36,
    name: "memory_quality_retry_diagnostics",
    path: new URL("../../migrations/0036-memory-quality-retry-diagnostics.sql", import.meta.url)
  },
  {
    version: 37,
    name: "clear_terminal_quality_errors",
    path: new URL("../../migrations/0037-clear-terminal-quality-errors.sql", import.meta.url)
  },
  {
    version: 38,
    name: "model_health_reminder_content",
    path: new URL("../../migrations/0038-model-health-reminder-content.sql", import.meta.url)
  },
  {
    version: 39,
    name: "retrieval_stage_timings",
    path: new URL("../../migrations/0039-retrieval-stage-timings.sql", import.meta.url)
  },
  {
    version: 40,
    name: "retrieval_snapshot_retention",
    path: new URL("../../migrations/0040-retrieval-snapshot-retention.sql", import.meta.url)
  },
  {
    version: 41,
    name: "active_retrieval_fts",
    path: new URL("../../migrations/0041-active-retrieval-fts.sql", import.meta.url)
  },
  {
    version: 42,
    name: "automatic_retrieval_receipt_indexes",
    path: new URL("../../migrations/0042-automatic-retrieval-receipt-indexes.sql", import.meta.url)
  },
  {
    version: 43,
    name: "capture_session_activity_index",
    path: new URL("../../migrations/0043-capture-session-activity-index.sql", import.meta.url)
  },
  {
    version: 44,
    name: "remove_shadow_invalidation",
    path: new URL("../../migrations/0044-remove-shadow-invalidation.sql", import.meta.url)
  },
  {
    version: 45,
    name: "drop_retired_retrieval_fts",
    path: new URL("../../migrations/0045-drop-retired-retrieval-fts.sql", import.meta.url)
  },
  {
    version: 46,
    name: "admission_audit",
    path: new URL("../../migrations/0046-admission-audit.sql", import.meta.url)
  },
  {
    version: 47,
    name: "redact_admission_audit_hashes",
    path: new URL("../../migrations/0047-redact-admission-audit-hashes.sql", import.meta.url)
  },
  {
    version: 48,
    name: "knowledge_verification_runs",
    path: new URL("../../migrations/0048-knowledge-verification-runs.sql", import.meta.url)
  },
  {
    version: 49,
    name: "sensitivity_observation_source_kind",
    path: new URL("../../migrations/0049-sensitivity-observation-source-kind.sql", import.meta.url)
  },
  {
    version: 50,
    name: "foreground_attempts",
    path: new URL("../../migrations/0050-foreground-attempts.sql", import.meta.url)
  },
  {
    version: 51,
    name: "retrieval_catalog_generations",
    path: new URL("../../migrations/0051-retrieval-catalog-generations.sql", import.meta.url)
  },
  {
    version: 52,
    name: "complete_foreground_reliability_schema",
    path: new URL(
      "../../migrations/0052-complete-foreground-reliability-schema.sql",
      import.meta.url
    )
  },
  {
    version: 53,
    name: "portable_memory_refs",
    path: new URL("../../migrations/0053-portable-memory-refs.sql", import.meta.url)
  },
  {
    version: 54,
    name: "context_memory_legend",
    path: new URL("../../migrations/0054-context-memory-legend.sql", import.meta.url)
  }
];

let loadedMigrationsPromise: Promise<readonly LoadedMigration[]> | undefined;

function loadMigrations(): Promise<readonly LoadedMigration[]> {
  loadedMigrationsPromise ??= Promise.all(migrations.map(async (migration) => {
    const source = await readFile(migration.path, "utf8");
    return {
      ...migration,
      source,
      sourceSha256: createHash("sha256").update(source).digest("hex")
    };
  }));
  return loadedMigrationsPromise;
}

export interface OpenRuntimeDatabaseOptions {
  readonly busyTimeoutMilliseconds?: number;
  readonly applyPendingMigrations?: boolean;
}

export async function openRuntimeDatabaseReadOnly(
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
  const database = new DatabaseSync(join(runtimeRoot, "state", "memstore.sqlite"), {
    readOnly: true
  });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMilliseconds)}`);
    const loadedMigrations = await loadMigrations();
    const existingMigrations = new Map(
      database.prepare(
        "SELECT version, source_sha256 FROM schema_migrations ORDER BY version"
      ).all().map((row) => [row.version, row.source_sha256])
    );
    for (const migration of loadedMigrations) {
      const existingSourceSha256 = existingMigrations.get(migration.version);
      if (existingSourceSha256 === undefined) {
        throw new Error(
          `Migration ${String(migration.version)} has not been applied to this Runtime.`
        );
      }
      if (existingSourceSha256 !== migration.sourceSha256) {
        throw new Error(
          `Migration ${String(migration.version)} source checksum does not match the applied schema.`
        );
      }
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
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
  const databasePath = join(stateDirectory, "memstore.sqlite");
  const databaseExisted = await access(databasePath)
    .then(() => true)
    .catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) return false;
      throw error;
    });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databasePath);

  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMilliseconds)}`);
  if (!databaseExisted || options.applyPendingMigrations === true) {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        binary_version TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT
    `);
  }

  const loadedMigrations = await loadMigrations();
  const existingMigrations = new Map(
    database.prepare(
      "SELECT version, source_sha256 FROM schema_migrations ORDER BY version"
    ).all().map((row) => [row.version, row.source_sha256])
  );
  for (const migration of loadedMigrations) {
    const existingSourceSha256 = existingMigrations.get(migration.version);
    const existing = existingSourceSha256 === undefined
      ? undefined
      : { source_sha256: existingSourceSha256 };
    if (existing !== undefined) {
      if (existing.source_sha256 !== migration.sourceSha256) {
        database.close();
        throw new Error(
          `Migration ${String(migration.version)} source checksum does not match the applied schema.`
        );
      }
      continue;
    }
    if (databaseExisted && options.applyPendingMigrations !== true) {
      database.close();
      throw new Error(
        `Migration ${String(migration.version)} has not been applied to this Runtime.`
      );
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.source);
      database
        .prepare(
          `INSERT INTO schema_migrations(
             version, name, source_sha256, binary_version, applied_at
           ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          migration.version,
          migration.name,
          migration.sourceSha256,
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

  const runtimeIdentity = database
    .prepare("SELECT runtime_id FROM runtime_identity WHERE singleton = 1")
    .get();
  if (runtimeIdentity === undefined) {
    if (databaseExisted && options.applyPendingMigrations !== true) {
      database.close();
      throw new Error("Runtime identity is missing from an existing Runtime.");
    }
    database
      .prepare(
        `INSERT INTO runtime_identity(
           singleton, runtime_id, created_at
         ) VALUES (1, ?, ?)`
      )
      .run(`msruntime_${randomUUID()}`, new Date().toISOString());
  }

  return database;
}
