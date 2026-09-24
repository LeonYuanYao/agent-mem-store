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
import { initializeMemStore } from "../../../src/operations/initialize.js";
import { inspectDoctor, retryOperation } from "../../../src/operations/maintenance.js";
import { inspectStatus } from "../../../src/operations/status.js";

const roots: string[] = [];

test("explicit governance retry resumes the frozen failed page without replaying applied pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-governance-resume-page-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime"), vaultRoot = join(root, "vault");
  await initializeGovernanceSchedule({ runtimeRoot, timeZone: "Asia/Shanghai", registeredAt: "2026-08-04T00:00:00.000Z", pageSize: 1 });
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  for (const body of ["Preserve applied pages.", "Resume failed pages."]) {
    await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "agent", memory: makeCanonicalMemory({
      memoryId: `msmem_${randomUUID()}`, revisionId: `msrev_${randomUUID()}`, body, authority: "agent_derived"
    }) });
  }
  const now = "2026-08-10T19:02:00.000Z";
  const scheduled = await scheduleDueGovernance({ runtimeRoot, now, workerStartedAt: "2026-08-10T18:00:00.000Z" });
  if (scheduled.state !== "scheduled") throw new Error("Expected governance run.");
  let failedInput: string | undefined;
  const good: GovernanceAdapter = { reviewPage: () => Promise.resolve({ schemaVersion: 1, kind: "governance_page_review",
    agentActions: [], reviewSuggestions: [], futurePurgeObligations: [], summaryItems: [] }) };
  expect(await runNextGovernanceStep({ runtimeRoot, vaultRoot, now, adapter: good })).toMatchObject({ state: "reviewed", pageOrdinal: 0 });
  expect(await runNextGovernanceStep({ runtimeRoot, vaultRoot, now, adapter: good })).toMatchObject({ state: "applied", pageOrdinal: 0 });
  expect(await runNextGovernanceStep({ runtimeRoot, vaultRoot, now, adapter: { reviewPage(input) {
    failedInput = JSON.stringify(input);
    throw new LunaInvocationError("schema_invalid", false, "Explicit handling required.");
  } } })).toMatchObject({ state: "blocked" });
  await retryOperation({ runtimeRoot, operationId: scheduled.runId, requestedAt: now, preview: false });
  expect(await runNextGovernanceStep({ runtimeRoot, vaultRoot, now, adapter: { reviewPage(input) {
    expect(input.pageOrdinal).toBe(1);
    expect(JSON.stringify(input)).toBe(failedInput);
    return good.reviewPage(input);
  } } })).toMatchObject({ state: "reviewed", pageOrdinal: 1 });
  expect(await runNextGovernanceStep({ runtimeRoot, vaultRoot, now, adapter: good })).toMatchObject({ state: "applied", pageOrdinal: 1 });
  expect(await runNextGovernanceStep({ runtimeRoot, vaultRoot, now, adapter: good })).toMatchObject({ state: "phase_advanced", phase: "finalize" });
  expect(await runNextGovernanceStep({ runtimeRoot, vaultRoot, now, adapter: good })).toMatchObject({ state: "completed" });
  expect((await inspectStatus({ runtimeRoot, vaultRoot })).governance).toBeNull();
  expect((await inspectDoctor({ runtimeRoot, vaultRoot, deep: false, now })).checks.find(c => c.name === "governance")?.state).toBe("ok");
});

test.each(["local_error", "invalid_relationship"])("governance distinguishes %s without leaking exception text", async (failure) => {
  const root = await mkdtemp(join(tmpdir(), "memstore-governance-classification-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime"), vaultRoot = join(root, "vault");
  await initializeGovernanceSchedule({ runtimeRoot, timeZone: "Asia/Shanghai", registeredAt: "2026-08-04T00:00:00.000Z" });
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const memoryId = `msmem_${randomUUID()}`;
  await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "agent", memory: makeCanonicalMemory({
    memoryId, revisionId: `msrev_${randomUUID()}`, body: "Keep retry budgets bounded.", authority: "agent_derived"
  }) });
  await scheduleDueGovernance({ runtimeRoot, now: "2026-08-10T19:01:00.000Z", workerStartedAt: "2026-08-10T18:00:00.000Z" });
  const now = "2026-08-10T19:02:00.000Z";
  const adapter: GovernanceAdapter = { reviewPage() {
    if (failure === "local_error") throw new Error("PRIVATE_TEST_DIAGNOSTIC");
    return Promise.resolve({ schemaVersion: 1, kind: "governance_page_review", agentActions: [{
      kind: "add_relationship", sourceMemoryId: memoryId, targetMemoryId: "outside-run", relationshipType: "supports",
      reason: "PRIVATE_TEST_DIAGNOSTIC", evidenceRefs: ["fixture:source"]
    }], reviewSuggestions: [], futurePurgeObligations: [], summaryItems: [] });
  } };
  await runNextGovernanceStep({ runtimeRoot, vaultRoot, now, adapter });
  const status = await inspectStatus({ runtimeRoot, vaultRoot });
  expect(status.governance).toMatchObject(failure === "local_error" ? {
    state: "blocked", last_error_category: "local_processing",
    last_error_diagnostic: { stage: "local_processing", code: "governance_processing_failed" }
  } : {
    state: "retrying", last_error_category: "schema_invalid",
    last_error_diagnostic: { stage: "evidence_binding", code: "relationship_target_outside_run" }
  });
  expect(JSON.stringify(status.governance)).not.toContain("PRIVATE_TEST_DIAGNOSTIC");
  if (failure === "local_error") expect((await inspectLunaHealth({ runtimeRoot, now })).consecutiveFailures).toBe(0);
});

test("doctor reports exhausted governance separately from ordinary Luna work", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-governance-doctor-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime"), vaultRoot = join(root, "vault");
  await initializeGovernanceSchedule({ runtimeRoot, timeZone: "Asia/Shanghai", registeredAt: "2026-08-04T00:00:00.000Z" });
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "agent", memory: makeCanonicalMemory({
    memoryId: `msmem_${randomUUID()}`, revisionId: `msrev_${randomUUID()}`,
    body: "Keep retry budgets bounded.", authority: "agent_derived"
  }) });
  const scheduled = await scheduleDueGovernance({ runtimeRoot, now: "2026-08-10T19:01:00.000Z", workerStartedAt: "2026-08-10T18:00:00.000Z" });
  if (scheduled.state !== "scheduled") throw new Error("Expected governance run.");
  let now = "2026-08-10T19:02:00.000Z";
  const adapter: GovernanceAdapter = { reviewPage() {
    throw new LunaInvocationError("schema_invalid", true, "Invalid target", {
      stage: "retention_validation", code: "unrequested_retention_target", path: "retentionAssessments.0.memoryId"
    });
  } };
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    const result = await runNextGovernanceStep({ runtimeRoot, vaultRoot, now, adapter });
    if (result.state === "retrying") now = result.nextRetryAt;
    else expect(result.state).toBe("blocked");
  }
  const doctor = await inspectDoctor({ runtimeRoot, vaultRoot, deep: false, now });
  expect(doctor.state).toBe("degraded");
  const governanceCheck = doctor.checks.find(check => check.name === "governance");
  expect(governanceCheck?.state).toBe("warning");
  expect(governanceCheck?.detail).toContain(scheduled.runId);
  expect(typeof governanceCheck?.recoveryCondition).toBe("string");
  expect(doctor.checks.find(check => check.name === "luna_operations")?.state).toBe("ok");
  expect((await inspectStatus({ runtimeRoot, vaultRoot })).governance).toMatchObject({
    state: "blocked", consecutive_failure_count: 7, last_error_category: "schema_invalid",
    last_error_diagnostic: { stage: "retention_validation", code: "unrequested_retention_target", path: "retentionAssessments.0.memoryId" }
  });
  await expect(retryOperation({ runtimeRoot, operationId: scheduled.runId, requestedAt: now, preview: true }))
    .resolves.toMatchObject({ state: "preview", dryRun: true, wouldRetry: true });
  expect((await inspectStatus({ runtimeRoot, vaultRoot })).governance?.state).toBe("blocked");
  await expect(retryOperation({ runtimeRoot, operationId: scheduled.runId, requestedAt: now, preview: false }))
    .resolves.toMatchObject({ state: "queued", lifetimeAttemptCount: 7 });
  expect((await inspectStatus({ runtimeRoot, vaultRoot })).governance).toMatchObject({
    state: "pending", consecutive_failure_count: 0, attempt_count: 7
  });
  expect((await inspectDoctor({ runtimeRoot, vaultRoot, deep: false, now })).checks.find(c => c.name === "governance")?.state).toBe("info");
  const reviewed = await runNextGovernanceStep({ runtimeRoot, vaultRoot, now, adapter: { reviewPage() {
    return Promise.resolve({ schemaVersion: 1, kind: "governance_page_review", agentActions: [],
      reviewSuggestions: [], futurePurgeObligations: [], summaryItems: ["No supported changes."] });
  } } });
  expect(reviewed.state).toBe("reviewed");
  expect((await inspectStatus({ runtimeRoot, vaultRoot })).governance).toMatchObject({
    last_error_category: null, last_error_diagnostic: null, attempt_count: 8
  });
  const recoveredDoctor = await inspectDoctor({ runtimeRoot, vaultRoot, deep: false, now });
  expect(recoveredDoctor.checks.find(check => check.name === "governance")?.state).toBe("ok");
  await expect(retryOperation({ runtimeRoot, operationId: scheduled.runId, requestedAt: now, preview: false }))
    .rejects.toMatchObject({ code: "operation_not_retryable" });
});

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
