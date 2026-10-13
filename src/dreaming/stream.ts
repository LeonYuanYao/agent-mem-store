import type { DatabaseSync } from "node:sqlite";

/**
 * Renders one captured Session as plain text for extraction: user prompts,
 * assistant replies and tool calls with bounded results. Knowledge an agent
 * learns by reading files often appears only in tool output, so results are
 * kept (head and tail) rather than dropped.
 */

const toolHeadCharacters = 1_500;
const toolTailCharacters = 500;
const toolInputCharacters = 400;
const pathPattern = /(?:[\w.@-]+\/)+[\w.@-]+\.(?:ts|tsx|js|mjs|cjs|md|mdx|json|py|mm|h|hpp|c|cc|cpp|cfg|toml|ya?ml|sh|swift|kt|java|go|rs)\b/gu;

export interface SessionStream {
  readonly chunks: readonly string[];
  readonly firstEventAt: string;
  readonly lastEventAt: string;
  readonly cwds: readonly string[];
  /** File paths touched by tool calls, keyed by turn label (T01, T02, ...). */
  readonly turnPaths: Readonly<Record<string, readonly string[]>>;
}

function decodePayload(rows: readonly Record<string, unknown>[]): unknown {
  const buffers = rows.map((row) => row.payload instanceof Uint8Array ? Buffer.from(row.payload) : Buffer.alloc(0));
  try {
    return JSON.parse(Buffer.concat(buffers).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Chat bridges such as botmux wrap each prompt in routing rules, skill lists and
 * identity blocks around a `<user_message>` element. Only that element is the
 * user's own text; the wrapper would otherwise read as rules the user stated.
 */
export function userPromptText(prompt: string): string {
  const messages = [...prompt.matchAll(/<user_message>([\s\S]*?)<\/user_message>/gu)].map((match) => (match[1] ?? "").trim());
  return messages.length === 0 ? prompt : messages.join("\n\n");
}

function boundedResult(value: string): string {
  if (value.length <= toolHeadCharacters + toolTailCharacters) return value;
  const omitted = value.length - toolHeadCharacters - toolTailCharacters;
  return `${value.slice(0, toolHeadCharacters)}\n…[${String(omitted)} chars omitted]…\n${value.slice(-toolTailCharacters)}`;
}

export function readSessionStream(
  database: DatabaseSync,
  request: { readonly sessionId: string; readonly projectId: string; readonly chunkCharacters: number }
): SessionStream | undefined {
  const events = database.prepare(
    `SELECT event_id, event_kind, created_at FROM capture_events
     WHERE session_id = ? AND project_id = ? ORDER BY created_at, event_id`
  ).all(request.sessionId, request.projectId);
  if (events.length === 0) return undefined;
  const segments = database.prepare(
    "SELECT payload FROM capture_segments WHERE event_id = ? ORDER BY segment_index"
  );
  const lines: string[] = [];
  const cwds = new Set<string>();
  const turnPaths: Record<string, string[]> = {};
  let turn = 0;
  const label = (): string => `T${String(turn).padStart(2, "0")}`;
  for (const event of events) {
    const payload = record(decodePayload(segments.all(String(event.event_id))));
    if (event.event_kind === "UserPromptSubmit") {
      turn += 1;
      lines.push(`\n### ${label()} USER\n${userPromptText(text(payload.prompt))}`);
    } else if (event.event_kind === "Stop") {
      lines.push(`### ${label()} ASSISTANT\n${text(payload.assistantMessage)}`);
    } else if (event.event_kind === "PostToolUse") {
      if (typeof payload.cwd === "string") cwds.add(payload.cwd);
      const input = record(payload.input);
      const command = typeof input.command === "string" ? input.command
        : typeof input.cmd === "string" ? input.cmd : text(payload.input);
      const paths = turnPaths[label()] ?? [];
      for (const match of command.matchAll(pathPattern)) {
        if (!paths.includes(match[0]) && paths.length < 20) paths.push(match[0]);
      }
      turnPaths[label()] = paths;
      lines.push(`[tool ${label()}] ${text(payload.toolName) || "tool"}: ${command.slice(0, toolInputCharacters)}\n→ ${boundedResult(text(payload.response))}`);
    }
  }
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current.length > 0 && current.length + line.length > request.chunkCharacters) {
      chunks.push(current);
      current = "";
    }
    current += `${line.slice(0, request.chunkCharacters)}\n`;
  }
  if (current.trim().length > 0) chunks.push(current);
  return {
    chunks,
    firstEventAt: String(events[0]?.created_at),
    lastEventAt: String(events.at(-1)?.created_at),
    cwds: [...cwds],
    turnPaths
  };
}
