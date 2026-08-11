import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { captureEvent, readCapturedEvent } from "../../../src/capture/index.js";
import { captureAbandonedSessionEnd } from "../../../src/worker/session-catchup.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a Session missing SessionEnd is closed only after 24 hours of inactivity", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-session-catch-up-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent_abandoned_source",
      deduplicationKey: "codex:abandoned:source",
      agent: "codex",
      eventKind: "Stop",
      occurredAt: "2026-08-07T09:00:00.000Z",
      projectId: "msproj_abandoned",
      sessionId: "abandoned-session",
      payload: { transcript: "not copied into the synthetic event" }
    }
  });

  await expect(captureAbandonedSessionEnd({
    runtimeRoot,
    now: "2026-08-08T08:59:59.999Z",
    inactivityMilliseconds: 24 * 60 * 60 * 1_000
  })).resolves.toEqual({ state: "empty" });

  const caughtUp = await captureAbandonedSessionEnd({
    runtimeRoot,
    now: "2026-08-08T09:00:00.000Z",
    inactivityMilliseconds: 24 * 60 * 60 * 1_000
  });
  expect(caughtUp).toMatchObject({ state: "captured", sessionId: "abandoned-session" });
  if (caughtUp.state !== "captured") throw new Error("Expected a synthetic SessionEnd.");
  const event = await readCapturedEvent(runtimeRoot, caughtUp.eventId);
  expect(event).toMatchObject({
    eventKind: "SessionEnd",
    sessionId: "abandoned-session",
    payload: {
      synthetic: true,
      reason: "session_idle_timeout",
      lastEventAt: "2026-08-07T09:00:00.000Z"
    }
  });
  expect(JSON.stringify(event)).not.toContain("not copied into the synthetic event");
  await expect(captureAbandonedSessionEnd({
    runtimeRoot,
    now: "2026-08-09T09:00:00.000Z",
    inactivityMilliseconds: 24 * 60 * 60 * 1_000
  })).resolves.toEqual({ state: "empty" });
});
