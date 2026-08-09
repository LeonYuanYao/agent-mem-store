import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { RecordingNotifier } from "../../../src/adapters/macos/notifier.js";
import { initializeMemStore } from "../../../src/operations/initialize.js";
import { generateReviewInbox } from "../../../src/review/inbox.js";
import { dispatchNextReminder, prepareReviewReminder } from "../../../src/review/reminders.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a failed notification remains durable and succeeds on its next retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-reminder-recovery-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare(
      `INSERT INTO sensitivity_findings(
         finding_id, fingerprint, state, category,
         first_seen_at, last_seen_at, occurrence_count
       ) VALUES ('finding-recovery', 'fingerprint-recovery',
                 'quarantined', 'uncertain', ?, ?, 1)`
    ).run("2026-08-08T06:00:00.000Z", "2026-08-08T06:00:00.000Z");
  } finally {
    database.close();
  }
  await generateReviewInbox({ runtimeRoot, vaultRoot, generatedAt: "2026-08-08T06:01:00.000Z" });
  const prepared = await prepareReviewReminder({
    runtimeRoot,
    vaultRoot,
    digestKey: "weekly:2026-08-08",
    dueAt: "2026-08-08T06:02:00.000Z",
    createdAt: "2026-08-08T06:01:00.000Z"
  });
  if (prepared.state === "empty") throw new Error("Expected reminder.");

  await expect(dispatchNextReminder({
    runtimeRoot,
    now: "2026-08-08T06:02:00.000Z",
    notifier: new RecordingNotifier({ state: "failed", errorCode: "transient" })
  })).resolves.toEqual({ state: "failed", reminderId: prepared.reminderId });
  await expect(dispatchNextReminder({
    runtimeRoot,
    now: "2026-08-08T06:06:59.000Z",
    notifier: new RecordingNotifier()
  })).resolves.toEqual({ state: "empty" });
  await expect(dispatchNextReminder({
    runtimeRoot,
    now: "2026-08-08T06:07:00.000Z",
    notifier: new RecordingNotifier()
  })).resolves.toEqual({ state: "delivered", reminderId: prepared.reminderId });
});
