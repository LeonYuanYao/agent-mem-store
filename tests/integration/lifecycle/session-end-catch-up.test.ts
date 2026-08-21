import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { captureEvent, readCapturedEvent } from "../../../src/capture/index.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { captureAbandonedSessionEnd } from "../../../src/worker/session-catchup.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("the abandoned-session scan uses the session activity covering index", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-session-catch-up-plan-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const plan = database.prepare(
      `EXPLAIN QUERY PLAN
       WITH inactive_sessions AS (
         SELECT session_id, MAX(occurred_at) AS last_event_at
         FROM capture_events
         WHERE session_id IS NOT NULL
         GROUP BY session_id
         HAVING MAX(CASE WHEN event_kind = 'SessionEnd' THEN 1 ELSE 0 END) = 0
            AND MAX(occurred_at) <= ?
       )
       SELECT inactive.session_id, inactive.last_event_at,
              capture.event_id AS last_event_id, capture.project_id
       FROM inactive_sessions AS inactive
       JOIN capture_events AS capture
         ON capture.session_id = inactive.session_id
        AND capture.occurred_at = inactive.last_event_at
       ORDER BY inactive.last_event_at ASC, capture.created_at DESC
       LIMIT 1`
    ).all("2026-08-08T09:00:00.000Z") as readonly Record<string, unknown>[];
    const details = plan.map((row) => String(row.detail));
    expect(details).toContainEqual(
      expect.stringContaining("USING COVERING INDEX capture_events_session_activity")
    );
    expect(details).not.toContainEqual(expect.stringContaining("USE TEMP B-TREE FOR GROUP BY"));
  } finally {
    database.close();
  }
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
