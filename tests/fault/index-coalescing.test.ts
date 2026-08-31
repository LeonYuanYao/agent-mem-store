import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  beginRetrievalIndexBuild,
  completeRetrievalIndexBuild,
  failRetrievalIndexBuild,
  inspectRetrievalCatalogGeneration
} from "../../src/retrieval/index-coordinator.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memstore-index-coordinator-"));
  roots.push(root);
  return root;
}

function insertCatalogRows(
  database: Awaited<ReturnType<typeof openRuntimeDatabase>>,
  count: number,
  offset = 0
): void {
  const insert = database.prepare(
    `INSERT INTO memory_catalog(
       memory_id, current_revision_id, canonical_path, scope_kind, project_id,
       authority, sensitivity, lifecycle, content_identity, revised_at, catalog_updated_at
     ) VALUES (?, ?, ?, 'global', NULL, 'agent_derived', 'normal', 'active', ?, ?, ?)`
  );
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    const identity = ordinal + offset;
    insert.run(
      `msmem_coalescing_${String(identity)}`,
      `msrev_coalescing_${String(identity)}`,
      `/vault/coalescing-${String(identity)}.md`,
      `identity-${String(identity)}`,
      "2026-08-26T18:00:00.000Z",
      "2026-08-26T18:00:00.000Z"
    );
  }
}

test("one hundred catalog changes produce one build and at most one follow-up", async () => {
  const runtimeRoot = await createRoot();
  const database = await openRuntimeDatabase(runtimeRoot);
  insertCatalogRows(database, 100);
  database.prepare(
    `UPDATE retrieval_catalog_generations
     SET dirty_at = ?, force_due_at = ? WHERE singleton = 1`
  ).run("2026-08-26T18:00:00.000Z", "2026-08-26T18:02:00.000Z");
  database.close();

  await expect(inspectRetrievalCatalogGeneration(runtimeRoot)).resolves.toMatchObject({
    dirtyGeneration: 100,
    publishedGeneration: 0,
    buildingGeneration: null
  });
  const first = await beginRetrievalIndexBuild({
    runtimeRoot,
    now: "2026-08-26T18:01:00.000Z",
    activeIndexExists: true,
    adapterMatches: true,
    foregroundPressure: false
  });
  expect(first).toEqual({ state: "started", targetGeneration: 100, reason: "quiet_period" });

  const changing = await openRuntimeDatabase(runtimeRoot);
  insertCatalogRows(changing, 100, 100);
  changing.prepare(
    "UPDATE retrieval_catalog_generations SET dirty_at = ? WHERE singleton = 1"
  ).run("2026-08-26T18:01:10.000Z");
  changing.close();
  await completeRetrievalIndexBuild({
    runtimeRoot,
    targetGeneration: 100,
    completedAt: "2026-08-26T18:01:05.000Z"
  });
  await expect(inspectRetrievalCatalogGeneration(runtimeRoot)).resolves.toMatchObject({
    dirtyGeneration: 200,
    publishedGeneration: 100,
    buildingGeneration: null
  });

  const followUp = await beginRetrievalIndexBuild({
    runtimeRoot,
    now: "2026-08-26T18:02:00.000Z",
    activeIndexExists: true,
    adapterMatches: true,
    foregroundPressure: false
  });
  expect(followUp).toMatchObject({ state: "started", targetGeneration: 200 });
  await completeRetrievalIndexBuild({
    runtimeRoot,
    targetGeneration: 200,
    completedAt: "2026-08-26T18:02:05.000Z"
  });
  await expect(beginRetrievalIndexBuild({
    runtimeRoot,
    now: "2026-08-26T18:03:00.000Z",
    activeIndexExists: true,
    adapterMatches: true,
    foregroundPressure: false
  })).resolves.toEqual({ state: "not_due", reason: "clean" });
});

test("foreground pressure yields quiet builds but not force-due work", async () => {
  const runtimeRoot = await createRoot();
  const database = await openRuntimeDatabase(runtimeRoot);
  insertCatalogRows(database, 1);
  database.prepare(
    `UPDATE retrieval_catalog_generations
     SET dirty_at = ?, force_due_at = ? WHERE singleton = 1`
  ).run("2026-08-26T18:00:00.000Z", "2026-08-26T18:02:00.000Z");
  database.close();

  await expect(beginRetrievalIndexBuild({
    runtimeRoot,
    now: "2026-08-26T18:01:00.000Z",
    activeIndexExists: true,
    adapterMatches: true,
    foregroundPressure: true
  })).resolves.toEqual({ state: "not_due", reason: "foreground_pressure" });
  await expect(beginRetrievalIndexBuild({
    runtimeRoot,
    now: "2026-08-26T18:02:00.000Z",
    activeIndexExists: true,
    adapterMatches: true,
    foregroundPressure: true
  })).resolves.toEqual({ state: "started", targetGeneration: 1, reason: "force_due" });
});

test("recovery mode coalesces small generation advances and always yields to foreground pressure", async () => {
  const runtimeRoot = await createRoot();
  const database = await openRuntimeDatabase(runtimeRoot);
  insertCatalogRows(database, 100);
  database.prepare(
    `UPDATE retrieval_catalog_generations
     SET dirty_at = ?, force_due_at = ? WHERE singleton = 1`
  ).run("2026-08-26T18:00:00.000Z", "2026-08-26T18:02:00.000Z");
  database.close();

  const initial = await beginRetrievalIndexBuild({
    runtimeRoot,
    now: "2026-08-26T18:05:00.000Z",
    activeIndexExists: true,
    adapterMatches: true,
    foregroundPressure: false,
    recoveryMode: true
  });
  expect(initial).toEqual({
    state: "started",
    targetGeneration: 100,
    reason: "recovery_batch"
  });
  await completeRetrievalIndexBuild({
    runtimeRoot,
    targetGeneration: 100,
    completedAt: "2026-08-26T18:05:05.000Z"
  });

  const changing = await openRuntimeDatabase(runtimeRoot);
  insertCatalogRows(changing, 10, 100);
  changing.prepare(
    `UPDATE retrieval_catalog_generations
     SET dirty_at = ?, force_due_at = ? WHERE singleton = 1`
  ).run("2026-08-26T18:06:00.000Z", "2026-08-26T18:08:00.000Z");
  changing.close();

  await expect(beginRetrievalIndexBuild({
    runtimeRoot,
    now: "2026-08-26T18:15:00.000Z",
    activeIndexExists: true,
    adapterMatches: true,
    foregroundPressure: false,
    recoveryMode: true
  })).resolves.toEqual({ state: "not_due", reason: "recovery_coalescing" });
  await expect(beginRetrievalIndexBuild({
    runtimeRoot,
    now: "2026-08-26T18:36:00.000Z",
    activeIndexExists: true,
    adapterMatches: true,
    foregroundPressure: true,
    recoveryMode: true
  })).resolves.toEqual({ state: "not_due", reason: "foreground_pressure" });
  await expect(beginRetrievalIndexBuild({
    runtimeRoot,
    now: "2026-08-26T18:36:00.000Z",
    activeIndexExists: true,
    adapterMatches: true,
    foregroundPressure: false,
    recoveryMode: true
  })).resolves.toEqual({
    state: "started",
    targetGeneration: 110,
    reason: "recovery_staleness"
  });
});

test("failed builds respect a five-minute cooldown", async () => {
  const runtimeRoot = await createRoot();
  const database = await openRuntimeDatabase(runtimeRoot);
  insertCatalogRows(database, 1);
  database.close();
  const started = await beginRetrievalIndexBuild({
    runtimeRoot,
    now: "2026-08-26T18:01:00.000Z",
    activeIndexExists: false,
    adapterMatches: false,
    foregroundPressure: false
  });
  if (started.state !== "started") throw new Error("Expected an immediate initial build.");
  await failRetrievalIndexBuild({
    runtimeRoot,
    targetGeneration: started.targetGeneration,
    failedAt: "2026-08-26T18:01:01.000Z"
  });

  await expect(beginRetrievalIndexBuild({
    runtimeRoot,
    now: "2026-08-26T18:05:59.000Z",
    activeIndexExists: false,
    adapterMatches: false,
    foregroundPressure: false
  })).resolves.toEqual({ state: "not_due", reason: "failure_cooldown" });
  await expect(beginRetrievalIndexBuild({
    runtimeRoot,
    now: "2026-08-26T18:06:01.000Z",
    activeIndexExists: false,
    adapterMatches: false,
    foregroundPressure: false
  })).resolves.toMatchObject({ state: "started", reason: "index_unavailable" });
});
