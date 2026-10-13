import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { writeFileAtomically } from "../contracts/atomic-file.js";

/**
 * Writes the human-readable Dreams report into the Vault. In shadow mode this is
 * the only Vault write: it lists what dreaming would inject, scope to a branch,
 * keep searchable, send to review or drop, with the verifier's evidence.
 */

const tierTitles: Record<string, string> = {
  inject: "注入层（会自动注入）",
  branch: "分支层（只在对应分支的会话注入）",
  pool: "可搜索池（不自动注入）",
  review: "需要复核（验证器认为错误或过时）",
  drop: "丢弃（一次性信息，或已写在自动加载的文档/skill 中）"
};

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

export async function writeDreamReport(request: {
  readonly database: DatabaseSync;
  readonly vaultRoot: string;
  readonly runId: string;
  readonly projectId: string;
  readonly now: string;
}): Promise<string> {
  const run = request.database.prepare("SELECT scheduled_for, stats_json, mode FROM dream_runs WHERE run_id = ?").get(request.runId);
  const stats = parse<Record<string, number>>(run?.stats_json, {});
  const items = request.database.prepare(
    "SELECT statement, refined_statement, tier, tier_reason, scope, verdict_json, defense_json, session_ids_json FROM dream_items WHERE run_id = ? ORDER BY tier, scope DESC, claim_type"
  ).all(request.runId);
  const lines = [
    `# Dreams · ${request.now.slice(0, 10)}`,
    "",
    `- Project: \`${request.projectId}\``,
    `- Run: \`${request.runId}\` · mode: ${String(run?.mode ?? "shadow")}（影子模式不写正式记忆、不改变注入）`,
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
      const verdict = parse<{ verdict?: string; evidence?: string[]; reason?: string }>(item.verdict_json, {});
      const defense = parse<{ decision?: string; final_verdict?: string; reason?: string } | undefined>(item.defense_json, undefined);
      const sessions = parse<string[]>(item.session_ids_json, []).length;
      // The refined statement is what dreaming would keep; the original is shown for review.
      // Global knowledge (general tools, personal workflow) is listed after project knowledge and tagged:
      // apply mode stores it in the Global space rather than this Project.
      const tag = item.scope === "global" ? "〔全局〕" : "";
      if (typeof item.refined_statement === "string") {
        lines.push(`- ${tag}${escapeLine(item.refined_statement)}`);
        lines.push(`  - 收窄前：${escapeLine(String(item.statement))}`);
      } else {
        lines.push(`- ${tag}${escapeLine(String(item.statement))}`);
      }
      lines.push(`  - ${String(item.tier_reason)} · verdict: ${verdict.verdict ?? "-"}${defense === undefined ? "" : ` → defense ${defense.decision ?? "-"}: ${defense.final_verdict ?? "-"}`}` +
        ` · scope: ${String(item.scope)} · sessions: ${String(sessions)}`);
      for (const evidence of (verdict.evidence ?? []).slice(0, 2)) lines.push(`  - 证据：${escapeLine(evidence).slice(0, 240)}`);
      if (tier === "review" || tier === "branch") lines.push(`  - 理由：${escapeLine(defense?.reason ?? verdict.reason ?? "").slice(0, 240)}`);
    }
    lines.push("");
  }
  const directory = join(request.vaultRoot, "_MemStore", "Dreams");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${request.now.slice(0, 10)}-${request.projectId.slice(7, 15)}-${request.runId.slice(8, 16)}.md`);
  await writeFileAtomically(path, `${lines.join("\n")}\n`, 0o644);
  return path;
}
