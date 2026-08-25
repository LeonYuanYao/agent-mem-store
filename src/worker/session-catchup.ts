import { createHash } from "node:crypto";
import { z } from "zod";

import { captureEvent } from "../capture/index.js";
import { openRuntimeDatabase } from "../runtime/database.js";

export const abandonedSessionInactivityMilliseconds = 2 * 60 * 60 * 1_000;

export type CaptureAbandonedSessionEndResult =
  | { readonly state: "empty" }
  | {
      readonly state: "captured";
      readonly eventId: string;
      readonly sessionId: string;
      readonly lastEventAt: string;
    };

export async function captureAbandonedSessionEnd(request: {
  readonly runtimeRoot: string;
  readonly now: string;
  readonly inactivityMilliseconds: number;
}): Promise<CaptureAbandonedSessionEndResult> {
  const now = z.iso.datetime().parse(request.now);
  const inactivityMilliseconds = z.number().int().min(60_000).max(30 * 86_400_000).parse(
    request.inactivityMilliseconds
  );
  const inactiveBefore = new Date(Date.parse(now) - inactivityMilliseconds).toISOString();
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let row: Record<string, unknown> | undefined;
  try {
    row = database.prepare(
      `WITH inactive_sessions AS (
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
    ).get(inactiveBefore);
  } finally {
    database.close();
  }
  if (row === undefined) return { state: "empty" };
  const sessionId = z.string().min(1).parse(row.session_id);
  const lastEventAt = z.iso.datetime().parse(row.last_event_at);
  const lastEventId = z.string().min(1).parse(row.last_event_id);
  const identity = createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(lastEventId)
    .digest("hex");
  const eventId = `msevent_abandoned_${identity.slice(0, 32)}`;
  const captured = await captureEvent({
    runtimeRoot: request.runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId,
      deduplicationKey: `memstore:session-idle:${identity}`,
      agent: "codex",
      eventKind: "SessionEnd",
      occurredAt: now,
      ...(typeof row.project_id === "string" ? { projectId: row.project_id } : {}),
      sessionId,
      payload: {
        synthetic: true,
        reason: "session_idle_timeout",
        lastEventAt
      }
    }
  });
  if (captured.state !== "captured" && captured.state !== "duplicate") {
    throw new Error(`Synthetic SessionEnd was rejected with state ${captured.state}.`);
  }
  return { state: "captured", eventId: captured.eventId, sessionId, lastEventAt };
}
