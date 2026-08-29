import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";

import { probeRuntimeCompatibility } from "../../src/contracts/runtime-compatibility.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

test("the supported runtime provides the SQLite guarantees required by MemStore", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memstore-runtime-probe-"));
  temporaryDirectories.push(directory);

  const result = await probeRuntimeCompatibility(directory);

  expect(result).toEqual({
    nodeVersion: "22.17.0",
    sqliteVersion: "3.50.0",
    wal: true,
    foreignKeys: true,
    fts5: true,
    consistentBackup: true
  });
});

test("an applied migration with a changed checksum blocks database opening", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-migration-integrity-"));
  temporaryDirectories.push(root);
  const database = await openRuntimeDatabase(root);
  database.close();
  const rawDatabase = new DatabaseSync(join(root, "state", "memstore.sqlite"));
  rawDatabase
    .prepare("UPDATE schema_migrations SET source_sha256 = ? WHERE version = 1")
    .run("0".repeat(64));
  rawDatabase.close();

  await expect(openRuntimeDatabase(root)).rejects.toThrow("checksum");
});

test("a Runtime created from the applied foreground prototypes upgrades additively", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-foreground-migration-upgrade-"));
  temporaryDirectories.push(root);
  const initialized = await openRuntimeDatabase(root);
  initialized.close();

  const legacy = new DatabaseSync(join(root, "state", "memstore.sqlite"));
  legacy.exec(`
    DROP TABLE foreground_event_reservations;
    DROP TABLE foreground_attempt_maintenance;
    DROP TABLE foreground_attempt_overflow;
    DROP TRIGGER memory_catalog_retrieval_generation_insert;
    DROP TRIGGER memory_catalog_retrieval_generation_update;
    DROP TRIGGER memory_catalog_retrieval_generation_delete;
    DROP TABLE retrieval_catalog_generations;
    DELETE FROM schema_migrations WHERE version = 52;
  `);
  legacy.exec(await readFile(
    new URL("../../migrations/0051-retrieval-catalog-generations.sql", import.meta.url),
    "utf8"
  ));
  legacy.prepare(
    "UPDATE schema_migrations SET source_sha256 = ? WHERE version = 50"
  ).run("e9d119a01b26f058e09dacafaaf1d4efa7046402c43b4309d1c107d1452dacae");
  legacy.prepare(
    "UPDATE schema_migrations SET source_sha256 = ? WHERE version = 51"
  ).run("81ff9afc83092e6718c69e9f125fee9d7472977fcb18529dbb4abbf742ee1a13");
  legacy.close();

  await expect(openRuntimeDatabase(root)).rejects.toThrow(
    "Migration 52 has not been applied"
  );
  const stillLegacy = new DatabaseSync(join(root, "state", "memstore.sqlite"), {
    readOnly: true
  });
  expect(stillLegacy.prepare(
    "SELECT name FROM schema_migrations WHERE version = 52"
  ).get()).toBeUndefined();
  stillLegacy.close();

  const upgraded = await openRuntimeDatabase(root, { applyPendingMigrations: true });
  try {
    expect(upgraded.prepare(
      "SELECT name FROM schema_migrations WHERE version = 52"
    ).get()).toEqual({ name: "complete_foreground_reliability_schema" });
    expect(upgraded.prepare(
      "SELECT next_prune_at FROM foreground_attempt_maintenance WHERE singleton = 1"
    ).get()).toEqual({ next_prune_at: "1970-01-01T00:00:00.000Z" });
    expect(upgraded.prepare(
      "SELECT COUNT(*) AS count FROM foreground_attempt_overflow"
    ).get()).toEqual({ count: 0 });
    expect(upgraded.prepare(
      "SELECT COUNT(*) AS count FROM foreground_event_reservations"
    ).get()).toEqual({ count: 0 });
    expect(upgraded.prepare(
      `SELECT quiet_period_ms, maximum_staleness_ms
       FROM retrieval_catalog_generations WHERE singleton = 1`
    ).get()).toEqual({ quiet_period_ms: 30_000, maximum_staleness_ms: 120_000 });
    expect(upgraded.prepare(
      `SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'trigger' AND name LIKE 'memory_catalog_retrieval_generation_%'`
    ).get()).toEqual({ count: 3 });
  } finally {
    upgraded.close();
  }
});

test("opening an initialized Runtime does not compete for the SQLite writer lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-runtime-read-open-"));
  temporaryDirectories.push(root);
  const initialized = await openRuntimeDatabase(root);
  initialized.close();
  const writer = new DatabaseSync(join(root, "state", "memstore.sqlite"));
  writer.exec("BEGIN IMMEDIATE");
  try {
    const opened = await openRuntimeDatabase(root, { busyTimeoutMilliseconds: 25 });
    opened.close();
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
});

test("runtime initialization retires the full-history lexical index", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-retired-fts-"));
  temporaryDirectories.push(root);

  const database = await openRuntimeDatabase(root);
  try {
    expect(() => database.prepare("SELECT COUNT(*) FROM fts_memories").get())
      .toThrow("no such table: fts_memories");
    expect(database.prepare("SELECT COUNT(*) AS count FROM active_fts_memories").get())
      .toEqual({ count: 0 });
  } finally {
    database.close();
  }
});
