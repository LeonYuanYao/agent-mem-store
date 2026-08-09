import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import {
  initializeGovernanceSchedule,
  scheduleDueGovernance
} from "../../../src/governance/scheduling.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRuntime(registeredAt: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memstore-governance-schedule-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  await initializeGovernanceSchedule({
    runtimeRoot,
    timeZone: "America/Los_Angeles",
    registeredAt,
    startupDelaySeconds: 600,
    pageSize: 50
  });
  return runtimeRoot;
}

test("Monday 19:00 follows the configured IANA zone across DST", async () => {
  const runtimeRoot = await makeRuntime("2026-03-01T00:00:00.000Z");

  const beforeDst = await scheduleDueGovernance({
    runtimeRoot,
    now: "2026-03-03T03:01:00.000Z",
    workerStartedAt: "2026-03-03T02:00:00.000Z"
  });
  const afterDst = await scheduleDueGovernance({
    runtimeRoot,
    now: "2026-03-10T02:01:00.000Z",
    workerStartedAt: "2026-03-10T01:00:00.000Z"
  });

  expect(beforeDst).toMatchObject({ state: "scheduled", kind: "monthly" });
  if (beforeDst.state !== "scheduled") throw new Error("Expected scheduled governance.");
  expect(beforeDst.coverageThrough).toBe("2026-03-03T03:01:00.000Z");
  // The first run remains active, so the next occurrence is audited but not double-run.
  expect(afterDst).toMatchObject({ state: "active_run" });

  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const dueTimes = database
      .prepare("SELECT cadence, due_at FROM governance_obligations ORDER BY due_at, cadence")
      .all();
    expect(dueTimes).toEqual([
      { cadence: "monthly", due_at: "2026-03-03T03:00:00.000Z" },
      { cadence: "weekly", due_at: "2026-03-03T03:00:00.000Z" },
      { cadence: "weekly", due_at: "2026-03-10T02:00:00.000Z" }
    ]);
  } finally {
    database.close();
  }
});

test("startup delay defers catch-up and a monthly run coalesces missed weekly duties", async () => {
  const runtimeRoot = await makeRuntime("2026-06-02T03:00:00.000Z");

  await expect(scheduleDueGovernance({
    runtimeRoot,
    now: "2026-07-07T02:05:00.000Z",
    workerStartedAt: "2026-07-07T02:00:00.000Z"
  })).resolves.toMatchObject({ state: "deferred", reason: "startup_delay" });

  const scheduled = await scheduleDueGovernance({
    runtimeRoot,
    now: "2026-07-07T02:11:00.000Z",
    workerStartedAt: "2026-07-07T02:00:00.000Z"
  });
  expect(scheduled).toMatchObject({
    state: "scheduled",
    kind: "monthly",
    includesWeekly: true,
    recoveredOccurrenceCount: 6
  });
  if (scheduled.state !== "scheduled") throw new Error("Expected scheduled governance.");

  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM governance_runs WHERE state = 'pending'"
    ).get()).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM governance_obligations WHERE run_id = ?"
    ).get(scheduled.runId)).toEqual({ count: 6 });
  } finally {
    database.close();
  }
});
