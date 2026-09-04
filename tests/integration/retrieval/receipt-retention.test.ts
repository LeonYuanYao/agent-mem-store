import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { inspectStatus } from "../../../src/operations/status.js";
import { runWorkerOnce } from "../../../src/worker/main.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function insertReceipt(
  database: Awaited<ReturnType<typeof openRuntimeDatabase>>,
  receiptId: string,
  createdAt: string,
  itemCount: number
): void {
  database.prepare(
    `INSERT INTO retrieval_receipts(
       receipt_id, caller_kind, caller_identity, query_identity, normalized_query,
       scope_binding, project_id, index_revision_id, epoch_id,
       rendered_token_count, automatic_epoch_total, budget_tier, semantic_stage,
       empty_reason, soft_target_restricted, hard_limit_blocked, rows_examined,
       bucket_page_count, terminal_stop_reason, omitted_item_count,
       omission_details_truncated, latency_ms, created_at, timing_json
     ) VALUES (?, 'user_prompt', 'caller', 'query', 'normalized query',
       'global', NULL, NULL, NULL, 12, NULL, 'default', 'not_applicable',
       NULL, 0, 0, 3, 1, 'complete', 0, 0, 4.5, ?, '{}')`
  ).run(receiptId, createdAt);
  const insertItem = database.prepare(
    `INSERT INTO retrieval_receipt_items(
       receipt_id, memory_id, revision_id, rank_ordinal, relevance_band,
       representation_kind, rendered_token_count, score, reasons_json,
       outcome, omission_reason
     ) VALUES (?, ?, ?, ?, 'probable', 'compact', 6, 3, '[]', ?, ?)`
  );
  for (let index = 0; index < itemCount; index += 1) {
    const selected = index === 0;
    insertItem.run(
      receiptId,
      `msmem_${receiptId}_${String(index)}`,
      `msrev_${receiptId}_${String(index)}`,
      index,
      selected ? "selected" : "omitted",
      selected ? null : "item_limit"
    );
  }
}

test("the Worker aggregates and removes expired Injection Receipts while protecting reported Bad Cases", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-receipt-retention-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    insertReceipt(database, "msreceipt_expired", "2026-07-01T00:00:00.000Z", 2);
    insertReceipt(database, "msreceipt_protected", "2026-07-02T00:00:00.000Z", 1);
    insertReceipt(database, "msreceipt_recent", "2026-08-15T00:00:00.000Z", 1);
    database.prepare(
      `INSERT INTO foreground_event_reservations(
         event_id, event_kind, state, receipt_id, attempt_count, last_error_code,
         next_retry_at, created_at, updated_at
       ) VALUES ('event-expired', 'UserPromptSubmit', 'completed',
         'msreceipt_expired', 1, NULL, NULL,
         '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`
    ).run();
    database.prepare(
      `INSERT INTO bad_cases(
         bad_case_id, signature, kind, component, project_id, severity,
         occurrence_count, first_seen_at, last_seen_at, state, reminder_state,
         diagnostic_bundle_path, diagnostic_bundle_sha256
       ) VALUES ('msbadcase_protected', 'signature-protected',
         'irrelevant_retrieval', 'ranking', NULL, 'normal', 1,
         '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z',
         'open', 'pending', 'badcases/protected.json',
         'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`
    ).run();
    database.prepare(
      `INSERT INTO irrelevant_observations(
         observation_id, receipt_id, memory_id, revision_id,
         caller_identity, bad_case_id, observed_at
       ) VALUES ('observation-protected', 'msreceipt_protected',
         'msmem_msreceipt_protected_0', 'msrev_msreceipt_protected_0',
         'caller', 'msbadcase_protected', '2026-07-02T00:00:00.000Z')`
    ).run();
  } finally {
    database.close();
  }

  const result = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "worker-receipt-retention",
    now: "2026-09-01T00:00:00.000Z",
    workerStartedAt: "2026-09-01T00:00:00.000Z"
  });

  expect(result.activities).toContain("receipt-retention:pruned:1/2");
  const inspected = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(inspected.prepare(
      "SELECT receipt_id FROM retrieval_receipts ORDER BY receipt_id"
    ).all()).toEqual([
      { receipt_id: "msreceipt_protected" },
      { receipt_id: "msreceipt_recent" }
    ]);
    expect(inspected.prepare(
      "SELECT receipt_id FROM foreground_event_reservations WHERE event_id = 'event-expired'"
    ).get()).toEqual({ receipt_id: null });
    expect(inspected.prepare(
      `SELECT summary_date, caller_kind, receipt_count, rendered_token_count,
              selected_item_count, omitted_item_count, latency_ms_total
       FROM retrieval_receipt_daily_summaries`
    ).all()).toEqual([{
      summary_date: "2026-07-01",
      caller_kind: "user_prompt",
      receipt_count: 1,
      rendered_token_count: 12,
      selected_item_count: 1,
      omitted_item_count: 1,
      latency_ms_total: 4.5
    }]);
  } finally {
    inspected.close();
  }

  await expect(inspectStatus({ runtimeRoot, vaultRoot })).resolves.toMatchObject({
    injection_receipt_retention: {
      retention_days: 30,
      receipt_count: 2,
      item_count: 2,
      expired_eligible_count: 0,
      expired_protected_count: 1,
      daily_summary_count: 1,
      last_deleted_receipt_count: 1,
      last_deleted_item_count: 2,
      total_deleted_receipt_count: 1,
      total_deleted_item_count: 2,
      last_error_code: null,
      consecutive_failure_count: 0
    }
  });
});

test("the Worker catches up an Injection Receipt backlog in bounded batches", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-receipt-catch-up-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < 1_001; index += 1) {
      insertReceipt(
        database,
        `msreceipt_backlog_${String(index).padStart(4, "0")}`,
        "2026-07-01T00:00:00.000Z",
        0
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }

  const first = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "worker-receipt-catch-up",
    now: "2026-09-01T00:00:00.000Z",
    workerStartedAt: "2026-09-01T00:00:00.000Z"
  });
  expect(first.activities).toContain("receipt-retention:pruned:1000/0");

  const beforeCatchUp = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "worker-receipt-catch-up",
    now: "2026-09-01T00:00:29.000Z",
    workerStartedAt: "2026-09-01T00:00:00.000Z"
  });
  expect(beforeCatchUp.activities ?? []).not.toContain("receipt-retention:pruned:1/0");

  const catchUp = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "worker-receipt-catch-up",
    now: "2026-09-01T00:00:30.000Z",
    workerStartedAt: "2026-09-01T00:00:00.000Z"
  });
  expect(catchUp.activities).toContain("receipt-retention:pruned:1/0");
});

test("Injection Receipt retention failures stay local, retry, and remain visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-receipt-retry-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    insertReceipt(database, "msreceipt_delete_failure", "2026-07-01T00:00:00.000Z", 1);
    database.exec(
      `CREATE TRIGGER test_block_receipt_delete
       BEFORE DELETE ON retrieval_receipts
       BEGIN
         SELECT RAISE(ABORT, 'test receipt delete failure');
       END`
    );
  } finally {
    database.close();
  }

  const result = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "worker-receipt-retry",
    now: "2026-09-01T00:00:00.000Z",
    workerStartedAt: "2026-09-01T00:00:00.000Z"
  });

  expect(result.activities).toContain("receipt-retention:failed:Error");
  await expect(inspectStatus({ runtimeRoot, vaultRoot })).resolves.toMatchObject({
    injection_receipt_retention: {
      receipt_count: 1,
      item_count: 1,
      last_error_code: "Error",
      consecutive_failure_count: 1,
      next_check_at: "2026-09-01T00:05:00Z"
    }
  });
});

test("Injection Receipt retention yields to foreground retrieval pressure", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-receipt-pressure-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    insertReceipt(database, "msreceipt_foreground_pressure", "2026-07-01T00:00:00.000Z", 1);
  } finally {
    database.close();
  }

  await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "worker-receipt-pressure",
    now: "2026-09-01T00:00:00.000Z",
    workerStartedAt: "2026-09-01T00:00:00.000Z",
    adapters: { foregroundPressure: () => true }
  });
  const retained = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(retained.prepare(
      "SELECT COUNT(*) AS count FROM retrieval_receipts"
    ).get()).toEqual({ count: 1 });
  } finally {
    retained.close();
  }

  const resumed = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "worker-receipt-pressure",
    now: "2026-09-01T00:00:01.000Z",
    workerStartedAt: "2026-09-01T00:00:00.000Z",
    adapters: { foregroundPressure: () => false }
  });
  expect(resumed.activities).toContain("receipt-retention:pruned:1/1");
});
