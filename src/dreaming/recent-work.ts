import { Temporal } from "@js-temporal/polyfill";

import { classifyLocalSensitivity } from "../contracts/sensitivity.js";
import { openRuntimeDatabase, openRuntimeDatabaseReadOnly } from "../runtime/database.js";
import type { DreamingConfiguration } from "./config.js";
import { DreamModelError, transientModelErrors, type DreamModel } from "./model.js";
import { projectDisplay } from "./report.js";
import { readSessionStream } from "./stream.js";

/**
 * Recent work (ADR-0164): dreaming keeps only knowledge that stays true, so a new
 * Session could not tell what the last one was doing. When a Session has been idle
 * for `recent_work_idle_minutes`, one low-effort model call writes a short note of
 * where its work stands; the next Session of the Project starts with the latest
 * notes. Notes live in the runtime database only and expire after `recent_work_days`.
 */

const transcriptCharacters = 20_000;
const summaryCharacters = 400;
const notesInjected = 2;
const refreshMinutes = 60;

export type RecentWorkStepResult =
  | { readonly state: "idle" }
  | { readonly state: "noted" | "nothing_to_carry" | "failed"; readonly sessionId: string };

export async function runNextRecentWorkStep(request: {
  readonly runtimeRoot: string;
  readonly now: string;
  readonly configuration: DreamingConfiguration;
  readonly model: DreamModel;
}): Promise<RecentWorkStepResult> {
  const summarize = request.model.summarizeWork?.bind(request.model);
  if (!request.configuration.recent_work || summarize === undefined) return { state: "idle" };
  const now = Date.parse(request.now);
  const oldest = new Date(now - request.configuration.recent_work_days * 86_400_000).toISOString();
  const idleBefore = new Date(now - request.configuration.recent_work_idle_minutes * 60_000).toISOString();
  const refreshBefore = new Date(now - refreshMinutes * 60_000).toISOString();
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.prepare("DELETE FROM recent_work_notes WHERE through_event_at < ?").run(oldest);
    // The most recently active idle Session whose work has moved on since its note.
    // Only the latest notes of a Project are injected, so a Session with two newer notes in its Project is skipped.
    const session = database.prepare(
      `WITH activity AS (
         SELECT session_id, max(created_at) AS last_at, max(agent) AS agent, sum(event_kind = 'UserPromptSubmit') AS prompts
         FROM capture_events WHERE created_at >= ? GROUP BY session_id
       ), located AS (
         SELECT activity.*, (SELECT project_id FROM capture_events WHERE session_id = activity.session_id AND project_id IS NOT NULL
           ORDER BY created_at LIMIT 1) AS project_id
         FROM activity WHERE prompts > 0 AND last_at <= ?
       )
       SELECT located.session_id, located.last_at, located.agent, located.project_id, note.summary AS previous
       FROM located LEFT JOIN recent_work_notes AS note ON note.session_id = located.session_id
       WHERE (note.session_id IS NULL OR note.last_error_code IS NOT NULL
              OR (note.through_event_at < located.last_at AND note.updated_at <= ?))
         AND (note.next_attempt_at IS NULL OR note.next_attempt_at <= ?)
         AND (SELECT count(*) FROM recent_work_notes AS newer WHERE newer.project_id = located.project_id
              AND newer.summary != '' AND newer.through_event_at > located.last_at) < ?
       ORDER BY located.last_at DESC LIMIT 1`
    ).get(oldest, idleBefore, refreshBefore, request.now, notesInjected);
    if (session === undefined || typeof session.project_id !== "string") return { state: "idle" };
    const projectId = session.project_id;
    const sessionId = String(session.session_id);
    const lastAt = String(session.last_at);
    const stream = readSessionStream(database, { sessionId, until: lastAt, chunkCharacters: 400_000 });
    const transcript = (stream?.chunks ?? []).join("").slice(-transcriptCharacters);
    const previous = typeof session.previous === "string" && session.previous !== "" ? session.previous : undefined;
    const upsert = (summary: string, tokens: number, error?: { code: string; retryAt: string }) => database.prepare(
      `INSERT INTO recent_work_notes(session_id, project_id, agent, summary, through_event_at, tokens, next_attempt_at, last_error_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET summary = CASE WHEN excluded.last_error_code IS NULL THEN excluded.summary ELSE summary END,
         through_event_at = CASE WHEN excluded.last_error_code IS NULL THEN excluded.through_event_at ELSE through_event_at END,
         tokens = tokens + excluded.tokens, next_attempt_at = excluded.next_attempt_at,
         last_error_code = excluded.last_error_code, updated_at = excluded.updated_at`
    ).run(sessionId, projectId, String(session.agent), summary, lastAt, tokens,
      error?.retryAt ?? null, error?.code ?? null, request.now, request.now);
    if (transcript.trim() === "") {
      upsert("", 0);
      return { state: "nothing_to_carry", sessionId };
    }
    const projectLabel = projectDisplay(database, projectId).label;
    try {
      const note = await summarize({ projectLabel, transcript, ...(previous === undefined ? {} : { previous }) });
      const summary = note.summary.trim().slice(0, summaryCharacters);
      // A note never carries what the sensitivity check would block from capture.
      const keep = note.carryOver && summary !== "" && classifyLocalSensitivity(summary).state === "normal";
      upsert(keep ? summary : "", note.usage.tokens);
      return { state: keep ? "noted" : "nothing_to_carry", sessionId };
    } catch (error) {
      const code = error instanceof DreamModelError ? error.code : "process_failed";
      const delayMinutes = transientModelErrors.includes(code) ? 30 : 6 * 60;
      upsert("", 0, { code, retryAt: new Date(now + delayMinutes * 60_000).toISOString() });
      return { state: "failed", sessionId };
    }
  } finally {
    database.close();
  }
}

/** The SessionStart context: the latest notes of other Sessions of the Project, or undefined. */
export async function recentWorkContext(request: {
  readonly runtimeRoot: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly now: string;
  readonly configuration: DreamingConfiguration;
}): Promise<{ readonly text: string; readonly count: number } | undefined> {
  if (!request.configuration.enabled || !request.configuration.recent_work) return undefined;
  const oldest = new Date(Date.parse(request.now) - request.configuration.recent_work_days * 86_400_000).toISOString();
  const database = await openRuntimeDatabaseReadOnly(request.runtimeRoot);
  let notes: { agent: string; at: string; summary: string }[];
  try {
    notes = database.prepare(
      `SELECT agent, through_event_at, summary FROM recent_work_notes
       WHERE project_id = ? AND session_id != ? AND summary != '' AND through_event_at >= ?
       ORDER BY through_event_at DESC LIMIT ?`
    ).all(request.projectId, request.sessionId, oldest, notesInjected)
      .map((row) => ({ agent: String(row.agent), at: String(row.through_event_at), summary: String(row.summary) }));
  } finally {
    database.close();
  }
  if (notes.length === 0) return undefined;
  const lines = notes.map((note) => {
    const at = Temporal.Instant.from(note.at).toZonedDateTimeISO(request.configuration.timezone);
    const when = `${at.toPlainDate().toString().slice(5)} ${at.toPlainTime().toString().slice(0, 5)}`;
    return `- ${when} · ${note.agent === "claude" ? "Claude Code" : "Codex"}：${note.summary.replace(/\s*\n\s*/gu, " ")}`;
  });
  return {
    count: notes.length,
    text: ["<memstore-recent-work>",
      "本项目最近其他会话的工作进展（MemStore 根据会话记录自动整理，未经验证，7 天后过期）。只用于衔接；与当前任务无关就忽略，涉及事实时以代码和用户为准。",
      ...lines, "</memstore-recent-work>"].join("\n")
  };
}

/** Recent work for the first prompt of a Session: once per Session, before its own history exists. */
export async function firstPromptRecentWork(request: {
  readonly runtimeRoot: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly now: string;
  readonly configuration: DreamingConfiguration;
}): Promise<{ readonly text: string; readonly count: number } | undefined> {
  if (!request.configuration.enabled || !request.configuration.recent_work) return undefined;
  const database = await openRuntimeDatabaseReadOnly(request.runtimeRoot);
  let prompts: number;
  try {
    // The current prompt is usually captured already; an Inbox-delayed one is not.
    prompts = Number(database.prepare("SELECT count(*) AS n FROM capture_events WHERE session_id = ? AND event_kind = 'UserPromptSubmit'")
      .get(request.sessionId)?.n ?? 0);
  } finally {
    database.close();
  }
  return prompts <= 1 ? recentWorkContext(request) : undefined;
}

/** The hook display line for injected recent work. */
export function recentWorkDisplay(count: number): string {
  return `MemStore：附上本项目最近工作 ${String(count)} 条`;
}
