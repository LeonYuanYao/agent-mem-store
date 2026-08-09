import { access } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

export interface RuntimeCompatibility {
  readonly nodeVersion: string;
  readonly sqliteVersion: string;
  readonly wal: boolean;
  readonly foreignKeys: boolean;
  readonly fts5: boolean;
  readonly consistentBackup: boolean;
}

function firstValue(row: Record<string, unknown> | undefined): unknown {
  return row === undefined ? undefined : Object.values(row)[0];
}

export async function probeRuntimeCompatibility(
  directory: string
): Promise<RuntimeCompatibility> {
  const databasePath = join(directory, "probe.sqlite");
  const backupPath = join(directory, "probe.backup.sqlite");
  const database = new DatabaseSync(databasePath);

  try {
    const journalMode = firstValue(database.prepare("PRAGMA journal_mode = WAL").get());
    database.exec("PRAGMA foreign_keys = ON");
    const foreignKeys = firstValue(database.prepare("PRAGMA foreign_keys").get());
    const sqliteVersion = firstValue(
      database.prepare("SELECT sqlite_version() AS version").get()
    );

    database.exec("CREATE VIRTUAL TABLE probe_fts USING fts5(body)");
    database.exec("CREATE TABLE probe_data (value TEXT NOT NULL)");
    database.prepare("INSERT INTO probe_data(value) VALUES (?)").run("durable");

    await backup(database, backupPath);
    await access(backupPath);

    const backupDatabase = new DatabaseSync(backupPath, { readOnly: true });
    let consistentBackup = false;
    try {
      consistentBackup =
        firstValue(backupDatabase.prepare("SELECT value FROM probe_data").get()) ===
        "durable";
    } finally {
      backupDatabase.close();
    }

    return {
      nodeVersion: process.versions.node,
      sqliteVersion: typeof sqliteVersion === "string" ? sqliteVersion : "unknown",
      wal: journalMode === "wal",
      foreignKeys: foreignKeys === 1,
      fts5: true,
      consistentBackup
    };
  } finally {
    database.close();
  }
}
