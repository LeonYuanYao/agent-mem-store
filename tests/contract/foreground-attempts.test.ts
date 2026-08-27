import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  inspectForegroundAttempts,
  recordForegroundAttempt
} from "../../src/retrieval/foreground-attempts.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("foreground attempt telemetry is body-free and separates deadline cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-foreground-attempts-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  await recordForegroundAttempt({
    runtimeRoot,
    attempt: {
      requestId: "foreground-attempt-deadline",
      eventKind: "UserPromptSubmit",
      projectId: "msproj_attempt_fixture",
      outcome: "deadline_exceeded",
      admissionDelayMs: 0,
      computeMs: 55,
      receiptCommitMs: 0,
      observedClientElapsedMs: 50,
      cancellationObservedMs: 50,
      postDeadlineWorkMs: 5,
      createdAt: "2026-08-26T19:00:00.000Z",
      completedAt: "2026-08-26T19:00:00.055Z"
    }
  });

  await expect(inspectForegroundAttempts(runtimeRoot)).resolves.toMatchObject({
    totalCount: 1,
    deadlineCount: 1,
    postDeadlineCount: 1,
    maximumPostDeadlineWorkMs: 5
  });
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const columns = database.prepare("PRAGMA table_info(foreground_attempts)").all()
      .map((row) => String(row.name));
    for (const forbidden of ["prompt", "memory_body", "pack_body", "error_text"]) {
      expect(columns).not.toContain(forbidden);
    }
  } finally {
    database.close();
  }
});
