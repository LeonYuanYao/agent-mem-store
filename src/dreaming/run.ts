import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { Temporal } from "@js-temporal/polyfill";

import { openRuntimeDatabase } from "../runtime/database.js";
import { cloneOf, sessionSourceBranches, type SourceBranch } from "./branches.js";
import type { DreamingConfiguration } from "./config.js";
import { DreamModelError, type DreamModel, type Verdict } from "./model.js";
import { EvidenceReader } from "./msverify.js";
import { presearch, renderPresearch } from "./presearch.js";
import { buildRepoMap, repoMapSchema, type RepoMap } from "./repo-map.js";
import { writeDreamReport } from "./report.js";
import { readSessionStream } from "./stream.js";
import { relevantRepositories, tierOf } from "./tier.js";
import { routePath } from "./repo-map.js";

const retryBackoffMilliseconds = 5 * 60_000;
const maximumChunkAttempts = 3;
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

const temporaryRootPattern = /^(?:\/private)?\/(?:tmp|var\/folders)\//u;

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

function eligibleSessions(
  database: DatabaseSync,
  projectId: string,
  now: string,
  configuration: DreamingConfiguration
): { session_id: string; first_at: string; last_at: string }[] {
  const lookback = new Date(Date.parse(now) - configuration.lookback_days * 86_400_000).toISOString();
  const inactiveBefore = new Date(Date.parse(now) - configuration.inactivity_minutes * 60_000).toISOString();
  return database.prepare(
    `SELECT session_id, MIN(created_at) AS first_at, MAX(created_at) AS last_at,
            MAX(event_kind = 'SessionEnd') AS ended
     FROM capture_events
     WHERE project_id = ? AND session_id IS NOT NULL
       AND session_id NOT IN (SELECT session_id FROM dream_sessions)
     GROUP BY session_id
     HAVING last_at >= ? AND (ended = 1 OR last_at <= ?)
     ORDER BY last_at ASC LIMIT ?`
  ).all(projectId, lookback, inactiveBefore, configuration.max_sessions_per_run)
    .map((row) => ({ session_id: String(row.session_id), first_at: String(row.first_at), last_at: String(row.last_at) }));
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
      created.push(createRun(database, projectId, scheduledFor, request.now));
    }
  } finally {
    database.close();
  }
  return { created };
}

function createRun(database: DatabaseSync, projectId: string, scheduledFor: string, now: string): string {
  const runId = `msdream_${randomUUID()}`;
  database.prepare(
    `INSERT INTO dream_runs(run_id, project_id, scheduled_for, mode, stage, window_end, created_at, updated_at)
     VALUES (?, ?, ?, 'shadow', 'select', ?, ?, ?)`
  ).run(runId, projectId, scheduledFor, now, now, now);
  return runId;
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

interface RunRow {
  readonly runId: string;
  readonly projectId: string;
  readonly stage: Stage;
  readonly scheduledFor: string;
  readonly windowEnd: string;
  readonly stats: Record<string, number>;
}

function nextOpenRun(database: DatabaseSync, now: string): RunRow | undefined {
  const row = database.prepare(
    `SELECT run_id, project_id, stage, scheduled_for, window_end, stats_json FROM dream_runs
     WHERE stage NOT IN ('completed', 'failed')
       AND (last_error_code IS NULL OR updated_at <= ?)
     ORDER BY created_at LIMIT 1`
  ).get(new Date(Date.parse(now) - retryBackoffMilliseconds).toISOString());
  return row === undefined ? undefined : {
    runId: String(row.run_id),
    projectId: String(row.project_id),
    stage: row.stage as Stage,
    scheduledFor: String(row.scheduled_for),
    windowEnd: String(row.window_end),
    stats: parseJson<Record<string, number>>(row.stats_json, {})
  };
}

function advance(database: DatabaseSync, run: RunRow, stage: Stage, now: string, stats?: Record<string, number>): void {
  database.prepare(
    `UPDATE dream_runs SET stage = ?, updated_at = ?, last_error_code = NULL, stats_json = ?,
       completed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE completed_at END
     WHERE run_id = ?`
  ).run(stage, now, json(stats ?? run.stats), stage, now, run.runId);
}

function addStats(run: RunRow, additions: Record<string, number>): Record<string, number> {
  const stats = { ...run.stats };
  for (const [key, value] of Object.entries(additions)) stats[key] = (stats[key] ?? 0) + value;
  return stats;
}

function recordError(database: DatabaseSync, run: RunRow, code: string, now: string): void {
  database.prepare("UPDATE dream_runs SET last_error_code = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE run_id = ?")
    .run(code.slice(0, 64), now, run.runId);
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
      recordError(database, run, code, request.now);
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
      const sessions = eligibleSessions(database, run.projectId, run.windowEnd, configuration);
      await mkdir(runDirectory(runtimeRoot, run.runId), { recursive: true, mode: 0o700 });
      const map = kind === "git" && roots.length > 0 ? await buildRepoMap(roots, now,
        configuration.host_skill_roots.map((root) => root.replace(/^~(?=\/|$)/u, homedir()))) : undefined;
      if (map !== undefined) {
        await writeFile(join(runDirectory(runtimeRoot, run.runId), "repomap.json"), json(map), { mode: 0o600 });
        await writeToolWrapper(runtimeRoot, run.runId);
      }
      let chunks = 0;
      for (const session of sessions) {
        const stream = readSessionStream(database, { sessionId: session.session_id, projectId: run.projectId, chunkCharacters: configuration.chunk_characters });
        const clone = cloneOf(stream?.cwds ?? [], roots) ?? roots[0];
        const branches: SourceBranch[] = map === undefined || clone === undefined ? [] : await sessionSourceBranches({ map, clone, startedAt: session.first_at });
        database.prepare(
          `INSERT INTO dream_sessions(session_id, project_id, run_id, first_event_at, last_event_at, chunk_count, branch_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(session.session_id, run.projectId, run.runId, session.first_at, session.last_at, stream?.chunks.length ?? 0, json(branches));
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
      const stream = readSessionStream(database, { sessionId, projectId: run.projectId, chunkCharacters: configuration.chunk_characters });
      const text = stream?.chunks[index - 1];
      if (text === undefined) {
        database.prepare("UPDATE dream_chunks SET state = 'failed', last_error_code = 'chunk_unavailable' WHERE run_id = ? AND session_id = ? AND chunk_index = ?")
          .run(run.runId, sessionId, index);
        return "chunk_unavailable";
      }
      const { roots } = await projectRoots(database, run.projectId, request.allowTemporaryRoots);
      try {
        const { candidates, usage } = await request.model.extract({
          projectLabel: roots.join(", ") || run.projectId, chunk: text, index, total: stream?.chunks.length ?? index
        });
        const source = text.replace(/\s+/gu, "").toLowerCase();
        for (const candidate of candidates) {
          const quote = candidate.quote.replace(/\s+/gu, "").toLowerCase().slice(0, 50);
          const paths = [...new Set(candidate.turn_refs.flatMap((turn) => stream?.turnPaths[turn] ?? []))].slice(0, 10);
          database.prepare(
            `INSERT INTO dream_candidates(candidate_id, run_id, session_id, chunk_index, statement, claim_type, scope,
               explicit_user, quote_found, check_hints_json, source_paths_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(`msdc_${randomUUID()}`, run.runId, sessionId, index, candidate.statement, candidate.claim_type, candidate.scope,
            candidate.explicit_user ? 1 : 0, quote.length > 0 && source.includes(quote) ? 1 : 0, json(candidate.check_hints), json(paths));
        }
        database.prepare("UPDATE dream_chunks SET state = 'completed', candidate_count = ? WHERE run_id = ? AND session_id = ? AND chunk_index = ?")
          .run(candidates.length, run.runId, sessionId, index);
        advance(database, run, "extract", now, addStats(run, { extract_calls: 1, extract_tokens: usage.tokens, candidates: candidates.length }));
        return `chunk ${sessionId.slice(0, 8)}#${String(index)} -> ${String(candidates.length)}`;
      } catch (error) {
        const attempts = Number(chunk.attempt_count) + 1;
        const code = error instanceof DreamModelError ? error.code : "local_failure";
        database.prepare(
          `UPDATE dream_chunks SET attempt_count = ?, last_error_code = ?, state = CASE WHEN ? >= ? THEN 'failed' ELSE state END
           WHERE run_id = ? AND session_id = ? AND chunk_index = ?`
        ).run(attempts, code, attempts, maximumChunkAttempts, run.runId, sessionId, index);
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
             explicit_user, first_seen_at, check_hints_json, source_paths_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(`msdi_${randomUUID()}`, run.runId, statement, claimType, scope, json(members.map((member) => String(member.candidate_id))),
          json(sessions), members.some((member) => member.explicit_user === 1) ? 1 : 0,
          members.map((member) => String(member.first_event_at)).sort()[0] ?? now,
          json([...new Set([...hints, ...members.flatMap((member) => parseJson<string[]>(member.check_hints_json, []))])].slice(0, 10)),
          json([...new Set(members.flatMap((member) => parseJson<string[]>(member.source_paths_json, [])))].slice(0, 10)));
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
      for (const item of items) {
        const facts = map === undefined ? [] : await presearch(map, String(item.statement), now, branchCache);
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
        `SELECT item_id, statement, check_hints_json, source_paths_json, presearch_json, first_seen_at FROM dream_items
         WHERE run_id = ? AND verdict_json IS NULL ORDER BY item_id LIMIT ?`
      ).all(run.runId, configuration.verify_batch_size);
      if (items.length === 0) {
        advance(database, run, "defend", now);
        return "verify_complete";
      }
      if (map === undefined) {
        for (const item of items) {
          database.prepare("UPDATE dream_items SET verdict_json = ? WHERE item_id = ?").run(json({
            id: String(item.item_id), claim_type: "external_system", durability: "long_term", scope: "project", subsystem: "",
            verdict: "not_repo_verifiable", branch: "", evidence: [], reason: "Project has no Git repository to verify against."
          } satisfies Verdict), String(item.item_id));
        }
        return `unverifiable ${String(items.length)}`;
      }
      const aliases = new Map(items.map((item, position) => [`V${String(position + 1)}`, item]));
      const claims = [...aliases].map(([alias, item]) => {
        const hints = parseJson<string[]>(item.check_hints_json, []);
        const paths = parseJson<string[]>(item.source_paths_json, []);
        return {
          id: alias,
          text: String(item.statement) +
            (hints.length > 0 ? `（检索提示：${hints.join(", ")}）` : "") +
            renderPresearch(parseJson(item.presearch_json, [])) +
            (paths.length > 0 ? `（来源线索：这条记忆产生时 agent 读过这些文件，可优先查看：${paths.join(", ")}）` : ""),
          created_at: String(item.first_seen_at).slice(0, 10)
        };
      });
      const tool = join(runDirectory(runtimeRoot, run.runId), "msverify");
      const { results, usage } = await request.model.verify({ tool, repoMap: new EvidenceReader(map).map().join("\n"), claims });
      for (const [alias, item] of aliases) {
        const result = results.find((candidate) => candidate.id === alias);
        const verdict: Verdict = result ?? {
          id: alias, claim_type: "code_state", durability: "long_term", scope: "project", subsystem: "",
          verdict: "inconclusive", branch: "", evidence: [], reason: "verifier_omitted"
        };
        database.prepare("UPDATE dream_items SET verdict_json = ? WHERE item_id = ?").run(json({ ...verdict, id: String(item.item_id) }), String(item.item_id));
      }
      advance(database, run, "verify", now, addStats(run, { verify_calls: 1, verify_tokens: usage.tokens }));
      return `verified ${String(items.length)}`;
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
      const items = database.prepare("SELECT * FROM dream_items WHERE run_id = ?").all(run.runId);
      const counts: Record<string, number> = {};
      for (const item of items) {
        const verdict = parseJson<Verdict | undefined>(item.verdict_json, undefined);
        const defense = parseJson<{ final_verdict?: string; branch?: string } | undefined>(item.defense_json, undefined);
        const finalVerdict = defense?.final_verdict ?? verdict?.verdict ?? "inconclusive";
        const scope = verdict?.scope ?? (item.scope === "global" ? "global" : "project");
        const { tier, reason } = tierOf({
          scope,
          verdict: finalVerdict,
          durability: verdict?.durability ?? "long_term",
          branch: defense?.branch || verdict?.branch || "",
          explicitUser: item.explicit_user === 1,
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
      advance(database, run, "report", now, { ...run.stats, items: items.length, ...counts });
      return `tiered ${String(items.length)}`;
    }
    case "report": {
      const path = await writeDreamReport({ database, vaultRoot: request.vaultRoot, runId: run.runId, projectId: run.projectId, now });
      database.prepare("UPDATE dream_runs SET report_path = ? WHERE run_id = ?").run(path, run.runId);
      advance(database, run, "completed", now);
      return path.split(sep).slice(-1)[0];
    }
    default:
      return undefined;
  }
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
