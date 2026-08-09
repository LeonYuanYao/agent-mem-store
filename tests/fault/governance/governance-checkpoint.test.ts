import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { initializeGovernanceSchedule, scheduleDueGovernance } from "../../../src/governance/scheduling.js";
import { runNextGovernanceStep, type GovernanceAdapter } from "../../../src/governance/worker.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a reviewed page survives process loss and coverage advances only after the logical run", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-governance-checkpoint-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  for (let index = 0; index < 3; index += 1) {
    await writeCanonicalMemory({
      runtimeRoot,
      vaultRoot,
      actor: "agent",
      memory: makeCanonicalMemory({
        memoryId: `msmem_${randomUUID()}`,
        revisionId: `msrev_${randomUUID()}`,
        body: `Agent memory ${String(index)}`,
        authority: "agent_derived"
      })
    });
  }
  await initializeGovernanceSchedule({
    runtimeRoot,
    timeZone: "UTC",
    registeredAt: "2026-08-04T00:00:00.000Z",
    startupDelaySeconds: 600,
    pageSize: 2
  });
  const scheduled = await scheduleDueGovernance({
    runtimeRoot,
    now: "2026-08-10T19:01:00.000Z",
    workerStartedAt: "2026-08-10T18:00:00.000Z"
  });
  if (scheduled.state !== "scheduled") throw new Error("Expected governance run.");
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory: makeCanonicalMemory({
      memoryId: `msmem_${randomUUID()}`,
      revisionId: `msrev_${randomUUID()}`,
      body: "Written after the fixed run snapshot.",
      authority: "agent_derived"
    })
  });
  let invocationCount = 0;
  let reviewedMemoryCount = 0;
  const adapter: GovernanceAdapter = {
    reviewPage(request) {
      invocationCount += 1;
      reviewedMemoryCount += request.memories.length;
      return Promise.resolve({
        schemaVersion: 1,
        kind: "governance_page_review",
        agentActions: [], reviewSuggestions: [], futurePurgeObligations: [],
        summaryItems: [`page ${String(invocationCount)}`]
      });
    }
  };

  // The Luna result is durable before any action is applied. A new worker must not call Luna again.
  await runNextGovernanceStep({
    runtimeRoot, vaultRoot, now: "2026-08-10T19:02:00.000Z", adapter
  });
  await runNextGovernanceStep({
    runtimeRoot, vaultRoot, now: "2026-08-10T19:03:00.000Z", adapter
  });
  expect(invocationCount).toBe(1);

  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(database.prepare(
      "SELECT successful_through FROM governance_cursors WHERE cadence = 'weekly'"
    ).get()).toEqual({ successful_through: "2026-08-04T00:00:00.000Z" });
  } finally {
    database.close();
  }

  for (let step = 0; step < 5; step += 1) {
    await runNextGovernanceStep({
      runtimeRoot,
      vaultRoot,
      now: `2026-08-10T19:0${String(step + 4)}:00.000Z`,
      adapter
    });
  }
  expect(invocationCount).toBe(2);
  expect(reviewedMemoryCount).toBe(3);
  const completedDatabase = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(completedDatabase.prepare(
      "SELECT state, coverage_through FROM governance_runs WHERE run_id = ?"
    ).get(scheduled.runId)).toEqual({ state: "completed", coverage_through: scheduled.coverageThrough });
    expect(completedDatabase.prepare(
      "SELECT successful_through FROM governance_cursors WHERE cadence = 'weekly'"
    ).get()).toEqual({ successful_through: scheduled.coverageThrough });
  } finally {
    completedDatabase.close();
  }
});
