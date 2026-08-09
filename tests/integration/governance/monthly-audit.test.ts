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

test("monthly governance performs weekly duties then audits all Active and Archived metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-monthly-governance-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const archivedId = `msmem_${randomUUID()}`;
  for (const [index, lifecycle] of ["active", "active", "archived"] .entries()) {
    await writeCanonicalMemory({
      runtimeRoot,
      vaultRoot,
      actor: "agent",
      memory: makeCanonicalMemory({
        memoryId: index === 2 ? archivedId : `msmem_${randomUUID()}`,
        revisionId: `msrev_${randomUUID()}`,
        body: `Monthly memory ${String(index)}`,
        authority: "agent_derived",
        lifecycle: lifecycle as "active" | "archived"
      })
    });
  }
  await initializeGovernanceSchedule({
    runtimeRoot,
    timeZone: "UTC",
    registeredAt: "2026-07-07T00:00:00.000Z",
    startupDelaySeconds: 600,
    pageSize: 2
  });
  const scheduled = await scheduleDueGovernance({
    runtimeRoot,
    now: "2026-08-10T19:01:00.000Z",
    workerStartedAt: "2026-08-10T18:00:00.000Z"
  });
  if (scheduled.state !== "scheduled") throw new Error("Expected monthly governance.");
  expect(scheduled).toMatchObject({ kind: "monthly", includesWeekly: true });

  const pageSizes: Record<"weekly" | "monthly", number[]> = { weekly: [], monthly: [] };
  const monthlyLifecycles: string[] = [];
  const adapter: GovernanceAdapter = {
    reviewPage(request) {
      pageSizes[request.phase].push(request.memories.length);
      if (request.phase === "monthly") {
        expect(request.auditSignals).toMatchObject({
          modelHealthState: "healthy",
          captureBacklogCount: 0,
          lunaBacklogCount: 0
        });
        monthlyLifecycles.push(...request.memories.map((memory) => memory.lifecycle));
      }
      return Promise.resolve({
        schemaVersion: 1,
        kind: "governance_page_review",
        agentActions: [],
        reviewSuggestions: [],
        futurePurgeObligations: request.phase === "monthly" &&
          request.memories.some((memory) => memory.memoryId === archivedId)
          ? [{
              memoryId: archivedId,
              notBefore: "2027-02-10T19:01:00.000Z",
              reason: "Archived retention can be reviewed after six months."
            }]
          : [],
        summaryItems: [`${request.phase} page ${String(request.pageOrdinal)}`]
      });
    }
  };
  let completed = false;
  for (let step = 0; step < 12; step += 1) {
    const result = await runNextGovernanceStep({
      runtimeRoot,
      vaultRoot,
      now: new Date(Date.parse("2026-08-10T19:02:00.000Z") + step * 60_000).toISOString(),
      adapter
    });
    if (result.state === "completed") {
      completed = true;
      break;
    }
  }
  expect(completed).toBe(true);
  expect(pageSizes.weekly).toEqual([2, 1]);
  expect(pageSizes.monthly).toEqual([2, 1]);
  expect(monthlyLifecycles.sort()).toEqual(["active", "active", "archived"]);

  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(database.prepare(
      "SELECT memory_id, state FROM future_purge_obligations"
    ).get()).toEqual({ memory_id: archivedId, state: "pending" });
    expect(database.prepare(
      "SELECT cadence, successful_through FROM governance_cursors ORDER BY cadence"
    ).all()).toEqual([
      { cadence: "monthly", successful_through: scheduled.coverageThrough },
      { cadence: "weekly", successful_through: scheduled.coverageThrough }
    ]);
  } finally {
    database.close();
  }
});
