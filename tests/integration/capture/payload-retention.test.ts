import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { captureEvent, readCapturedEvent } from "../../../src/capture/index.js";
import { inspectCapturePayloadRetention, runScheduledCapturePayloadRetention } from "../../../src/capture/retention.js";
import { compactRuntimeDatabase, pauseForMigration } from "../../../src/operations/portability.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const now = "2026-10-13T00:00:00.000Z";
const daysAgo = (days: number): string => new Date(Date.parse(now) - days * 86_400_000).toISOString();

async function fixture(config = "schema_version = 1\n") {
  const root = await mkdtemp(join(tmpdir(), "memstore-payload-retention-"));
  directories.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(vaultRoot, { recursive: true });
  await writeFile(join(runtimeRoot, "config.toml"), config);
  return { runtimeRoot, vaultRoot };
}

async function event(runtimeRoot: string, id: string, state: string, updatedAt: string): Promise<void> {
  await captureEvent({ runtimeRoot, event: {
    schemaVersion: 1, eventId: id, deduplicationKey: `retention:${id}`, agent: "codex", eventKind: "UserPromptSubmit",
    occurredAt: updatedAt, sessionId: "s", turnId: id, payload: { prompt: `prompt ${id} ${"x".repeat(2_000)}` }
  } });
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare("UPDATE capture_events SET state = ?, updated_at = ? WHERE event_id = ?").run(state, updatedAt, id);
  } finally {
    database.close();
  }
}

async function segments(runtimeRoot: string): Promise<Record<string, number>> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    return Object.fromEntries(database.prepare(
      "SELECT e.event_id, COUNT(s.event_id) AS n FROM capture_events e LEFT JOIN capture_segments s USING (event_id) GROUP BY e.event_id"
    ).all().map((row) => [String(row.event_id), Number(row.n)]));
  } finally {
    database.close();
  }
}

test("terminal payloads older than the retention period are removed; pending work and recent payloads stay", async () => {
  const { runtimeRoot, vaultRoot } = await fixture();
  await event(runtimeRoot, "old-completed", "completed", daysAgo(40));
  await event(runtimeRoot, "recent-completed", "completed", daysAgo(5));
  await event(runtimeRoot, "old-pending", "pending", daysAgo(40));
  await event(runtimeRoot, "old-retrying", "retrying", daysAgo(40));
  await event(runtimeRoot, "dead-letter-60", "dead_letter", daysAgo(60));
  await event(runtimeRoot, "dead-letter-100", "dead_letter", daysAgo(100));

  const result = await runScheduledCapturePayloadRetention({ runtimeRoot, vaultRoot, now });
  expect(result).toMatchObject({ state: "completed", removedEventCount: 2, hasMore: false });
  expect(await segments(runtimeRoot)).toEqual({
    "old-completed": 0, "recent-completed": 1, "old-pending": 1, "old-retrying": 1, "dead-letter-60": 1, "dead-letter-100": 0
  });
  // A removed body reads as unavailable, not as a corrupt event; history rows remain.
  expect(await readCapturedEvent(runtimeRoot, "old-completed")).toBeUndefined();
  expect(await readCapturedEvent(runtimeRoot, "recent-completed")).toMatchObject({ eventId: "recent-completed" });
  expect(await inspectCapturePayloadRetention(runtimeRoot)).toMatchObject({ total_removed_event_count: 2, last_error_code: null });
  expect(await runScheduledCapturePayloadRetention({ runtimeRoot, vaultRoot, now })).toMatchObject({ state: "not_due" });
});

test("while dreaming is enabled the payload period never drops below the dreaming lookback", async () => {
  const { runtimeRoot, vaultRoot } = await fixture("schema_version = 1\n\n[dreaming]\nenabled = true\nlookback_days = 30\n");
  await event(runtimeRoot, "thirty-and-a-half", "completed", daysAgo(30.5));
  await event(runtimeRoot, "thirty-two", "completed", daysAgo(32));
  await runScheduledCapturePayloadRetention({ runtimeRoot, vaultRoot, now });
  expect(await segments(runtimeRoot)).toEqual({ "thirty-and-a-half": 1, "thirty-two": 0 });
});

test("compaction previews reclaimable space and runs only while the Worker and capture are paused", async () => {
  const { runtimeRoot, vaultRoot } = await fixture();
  for (let index = 0; index < 20; index += 1) await event(runtimeRoot, `e${String(index)}`, "completed", daysAgo(40));
  await runScheduledCapturePayloadRetention({ runtimeRoot, vaultRoot, now });
  const preview = await compactRuntimeDatabase({ runtimeRoot, apply: false });
  expect(preview).toMatchObject({ state: "preview", dry_run: true });
  expect(Number(preview.reclaimable_bytes)).toBeGreaterThan(0);
  await expect(compactRuntimeDatabase({ runtimeRoot, apply: true })).rejects.toThrow(/portability pause/u);
  await pauseForMigration({ runtimeRoot, pausedAt: now });
  const compacted = await compactRuntimeDatabase({ runtimeRoot, apply: true });
  expect(compacted.state).toBe("compacted");
  expect(Number(compacted.size_after_bytes)).toBeLessThan(Number(compacted.size_before_bytes));
});
