import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { captureEvent, readCapturedEvent } from "../../../src/capture/index.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { runWorkerOnce } from "../../../src/worker/main.js";
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
         SELECT session_id, MAX(occurred_at) AS last_event_at,
                MAX(CASE WHEN event_kind = 'SessionEnd' THEN occurred_at END)
                  AS last_session_end_at
         FROM capture_events
         WHERE session_id IS NOT NULL
         GROUP BY session_id
         HAVING MAX(occurred_at) <= ?
            AND (
              MAX(CASE WHEN event_kind = 'SessionEnd' THEN occurred_at END) IS NULL
              OR MAX(CASE WHEN event_kind = 'SessionEnd' THEN occurred_at END) <
                 MAX(occurred_at)
            )
       )
       SELECT inactive.session_id, inactive.last_event_at,
              capture.event_id AS last_event_id, capture.project_id
       FROM inactive_sessions AS inactive
       JOIN capture_events AS capture
         ON capture.session_id = inactive.session_id
        AND capture.occurred_at = inactive.last_event_at
        AND capture.event_kind <> 'SessionEnd'
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

test("the catch-up primitive respects its configured inactivity window", async () => {
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

test("a resumed Session receives a new inactivity checkpoint after its latest episode", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-resumed-session-catch-up-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  for (const [index, event] of [
    { eventKind: "UserPromptSubmit" as const, occurredAt: "2026-08-25T08:55:00.000Z" },
    { eventKind: "SessionEnd" as const, occurredAt: "2026-08-25T09:00:00.000Z" },
    { eventKind: "Stop" as const, occurredAt: "2026-08-25T10:00:00.000Z" }
  ].entries()) {
    await captureEvent({
      runtimeRoot,
      event: {
        schemaVersion: 1,
        eventId: `msevent_resumed_catch_up_${String(index)}`,
        deduplicationKey: `codex:resumed-catch-up:${String(index)}`,
        agent: "codex",
        eventKind: event.eventKind,
        occurredAt: event.occurredAt,
        projectId: "msproj_resumed_catch_up",
        sessionId: "resumed-catch-up-session",
        ...(event.eventKind === "SessionEnd" ? {} : { turnId: `turn-${String(index)}` }),
        payload: { index }
      }
    });
  }

  await expect(captureAbandonedSessionEnd({
    runtimeRoot,
    now: "2026-08-25T11:59:59.999Z",
    inactivityMilliseconds: 2 * 60 * 60 * 1_000
  })).resolves.toEqual({ state: "empty" });
  await expect(captureAbandonedSessionEnd({
    runtimeRoot,
    now: "2026-08-25T12:00:00.000Z",
    inactivityMilliseconds: 2 * 60 * 60 * 1_000
  })).resolves.toMatchObject({
    state: "captured",
    sessionId: "resumed-catch-up-session",
    lastEventAt: "2026-08-25T10:00:00.000Z"
  });
});

test("the Worker closes a paused Session after two hours so durable Batches can consolidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-session-checkpoint-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent_session_checkpoint_source",
      deduplicationKey: "codex:session-checkpoint:source",
      agent: "codex",
      eventKind: "Stop",
      occurredAt: "2026-08-25T09:00:00.000Z",
      projectId: "msproj_session_checkpoint",
      sessionId: "session-checkpoint",
      turnId: "session-checkpoint-turn",
      payload: { summary: "Durable source body is not copied into catch-up." }
    }
  });
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare(
      "UPDATE capture_events SET state = 'completed' WHERE event_id = ?"
    ).run("msevent_session_checkpoint_source");
  } finally {
    database.close();
  }

  const early = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "session-checkpoint-worker",
    now: "2026-08-25T10:59:59.999Z",
    workerStartedAt: "2026-08-25T08:59:00.000Z"
  });
  expect(early.activities ?? []).not.toContain("session-end:catch-up");

  const due = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "session-checkpoint-worker",
    now: "2026-08-25T11:00:00.000Z",
    workerStartedAt: "2026-08-25T08:59:00.000Z"
  });
  expect(due.activities ?? []).toContain("session-end:catch-up");

  const verification = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(verification.prepare(
      `SELECT event_kind, json_extract(CAST(segment.payload AS TEXT), '$.reason') AS reason
       FROM capture_events AS event
       JOIN capture_segments AS segment ON segment.event_id = event.event_id
       WHERE event.session_id = ? AND event.event_kind = 'SessionEnd'`
    ).get("session-checkpoint")).toEqual({
      event_kind: "SessionEnd",
      reason: "session_idle_timeout"
    });
  } finally {
    verification.close();
  }
});
