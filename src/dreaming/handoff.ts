import { openRuntimeDatabase } from "../runtime/database.js";

/**
 * With dreaming enabled, captured events are owned by the nightly run instead of
 * per-turn distillation. Pending events that no distillation batch has claimed
 * are marked completed so they never enter per-turn Luna work, background
 * recovery backlog counts or governance deferral. Their payloads stay readable
 * for dreaming under the normal capture retention rules.
 */
export async function handOffCaptureToDreaming(request: {
  readonly runtimeRoot: string;
  readonly now: string;
  readonly minimumAgeMilliseconds?: number;
}): Promise<number> {
  const eligibleBefore = new Date(Date.parse(request.now) - (request.minimumAgeMilliseconds ?? 30_000)).toISOString();
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const result = database.prepare(
      `UPDATE capture_events SET state = 'completed', updated_at = ?
       WHERE event_id IN (
         SELECT capture.event_id FROM capture_events AS capture
         WHERE capture.state = 'pending' AND capture.created_at <= ?
           AND NOT EXISTS (SELECT 1 FROM distillation_batch_events AS assigned WHERE assigned.event_id = capture.event_id)
         ORDER BY capture.created_at LIMIT 256
       )`
    ).run(request.now, eligibleBefore);
    return Number(result.changes);
  } finally {
    database.close();
  }
}
