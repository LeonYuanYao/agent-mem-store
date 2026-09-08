import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openRuntimeDatabase } from "../../src/runtime/database.js";
import { initializeMemStore } from "../../src/operations/initialize.js";
import { recordForegroundAttempt, recordForegroundAttemptOverflow } from "../../src/retrieval/foreground-attempts.js";
import { inspectForegroundHealth } from "../../src/health/foreground.js";
import { inspectIndexHealth } from "../../src/health/index.js";
import { inspectIndexWait } from "../../src/retrieval/index-wait.js";
import { captureEvent } from "../../src/capture/index.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memstore-current-health-")); roots.push(root);
  const runtimeRoot = join(root, "runtime");
  await initializeMemStore({ runtimeRoot, vaultRoot: join(root, "vault"), preview: false });
  return runtimeRoot;
}

test("duplicate failure observations count once and empty/cancelled requests do not prove recovery", async () => {
  const runtimeRoot = await fixture();
  for (let i = 0; i < 12; i++) {
    const at = `2026-09-08T00:00:${String(i).padStart(2, "0")}.000Z`;
    await recordForegroundAttempt({ runtimeRoot, attempt: {
      requestId: `observation-${String(i)}`, eventId: i < 3 ? "same-event" : `other-${String(i)}`,
      eventKind: "UserPromptSubmit", outcome: i < 3 ? "failed" : i % 2 ? "empty" : "cancelled",
      admissionDelayMs: 0, computeMs: 1, receiptCommitMs: 0, observedClientElapsedMs: 1,
      postDeadlineWorkMs: 0, createdAt: at, completedAt: at
    } });
  }
  expect(await inspectForegroundHealth(runtimeRoot, "2026-09-08T00:01:00.000Z"))
    .toMatchObject({ state: "recovering", recentFailureCount: 1, successSinceFailure: 0, severity: "info" });
  expect(await inspectForegroundHealth(runtimeRoot, "2026-09-09T00:00:00.000Z"))
    .toMatchObject({ state: "awaiting_verification", severity: "info" });
  expect(await inspectForegroundHealth(runtimeRoot, "2026-09-07T00:00:00.000Z"))
    .toMatchObject({ state: "healthy", recentFailureCount: 0 });
});

test("overflow failure evidence is not hidden by a quiet main attempt table", async () => {
  const runtimeRoot = await fixture();
  await recordForegroundAttemptOverflow({ runtimeRoot, bucketAt: "2026-09-08T00:00:00.000Z", outcome: "unavailable", occurrenceCount: 4 });
  expect(await inspectForegroundHealth(runtimeRoot, "2026-09-08T00:01:00.000Z"))
    .toMatchObject({ state: "degraded", recentFailureCount: 4 });
});

test("index scheduling and health share cooldown, then escalate a stalled generation and recover on publish", async () => {
  const runtimeRoot = await fixture();
  const db = await openRuntimeDatabase(runtimeRoot);
  try {
    db.prepare(`UPDATE retrieval_catalog_generations SET dirty_generation=2, published_generation=1,
      dirty_at=?, force_due_at=? WHERE singleton=1`).run("2026-09-08T00:00:00.000Z", "2026-09-08T00:02:00.000Z");
    db.prepare(`INSERT INTO retrieval_index_build_activity(singleton,build_id,state,started_at,lease_until,completed_at)
      VALUES (1,'test-build','failed',?,?,?)`).run("2026-09-08T00:00:00.000Z", "2026-09-08T00:00:00.000Z", "2026-09-08T00:00:00.000Z");
    expect(await inspectIndexWait(runtimeRoot, "2026-09-08T00:03:00.000Z"))
      .toMatchObject({ waiting: true, reason: "failure_cooldown", until: "2026-09-08T00:05:00.000Z" });
    expect(await inspectIndexHealth(runtimeRoot, "2026-09-08T00:03:00.000Z"))
      .toMatchObject({ state: "failure_cooldown", severity: "info" });
    db.prepare("UPDATE retrieval_index_build_activity SET state='complete' WHERE singleton=1").run();
    await captureEvent({ runtimeRoot, event: {
      schemaVersion: 1, eventId: "msev_123e4567-e89b-42d3-a456-426614174101", deduplicationKey: "health-backlog",
      agent: "codex", eventKind: "UserPromptSubmit", occurredAt: "2026-09-08T00:01:00.000Z", payload: { text: "Pending work" }
    } });
    expect(await inspectIndexWait(runtimeRoot, "2026-09-08T00:03:00.000Z"))
      .toMatchObject({ waiting: true, reason: "backlog_coalescing" });
    expect(await inspectIndexHealth(runtimeRoot, "2026-09-08T00:03:00.000Z"))
      .toMatchObject({ state: "backlog_coalescing", severity: "info" });
    expect(await inspectIndexWait(runtimeRoot, "2026-09-08T00:07:00.000Z"))
      .toMatchObject({ waiting: false });
    expect(await inspectIndexHealth(runtimeRoot, "2026-09-08T00:07:00.000Z"))
      .toMatchObject({ state: "stalled", severity: "warning" });
    db.prepare("UPDATE retrieval_catalog_generations SET published_generation=dirty_generation WHERE singleton=1").run();
    expect(await inspectIndexHealth(runtimeRoot, "2026-09-08T00:08:00.000Z"))
      .toMatchObject({ state: "current", severity: "ok" });
  } finally { db.close(); }
});
