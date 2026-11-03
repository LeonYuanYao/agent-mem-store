import { isAgentNotification, userPromptText, withoutPrivateText } from "../contracts/prompt-text.js";
import { openRuntimeDatabaseReadOnly } from "../runtime/database.js";

/**
 * The Session's recent turns as captured (ADR-0167), for the conversation context Jev
 * reads when the in-memory history is empty, as after every Worker restart. Prompts
 * come from UserPromptSubmit, replies from Stop; task notifications and text marked
 * private stay out; the current prompt, if already captured, is not history.
 */
export async function capturedConversationTurns(request: {
  readonly runtimeRoot: string;
  readonly sessionId: string;
  readonly currentPrompt: string;
  readonly limit?: number;
}): Promise<{ readonly user: string; readonly assistant?: string }[]> {
  const database = await openRuntimeDatabaseReadOnly(request.runtimeRoot);
  try {
    const events = database.prepare(
      `SELECT event_id, event_kind FROM capture_events
       WHERE session_id = ? AND event_kind IN ('UserPromptSubmit', 'Stop') AND payload_removed_at IS NULL
       ORDER BY created_at DESC, event_id DESC LIMIT 24`
    ).all(request.sessionId).reverse();
    const segments = database.prepare("SELECT payload FROM capture_segments WHERE event_id = ? ORDER BY segment_index");
    const turns: { user: string; assistant?: string }[] = [];
    for (const event of events) {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(Buffer.concat(segments.all(String(event.event_id)).map((row) =>
          row.payload instanceof Uint8Array ? Buffer.from(row.payload) : Buffer.alloc(0))).toString("utf8")) as Record<string, unknown>;
      } catch { continue; }
      if (event.event_kind === "UserPromptSubmit" && typeof payload.prompt === "string") {
        const prompt = withoutPrivateText(userPromptText(payload.prompt)).text.trim();
        if (prompt !== "" && !isAgentNotification(prompt)) turns.push({ user: prompt });
      } else if (event.event_kind === "Stop" && typeof payload.assistantMessage === "string" && turns.length > 0) {
        const last = turns[turns.length - 1];
        if (last !== undefined && payload.assistantMessage.trim() !== "") last.assistant = payload.assistantMessage;
      }
    }
    const current = withoutPrivateText(userPromptText(request.currentPrompt)).text.trim();
    if (turns.at(-1)?.user === current && turns.at(-1)?.assistant === undefined) turns.pop();
    return turns.slice(-(request.limit ?? 3));
  } finally {
    database.close();
  }
}
