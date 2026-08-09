import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";

import { createRuntimeBackup } from "../../../src/operations/portability.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("online backup contains the latest committed WAL state", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-online-backup-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const backupPath = join(root, "backup", "memstore.sqlite");
  const live = await openRuntimeDatabase(runtimeRoot);
  try {
    live.prepare(
      `INSERT INTO worker_control(singleton, capture_paused, worker_paused, updated_at, reason)
       VALUES (1, 1, 1, '2026-08-08T06:00:00.000Z', 'wal-proof')`
    ).run();
    await createRuntimeBackup({
      runtimeRoot,
      destinationPath: backupPath,
      createdAt: "2026-08-08T06:01:00.000Z"
    });
  } finally {
    live.close();
  }

  const copy = new DatabaseSync(backupPath, { readOnly: true });
  try {
    expect(copy.prepare("SELECT reason FROM worker_control WHERE singleton = 1").get()).toEqual({
      reason: "wal-proof"
    });
    expect(copy.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    copy.close();
  }
});
