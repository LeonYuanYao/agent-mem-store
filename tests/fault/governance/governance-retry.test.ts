import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { captureEvent } from "../../../src/capture/index.js";
import { initializeGovernanceSchedule, scheduleDueGovernance } from "../../../src/governance/scheduling.js";
import { runNextGovernanceStep, type GovernanceAdapter } from "../../../src/governance/worker.js";
import { LunaInvocationError } from "../../../src/luna/index.js";
import { inspectLunaHealth } from "../../../src/luna/operations.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { runWorkerOnce } from "../../../src/worker/main.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("foreground work wins and a Luna outage retries without advancing coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-governance-retry-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory: makeCanonicalMemory({
      memoryId: `msmem_${randomUUID()}`,
      revisionId: `msrev_${randomUUID()}`,
      body: "A memory reviewed after retry.",
      authority: "agent_derived"
    })
  });
  await initializeGovernanceSchedule({
    runtimeRoot,
    timeZone: "UTC",
    registeredAt: "2026-08-04T00:00:00.000Z",
    startupDelaySeconds: 600
  });
  const scheduled = await scheduleDueGovernance({
    runtimeRoot,
    now: "2026-08-10T19:01:00.000Z",
    workerStartedAt: "2026-08-10T18:00:00.000Z"
  });
  if (scheduled.state !== "scheduled") throw new Error("Expected governance run.");
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent-governance-foreground",
      deduplicationKey: "governance:foreground",
      agent: "codex",
      eventKind: "UserPromptSubmit",
      occurredAt: "2026-08-10T19:01:30.000Z",
      payload: { text: "Foreground capture must run first." }
    }
  });
  const adapter: GovernanceAdapter = {
    reviewPage() {
      throw new LunaInvocationError("unavailable", true, "temporary outage");
    }
  };
  await expect(runNextGovernanceStep({
    runtimeRoot, vaultRoot, now: "2026-08-10T19:02:00.000Z", adapter
  })).resolves.toEqual({ state: "yielded", reason: "foreground_backlog" });

  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare("UPDATE capture_events SET state = 'completed'").run();
    database.prepare(
      `INSERT INTO retrieval_index_build_activity(
         singleton, build_id, state, started_at, lease_until
       ) VALUES (1, 'index-build-test', 'building', ?, ?)`
    ).run("2026-08-10T19:01:00.000Z", "2026-08-10T20:00:00.000Z");
  } finally {
    database.close();
  }
  await expect(runNextGovernanceStep({
    runtimeRoot, vaultRoot, now: "2026-08-10T19:02:30.000Z", adapter
  })).resolves.toEqual({ state: "yielded", reason: "foreground_backlog" });
  const completedIndexDatabase = await openRuntimeDatabase(runtimeRoot);
  try {
    completedIndexDatabase.prepare(
      "UPDATE retrieval_index_build_activity SET state = 'complete', completed_at = ?, lease_until = ?"
    ).run("2026-08-10T19:02:31.000Z", "2026-08-10T19:02:31.000Z");
  } finally {
    completedIndexDatabase.close();
  }
  const failed = await runNextGovernanceStep({
    runtimeRoot, vaultRoot, now: "2026-08-10T19:03:00.000Z", adapter
  });
  if (failed.state !== "retrying") throw new Error("Expected retrying governance.");
  expect(await inspectLunaHealth({
    runtimeRoot, now: "2026-08-10T19:03:01.000Z"
  })).toMatchObject({ consecutiveFailures: 1, reasonCategory: "unavailable" });
  const cursorDatabase = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(cursorDatabase.prepare(
      "SELECT successful_through FROM governance_cursors WHERE cadence = 'weekly'"
    ).get()).toEqual({ successful_through: "2026-08-04T00:00:00.000Z" });
  } finally {
    cursorDatabase.close();
  }

  const healthyAdapter: GovernanceAdapter = {
    reviewPage() {
      return Promise.resolve({
        schemaVersion: 1,
        kind: "governance_page_review",
        agentActions: [], reviewSuggestions: [], futurePurgeObligations: [],
        summaryItems: ["Recovered after a Luna outage."]
      });
    }
  };
  await expect(runNextGovernanceStep({
    runtimeRoot,
    vaultRoot,
    now: failed.nextRetryAt,
    adapter: healthyAdapter
  })).resolves.toMatchObject({ state: "reviewed" });
  const recoveredDatabase = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(recoveredDatabase.prepare(
      `SELECT last_error_category, consecutive_failure_count
       FROM governance_runs WHERE run_id = ?`
    ).get(failed.runId)).toEqual({
      last_error_category: null,
      consecutive_failure_count: 0
    });
  } finally {
    recoveredDatabase.close();
  }
});

test("an overdue governance retry receives a bounded service turn despite continuing capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-governance-retry-fairness-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory: makeCanonicalMemory({
      memoryId: `msmem_${randomUUID()}`,
      revisionId: `msrev_${randomUUID()}`,
      body: "Governance retries must eventually receive service.",
      authority: "agent_derived"
    })
  });
  await initializeGovernanceSchedule({
    runtimeRoot,
    timeZone: "UTC",
    registeredAt: "2026-08-04T00:00:00.000Z",
    startupDelaySeconds: 600
  });
  const scheduled = await scheduleDueGovernance({
    runtimeRoot,
    now: "2026-08-10T19:01:00.000Z",
    workerStartedAt: "2026-08-10T18:00:00.000Z"
  });
  if (scheduled.state !== "scheduled") throw new Error("Expected governance run.");
  const unavailableAdapter: GovernanceAdapter = {
    reviewPage() {
      throw new LunaInvocationError("unavailable", true, "temporary outage");
    }
  };
  const failed = await runNextGovernanceStep({
    runtimeRoot,
    vaultRoot,
    now: "2026-08-10T19:02:00.000Z",
    adapter: unavailableAdapter
  });
  if (failed.state !== "retrying") throw new Error("Expected retrying governance.");
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent-governance-continuing-capture",
      deduplicationKey: "governance:continuing-capture",
      agent: "codex",
      eventKind: "UserPromptSubmit",
      occurredAt: failed.nextRetryAt,
      payload: { text: "Capture continues while governance is overdue." }
    }
  });
  let reviewCalls = 0;
  const healthyAdapter: GovernanceAdapter = {
    reviewPage() {
      reviewCalls += 1;
      return Promise.resolve({
        schemaVersion: 1,
        kind: "governance_page_review",
        agentActions: [],
        reviewSuggestions: [],
        futurePurgeObligations: [],
        summaryItems: ["The overdue retry recovered without draining all capture first."]
      });
    }
  };

  const recovered = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "governance-fairness-worker",
    now: failed.nextRetryAt,
    workerStartedAt: "2026-08-10T18:00:00.000Z",
    adapters: { governance: healthyAdapter }
  });
  expect(recovered.state).toBe("worked");
  expect(recovered.activities).toContain("governance:reviewed");
  expect(reviewCalls).toBe(1);

  const applied = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "governance-fairness-worker",
    now: new Date(Date.parse(failed.nextRetryAt) + 1_000).toISOString(),
    workerStartedAt: "2026-08-10T18:00:00.000Z",
    adapters: { governance: healthyAdapter }
  });
  expect(applied.state).toBe("worked");
  expect(applied.activities).toContain("governance:applied");
  expect(reviewCalls).toBe(1);

  const advanced = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "governance-fairness-worker",
    now: new Date(Date.parse(failed.nextRetryAt) + 2_000).toISOString(),
    workerStartedAt: "2026-08-10T18:00:00.000Z",
    adapters: { governance: healthyAdapter }
  });
  expect(advanced.state).toBe("worked");
  expect(advanced.activities).toContain("governance:phase_advanced");
  expect(reviewCalls).toBe(1);
});

test("governance blocks after the initial call and six automatic retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-governance-retry-limit-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory: makeCanonicalMemory({
      memoryId: `msmem_${randomUUID()}`,
      revisionId: `msrev_${randomUUID()}`,
      body: "Governance retry epochs are bounded.",
      authority: "agent_derived"
    })
  });
  await initializeGovernanceSchedule({
    runtimeRoot,
    timeZone: "UTC",
    registeredAt: "2026-08-04T00:00:00.000Z",
    startupDelaySeconds: 600
  });
  const scheduled = await scheduleDueGovernance({
    runtimeRoot,
    now: "2026-08-10T19:01:00.000Z",
    workerStartedAt: "2026-08-10T18:00:00.000Z"
  });
  if (scheduled.state !== "scheduled") throw new Error("Expected governance run.");
  let callCount = 0;
  const unavailableAdapter: GovernanceAdapter = {
    reviewPage() {
      callCount += 1;
      throw new LunaInvocationError("unavailable", true, "temporary outage");
    }
  };
  let attemptAt = "2026-08-10T19:02:00.000Z";
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    const result = await runNextGovernanceStep({
      runtimeRoot,
      vaultRoot,
      now: attemptAt,
      adapter: unavailableAdapter
    });
    if (attempt < 7) {
      if (result.state !== "retrying") throw new Error(`Expected retry ${String(attempt)}.`);
      attemptAt = result.nextRetryAt;
    } else {
      expect(result).toEqual({ state: "blocked" });
    }
  }
  expect(callCount).toBe(7);
});
