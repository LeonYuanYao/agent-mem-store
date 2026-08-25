import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  captureEvent,
  inspectSensitivityFinding,
  readCapturedEvent
} from "../../../src/capture/index.js";
import {
  inspectSensitivityAssessment,
  summarizeSensitivityFindings
} from "../../../src/sensitivity/summary.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

test("a Capture Event is durable and duplicate delivery is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capture-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const event = {
    schemaVersion: 1 as const,
    eventId: "msevent_123e4567-e89b-42d3-a456-426614174010",
    deduplicationKey: "codex:session-1:turn-1:stop",
    agent: "codex" as const,
    eventKind: "Stop" as const,
    occurredAt: "2026-08-07T01:00:00.000Z",
    projectId: "msproj_123e4567-e89b-42d3-a456-426614174000",
    sessionId: "session-1",
    turnId: "turn-1",
    payload: {
      assistantMessage: "The build succeeds after enabling FTS5."
    }
  };

  const first = await captureEvent({ runtimeRoot, event });
  const replay = await captureEvent({
    runtimeRoot,
    event: { ...event, eventId: "msevent_123e4567-e89b-42d3-a456-426614174011" }
  });
  const stored = await readCapturedEvent(runtimeRoot, event.eventId);

  expect(first).toEqual({
    state: "captured",
    eventId: event.eventId,
    segmentCount: 1,
    sourceBytes: 62,
    retainedBytes: 62,
    sourceTruncated: false
  });
  expect(replay).toEqual({
    state: "duplicate",
    eventId: event.eventId
  });
  expect(stored).toEqual(event);
});

async function collectFileBodies(directory: string): Promise<readonly Buffer[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const bodies: Buffer[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      bodies.push(...(await collectFileBodies(path)));
    } else if (entry.isFile()) {
      bodies.push(await readFile(path));
    }
  }
  return bodies;
}

test("a high-confidence credential is blocked without retaining its body", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capture-secret-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const secret = "sk-live-0123456789abcdefghijklmnopqrstuvwxyz";
  const eventId = "msevent_123e4567-e89b-42d3-a456-426614174012";

  const result = await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId,
      deduplicationKey: "codex:session-1:turn-2:tool",
      agent: "codex",
      eventKind: "PostToolUse",
      occurredAt: "2026-08-07T01:01:00.000Z",
      sessionId: "session-1",
      turnId: "turn-2",
      payload: { tool: "shell", output: `Authorization: Bearer ${secret}` }
    }
  });

  expect(result).toMatchObject({
    state: "blocked_secret",
    category: "authorization_header"
  });
  expect(await readCapturedEvent(runtimeRoot, eventId)).toBeUndefined();
  if (result.state === "blocked_secret") {
    expect(await inspectSensitivityFinding(runtimeRoot, result.findingId)).toEqual({
      findingId: result.findingId,
      state: "blocked_secret",
      category: "authorization_header",
      bodyRetained: false,
      firstSeenAt: "2026-08-07T01:01:00.000Z",
      lastSeenAt: "2026-08-07T01:01:00.000Z",
      occurrenceCount: 1
    });
  }
  const runtimeBodies = await collectFileBodies(runtimeRoot);
  expect(runtimeBodies.some((body) => body.includes(secret))).toBe(false);
});

test("credential-shaped uncertainty is quarantined body-free while a commit hash remains capturable", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capture-quarantine-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const uncertain = "AbCdEf0123456789+/ZyxWv9876543210==";

  const quarantined = await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent_123e4567-e89b-42d3-a456-426614174013",
      deduplicationKey: "codex:session-1:turn-3:stop",
      agent: "codex",
      eventKind: "Stop",
      occurredAt: "2026-08-07T01:02:00.000Z",
      payload: { note: `This may be a credential ${uncertain}` }
    }
  });
  const benign = await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent_123e4567-e89b-42d3-a456-426614174014",
      deduplicationKey: "codex:session-1:turn-4:stop",
      agent: "codex",
      eventKind: "Stop",
      occurredAt: "2026-08-07T01:03:00.000Z",
      payload: { note: "Commit 0123456789abcdef0123456789abcdef01234567 passed." }
    }
  });

  expect(quarantined).toMatchObject({
    state: "quarantined",
    category: "contextual_credential"
  });
  if (quarantined.state !== "quarantined") throw new Error("Expected body-free quarantine.");
  await expect(summarizeSensitivityFindings({
    runtimeRoot,
    state: "quarantined"
  })).resolves.toMatchObject({
    findingCount: 1,
    occurrenceCount: 1,
    bodyRetainedCount: 0,
    groups: [{ sourceKind: "codex:Stop", findingCount: 1, occurrenceCount: 1 }]
  });
  await expect(inspectSensitivityAssessment({
    runtimeRoot,
    findingId: quarantined.findingId
  })).resolves.toMatchObject({
    findingId: quarantined.findingId,
    bodyRetained: false,
    sourceKinds: [{ sourceKind: "codex:Stop", occurrenceCount: 1 }],
    reviewability: "safe_resubmission_or_readable_source_required"
  });
  expect(benign.state).toBe("captured");
  const runtimeBodies = await collectFileBodies(runtimeRoot);
  expect(runtimeBodies.some((body) => body.includes(uncertain))).toBe(false);
});

test("large Capture Events are segmented and oversized input remains valid after explicit truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capture-segments-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const segmentedId = "msevent_123e4567-e89b-42d3-a456-426614174015";
  const truncatedId = "msevent_123e4567-e89b-42d3-a456-426614174016";
  const segmentedText = "x".repeat(70_000);
  const oversizedText = "y".repeat(1_100_000);

  const segmented = await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: segmentedId,
      deduplicationKey: "codex:session-1:turn-5:stop",
      agent: "codex",
      eventKind: "Stop",
      occurredAt: "2026-08-07T01:04:00.000Z",
      payload: { text: segmentedText }
    }
  });
  const truncated = await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: truncatedId,
      deduplicationKey: "codex:session-1:turn-6:stop",
      agent: "codex",
      eventKind: "Stop",
      occurredAt: "2026-08-07T01:05:00.000Z",
      payload: { text: oversizedText }
    }
  });

  expect(segmented).toMatchObject({
    state: "captured",
    segmentCount: 2,
    sourceBytes: 70_011,
    retainedBytes: 70_011,
    sourceTruncated: false
  });
  expect((await readCapturedEvent(runtimeRoot, segmentedId))?.payload).toEqual({
    text: segmentedText
  });
  expect(truncated).toMatchObject({
    state: "captured",
    sourceBytes: 1_100_011,
    sourceTruncated: true
  });
  const storedTruncated = await readCapturedEvent(runtimeRoot, truncatedId);
  expect(storedTruncated?.payload).toMatchObject({
    memstoreTruncated: true,
    originalBytes: 1_100_011
  });
});
