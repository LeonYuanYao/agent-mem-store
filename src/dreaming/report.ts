import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Temporal } from "@js-temporal/polyfill";

import { writeFileAtomically } from "../contracts/atomic-file.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import { temporaryRootPattern } from "./repo-map.js";

/**
 * Writes the human-readable Dreams notes into the Vault. In shadow mode these are
 * the only Vault writes: one report per run listing what dreaming would inject,
 * scope to a branch, keep searchable, send to review or drop, with the verifier's
 * evidence; and an overview of everything dreaming kept in the recent window.
 */

export const dreamsDirectoryName = join("_MemStore", "Dreams");
export const overviewFileName = "总览.md";
const overviewWindowDays = 14;

const tierTitles: Record<string, string> = {
  inject: "注入层（会自动注入）",
  branch: "分支层（只在对应分支的会话注入）",
  pool: "可搜索池（不自动注入）",
  review: "需要复核（验证器认为错误或过时）",
  drop: "丢弃（一次性信息，或已写在自动加载的文档/skill 中）"
};

const reasonLabels: Record<string, string> = {
  confirmed: "已用仓库证据验证",
  explicit_user: "用户明确表达",
  recurring: "多个会话反复出现",
  contradicted: "与仓库现状矛盾",
  stale: "已过时",
  episodic: "一次性信息",
  already_in_autoloaded_docs: "已写在自动加载的文档/skill 中",
  catch_all_project: "主目录兜底项目只保留全局知识",
  user_task_instruction: "用户对当次任务的要求，只进可搜索池"
};

const userSupportLabels: Record<string, string> = {
  user_stated_rule: "用户本人表达",
  user_task_instruction: "用户对当次任务的要求",
  pasted_task_instruction: "来自贴入的任务说明",
  not_user_stated: "原话中找不到"
};

const verdictLabels: Record<string, string> = {
  not_repo_verifiable: "无法用仓库验证",
  inconclusive: "证据不足"
};

function reasonLabel(tier: string, reason: string): string {
  const known = reasonLabels[reason];
  if (known !== undefined) return known;
  if (tier === "branch") return `分支 ${reason}`;
  const verdict = /^single_session_(.+)$/u.exec(reason)?.[1];
  return verdict === undefined ? reason : `仅一个会话出现，${verdictLabels[verdict] ?? verdict}`;
}

export const applyStateLabels: Record<string, string> = {
  written: "新建",
  revised: "修订已有的 dreaming 记忆",
  observed: "已有同一条，记一次观察",
  duplicate_human: "手写记忆已覆盖，跳过",
  conflict_human: "与手写记忆矛盾，需要你复核",
  review_due: "已写入的记忆被判错误或过时，停止注入",
  skipped: "跳过",
  failed: "失败，下次重试",
  pending: "待写入"
};
const applyStateOrder = ["conflict_human", "written", "revised", "review_due", "observed", "duplicate_human", "skipped", "failed", "pending"];

function memoryRefs(database: DatabaseSync, memoryIds: readonly string[]): Map<string, string> {
  const refs = new Map<string, string>();
  for (const memoryId of new Set(memoryIds)) {
    const ref = database.prepare("SELECT memory_ref FROM memory_catalog WHERE memory_id = ?").get(memoryId)?.memory_ref;
    refs.set(memoryId, typeof ref === "number" ? `M:${String(ref)}` : memoryId.slice(0, 14));
  }
  return refs;
}

function applyLines(database: DatabaseSync, rows: readonly { state: string; text: string; memoryId?: string | undefined; reason: string; prefix?: string }[]): string[] {
  const refs = memoryRefs(database, rows.flatMap((row) => row.memoryId === undefined ? [] : [row.memoryId]));
  const lines: string[] = [];
  for (const state of applyStateOrder) {
    const group = rows.filter((row) => row.state === state);
    if (group.length === 0) continue;
    lines.push(`### ${applyStateLabels[state] ?? state} · ${String(group.length)}`, "");
    for (const row of group) {
      const ref = row.memoryId === undefined ? "" : ` → ${refs.get(row.memoryId) ?? ""}`;
      lines.push(`- ${row.prefix ?? ""}${escapeLine(row.text)}${ref}`);
      if (state !== "written" && state !== "observed" && row.reason !== "") lines.push(`  - ${escapeLine(row.reason).slice(0, 200)}`);
    }
    lines.push("");
  }
  return lines;
}

/** The note `memstore dream apply` writes: what apply would do (preview) or did. */
export async function writeApplyNote(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly now: string;
  readonly timeZone: string;
  readonly preview: boolean;
  readonly outcomes: readonly { readonly state: string; readonly text: string; readonly memoryId?: string; readonly reason: string; readonly projectId: string }[];
}): Promise<string> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const at = Temporal.Instant.from(request.now).toZonedDateTimeISO(request.timeZone);
    const counts = applyStateOrder.flatMap((state) => {
      const count = request.outcomes.filter((outcome) => outcome.state === state).length;
      return count === 0 ? [] : [`${applyStateLabels[state] ?? state} ${String(count)}`];
    });
    const lines = [
      `# Dreams apply ${request.preview ? "预演" : "结果"} · ${at.toPlainDate().toString()}`, "",
      request.preview
        ? "- 预演只判断、不写入：下面是正式写入时每条注入层知识会怎么处理。预演中每批只能看到已有记忆，所以同一条在不同批次重复时，正式写入会比这里多出「已有同一条」。"
        : "- 已写入正式记忆（来源标记 dreaming-v1，归在代理生成）。撤销：`memstore dream rollback --apply`（批量归档，可恢复）。",
      `- ${counts.join(" · ") || "没有需要处理的条目"}`, ""
    ];
    const projects = [...new Set(request.outcomes.map((outcome) => outcome.projectId))];
    for (const projectId of projects) {
      const rows = request.outcomes.filter((outcome) => outcome.projectId === projectId);
      lines.push(`## ${projectDisplay(database, projectId).label} · ${String(rows.length)}`, "", ...applyLines(database, rows));
    }
    const directory = join(request.vaultRoot, dreamsDirectoryName);
    await mkdir(directory, { recursive: true });
    const path = join(directory, `apply-${request.preview ? "preview" : "result"}-${at.toPlainDate().toString()}.md`);
    await writeFileAtomically(path, `${lines.join("\n")}\n`, 0o644);
    return path;
  } finally {
    database.close();
  }
}

function parse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function escapeLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function displayStatement(item: Record<string, unknown>): string {
  return escapeLine(typeof item.refined_statement === "string" ? item.refined_statement : String(item.statement));
}

/** Readable Project label (its most recently used non-temporary root) and a filename-safe slug. */
export function projectDisplay(database: DatabaseSync, projectId: string): { readonly label: string; readonly slug: string } {
  const roots = database.prepare("SELECT canonical_root FROM project_roots WHERE project_id = ? ORDER BY last_used_at DESC")
    .all(projectId).map((row) => String(row.canonical_root));
  const root = roots.find((candidate) => !temporaryRootPattern.test(candidate)) ?? roots[0];
  if (root === undefined) return { label: projectId, slug: projectId.slice(7, 15) };
  const home = homedir();
  const label = root === home ? "~" : root.startsWith(`${home}/`) ? `~${root.slice(home.length)}` : root;
  const slug = (root === home ? "home" : basename(root)).replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 40) || "project";
  return { label, slug };
}

/** The local calendar day a run belongs to: its schedule date, or for manual runs the day it was started. */
function runDate(scheduledFor: unknown, createdAt: unknown, timeZone: string): string {
  if (typeof scheduledFor === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(scheduledFor)) return scheduledFor;
  return Temporal.Instant.from(String(createdAt)).toZonedDateTimeISO(timeZone).toPlainDate().toString();
}

export async function writeDreamReport(request: {
  readonly database: DatabaseSync;
  readonly vaultRoot: string;
  readonly runId: string;
  readonly projectId: string;
  readonly timeZone: string;
}): Promise<string> {
  const run = request.database.prepare("SELECT scheduled_for, created_at, stats_json, mode FROM dream_runs WHERE run_id = ?").get(request.runId);
  const stats = parse<Record<string, number>>(run?.stats_json, {});
  const project = projectDisplay(request.database, request.projectId);
  const date = runDate(run?.scheduled_for, run?.created_at, request.timeZone);
  const items = request.database.prepare(
    "SELECT statement, refined_statement, tier, tier_reason, scope, verdict_json, defense_json, session_ids_json FROM dream_items WHERE run_id = ? ORDER BY tier, scope DESC, claim_type"
  ).all(request.runId);
  const lines = [
    `# Dreams · ${date} · ${project.label}`,
    "",
    `- Project: ${project.label} (\`${request.projectId}\`)`,
    `- Run: \`${request.runId}\` · mode: ${String(run?.mode ?? "shadow")}（影子模式不写正式记忆、不改变注入）· 跨项目汇总见 [[${basename(overviewFileName, ".md")}]]`,
    `- Sessions: ${String(stats.sessions ?? 0)} · chunks: ${String(stats.chunks ?? 0)} · candidates: ${String(stats.candidates ?? 0)} · items: ${String(items.length)}` +
      ` (global: ${String(items.filter((item) => item.scope === "global").length)})`,
    `- Model calls: extract ${String(stats.extract_calls ?? 0)}, merge ${String(stats.merge_calls ?? 0)}, verify ${String(stats.verify_calls ?? 0)}, defense ${String(stats.defense_calls ?? 0)}` +
      ` · tokens ≈ ${String((stats.extract_tokens ?? 0) + (stats.merge_tokens ?? 0) + (stats.verify_tokens ?? 0) + (stats.defense_tokens ?? 0))}`,
    ""
  ];
  for (const tier of ["inject", "branch", "review", "pool", "drop"]) {
    const group = items.filter((item) => item.tier === tier);
    lines.push(`## ${tierTitles[tier] ?? tier} · ${String(group.length)}`, "");
    for (const item of group) {
      const verdict = parse<{ verdict?: string; evidence?: string[]; reason?: string; user_support?: string; documented_at?: string }>(item.verdict_json, {});
      const defense = parse<{ decision?: string; final_verdict?: string; reason?: string } | undefined>(item.defense_json, undefined);
      const sessions = parse<string[]>(item.session_ids_json, []).length;
      // The refined statement is what dreaming would keep; the original is shown for review.
      // Global knowledge (general tools, personal workflow) is listed after project knowledge and tagged:
      // apply mode stores it in the Global space rather than this Project.
      const tag = item.scope === "global" ? "〔全局〕" : "";
      lines.push(`- ${tag}${displayStatement(item)}`);
      if (typeof item.refined_statement === "string") lines.push(`  - 收窄前：${escapeLine(String(item.statement))}`);
      const support = verdict.user_support === undefined ? undefined : userSupportLabels[verdict.user_support];
      const userSupportNote = support === undefined ? "" : ` · 原话：${support}`;
      const defended = defense === undefined ? "" : ` → defense ${defense.decision ?? "-"}: ${defense.final_verdict ?? "-"}`;
      lines.push(`  - ${reasonLabel(tier, String(item.tier_reason))} · verdict: ${verdict.verdict ?? "-"}${defended}` +
        ` · scope: ${String(item.scope)} · sessions: ${String(sessions)}` + userSupportNote);
      if ((verdict.documented_at ?? "") !== "") lines.push(`  - 已写在：${escapeLine(verdict.documented_at ?? "")}`);
      for (const evidence of (verdict.evidence ?? []).slice(0, 2)) lines.push(`  - 证据：${escapeLine(evidence).slice(0, 240)}`);
      if (tier === "review" || tier === "branch") lines.push(`  - 理由：${escapeLine(defense?.reason ?? verdict.reason ?? "").slice(0, 240)}`);
    }
    lines.push("");
  }
  const applied = request.database.prepare(
    "SELECT COALESCE(refined_statement, statement) AS text, apply_state, apply_memory_id, apply_reason FROM dream_items WHERE run_id = ? AND apply_state IS NOT NULL ORDER BY item_id"
  ).all(request.runId);
  if (applied.length > 0) {
    lines.push(`## 写入正式记忆 · ${String(applied.length)}`, "", ...applyLines(request.database, applied.map((row) => ({
      state: String(row.apply_state), text: String(row.text), reason: typeof row.apply_reason === "string" ? row.apply_reason : "",
      ...(typeof row.apply_memory_id === "string" ? { memoryId: row.apply_memory_id } : {})
    }))));
  }
  const directory = join(request.vaultRoot, dreamsDirectoryName);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${date}-${project.slug}-${request.runId.slice(8, 16)}.md`);
  await writeFileAtomically(path, `${lines.join("\n")}\n`, 0o644);
  return path;
}

/**
 * One note with everything dreaming kept (all tiers except drop) from completed
 * runs in the recent window, plus `includeRunId` while that run is finishing:
 * global knowledge first, then each Project. A statement kept by several runs is
 * listed once, from its latest run.
 */
export async function writeDreamOverview(request: {
  readonly database: DatabaseSync;
  readonly vaultRoot: string;
  readonly now: string;
  readonly timeZone: string;
  readonly includeRunId?: string;
}): Promise<string> {
  const since = Temporal.Instant.from(request.now).subtract({ hours: overviewWindowDays * 24 }).toString();
  const rows = request.database.prepare(
    `SELECT i.statement, i.refined_statement, i.tier, i.tier_reason, i.scope, r.project_id, r.report_path
     FROM dream_items i JOIN dream_runs r USING (run_id)
     WHERE (r.stage = 'completed' OR r.run_id = ?) AND r.created_at >= ? AND i.tier IN ('inject', 'branch', 'pool', 'review')
     ORDER BY r.created_at DESC, i.claim_type`
  ).all(request.includeRunId ?? null, since);
  const tierOrder = ["inject", "branch", "pool", "review"];
  const labels = new Map<string, string>();
  const groups = new Map<string, Map<string, string[]>>();
  const seen = new Set<string>();
  const totals = new Map<string, number>();
  for (const row of rows) {
    const projectId = String(row.project_id);
    const statement = displayStatement(row);
    const key = `${row.scope === "global" ? "global" : projectId}\0${statement}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = labels.get(projectId) ?? projectDisplay(request.database, projectId).label;
    labels.set(projectId, label);
    const group = row.scope === "global" ? "全局（与具体项目无关）" : `项目 ${label}`;
    const tiers = groups.get(group) ?? new Map<string, string[]>();
    groups.set(group, tiers);
    const tier = String(row.tier);
    const report = typeof row.report_path === "string" ? ` · [[${basename(row.report_path, ".md")}]]` : "";
    const source = row.scope === "global" ? ` · 来自 ${label}` : "";
    tiers.set(tier, [...(tiers.get(tier) ?? []), `- ${statement}\n  - ${reasonLabel(tier, String(row.tier_reason))}${source}${report}`]);
    totals.set(tier, (totals.get(tier) ?? 0) + 1);
  }
  const at = Temporal.Instant.from(request.now).toZonedDateTimeISO(request.timeZone);
  const lines = [
    "# Dreams 总览",
    "",
    `- 截至 ${at.toPlainDate().toString()} ${at.toPlainTime().toString().slice(0, 5)}：最近 ${String(overviewWindowDays)} 天 dreaming 保留下来的知识（不含丢弃层），同一表述只列最近一次。`,
    `- ${tierOrder.map((tier) => `${(tierTitles[tier] ?? tier).replace(/（.*$/u, "")} ${String(totals.get(tier) ?? 0)}`).join(" · ")}`,
    "- 影子模式：这些知识还没有写成正式记忆，也不会被注入；「注入层」是开启 apply 模式后会自动注入的部分。每条后面的链接是对应的单次报告（含验证证据）。",
    ""
  ];
  const ordered = [...groups.keys()].sort((a, b) => (a.startsWith("全局") ? -1 : b.startsWith("全局") ? 1 : a.localeCompare(b)));
  for (const group of ordered) {
    const tiers = groups.get(group) ?? new Map<string, string[]>();
    const count = tierOrder.reduce((sum, tier) => sum + (tiers.get(tier)?.length ?? 0), 0);
    lines.push(`## ${group} · ${String(count)}`, "");
    for (const tier of tierOrder) {
      const entries = tiers.get(tier);
      if (entries === undefined) continue;
      lines.push(`### ${tierTitles[tier] ?? tier} · ${String(entries.length)}`, "", ...entries, "");
    }
  }
  if (ordered.length === 0) lines.push("（最近没有可展示的 dreaming 结果。）", "");
  const directory = join(request.vaultRoot, dreamsDirectoryName);
  await mkdir(directory, { recursive: true });
  const path = join(directory, overviewFileName);
  await writeFileAtomically(path, `${lines.join("\n")}\n`, 0o644);
  return path;
}
