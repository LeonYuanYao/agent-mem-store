import { Temporal } from "@js-temporal/polyfill";

import { openRuntimeDatabaseReadOnly } from "../runtime/database.js";
import { readCanonicalMemory } from "../vault/index.js";
import { projectDisplay } from "./report.js";

/**
 * `memstore dream digest` (ADR-0163): what dreaming changed in Memory since a
 * time, short enough for a chat message, with the commands that undo it. It reads
 * the runtime tables and the Vault only; no model call.
 */

export interface DreamDigest {
  readonly since: string;
  readonly runIds: readonly string[];
  readonly counts: Readonly<Record<"written" | "revised" | "observed" | "review_due", number>>;
  readonly text: string;
}

const listLimit = 20;
const statementCharacters = 80;

const labels = { written: "新写入", revised: "修订", review_due: "待复核" } as const;

export async function dreamDigest(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly since: string;
  readonly now: string;
  readonly timeZone: string;
}): Promise<DreamDigest> {
  const database = await openRuntimeDatabaseReadOnly(request.runtimeRoot);
  let runs: { runId: string; projectId: string }[];
  let items: { state: keyof typeof labels | "observed"; memoryId: string; runId: string; projectId: string; statement: string }[];
  const projects = new Map<string, string>();
  try {
    runs = database.prepare(
      `SELECT run_id, project_id FROM dream_runs WHERE completed_at IS NOT NULL AND completed_at >= ? ORDER BY completed_at`
    ).all(request.since).map((row) => ({ runId: String(row.run_id), projectId: String(row.project_id) }));
    items = runs.flatMap((run) => database.prepare(
      `SELECT apply_state, apply_memory_id, statement FROM dream_items
       WHERE run_id = ? AND apply_state IN ('written', 'revised', 'observed', 'review_due') AND apply_memory_id IS NOT NULL ORDER BY rowid`
    ).all(run.runId).map((row) => ({
      state: String(row.apply_state) as keyof typeof labels | "observed", memoryId: String(row.apply_memory_id),
      runId: run.runId, projectId: run.projectId, statement: String(row.statement)
    })));
    for (const run of runs) if (!projects.has(run.projectId)) projects.set(run.projectId, projectDisplay(database, run.projectId).label);
  } finally {
    database.close();
  }
  const counts = { written: 0, revised: 0, observed: 0, review_due: 0 };
  for (const item of items) counts[item.state] += 1;
  const day = Temporal.Instant.from(request.now).toZonedDateTimeISO(request.timeZone).toPlainDate().toString().slice(5);
  if (counts.written + counts.revised + counts.review_due === 0) {
    return { since: request.since, runIds: runs.map((run) => run.runId), counts,
      text: counts.observed === 0 ? `MemStore ${day}：dreaming 没有改动记忆。` : `MemStore ${day}：dreaming 没有新写入或修订，${String(counts.observed)} 条判为已知。` };
  }
  const lines = [
    `**MemStore 记忆整理 · ${day}**`,
    `新写入 ${String(counts.written)} · 修订 ${String(counts.revised)} · 判为已知 ${String(counts.observed)} · 待复核 ${String(counts.review_due)}`
  ];
  let listed = 0;
  for (const state of ["written", "revised", "review_due"] as const) {
    const ofState = items.filter((item) => item.state === state);
    if (ofState.length === 0) continue;
    lines.push("", `**${labels[state]}**`);
    for (const item of ofState) {
      if (listed >= listLimit) break;
      const loaded = await readCanonicalMemory({ runtimeRoot: request.runtimeRoot, vaultRoot: request.vaultRoot, memoryId: item.memoryId });
      if (loaded === undefined) continue;
      const text = loaded.memory.representations.compact.text.trim() || item.statement;
      const project = projects.size > 1 ? `〔${projects.get(item.projectId)?.split("/").at(-1) ?? ""}〕` : "";
      lines.push(`- M:${String(loaded.memory.memoryRef)} ${project}${text.length <= statementCharacters ? text : `${text.slice(0, statementCharacters)}…`}`);
      listed += 1;
    }
  }
  const total = counts.written + counts.revised + counts.review_due;
  if (total > listed) lines.push(`- …另有 ${String(total - listed)} 条，见 Obsidian「_MemStore/Dreams」`);
  lines.push("", "撤销一条：`memstore archive M:<id> --apply`；撤销一次运行：`memstore dream rollback <RUN_ID> --apply`",
    `RUN_ID：${runs.map((run) => `\`${run.runId}\``).join("、")}`);
  return { since: request.since, runIds: runs.map((run) => run.runId), counts, text: lines.join("\n") };
}
