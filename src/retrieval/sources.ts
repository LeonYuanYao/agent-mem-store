import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { userPromptText, withoutPrivateText } from "../contracts/prompt-text.js";
import { resolveMemoryReference } from "../memories/reference.js";
import { openRuntimeDatabaseReadOnly } from "../runtime/database.js";
import { readCanonicalMemory } from "../vault/index.js";

/**
 * `memstore recall sources` (ADR-0162): the conversation a dreaming Memory came
 * from. Candidates extracted since migration 76 name their turns, shown with the
 * user's prompt, the reply and the tools used; older Memories show their Sessions'
 * prompts as a timeline. Captured text is kept 30 days, so older sources are only
 * named. Text the user marked private never appears.
 */

export interface SourceTurn {
  readonly at: string;
  readonly user: string;
  readonly assistant?: string;
  readonly tools: readonly string[];
}

export interface SourceSession {
  readonly sessionId: string;
  readonly agent?: string;
  readonly firstEventAt?: string;
  readonly lastEventAt?: string;
  readonly state: "source_turns" | "timeline" | "expired" | "not_captured";
  readonly turns: readonly SourceTurn[];
}

const userCharacters = 800;
const assistantCharacters = 800;
const timelineCharacters = 160;
const timelineTurns = 12;
const sessionLimit = 4;

function decode(database: DatabaseSync, eventId: string): Record<string, unknown> {
  const rows = database.prepare("SELECT payload FROM capture_segments WHERE event_id = ? ORDER BY segment_index").all(eventId);
  try {
    const value: unknown = JSON.parse(Buffer.concat(rows.map((row) =>
      row.payload instanceof Uint8Array ? Buffer.from(row.payload) : Buffer.alloc(0))).toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

function promptOf(payload: Record<string, unknown>): string {
  return typeof payload.prompt === "string" ? withoutPrivateText(userPromptText(payload.prompt)).text : "";
}

interface EventRow { readonly eventId: string; readonly kind: string; readonly at: string; readonly removed: boolean }

function sessionEvents(database: DatabaseSync, sessionId: string): EventRow[] {
  return database.prepare(
    `SELECT event_id, event_kind, created_at, payload_removed_at FROM capture_events
     WHERE session_id = ? ORDER BY created_at, event_id`
  ).all(sessionId).map((row) => ({
    eventId: String(row.event_id), kind: String(row.event_kind), at: String(row.created_at), removed: row.payload_removed_at !== null
  }));
}

/** The turn a prompt event opens: everything until the next prompt of the Session. */
function turnFrom(database: DatabaseSync, events: readonly EventRow[], start: number): SourceTurn {
  const opening = events[start];
  if (opening === undefined) throw new Error("Turn start is out of range.");
  const tools = new Set<string>();
  let assistant: string | undefined;
  for (const event of events.slice(start + 1)) {
    if (event.kind === "UserPromptSubmit") break;
    const payload = decode(database, event.eventId);
    if (event.kind === "PostToolUse" && typeof payload.toolName === "string" && tools.size < 10) tools.add(payload.toolName);
    if (event.kind === "Stop" && typeof payload.assistantMessage === "string") assistant = payload.assistantMessage;
  }
  return {
    at: opening.at,
    user: clip(promptOf(decode(database, opening.eventId)), userCharacters),
    ...(assistant === undefined ? {} : { assistant: clip(assistant, assistantCharacters) }),
    tools: [...tools]
  };
}

export async function recallSources(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly memory: string;
}): Promise<{
  readonly memoryRef: string;
  readonly authority: string;
  readonly sessions: readonly SourceSession[];
  readonly note?: string;
}> {
  const resolved = await resolveMemoryReference(request.runtimeRoot, request.memory);
  const loaded = await readCanonicalMemory({ runtimeRoot: request.runtimeRoot, vaultRoot: request.vaultRoot, memoryId: resolved.memoryId });
  if (loaded === undefined || loaded.memory.lifecycle === "tombstone") throw new Error("Memory sources are unavailable.");
  const memory = loaded.memory;
  const database = await openRuntimeDatabaseReadOnly(request.runtimeRoot);
  try {
    // Source turns recorded on the candidates the Memory's dream items merged.
    const sourceEvents = new Map<string, Set<string>>();
    const candidateIds = database.prepare("SELECT member_ids_json FROM dream_items WHERE apply_memory_id = ?").all(memory.memoryId)
      .flatMap((row) => z.array(z.string()).catch([]).parse(JSON.parse(String(row.member_ids_json ?? "[]"))));
    for (const candidateId of new Set(candidateIds)) {
      const row = database.prepare("SELECT session_id, source_event_ids_json FROM dream_candidates WHERE candidate_id = ?").get(candidateId);
      if (row === undefined) continue;
      const events = sourceEvents.get(String(row.session_id)) ?? new Set<string>();
      for (const eventId of z.array(z.string()).catch([]).parse(JSON.parse(String(row.source_event_ids_json ?? "[]")))) events.add(eventId);
      sourceEvents.set(String(row.session_id), events);
    }
    const sessionIds = [...new Set([
      ...sourceEvents.keys(),
      ...memory.provenance.filter((entry) => entry.startsWith("session:")).map((entry) => entry.slice("session:".length))
    ])].slice(0, sessionLimit);
    const sessions = sessionIds.map((sessionId): SourceSession => {
      const events = sessionEvents(database, sessionId);
      if (events.length === 0) return { sessionId, state: "not_captured", turns: [] };
      const agentRow = database.prepare("SELECT agent FROM capture_events WHERE session_id = ? LIMIT 1").get(sessionId);
      const base = {
        sessionId, ...(agentRow === undefined ? {} : { agent: String(agentRow.agent) }),
        firstEventAt: events[0]?.at ?? "", lastEventAt: events.at(-1)?.at ?? ""
      };
      const prompts = events.map((event, index) => ({ event, index })).filter(({ event }) => event.kind === "UserPromptSubmit");
      if (prompts.every(({ event }) => event.removed)) return { ...base, state: "expired", turns: [] };
      const named = sourceEvents.get(sessionId) ?? new Set<string>();
      const sourcePrompts = prompts.filter(({ event }) => named.has(event.eventId) && !event.removed);
      if (sourcePrompts.length > 0) {
        return { ...base, state: "source_turns", turns: sourcePrompts.map(({ index }) => turnFrom(database, events, index)) };
      }
      return { ...base, state: "timeline", turns: prompts.filter(({ event }) => !event.removed).slice(0, timelineTurns).map(({ event }) => ({
        at: event.at, user: clip(promptOf(decode(database, event.eventId)), timelineCharacters), tools: []
      })) };
    });
    const note = memory.authority === "human_authored"
      ? "A Human-authored Memory has no source conversation; its origin is in `memstore recall provenance`."
      : sessions.length === 0 ? "No source Session is recorded for this Memory." : undefined;
    return {
      memoryRef: resolved.reference, authority: memory.authority, sessions,
      ...(note === undefined ? {} : { note })
    };
  } finally {
    database.close();
  }
}
