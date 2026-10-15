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

const userWordsCharacters = 2_000;

/**
 * The user message(s) behind a candidate the extractor marked as user-stated. The
 * quote decides: found in a USER turn gives that message; found only in replies or
 * tool output means the user did not say it (`other`); not found falls back to the
 * USER turns the candidate cites.
 */
export function userWordsFor(chunk: string, turnRefs: readonly string[], quote: string): {
  readonly source: "user" | "other" | "missing";
  readonly words: readonly string[];
} {
  const sections: { turn: string; user: boolean; text: string }[] = [];
  for (const line of chunk.split("\n")) {
    const heading = /^### (T\d+) (USER|ASSISTANT)$/u.exec(line);
    const tool = /^\[tool (T\d+)\]/u.exec(line);
    if (heading !== null) sections.push({ turn: heading[1] ?? "", user: heading[2] === "USER", text: "" });
    else if (tool !== null) sections.push({ turn: tool[1] ?? "", user: false, text: line });
    else { const last = sections.at(-1); if (last !== undefined) last.text += `${line}\n`; }
  }
  const normalize = (text: string): string => text.replace(/\s+/gu, "").toLowerCase();
  const needle = normalize(quote).slice(0, 50);
  const bound = (text: string): string => {
    const trimmed = text.trim();
    if (trimmed.length <= userWordsCharacters) return trimmed;
    const at = trimmed.indexOf(quote.trim().slice(0, 20));
    const start = at < 0 ? 0 : Math.max(0, at - userWordsCharacters / 2);
    return trimmed.slice(start, start + userWordsCharacters);
  };
  if (needle.length > 0) {
    const fromUser = sections.filter((section) => section.user && normalize(section.text).includes(needle));
    if (fromUser.length > 0) return { source: "user", words: fromUser.slice(0, 2).map((section) => bound(section.text)) };
    if (sections.some((section) => !section.user && normalize(section.text).includes(needle))) return { source: "other", words: [] };
  }
  const cited = sections.filter((section) => section.user && turnRefs.includes(section.turn));
  return { source: "missing", words: cited.slice(0, 2).map((section) => bound(section.text)) };
}

function boundedResult(value: string): string {
  if (value.length <= toolHeadCharacters + toolTailCharacters) return value;
  const omitted = value.length - toolHeadCharacters - toolTailCharacters;
  return `${value.slice(0, toolHeadCharacters)}\n…[${String(omitted)} chars omitted]…\n${value.slice(-toolTailCharacters)}`;
}

/**
 * Reads one segment of a Session: every event after `after` (exclusive) up to
 * `until` (inclusive), whichever Project each event resolved to. The bounds keep
 * chunking stable while the Session continues.
 */
export function readSessionStream(
  database: DatabaseSync,
  request: { readonly sessionId: string; readonly after?: string | undefined; readonly until: string; readonly chunkCharacters: number }
): SessionStream | undefined {
  const events = database.prepare(
    `SELECT event_id, event_kind, created_at FROM capture_events
     WHERE session_id = ? AND (? IS NULL OR created_at > ?) AND created_at <= ? ORDER BY created_at, event_id`
  ).all(request.sessionId, request.after ?? null, request.after ?? null, request.until);
  if (events.length === 0) return undefined;
  const segments = database.prepare(
    "SELECT payload FROM capture_segments WHERE event_id = ? ORDER BY segment_index"
  );
  const lines: string[] = request.after === undefined ? [] : ["（本会话更早的内容已在之前的 dreaming 中处理；以下只是之后的新活动。）"];
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
