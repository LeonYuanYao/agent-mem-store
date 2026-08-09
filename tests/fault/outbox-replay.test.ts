import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";

import {
  captureEvent,
  claimCaptureEvent,
  completeCaptureEvent,
  failCaptureEvent,
  inspectCaptureEventState,
  readCapturedEvent
} from "../../src/capture/index.js";

const temporaryDirectories: string[] = [];

test("an acknowledged Capture Event survives immediate process termination", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-outbox-crash-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const event = {
    schemaVersion: 1 as const,
    eventId: "msevent_123e4567-e89b-42d3-a456-426614174040",
    deduplicationKey: "codex:crash-session:turn-1:stop",
    agent: "codex" as const,
    eventKind: "Stop" as const,
    occurredAt: "2026-08-07T02:59:00.000Z",
    sessionId: "crash-session",
    turnId: "turn-1",
    payload: { assistantMessage: "Committed before forced termination." }
  };
  const captureModule = new URL("../../src/capture/index.ts", import.meta.url).href;
  const childSource = `
    import { captureEvent } from ${JSON.stringify(captureModule)};
    const result = await captureEvent(${JSON.stringify({ runtimeRoot, event })});
    if (result.state !== "captured") process.exit(2);
    process.stdout.write("ACKNOWLEDGED");
    process.kill(process.pid, "SIGKILL");
  `;

  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", childSource],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 }
  );

  expect(child.signal).toBe("SIGKILL");
  expect(child.stdout).toContain("ACKNOWLEDGED");
  expect(await readCapturedEvent(runtimeRoot, event.eventId)).toEqual(event);
  await expect(
    captureEvent({
      runtimeRoot,
      event: {
        ...event,
        eventId: "msevent_123e4567-e89b-42d3-a456-426614174041"
      }
    })
  ).resolves.toEqual({ state: "duplicate", eventId: event.eventId });
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

test("an expired Worker lease replays the event and completion is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-outbox-replay-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const eventId = "msevent_123e4567-e89b-42d3-a456-426614174017";
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId,
      deduplicationKey: "codex:session-2:turn-1:stop",
      agent: "codex",
      eventKind: "Stop",
      occurredAt: "2026-08-07T02:00:00.000Z",
      payload: { message: "durable" }
    }
  });

  const first = await claimCaptureEvent({
    runtimeRoot,
    workerId: "worker-a",
    now: "2026-08-07T02:00:01.000Z",
    leaseSeconds: 30
  });
  const beforeExpiry = await claimCaptureEvent({
    runtimeRoot,
    workerId: "worker-b",
    now: "2026-08-07T02:00:20.000Z",
    leaseSeconds: 30
  });
  const replay = await claimCaptureEvent({
    runtimeRoot,
    workerId: "worker-b",
    now: "2026-08-07T02:00:32.000Z",
    leaseSeconds: 30
  });

  expect(first).toMatchObject({ state: "claimed", eventId, attempt: 1 });
  expect(beforeExpiry).toEqual({ state: "empty" });
  expect(replay).toMatchObject({ state: "claimed", eventId, attempt: 2 });
  if (replay.state === "claimed") {
    expect(
      await completeCaptureEvent({
        runtimeRoot,
        eventId,
        leaseToken: replay.leaseToken,
        completedAt: "2026-08-07T02:00:33.000Z"
      })
    ).toEqual({ state: "completed", eventId });
    expect(
      await completeCaptureEvent({
        runtimeRoot,
        eventId,
        leaseToken: replay.leaseToken,
        completedAt: "2026-08-07T02:00:34.000Z"
      })
    ).toEqual({ state: "already_completed", eventId });
  }
});

test("a missing payload segment is never presented as intact evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-outbox-missing-segment-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const eventId = "msevent_123e4567-e89b-42d3-a456-426614174018";
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId,
      deduplicationKey: "codex:session-2:turn-2:stop",
      agent: "codex",
      eventKind: "Stop",
      occurredAt: "2026-08-07T02:01:00.000Z",
      payload: { message: "x".repeat(70_000) }
    }
  });
  const database = new DatabaseSync(join(runtimeRoot, "state", "memstore.sqlite"));
  database
    .prepare("DELETE FROM capture_segments WHERE event_id = ? AND segment_index = 1")
    .run(eventId);
  database.close();

  await expect(readCapturedEvent(runtimeRoot, eventId)).rejects.toBeInstanceOf(Error);
});

test("processing failure retries at the requested time and eventually dead-letters", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-outbox-retry-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const eventId = "msevent_123e4567-e89b-42d3-a456-426614174019";
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId,
      deduplicationKey: "codex:session-2:turn-3:stop",
      agent: "codex",
      eventKind: "Stop",
      occurredAt: "2026-08-07T03:00:00.000Z",
      payload: { statement: "retry me" }
    }
  });
  const first = await claimCaptureEvent({
    runtimeRoot,
    workerId: "worker-a",
    now: "2026-08-07T03:00:01.000Z",
    leaseSeconds: 10
  });
  if (first.state !== "claimed") throw new Error("Expected first claim.");
  const retry = await failCaptureEvent({
    runtimeRoot,
    eventId,
    leaseToken: first.leaseToken,
    failedAt: "2026-08-07T03:00:02.000Z",
    retryAt: "2026-08-07T03:01:00.000Z",
    retryable: true,
    maximumAttempts: 2,
    errorCode: "model_unavailable"
  });
  const tooEarly = await claimCaptureEvent({
    runtimeRoot,
    workerId: "worker-b",
    now: "2026-08-07T03:00:30.000Z",
    leaseSeconds: 10
  });
  const second = await claimCaptureEvent({
    runtimeRoot,
    workerId: "worker-b",
    now: "2026-08-07T03:01:00.000Z",
    leaseSeconds: 10
  });
  if (second.state !== "claimed") throw new Error("Expected retry claim.");
  const deadLetter = await failCaptureEvent({
    runtimeRoot,
    eventId,
    leaseToken: second.leaseToken,
    failedAt: "2026-08-07T03:01:01.000Z",
    retryAt: "2026-08-07T03:02:00.000Z",
    retryable: true,
    maximumAttempts: 2,
    errorCode: "model_unavailable"
  });

  expect(retry.state).toBe("retry_scheduled");
  expect(tooEarly).toEqual({ state: "empty" });
  expect(deadLetter.state).toBe("dead_letter");
  expect(await inspectCaptureEventState(runtimeRoot, eventId)).toEqual({
    eventId,
    state: "dead_letter",
    attemptCount: 2,
    lastErrorCode: "model_unavailable"
  });
});
