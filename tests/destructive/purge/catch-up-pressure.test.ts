import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  captureEvent,
  claimCaptureEvent,
  completeCaptureEvent
} from "../../../src/capture/index.js";
import { runArchivePurgeBatch } from "../../../src/purge/index.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a pending Capture Event makes purge yield and catch up after foreground work drains", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-purge-catch-up-"));
  roots.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const backupRoot = join(root, "backup");
  const memory = {
    ...makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174741",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174742",
      body: "Catch-up purge fixture.",
      authority: "agent_derived",
      lifecycle: "archived"
    }),
    lifecycleDetails: {
      archivedAt: "2025-01-01T00:00:00.000Z",
      reason: "superseded",
      purgeAfter: "2025-07-01T00:00:00.000Z"
    }
  } as const;
  await writeCanonicalMemory({ vaultRoot, runtimeRoot, actor: "agent", memory });
  await cp(vaultRoot, backupRoot, { recursive: true });
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent_123e4567-e89b-42d3-a456-426614174743",
      deduplicationKey: "codex:purge-pressure:turn-1:stop",
      agent: "codex",
      eventKind: "Stop",
      occurredAt: "2026-01-03T00:00:00.000Z",
      sessionId: "purge-pressure",
      turnId: "turn-1",
      payload: { assistantMessage: "Foreground capture must win." }
    }
  });

  const yielded = await runArchivePurgeBatch({
    vaultRoot,
    runtimeRoot,
    backupRoot,
    now: "2026-01-03T00:00:00.000Z"
  });
  const claimed = await claimCaptureEvent({
    runtimeRoot,
    workerId: "purge-test-worker",
    now: "2026-01-03T00:01:00.000Z",
    leaseSeconds: 60
  });
  if (claimed.state !== "claimed") throw new Error("Expected Capture work to be claimable.");
  await completeCaptureEvent({
    runtimeRoot,
    eventId: claimed.eventId,
    leaseToken: claimed.leaseToken,
    completedAt: "2026-01-03T00:01:01.000Z"
  });
  const caughtUp = await runArchivePurgeBatch({
    vaultRoot,
    runtimeRoot,
    backupRoot,
    now: "2026-01-03T00:05:00.000Z"
  });

  expect(yielded).toMatchObject({
    state: "yielded",
    purgedMemoryIds: [],
    nextEligibleAt: "2026-01-03T00:05:00Z"
  });
  expect(caughtUp).toMatchObject({
    state: "completed",
    purgedMemoryIds: [memory.memoryId],
    hasMore: false
  });
});
