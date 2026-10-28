import { randomUUID } from "node:crypto";
import { access, appendFile, chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { Temporal } from "@js-temporal/polyfill";

import { MemStoreCommandError } from "../contracts/envelope.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import { cloneOf, sessionSourceBranches, type SourceBranch } from "./branches.js";
import type { DreamingConfiguration } from "./config.js";
import { DreamModelError, transientModelErrors, type DreamModel, type Verdict } from "./model.js";
import { EvidenceReader } from "./msverify.js";
import { presearch, renderPresearch } from "./presearch.js";
import { buildRepoMap, repoMapSchema, temporaryRootPattern, type RepoMap } from "./repo-map.js";
import { dreamsDirectoryName, overviewFileName, writeDreamOverview, writeDreamReport } from "./report.js";
import { readSessionStream, userWordsFor } from "./stream.js";
import { applyBatch, applyBatchSize, loadApplyItems, statementKey, type ApplyItem, type ApplyOutcome } from "./apply.js";
import { applyMemoryLifecycleChange } from "../operations/memory-lifecycle.js";
import { isCatchAllRoot, relevantRepositories, tierOf } from "./tier.js";
import { routePath } from "./repo-map.js";

// A failing run waits 5, 10, 20, 40, then at most 60 minutes between attempts, so
// an outage of hours costs a few dozen cheap attempts rather than every chunk.
// Upper bound for a candidate's detail; the extractor is asked for at most 400 characters.
const detailCharacters = 1_200;
const retryBackoffMilliseconds = 5 * 60_000;
const maximumRetryBackoffMilliseconds = 60 * 60_000;
// A chunk fails for good after three failures of the call itself, or after 48
// connection failures: about two days offline with the backoff above, so an
// outage does not cost a claimed Session its knowledge.
const chunkFailureBudget = 48;
const hardFailureWeight = 16;
const mergeGroupSize = 120;
const prepareBatchSize = 10;
const defenseBatchSize = 4;

type Stage = "select" | "extract" | "merge" | "prepare" | "verify" | "defend" | "tier" | "report" | "completed" | "failed";

export interface DreamStepResult {
  readonly state: "idle" | "worked" | "deferred" | "failed";
  readonly runId?: string;
  readonly stage?: Stage;
  readonly detail?: string;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** A requested run applies when its request says so; other runs follow `[dreaming].mode`. */
function appliesRun(run: RunRow, configuration: DreamingConfiguration): boolean {
  return run.request === undefined ? configuration.mode === "apply" : run.request.apply;
}

function expandHome(path: string): string {
  return path.replace(/^~(?=\/|$)/u, homedir());
}

function runDirectory(runtimeRoot: string, runId: string): string {
  return join(runtimeRoot, "state", "dreaming", runId);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

/** Live, non-temporary roots of a Project; ephemeral test directories are not dreamed. */
export async function projectRoots(
  database: DatabaseSync,
  projectId: string,
  allowTemporaryRoots = false
): Promise<{ roots: string[]; kind: string }> {
  const rows = database.prepare("SELECT canonical_root, root_kind FROM project_roots WHERE project_id = ?").all(projectId);
  const roots: string[] = [];
  let kind = "non_git";
  for (const row of rows) {
    const root = String(row.canonical_root);
    if ((!allowTemporaryRoots && temporaryRootPattern.test(root)) || !(await exists(root))) continue;
    roots.push(root);
    if (row.root_kind === "git") kind = "git";
  }
  return { roots, kind };
}

interface EligibleSession {
  readonly session_id: string;
  /** Upper bound of the segment already dreamed about; undefined for a Session's first segment. */
  readonly after: string | undefined;
  readonly first_at: string;
  readonly last_at: string;
}

/**
 * Sessions of this Project with activity to dream about. A Session belongs to the
 * Project its first event resolved to: Claude Code reports the shell's current
 * directory, so a `cd` into a nested repository would otherwise split one Session
 * across Projects. A Session dreamed about before is eligible again once its newer
 * events have gone quiet, and only those are read; it is never re-claimed while
 * its previous run is still open.
 */
function eligibleSessions(
  database: DatabaseSync,
  projectId: string,
  now: string,
  configuration: DreamingConfiguration
): EligibleSession[] {
  const lookback = new Date(Date.parse(now) - configuration.lookback_days * 86_400_000).toISOString();
  const inactiveBefore = new Date(Date.parse(now) - configuration.inactivity_minutes * 60_000).toISOString();
  return database.prepare(
    `WITH recent AS (
       SELECT DISTINCT session_id FROM capture_events WHERE session_id IS NOT NULL AND created_at >= ?
     ), home AS (
       SELECT session_id, (SELECT e.project_id FROM capture_events e
                           WHERE e.session_id = recent.session_id AND e.project_id IS NOT NULL
                           ORDER BY e.created_at, e.event_id LIMIT 1) AS project_id
       FROM recent
     ), pending AS (
       SELECT h.session_id, d.last_event_at AS after
       FROM home h LEFT JOIN dream_sessions d USING (session_id)
       WHERE h.project_id = ?
         AND NOT EXISTS (SELECT 1 FROM dream_runs r WHERE r.run_id = d.run_id AND r.stage NOT IN ('completed', 'failed'))
     )
     SELECT p.session_id, p.after, MIN(e.created_at) AS first_at, MAX(e.created_at) AS last_at,
            MAX(CASE WHEN e.event_kind = 'SessionEnd' THEN e.created_at END) AS ended_at
     FROM pending p JOIN capture_events e ON e.session_id = p.session_id AND (p.after IS NULL OR e.created_at > p.after)
     GROUP BY p.session_id
     HAVING last_at >= ? AND (ended_at = last_at OR last_at <= ?)
     ORDER BY last_at ASC LIMIT ?`
  ).all(lookback, projectId, lookback, inactiveBefore, configuration.max_sessions_per_run)
    .map((row) => ({
      session_id: String(row.session_id),
      after: typeof row.after === "string" ? row.after : undefined,
      first_at: String(row.first_at),
      last_at: String(row.last_at)
    }));
}

/** Creates at most one run per Project per local calendar day once the configured hour has passed. */
export async function scheduleDueDreams(request: {
  readonly runtimeRoot: string;
  readonly now: string;
  readonly configuration: DreamingConfiguration;
  readonly allowTemporaryRoots?: boolean;
}): Promise<{ readonly created: readonly string[] }> {
  if (!request.configuration.enabled) return { created: [] };
  const local = Temporal.Instant.from(request.now).toZonedDateTimeISO(request.configuration.timezone);
  if (local.hour < request.configuration.hour) return { created: [] };
  const scheduledFor = local.toPlainDate().toString();
  const database = await openRuntimeDatabase(request.runtimeRoot);
  const created: string[] = [];
  try {
    const projects = database.prepare(
      `SELECT DISTINCT project_id FROM capture_events
       WHERE project_id IS NOT NULL AND created_at >= ?`
    ).all(new Date(Date.parse(request.now) - request.configuration.lookback_days * 86_400_000).toISOString());
    for (const row of projects) {
      const projectId = String(row.project_id);
      const already = database.prepare("SELECT 1 FROM dream_runs WHERE project_id = ? AND scheduled_for = ?").get(projectId, scheduledFor);
      if (already !== undefined) continue;
      if ((await projectRoots(database, projectId, request.allowTemporaryRoots)).roots.length === 0) continue;
      if (eligibleSessions(database, projectId, request.now, request.configuration).length === 0) continue;
      created.push(createRun(database, projectId, scheduledFor, request.now, request.configuration.mode));
    }
  } finally {
    database.close();
  }
  return { created };
}

function createRun(database: DatabaseSync, projectId: string, scheduledFor: string, now: string, mode: "shadow" | "apply" = "shadow"): string {
  const runId = `msdream_${randomUUID()}`;
  database.prepare(
    `INSERT INTO dream_runs(run_id, project_id, scheduled_for, mode, stage, window_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'select', ?, ?, ?)`
  ).run(runId, projectId, scheduledFor, mode, now, now, now);
  return runId;
}

/**
 * A run over exactly the capture events a user asked to remember from
 * (`memstore remember extract` while dreaming is enabled). The Worker runs it on
 * its next idle iteration; items that survive verification are injected as
 * user-requested knowledge.
 */
export async function startRequestedDreamRun(request: {
  readonly runtimeRoot: string;
  readonly projectId: string;
  readonly now: string;
  readonly request: DreamRequest;
}): Promise<string> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const runId = `msdream_${randomUUID()}`;
    database.prepare(
      `INSERT INTO dream_runs(run_id, project_id, scheduled_for, mode, stage, window_end, created_at, updated_at, request_json)
       VALUES (?, ?, ?, ?, 'select', ?, ?, ?, ?)`
    ).run(runId, request.projectId, `requested:${request.now}:${runId.slice(8, 16)}`, request.request.apply ? "apply" : "shadow", request.now, request.now, request.now,
      json(request.request));
    return runId;
  } finally {
    database.close();
  }
}

/** Manual trigger used by `memstore dream run`; ignores the schedule but not eligibility. */
export async function startDreamRun(request: { readonly runtimeRoot: string; readonly projectId: string; readonly now: string }): Promise<string> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    return createRun(database, request.projectId, `manual:${request.now}`, request.now);
  } finally {
    database.close();
  }
}

/** What `memstore remember extract` asked dreaming to read (ADR-0150). */
export interface DreamRequest {
  readonly eventIds: readonly string[];
  readonly selector: string;
  readonly scope: "project" | "global";
  /** Write the inject tier when the run completes; false previews in the report only. */
  readonly apply: boolean;
}

interface RunRow {
  readonly runId: string;
  readonly projectId: string;
  readonly stage: Stage;
  readonly scheduledFor: string;
  readonly windowEnd: string;
  readonly stats: Record<string, number>;
  readonly request?: DreamRequest;
}

function requestOf(value: unknown): { readonly request?: DreamRequest } {
  const request = parseRequest(value);
  return request === undefined ? {} : { request };
}

function parseRequest(value: unknown): DreamRequest | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = parseJson<Partial<DreamRequest>>(value, {});
  if (!Array.isArray(parsed.eventIds) || typeof parsed.selector !== "string") return undefined;
  return { eventIds: parsed.eventIds.map(String), selector: parsed.selector, scope: parsed.scope === "global" ? "global" : "project", apply: parsed.apply === true };
}

/** `attempt_count` counts failures since the run last made progress. */
function retryBackoff(failures: number): number {
  return Math.min(maximumRetryBackoffMilliseconds, retryBackoffMilliseconds * 2 ** Math.max(0, Math.min(failures - 1, 4)));
}

function nextOpenRun(database: DatabaseSync, now: string): RunRow | undefined {
  const row = database.prepare(
    `SELECT run_id, project_id, stage, scheduled_for, window_end, stats_json, last_error_code, attempt_count, updated_at, request_json FROM dream_runs
     WHERE stage NOT IN ('completed', 'failed') ORDER BY created_at`
  ).all().find((candidate) => candidate.last_error_code === null ||
    Date.parse(now) - Date.parse(String(candidate.updated_at)) >= retryBackoff(Number(candidate.attempt_count)));
  return row === undefined ? undefined : {
    runId: String(row.run_id),
    projectId: String(row.project_id),
    stage: row.stage as Stage,
    scheduledFor: String(row.scheduled_for),
    windowEnd: String(row.window_end),
    stats: parseJson<Record<string, number>>(row.stats_json, {}),
    ...requestOf(row.request_json)
  };
}

function advance(database: DatabaseSync, run: RunRow, stage: Stage, now: string, stats?: Record<string, number>): void {
  database.prepare(
    `UPDATE dream_runs SET stage = ?, updated_at = ?, last_error_code = NULL, attempt_count = 0, stats_json = ?,
       completed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE completed_at END
     WHERE run_id = ?`
  ).run(stage, now, json(stats ?? run.stats), stage, now, run.runId);
}

function addStats(run: RunRow, additions: Record<string, number>): Record<string, number> {
  const stats = { ...run.stats };
  for (const [key, value] of Object.entries(additions)) stats[key] = (stats[key] ?? 0) + value;
  return stats;
}

/** Counts the failure (stats `errors` keeps the total) and appends its output to the run's errors.log. */
async function recordError(database: DatabaseSync, run: RunRow, code: string, now: string, runtimeRoot: string, detail: string): Promise<void> {
  database.prepare(
    `UPDATE dream_runs SET last_error_code = ?, attempt_count = attempt_count + 1, updated_at = ?,
       stats_json = json_set(stats_json, '$.errors', COALESCE(json_extract(stats_json, '$.errors'), 0) + 1)
     WHERE run_id = ?`
  ).run(code.slice(0, 64), now, run.runId);
  const log = join(runDirectory(runtimeRoot, run.runId), "errors.log");
  try {
    if (((await stat(log).catch(() => undefined))?.size ?? 0) < 1_000_000) {
      await appendFile(log, `${now} ${run.stage} ${code}\n${detail.replace(/^/gmu, "  ")}\n`, { mode: 0o600 });
    }
  } catch {
    // The log is a diagnostic aid; a missing run directory must not hide the failure itself.
  }
}

async function loadMap(runtimeRoot: string, runId: string): Promise<RepoMap | undefined> {
  const path = join(runDirectory(runtimeRoot, runId), "repomap.json");
  if (!(await exists(path))) return undefined;
  return repoMapSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

/** A per-run wrapper keeps the verifier's command short and binds it to this run's repository map. */
async function writeToolWrapper(runtimeRoot: string, runId: string): Promise<string> {
  const directory = runDirectory(runtimeRoot, runId);
  const wrapper = join(directory, "msverify");
  const cli = fileURLToPath(new URL("./msverify-cli.js", import.meta.url));
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${cli}" --map "${join(directory, "repomap.json")}" "$@"\n`, { mode: 0o700 });
  await chmod(wrapper, 0o700);
  return wrapper;
}

export async function runNextDreamStep(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly now: string;
  readonly configuration: DreamingConfiguration;
  readonly model: DreamModel;
  /** Tests run inside the OS temporary directory; production never dreams ephemeral roots. */
  readonly allowTemporaryRoots?: boolean;
}): Promise<DreamStepResult> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const run = nextOpenRun(database, request.now);
    if (run === undefined) return { state: "idle" };
    try {
      const detail = await stepRun(database, run, request);
      return { state: "worked", runId: run.runId, stage: run.stage, ...(detail === undefined ? {} : { detail }) };
    } catch (error) {
      const code = error instanceof DreamModelError ? `model_${error.code}` : "local_failure";
      const detail = error instanceof DreamModelError ? error.detail : error instanceof Error ? `${error.name}: ${error.message}` : "";
      await recordError(database, run, code, request.now, request.runtimeRoot, detail);
      return { state: "failed", runId: run.runId, stage: run.stage, detail: code };
    }
  } finally {
    database.close();
  }
}

async function stepRun(
  database: DatabaseSync,
  run: RunRow,
  request: Parameters<typeof runNextDreamStep>[0]
): Promise<string | undefined> {
  const { configuration, now, runtimeRoot } = request;
  switch (run.stage) {
    case "select": {
      const { roots, kind } = await projectRoots(database, run.projectId, request.allowTemporaryRoots);
      const sessions = run.request === undefined ? eligibleSessions(database, run.projectId, run.windowEnd, configuration) : [];
      await mkdir(runDirectory(runtimeRoot, run.runId), { recursive: true, mode: 0o700 });
      const map = kind === "git" && roots.length > 0 ? await buildRepoMap(roots, now,
        [...configuration.host_skill_roots, ...configuration.host_instruction_files].map(expandHome)) : undefined;
      if (map !== undefined) {
        await writeFile(join(runDirectory(runtimeRoot, run.runId), "repomap.json"), json(map), { mode: 0o600 });
        await writeToolWrapper(runtimeRoot, run.runId);
      }
      let chunks = 0;
      if (run.request !== undefined) {
        // The requested events form one pseudo-Session of this run; nightly claims of real Sessions are untouched.
        const stream = readSessionStream(database, { sessionId: "", until: now, chunkCharacters: configuration.chunk_characters, eventIds: run.request.eventIds });
        const sessionId = `requested:${run.runId}`;
        database.prepare(
          `INSERT INTO dream_sessions(session_id, project_id, run_id, first_event_at, last_event_at, chunk_count, branch_json)
           VALUES (?, ?, ?, ?, ?, ?, '[]')`
        ).run(sessionId, run.projectId, run.runId, stream?.firstEventAt ?? now, stream?.lastEventAt ?? now, stream?.chunks.length ?? 0);
        for (let index = 0; index < (stream?.chunks.length ?? 0); index += 1) {
          database.prepare("INSERT INTO dream_chunks(run_id, session_id, chunk_index, state) VALUES (?, ?, ?, 'pending')").run(run.runId, sessionId, index + 1);
          chunks += 1;
        }
        advance(database, run, chunks === 0 ? "report" : "extract", now, { sessions: 1, chunks, repositories: map?.repos.length ?? 0 });
        return `requested chunks:${String(chunks)}`;
      }
      for (const session of sessions) {
        const stream = readSessionStream(database, {
          sessionId: session.session_id, after: session.after, until: session.last_at, chunkCharacters: configuration.chunk_characters
        });
        const clone = cloneOf(stream?.cwds ?? [], roots) ?? roots[0];
        const branches: SourceBranch[] = map === undefined || clone === undefined ? [] : await sessionSourceBranches({ map, clone, startedAt: session.first_at });
        database.prepare(
          `INSERT INTO dream_sessions(session_id, project_id, run_id, first_event_at, last_event_at, chunk_count, branch_json, segment_after)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id, run_id = excluded.run_id,
             first_event_at = excluded.first_event_at, last_event_at = excluded.last_event_at, chunk_count = excluded.chunk_count,
             branch_json = excluded.branch_json, segment_after = excluded.segment_after`
        ).run(session.session_id, run.projectId, run.runId, session.first_at, session.last_at, stream?.chunks.length ?? 0, json(branches),
          session.after ?? null);
        for (let index = 0; index < (stream?.chunks.length ?? 0); index += 1) {
          database.prepare("INSERT INTO dream_chunks(run_id, session_id, chunk_index, state) VALUES (?, ?, ?, 'pending')")
            .run(run.runId, session.session_id, index + 1);
          chunks += 1;
        }
      }
      advance(database, run, chunks === 0 ? "report" : "extract", now, { sessions: sessions.length, chunks, repositories: map?.repos.length ?? 0 });
      return `sessions:${String(sessions.length)} chunks:${String(chunks)}`;
    }
    case "extract": {
      const chunk = database.prepare(
        `SELECT session_id, chunk_index, attempt_count FROM dream_chunks
         WHERE run_id = ? AND state = 'pending' ORDER BY session_id, chunk_index LIMIT 1`
      ).get(run.runId);
      if (chunk === undefined) {
        advance(database, run, "merge", now);
        return "extraction_complete";
      }
      const sessionId = String(chunk.session_id);
      const index = Number(chunk.chunk_index);
      const segment = database.prepare("SELECT segment_after, last_event_at FROM dream_sessions WHERE session_id = ? AND run_id = ?")
        .get(sessionId, run.runId);
      const stream = run.request !== undefined
        ? readSessionStream(database, { sessionId, until: now, chunkCharacters: configuration.chunk_characters, eventIds: run.request.eventIds })
        : segment === undefined ? undefined : readSessionStream(database, {
        sessionId,
        after: typeof segment.segment_after === "string" ? segment.segment_after : undefined,
        until: String(segment.last_event_at),
        chunkCharacters: configuration.chunk_characters
      });
      const text = stream?.chunks[index - 1];
      if (text === undefined) {
        database.prepare("UPDATE dream_chunks SET state = 'failed', last_error_code = 'chunk_unavailable' WHERE run_id = ? AND session_id = ? AND chunk_index = ?")
          .run(run.runId, sessionId, index);
        return "chunk_unavailable";
      }
      const { roots } = await projectRoots(database, run.projectId, request.allowTemporaryRoots);
      try {
        const { candidates, usage } = await request.model.extract({
          projectLabel: roots.join(", ") || run.projectId, chunk: text, index, total: stream?.chunks.length ?? index,
          ...(run.request === undefined ? {} : { requested: true })
        });
        const source = text.replace(/\s+/gu, "").toLowerCase();
        for (const candidate of candidates) {
          const quote = candidate.quote.replace(/\s+/gu, "").toLowerCase().slice(0, 50);
          const paths = [...new Set(candidate.turn_refs.flatMap((turn) => stream?.turnPaths[turn] ?? []))].slice(0, 10);
          // A "user-stated" candidate whose quote comes from a reply or tool output was not said by the user.
          const user = candidate.explicit_user ? userWordsFor(text, candidate.turn_refs, candidate.quote) : undefined;
          const explicit = user !== undefined && user.source !== "other";
          database.prepare(
            `INSERT INTO dream_candidates(candidate_id, run_id, session_id, chunk_index, statement, claim_type, scope,
               explicit_user, quote_found, check_hints_json, source_paths_json, user_words_json, detail)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(`msdc_${randomUUID()}`, run.runId, sessionId, index, candidate.statement, candidate.claim_type, candidate.scope,
            explicit ? 1 : 0, quote.length > 0 && source.includes(quote) ? 1 : 0, json(candidate.check_hints), json(paths),
            explicit ? json(user.words) : null, candidate.detail.trim() === "" ? null : candidate.detail.trim().slice(0, detailCharacters));
        }
        database.prepare("UPDATE dream_chunks SET state = 'completed', candidate_count = ? WHERE run_id = ? AND session_id = ? AND chunk_index = ?")
          .run(candidates.length, run.runId, sessionId, index);
        advance(database, run, "extract", now, addStats(run, { extract_calls: 1, extract_tokens: usage.tokens, candidates: candidates.length }));
        return `chunk ${sessionId.slice(0, 8)}#${String(index)} -> ${String(candidates.length)}`;
      } catch (error) {
        const code = error instanceof DreamModelError ? error.code : "local_failure";
        const attempts = Number(chunk.attempt_count) + (transientModelErrors.includes(code) ? 1 : hardFailureWeight);
        database.prepare(
          `UPDATE dream_chunks SET attempt_count = ?, last_error_code = ?, state = CASE WHEN ? >= ? THEN 'failed' ELSE state END
           WHERE run_id = ? AND session_id = ? AND chunk_index = ?`
        ).run(attempts, code, attempts, chunkFailureBudget, run.runId, sessionId, index);
        throw error;
      }
    }
    case "merge": {
      const assigned = new Set(database.prepare("SELECT member_ids_json FROM dream_items WHERE run_id = ?").all(run.runId)
        .flatMap((row) => parseJson<string[]>(row.member_ids_json, [])));
      const candidates = database.prepare(
        `SELECT c.*, s.first_event_at FROM dream_candidates c JOIN dream_sessions s USING (session_id)
         WHERE c.run_id = ? ORDER BY c.claim_type, c.candidate_id`
      ).all(run.runId).filter((row) => !assigned.has(String(row.candidate_id)));
      if (candidates.length === 0) {
        advance(database, run, "prepare", now);
        return "merge_complete";
      }
      const claimType = String(candidates[0]?.claim_type);
      const group = candidates.filter((row) => row.claim_type === claimType).slice(0, mergeGroupSize);
      const aliases = new Map(group.map((row, position) => [`C${String(position + 1).padStart(3, "0")}`, row]));
      // A lone candidate has nothing to merge with; skip the model call.
      const { items, usage } = group.length === 1
        ? { items: [], usage: { tokens: 0, seconds: 0 } }
        : await request.model.merge({
            candidates: [...aliases].map(([alias, row]) => ({ id: alias, statement: String(row.statement), claim_type: String(row.claim_type), scope: String(row.scope) }))
          });
      const used = new Set<string>();
      const insert = (members: Record<string, unknown>[], statement: string, scope: string, hints: readonly string[]): void => {
        const sessions = [...new Set(members.map((member) => String(member.session_id)))];
        database.prepare(
          `INSERT INTO dream_items(item_id, run_id, statement, claim_type, scope, member_ids_json, session_ids_json,
             explicit_user, first_seen_at, check_hints_json, source_paths_json, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(`msdi_${randomUUID()}`, run.runId, statement, claimType, scope, json(members.map((member) => String(member.candidate_id))),
          json(sessions), members.some((member) => member.explicit_user === 1) ? 1 : 0,
          members.map((member) => String(member.first_event_at)).sort()[0] ?? now,
          json([...new Set([...hints, ...members.flatMap((member) => parseJson<string[]>(member.check_hints_json, []))])].slice(0, 10)),
          json([...new Set(members.flatMap((member) => parseJson<string[]>(member.source_paths_json, [])))].slice(0, 10)),
          // Members state one fact; the longest detail is the most complete account of it.
          members.map((member) => typeof member.detail === "string" ? member.detail : "")
            .sort((left, right) => right.length - left.length)[0] || null);
      };
      for (const item of items) {
        const members = item.member_ids.filter((alias) => aliases.has(alias) && !used.has(alias));
        if (members.length === 0) continue;
        members.forEach((alias) => used.add(alias));
        insert(members.map((alias) => aliases.get(alias) as Record<string, unknown>), item.statement, item.scope, item.check_hints);
      }
      // Merging must never lose a candidate: anything the model dropped stays as its own item.
      for (const [alias, row] of aliases) {
        if (!used.has(alias)) insert([row], String(row.statement), String(row.scope), []);
      }
      advance(database, run, "merge", now, addStats(run, { merge_calls: group.length === 1 ? 0 : 1, merge_tokens: usage.tokens }));
      return `merged ${claimType}: ${String(group.length)} -> ${String(items.length)}`;
    }
    case "prepare": {
      const map = await loadMap(runtimeRoot, run.runId);
      const items = database.prepare("SELECT item_id, statement, session_ids_json FROM dream_items WHERE run_id = ? AND presearch_json IS NULL LIMIT ?")
        .all(run.runId, prepareBatchSize);
      if (items.length === 0) {
        advance(database, run, "verify", now);
        return "prepare_complete";
      }
      const branchCache: Parameters<typeof presearch>[3] = new Map();
      const reader = map === undefined ? undefined : new EvidenceReader(map);
      for (const item of items) {
        const facts = map === undefined ? [] : await presearch(map, String(item.statement), now, branchCache, reader);
        const sessions = parseJson<string[]>(item.session_ids_json, []);
        const branches = sessions.flatMap((sessionId) => parseJson<SourceBranch[]>(
          database.prepare("SELECT branch_json FROM dream_sessions WHERE session_id = ?").get(sessionId)?.branch_json, []));
        database.prepare("UPDATE dream_items SET presearch_json = ?, source_branches_json = ? WHERE item_id = ?")
          .run(json(facts), json(branches), String(item.item_id));
      }
      return `prepared ${String(items.length)}`;
    }
    case "verify": {
      const map = await loadMap(runtimeRoot, run.runId);
      const items = database.prepare(
        `SELECT item_id, statement, check_hints_json, source_paths_json, presearch_json, first_seen_at, explicit_user, member_ids_json, detail
         FROM dream_items WHERE run_id = ? AND verdict_json IS NULL ORDER BY item_id LIMIT ?`
      ).all(run.runId, configuration.verify_batch_size * configuration.verify_parallelism);
      if (items.length === 0) {
        advance(database, run, "defend", now);
        return "verify_complete";
      }
      if (map === undefined) {
        for (const item of items) {
          database.prepare("UPDATE dream_items SET verdict_json = ? WHERE item_id = ?").run(json({
            id: String(item.item_id), claim_type: "external_system", durability: "long_term", scope: "project", subsystem: "",
            verdict: "not_repo_verifiable", branch: "", evidence: [], reason: "Project has no Git repository to verify against.", refined_statement: "",
            documented_at: "", user_support: "not_applicable", detail_check: "none"
          } satisfies Verdict), String(item.item_id));
        }
        return `unverifiable ${String(items.length)}`;
      }
      const tool = join(runDirectory(runtimeRoot, run.runId), "msverify");
      const repoMap = new EvidenceReader(map).map().join("\n");
      const batches: (typeof items)[] = [];
      for (let start = 0; start < items.length; start += configuration.verify_batch_size) {
        batches.push(items.slice(start, start + configuration.verify_batch_size));
      }
      // Batches run concurrently; a failed batch leaves its items for the next step.
      const settled = await Promise.allSettled(batches.map(async (batch) => {
        const aliases = new Map(batch.map((item, position) => [`V${String(position + 1)}`, item]));
        const claims = [...aliases].map(([alias, item]) => {
          const hints = parseJson<string[]>(item.check_hints_json, []);
          const paths = parseJson<string[]>(item.source_paths_json, []);
          const words = item.explicit_user === 1 ? userWordsOf(database, parseJson<string[]>(item.member_ids_json, [])) : [];
          return {
            id: alias,
            text: String(item.statement) +
              (hints.length > 0 ? `（检索提示：${hints.join(", ")}）` : "") +
              renderPresearch(parseJson(item.presearch_json, [])) +
              (paths.length > 0 ? `（来源线索：这条记忆产生时 agent 读过这些文件，可优先查看：${paths.join(", ")}）` : "") +
              (typeof item.detail === "string" && item.detail !== "" ? `（补充细节：${item.detail}）` : ""),
            created_at: String(item.first_seen_at).slice(0, 10),
            ...(words.length > 0 ? { user_words: words } : {})
          };
        });
        const { results, usage } = await request.model.verify({ tool, repoMap, claims });
        return { aliases, results, usage };
      }));
      let verified = 0;
      let tokens = 0;
      let calls = 0;
      let failure: unknown;
      for (const outcome of settled) {
        if (outcome.status === "rejected") {
          failure = outcome.reason;
          continue;
        }
        calls += 1;
        tokens += outcome.value.usage.tokens;
        for (const [alias, item] of outcome.value.aliases) {
          const result = outcome.value.results.find((candidate) => candidate.id === alias);
          const verdict: Verdict = result ?? {
            id: alias, claim_type: "code_state", durability: "long_term", scope: "project", subsystem: "",
            verdict: "inconclusive", branch: "", evidence: [], reason: "verifier_omitted", refined_statement: "", documented_at: "", user_support: "not_applicable", detail_check: "none"
          };
          const refined = verdict.refined_statement.trim();
          database.prepare("UPDATE dream_items SET verdict_json = ?, refined_statement = ? WHERE item_id = ?")
            .run(json({ ...verdict, id: String(item.item_id) }), refined === "" ? null : refined, String(item.item_id));
          verified += 1;
        }
      }
      advance(database, run, "verify", now, addStats(run, { verify_calls: calls, verify_tokens: tokens }));
      if (failure !== undefined) throw failure instanceof Error ? failure : new Error("verification batch failed");
      return `verified ${String(verified)}`;
    }
    case "defend": {
      const map = await loadMap(runtimeRoot, run.runId);
      const items = database.prepare(
        `SELECT item_id, statement, verdict_json, first_seen_at FROM dream_items
         WHERE run_id = ? AND defense_json IS NULL
           AND json_extract(verdict_json, '$.verdict') IN ('contradicted', 'stale') LIMIT ?`
      ).all(run.runId, defenseBatchSize);
      if (items.length === 0 || map === undefined) {
        advance(database, run, "tier", now);
        return "defense_complete";
      }
      const aliases = new Map(items.map((item, position) => [`D${String(position + 1)}`, item]));
      const claims = [...aliases].map(([alias, item]) => {
        const verdict = parseJson<Verdict>(item.verdict_json, {} as Verdict);
        return { id: alias, memory: String(item.statement), created_at: String(item.first_seen_at).slice(0, 10), verifier_verdict: verdict.verdict,
          verifier_subsystem: verdict.subsystem, verifier_evidence: verdict.evidence, verifier_reason: verdict.reason };
      });
      const tool = join(runDirectory(runtimeRoot, run.runId), "msverify");
      const { results, usage } = await request.model.defend({ tool, repoMap: new EvidenceReader(map).map().join("\n"), claims });
      for (const [alias, item] of aliases) {
        const result = results.find((candidate) => candidate.id === alias);
        // Without a defense answer the negative verdict stands for review; it never applies automatically.
        database.prepare("UPDATE dream_items SET defense_json = ? WHERE item_id = ?")
          .run(json(result ?? { id: alias, decision: "uphold", final_verdict: "contradicted", branch: "", evidence: [], reason: "defense_omitted" }), String(item.item_id));
      }
      advance(database, run, "defend", now, addStats(run, { defense_calls: 1, defense_tokens: usage.tokens }));
      return `defended ${String(items.length)}`;
    }
    case "tier": {
      const map = await loadMap(runtimeRoot, run.runId);
      const roots = database.prepare("SELECT canonical_root FROM project_roots WHERE project_id = ?").all(run.projectId)
        .map((row) => String(row.canonical_root));
      const catchAllProject = roots.length > 0 && roots.every((root) => isCatchAllRoot(root, homedir()));
      const items = database.prepare("SELECT * FROM dream_items WHERE run_id = ?").all(run.runId);
      const counts: Record<string, number> = {};
      for (const item of items) {
        const verdict = parseJson<Verdict | undefined>(item.verdict_json, undefined);
        const defense = parseJson<{ final_verdict?: string; branch?: string } | undefined>(item.defense_json, undefined);
        const finalVerdict = defense?.final_verdict ?? verdict?.verdict ?? "inconclusive";
        const scope = verdict?.scope ?? (item.scope === "global" ? "global" : "project");
        const { tier, reason } = tierOf({
          scope,
          catchAllProject,
          userRequested: run.request !== undefined,
          verdict: finalVerdict,
          durability: verdict?.durability ?? "long_term",
          branch: defense?.branch || verdict?.branch || "",
          explicitUser: item.explicit_user === 1,
          ...(verdict?.user_support === undefined ? {} : { userSupport: verdict.user_support }),
          ...(verdict?.documented_at === undefined ? {} : { documentedAt: verdict.documented_at }),
          sessionCount: parseJson<string[]>(item.session_ids_json, []).length,
          sourceBranches: parseJson<SourceBranch[]>(item.source_branches_json, []),
          relevantRepos: relevantRepositories({
            evidence: verdict?.evidence ?? [],
            sourcePathRepos: map === undefined ? [] : parseJson<string[]>(item.source_paths_json, [])
              .flatMap((path) => { const routed = routePath(map, path); return routed === undefined ? [] : [routed.repo.path]; }),
            presearch: parseJson(item.presearch_json, [])
          })
        });
        database.prepare("UPDATE dream_items SET tier = ?, tier_reason = ?, scope = ? WHERE item_id = ?").run(tier, reason, scope, String(item.item_id));
        counts[`tier_${tier}`] = (counts[`tier_${tier}`] ?? 0) + 1;
      }
      // Re-tiering replaces earlier tier counts instead of accumulating them.
      const previous = Object.fromEntries(Object.entries(run.stats).filter(([key]) => !key.startsWith("tier_")));
      if (appliesRun(run, configuration)) markApplyPending(database, run.runId);
      advance(database, run, "report", now, { ...previous, items: items.length, ...counts });
      return `tiered ${String(items.length)}`;
    }
    case "report": {
      if (appliesRun(run, configuration)) {
        // Apply pending items one batch per step before reporting them.
        const pending = loadApplyItems(database, "i.run_id = ? AND i.apply_state = 'pending'", run.runId).slice(0, applyBatchSize);
        if (pending.length > 0) {
          const { outcomes, usage } = await applyBatch({
            database, vaultRoot: request.vaultRoot, runtimeRoot, items: pending, model: request.model, now, preview: false,
            instructionFiles: configuration.host_instruction_files.map(expandHome)
          });
          const counts: Record<string, number> = { apply_calls: usage === undefined ? 0 : 1, apply_tokens: usage?.tokens ?? 0 };
          for (const outcome of outcomes) counts[`apply_${outcome.state}`] = (counts[`apply_${outcome.state}`] ?? 0) + 1;
          advance(database, run, "report", now, addStats(run, counts));
          return `applied ${String(outcomes.length)}`;
        }
      }
      const timeZone = request.configuration.timezone;
      const path = await writeDreamReport({ database, vaultRoot: request.vaultRoot, runId: run.runId, projectId: run.projectId, timeZone });
      database.prepare("UPDATE dream_runs SET report_path = ? WHERE run_id = ?").run(path, run.runId);
      await writeDreamOverview({ database, vaultRoot: request.vaultRoot, now, timeZone, includeRunId: run.runId });
      advance(database, run, "completed", now);
      return path.split(sep).slice(-1)[0];
    }
    default:
      return undefined;
  }
}

/**
 * Re-renders the reports of completed runs (all, or one) and the overview with the
 * current report format, for `memstore dream report`. A report whose file name
 * changed replaces the previous file; only Markdown files directly inside the
 * Dreams directory are ever removed.
 */
export async function renderDreamReports(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly now: string;
  readonly timeZone: string;
  readonly runId?: string;
}): Promise<{ readonly reports: readonly string[]; readonly removed: readonly string[]; readonly overview: string }> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const runs = database.prepare(
      "SELECT run_id, project_id, report_path FROM dream_runs WHERE stage = 'completed' AND (? IS NULL OR run_id = ?) ORDER BY created_at"
    ).all(request.runId ?? null, request.runId ?? null);
    if (request.runId !== undefined && runs.length === 0) {
      throw new MemStoreCommandError("dream_run_not_found", `No completed dream run ${request.runId}.`);
    }
    const directory = join(request.vaultRoot, dreamsDirectoryName);
    const reports: string[] = [];
    const removed: string[] = [];
    for (const run of runs) {
      const runId = String(run.run_id);
      const path = await writeDreamReport({ database, vaultRoot: request.vaultRoot, runId, projectId: String(run.project_id), timeZone: request.timeZone });
      const previous = typeof run.report_path === "string" ? run.report_path : undefined;
      if (previous !== undefined && previous !== path && dirname(previous) === directory &&
          previous.endsWith(".md") && basename(previous) !== overviewFileName) {
        await rm(previous, { force: true });
        removed.push(previous);
      }
      database.prepare("UPDATE dream_runs SET report_path = ? WHERE run_id = ?").run(path, runId);
      reports.push(path);
    }
    const overview = await writeDreamOverview({ database, vaultRoot: request.vaultRoot, now: request.now, timeZone: request.timeZone });
    return { reports, removed, overview };
  } finally {
    database.close();
  }
}

/**
 * Queues a run's items for apply mode: every inject item, and review items whose
 * statement dreaming already wrote (their Memory becomes review_due).
 */
function markApplyPending(database: DatabaseSync, runId: string): void {
  const written = new Set(database.prepare("SELECT statement_key FROM dream_memories").all().map((row) => String(row.statement_key)));
  for (const row of database.prepare(
    "SELECT item_id, tier, COALESCE(refined_statement, statement) AS text FROM dream_items WHERE run_id = ? AND apply_state IS NULL AND tier IN ('inject', 'review')"
  ).all(runId)) {
    if (row.tier === "inject" || written.has(statementKey(String(row.text)))) {
      database.prepare("UPDATE dream_items SET apply_state = 'pending' WHERE item_id = ?").run(String(row.item_id));
    }
  }
}

/**
 * `memstore dream apply`: applies (or previews) inject items of completed runs
 * created since `from`, or of one run, that apply has not considered yet.
 * Batches are per Project; each later batch sees what earlier ones wrote.
 */
export async function applyCompletedRuns(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly now: string;
  readonly model: DreamModel;
  readonly preview: boolean;
  readonly from?: string;
  readonly runId?: string;
  readonly timeZone: string;
  readonly instructionFiles?: readonly string[];
}): Promise<{ readonly outcomes: readonly (ApplyOutcome & { readonly text: string; readonly projectId: string; readonly runId: string })[]; readonly tokens: number }> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const items = loadApplyItems(database,
      `r.stage = 'completed' AND i.tier = 'inject' AND (i.apply_state IS NULL OR i.apply_state IN ('pending', 'failed'))
       AND (? IS NULL OR r.created_at >= ?) AND (? IS NULL OR r.run_id = ?)`,
      request.from ?? null, request.from ?? null, request.runId ?? null, request.runId ?? null);
    const outcomes: (ApplyOutcome & { text: string; projectId: string; runId: string })[] = [];
    let tokens = 0;
    const byProject = new Map<string, ApplyItem[]>();
    for (const item of items) byProject.set(item.projectId, [...(byProject.get(item.projectId) ?? []), item]);
    for (const group of byProject.values()) {
      for (let start = 0; start < group.length; start += applyBatchSize) {
        const batch = group.slice(start, start + applyBatchSize);
        const result = await applyBatch({
          database, vaultRoot: request.vaultRoot, runtimeRoot: request.runtimeRoot, items: batch, model: request.model, now: request.now,
          preview: request.preview, instructionFiles: (request.instructionFiles ?? []).map(expandHome)
        });
        tokens += result.usage?.tokens ?? 0;
        for (const outcome of result.outcomes) {
          const item = batch.find((candidate) => candidate.itemId === outcome.itemId);
          outcomes.push({ ...outcome, text: item?.text ?? "", projectId: item?.projectId ?? "", runId: item?.runId ?? "" });
        }
      }
    }
    return { outcomes, tokens };
  } finally {
    database.close();
  }
}

/** `memstore dream rollback`: archives (recoverably) the active Memory dreaming wrote, for one run or all. */
export async function rollbackDreamMemories(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly now: string;
  readonly apply: boolean;
  readonly runId?: string;
}): Promise<{ readonly memories: readonly { readonly memory_id: string; readonly memory_ref: number | null; readonly state: string }[] }> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let targets: { memoryId: string; memoryRef: number | null }[];
  try {
    targets = database.prepare(
      `SELECT d.memory_id, c.memory_ref FROM dream_memories d JOIN memory_catalog c USING (memory_id)
       WHERE c.lifecycle = 'active' AND (? IS NULL OR d.created_run_id = ?) ORDER BY d.created_at`
    ).all(request.runId ?? null, request.runId ?? null)
      .map((row) => ({ memoryId: String(row.memory_id), memoryRef: typeof row.memory_ref === "number" ? row.memory_ref : null }));
  } finally {
    database.close();
  }
  const memories: { memory_id: string; memory_ref: number | null; state: string }[] = [];
  for (const target of targets) {
    if (!request.apply) {
      memories.push({ memory_id: target.memoryId, memory_ref: target.memoryRef, state: "would_archive" });
      continue;
    }
    const result = await applyMemoryLifecycleChange({
      runtimeRoot: request.runtimeRoot, vaultRoot: request.vaultRoot, memory: target.memoryId, action: "archive",
      changedAt: request.now, reason: "dreaming_rollback"
    });
    memories.push({ memory_id: target.memoryId, memory_ref: target.memoryRef, state: result.state });
  }
  return { memories };
}

/** The user messages behind an item's user-stated members, deduplicated and bounded. */
function userWordsOf(database: DatabaseSync, memberIds: readonly string[]): string[] {
  const words: string[] = [];
  let characters = 0;
  for (const memberId of memberIds) {
    const row = database.prepare("SELECT user_words_json FROM dream_candidates WHERE candidate_id = ?").get(memberId);
    for (const text of parseJson<string[]>(row?.user_words_json, [])) {
      if (words.includes(text) || words.length >= 3 || characters + text.length > 4_000) continue;
      words.push(text);
      characters += text.length;
    }
  }
  return words;
}

export async function inspectDreams(runtimeRoot: string, limit = 10): Promise<Record<string, unknown>[]> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    return database.prepare(
      `SELECT run_id, project_id, scheduled_for, stage, last_error_code, attempt_count, stats_json, report_path, created_at, completed_at
       FROM dream_runs ORDER BY created_at DESC LIMIT ?`
    ).all(limit).map((row) => ({ ...row, stats: parseJson(row.stats_json, {}) }));
  } finally {
    database.close();
  }
}
