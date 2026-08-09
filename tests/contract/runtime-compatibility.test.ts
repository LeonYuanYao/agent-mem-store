import { mkdtemp, rm } from "node:fs/promises";
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
