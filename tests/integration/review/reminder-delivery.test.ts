import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { generateReviewInbox } from "../../../src/review/inbox.js";
import {
  acknowledgeReminder,
  dispatchNextReminder,
  prepareReviewReminder,
  snoozeReminder
} from "../../../src/review/reminders.js";
import { RecordingNotifier } from "../../../src/adapters/macos/notifier.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
test("a non-empty body-free digest is delivered, snoozed, and acknowledged durably", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-review-reminder-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "My Memory Vault");
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare(
      `INSERT INTO sensitivity_findings(
         finding_id, fingerprint, state, category,
         first_seen_at, last_seen_at, occurrence_count
       ) VALUES ('finding-1', 'fingerprint-1', 'quarantined',
                 'contextual_credential', ?, ?, 1)`
    ).run("2026-08-08T02:00:00.000Z", "2026-08-08T02:00:00.000Z");
  } finally {
    database.close();
  }
  await generateReviewInbox({ runtimeRoot, vaultRoot, generatedAt: "2026-08-08T02:01:00.000Z" });
  const prepared = await prepareReviewReminder({
    runtimeRoot,
    vaultRoot,
    digestKey: "weekly:2026-08-10",
    dueAt: "2026-08-10T11:00:00.000Z",
    createdAt: "2026-08-08T02:02:00.000Z"
  });
  if (prepared.state !== "pending") throw new Error("Expected pending reminder.");
  const notifier = new RecordingNotifier();
  await expect(dispatchNextReminder({
    runtimeRoot,
    now: "2026-08-10T11:00:01.000Z",
    notifier
  })).resolves.toMatchObject({ state: "delivered", reminderId: prepared.reminderId });
  expect(notifier.deliveries).toHaveLength(1);
  expect(notifier.deliveries[0]).toMatchObject({
    title: "MemStore review available",
    openUri: "obsidian://open?vault=My%20Memory%20Vault&file=_MemStore%2FReview%20Inbox.md"
  });
  expect(JSON.stringify(notifier.deliveries[0])).not.toContain("contextual_credential");

  await expect(snoozeReminder({
    runtimeRoot,
    reminderId: prepared.reminderId,
    snoozedAt: "2026-08-10T11:01:00.000Z",
    durationDays: 7
  })).resolves.toMatchObject({ state: "snoozed", snoozedUntil: "2026-08-17T11:01:00.000Z" });
  await expect(acknowledgeReminder({
    runtimeRoot,
    reminderId: prepared.reminderId,
    acknowledgedAt: "2026-08-17T11:02:00.000Z"
  })).resolves.toEqual({ state: "acknowledged", reminderId: prepared.reminderId });
});

test("an empty Inbox creates no reminder obligation", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-empty-reminder-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await generateReviewInbox({ runtimeRoot, vaultRoot, generatedAt: "2026-08-08T02:01:00.000Z" });
  await expect(prepareReviewReminder({
    runtimeRoot,
    vaultRoot,
    digestKey: "weekly:empty",
    dueAt: "2026-08-10T11:00:00.000Z",
    createdAt: "2026-08-08T02:02:00.000Z"
  })).resolves.toEqual({ state: "empty" });
});
