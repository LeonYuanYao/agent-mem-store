import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";

import { initializeMemStore } from "../../../src/operations/initialize.js";
import { inspectStatus } from "../../../src/operations/status.js";
import { runScheduledSensitivityRetention } from "../../../src/sensitivity/retention.js";
import { runWorkerOnce } from "../../../src/worker/main.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("scheduled sensitivity retention removes metadata after fifteen quiet days", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-sensitivity-retention-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });

  const databasePath = join(runtimeRoot, "state", "memstore.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare(
      `INSERT INTO sensitivity_findings(
         finding_id, fingerprint, state, category, first_seen_at,
         last_seen_at, occurrence_count, body_retained
       ) VALUES (?, ?, 'quarantined', 'contextual_credential', ?, ?, ?, 0)`
    ).run("expired", "expired-fingerprint", "2026-08-01T00:00:00.000Z", "2026-08-16T00:00:00.000Z", 2);
    database.prepare(
      `INSERT INTO sensitivity_findings(
         finding_id, fingerprint, state, category, first_seen_at,
         last_seen_at, occurrence_count, body_retained
       ) VALUES (?, ?, 'quarantined', 'contextual_credential', ?, ?, ?, 0)`
    ).run("active", "active-fingerprint", "2026-08-01T00:00:00.000Z", "2026-08-20T00:00:00.000Z", 2);
    const insertObservation = database.prepare(
      `INSERT INTO sensitivity_observations(
         fingerprint, source_identity, observed_at, source_kind
       ) VALUES (?, ?, ?, 'codex:PostToolUse')`
    );
    insertObservation.run("expired-fingerprint", "expired-source", "2026-08-16T00:00:00.000Z");
    insertObservation.run("active-fingerprint", "active-old-source", "2026-08-10T00:00:00.000Z");
    insertObservation.run("active-fingerprint", "active-recent-source", "2026-08-20T00:00:00.000Z");
  } finally {
    database.close();
  }

  const result = await runScheduledSensitivityRetention({
    runtimeRoot,
    vaultRoot,
    now: "2026-08-31T00:00:00.000Z"
  });

  expect(result).toMatchObject({
    state: "completed",
    retentionDays: 15,
    deletedFindingCount: 1,
    deletedObservationCount: 2,
    hasMore: false,
    nextCheckAt: "2026-08-31T06:00:00Z"
  });
  await expect(inspectStatus({ runtimeRoot, vaultRoot })).resolves.toMatchObject({
    sensitivity_retention: {
      metadata_retention_days: 15,
      next_check_at: "2026-08-31T06:00:00Z",
      last_checked_at: "2026-08-31T00:00:00.000Z",
      last_completed_at: "2026-08-31T00:00:00.000Z",
      last_error_code: null,
      consecutive_failure_count: 0,
      last_deleted_finding_count: 1,
      last_deleted_observation_count: 2,
      total_deleted_finding_count: 1,
      total_deleted_observation_count: 2
    }
  });
  const inspected = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(inspected.prepare(
      "SELECT finding_id FROM sensitivity_findings ORDER BY finding_id"
    ).all()).toEqual([{ finding_id: "active" }]);
    expect(inspected.prepare(
      "SELECT source_identity FROM sensitivity_observations ORDER BY source_identity"
    ).all()).toEqual([{ source_identity: "active-recent-source" }]);
  } finally {
    inspected.close();
  }
});

test("the Worker catches up sensitivity retention in bounded batches", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-sensitivity-worker-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });

  const databasePath = join(runtimeRoot, "state", "memstore.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("BEGIN");
    database.prepare(
      `INSERT INTO sensitivity_findings(
         finding_id, fingerprint, state, category, first_seen_at,
         last_seen_at, occurrence_count, body_retained
       ) VALUES (?, ?, 'blocked_secret', 'credential_field', ?, ?, ?, 0)`
    ).run("backlog", "backlog-fingerprint", "2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", 501);
    const insertObservation = database.prepare(
      `INSERT INTO sensitivity_observations(
         fingerprint, source_identity, observed_at, source_kind
       ) VALUES ('backlog-fingerprint', ?, '2026-08-01T00:00:00.000Z', 'codex:PostToolUse')`
    );
    for (let index = 0; index < 501; index += 1) {
      insertObservation.run(`source-${String(index).padStart(3, "0")}`);
    }
    database.exec("COMMIT");
  } finally {
    database.close();
  }

  const first = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "sensitivity-retention-test-worker",
    now: "2026-08-31T00:00:00.000Z",
    workerStartedAt: "2026-08-30T23:00:00.000Z"
  });
  const beforeCatchUp = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "sensitivity-retention-test-worker",
    now: "2026-08-31T00:00:29.000Z",
    workerStartedAt: "2026-08-30T23:00:00.000Z"
  });
  const caughtUp = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "sensitivity-retention-test-worker",
    now: "2026-08-31T00:00:30.000Z",
    workerStartedAt: "2026-08-30T23:00:00.000Z"
  });

  expect(first.activities).toContain("sensitivity-retention:pruned:0/500");
  expect(beforeCatchUp.activities ?? []).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/^sensitivity-retention:/u)])
  );
  expect(caughtUp.activities).toContain("sensitivity-retention:pruned:1/1");
  const inspected = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM sensitivity_findings").get())
      .toEqual({ count: 0 });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM sensitivity_observations").get())
      .toEqual({ count: 0 });
  } finally {
    inspected.close();
  }
});

test("sensitivity retention records a local failure and schedules an automatic retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-sensitivity-retry-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  await writeFile(
    join(vaultRoot, "_MemStore", "policy.toml"),
    "schema_version = 2\n",
    "utf8"
  );

  const result = await runScheduledSensitivityRetention({
    runtimeRoot,
    vaultRoot,
    now: "2026-08-31T00:00:00.000Z"
  });

  expect(result).toMatchObject({
    state: "failed",
    retentionDays: 15,
    deletedFindingCount: 0,
    deletedObservationCount: 0,
    nextCheckAt: "2026-08-31T00:05:00Z",
    errorCode: "Error"
  });
  const database = new DatabaseSync(join(runtimeRoot, "state", "memstore.sqlite"), {
    readOnly: true
  });
  try {
    expect(database.prepare(
      `SELECT consecutive_failure_count, last_error_code, next_check_at
       FROM sensitivity_retention_maintenance WHERE singleton = 1`
    ).get()).toEqual({
      consecutive_failure_count: 1,
      last_error_code: "Error",
      next_check_at: "2026-08-31T00:05:00Z"
    });
  } finally {
    database.close();
  }
});
