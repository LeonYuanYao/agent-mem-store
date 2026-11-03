/**
 * Weekly recall audit (ADR-0167): where automatic injection loses relevant Memory.
 * For a sample of real prompts, Codex (`--model`, default gpt-6.1-terra) labels the nearest
 * Memories that existed when the prompt was asked, plus what was injected. Each relevant
 * Memory is then traced through that prompt's receipt: injected, already in context, rejected
 * by Jev, cut by item limits, judged weak by the local gate, or never examined.
 *
 *   tsx scripts/audit-recall.ts --out DIR [--since ISO] [--sample 40] [--neighbors 12] [--model gpt-6.1-terra] [--effort medium]
 *
 * Writes cases.json, labels/, summary.json and a Chinese report.md; reruns resume labeling.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { isAgentNotification } from "../src/contracts/prompt-text.js";
import { loadConfiguredEmbeddingAdapter } from "../src/retrieval/embeddings/configured.js";
import { inspectUserPromptScoring } from "../src/retrieval/packs.js";
import { loadRetrievalSnapshot } from "../src/retrieval/snapshot.js";
import { labelRelevance, type Label } from "./lib/relevance-labels.js";

type Stage = "injected" | "already_present" | "jev_rejected" | "limit" | "jev_unavailable" | "local_weak" | "unavailable" | "not_examined";
interface Pair { memoryId: string; memoryRef: number | null; text: string; stage: Stage; jevScore?: number; label?: Label }
interface AuditCase { id: string; at: string; prompt: string; recent: string[]; candidates: Pair[] }

const { values } = parseArgs({ options: {
  since: { type: "string" }, out: { type: "string" }, sample: { type: "string", default: "40" }, neighbors: { type: "string", default: "12" },
  model: { type: "string", default: "gpt-6.1-terra" }, effort: { type: "string", default: "medium" }, parallel: { type: "string", default: "4" },
  runtime: { type: "string" }
} });
if (values.out === undefined) throw new Error("--out is required.");
const since = new Date(values.since ?? Date.now() - 7 * 86_400_000).toISOString();
const out = resolve(values.out.replace(/^~(?=\/|$)/u, homedir()));
const runtime = resolve(values.runtime ?? join(homedir(), "Library", "Application Support", "MemStore"));
mkdirSync(out, { recursive: true, mode: 0o700 });

function frontmatterAndBody(path: string): { createdAt?: string; body?: string } {
  try {
    const text = readFileSync(path, "utf8");
    const split = text.indexOf("\n---\n", 4);
    const frontmatter = split < 0 ? "" : text.slice(0, split);
    const createdAt = /^\s*created_at:\s*(\S+)\s*$/mu.exec(frontmatter)?.[1];
    return { ...(createdAt === undefined ? {} : { createdAt }), body: (split < 0 ? text : text.slice(split + 5)).trim().slice(0, 600) };
  } catch { return {}; }
}

function stageOf(item: { outcome: string; omission: string | null } | undefined): Stage {
  if (item === undefined) return "not_examined";
  if (item.outcome === "selected") return "injected";
  switch (item.omission) {
    case "already_present": return "already_present";
    case "jev_below_threshold": return "jev_rejected";
    case "unfiltered_low_confidence": return "jev_unavailable";
    case "weak_relevance": return "local_weak";
    case "representation_unavailable": return "unavailable";
    default: return "limit";
  }
}

async function buildCases(): Promise<AuditCase[]> {
  const casesPath = join(out, "cases.json");
  if (existsSync(casesPath)) return JSON.parse(readFileSync(casesPath, "utf8")) as AuditCase[];
  const database = new DatabaseSync(join(runtime, "state", "memstore.sqlite"), { readOnly: true });
  const catalog = new Map(database.prepare("SELECT memory_id, memory_ref, canonical_path FROM memory_catalog WHERE lifecycle = 'active'").all()
    .map(row => [String(row.memory_id), { ref: typeof row.memory_ref === "number" ? row.memory_ref : null, ...frontmatterAndBody(String(row.canonical_path)) }]));
  const receipts = database.prepare(`SELECT receipt_id, created_at, caller_identity, project_id, normalized_query, empty_reason FROM retrieval_receipts
    WHERE caller_kind = 'user_prompt' AND created_at >= ? AND project_id IS NOT NULL ORDER BY created_at`).all(since);
  const itemsOf = database.prepare("SELECT memory_id, outcome, omission_reason, reasons_json FROM retrieval_receipt_items WHERE receipt_id = ?");
  const history = new Map<string, string[]>();
  const pool: { id: string; at: string; project: string; prompt: string; recent: string[] }[] = [];
  for (const row of receipts) {
    const prompt = String(row.normalized_query ?? "").trim();
    const caller = String(row.caller_identity);
    const recent = history.get(caller) ?? [];
    const skipped = ["agent_notification", "continuation_only", "empty_prompt"].includes(String(row.empty_reason ?? ""));
    if (prompt !== "" && !skipped && !isAgentNotification(prompt)) {
      pool.push({ id: String(row.receipt_id), at: String(row.created_at), project: String(row.project_id), prompt, recent: [...recent] });
      history.set(caller, [prompt, ...recent].slice(0, 3));
    }
  }
  const loaded = await loadConfiguredEmbeddingAdapter(runtime);
  if (loaded === undefined) throw new Error("The embedding model is not installed in the runtime.");
  const snapshot = await loadRetrievalSnapshot({ runtimeRoot: runtime });
  const size = Math.min(Number(values.sample), pool.length);
  const cases: AuditCase[] = [];
  for (let index = 0; index < size; index += 1) {
    const entry = pool[Math.floor(index * pool.length / size)];
    if (entry === undefined) continue;
    const receiptItems = new Map(itemsOf.all(entry.id).map(row => [String(row.memory_id), {
      outcome: String(row.outcome), omission: typeof row.omission_reason === "string" ? row.omission_reason : null,
      jevScore: Number(/jev_score:([\d.]+)/u.exec(String(row.reasons_json ?? ""))?.[1] ?? Number.NaN)
    }]));
    const scoring = await inspectUserPromptScoring({ runtimeRoot: runtime, projectId: entry.project, prompt: entry.prompt,
      recentPrompts: entry.recent, adapter: loaded.adapter, requestedAt: new Date().toISOString(), snapshot });
    // Only Memories that existed when the prompt was asked could have been recalled.
    const existed = (memoryId: string): boolean => { const createdAt = catalog.get(memoryId)?.createdAt; return createdAt !== undefined && createdAt <= entry.at; };
    const nearest = [...scoring.items].sort((left, right) => right.score - left.score).map(item => item.memoryId).filter(existed)
      .slice(0, Number(values.neighbors));
    const injected = [...receiptItems].filter(([, item]) => item.outcome === "selected").map(([memoryId]) => memoryId);
    const candidates = [...new Set([...nearest, ...injected])].flatMap((memoryId): Pair[] => {
      const memory = catalog.get(memoryId);
      if (memory?.body === undefined) return [];
      const item = receiptItems.get(memoryId);
      return [{ memoryId, memoryRef: memory.ref, text: memory.body, stage: stageOf(item),
        ...(item !== undefined && Number.isFinite(item.jevScore) ? { jevScore: item.jevScore } : {}) }];
    });
    if (candidates.length > 0) cases.push({ id: entry.id, at: entry.at, prompt: entry.prompt, recent: entry.recent, candidates });
  }
  database.close();
  await loaded.dispose();
  writeFileSync(casesPath, JSON.stringify(cases, null, 1), { mode: 0o600 });
  return cases;
}

const stageNames: Record<Stage, string> = {
  injected: "已注入", already_present: "已在上下文里", jev_rejected: "被 Jev 拒绝", limit: "被条数或预算挤掉",
  jev_unavailable: "Jev 不可用时被保守过滤", local_weak: "本地初筛判为太弱", unavailable: "没有可注入的摘要", not_examined: "没进入候选"
};

function report(cases: AuditCase[]): void {
  const percent = (part: number, whole: number): string => whole === 0 ? "-" : `${(100 * part / whole).toFixed(1)}%`;
  const pairs = cases.flatMap(entry => entry.candidates.filter(pair => pair.label !== undefined).map(pair => ({ entry, pair })));
  const relevant = pairs.filter(({ pair }) => pair.label === "relevant");
  const served = (stage: Stage): boolean => stage === "injected" || stage === "already_present";
  const stages = Object.fromEntries((Object.keys(stageNames) as Stage[]).map(stage => [stage, relevant.filter(({ pair }) => pair.stage === stage).length]));
  const injected = pairs.filter(({ pair }) => pair.stage === "injected");
  const promptsWithRelevant = new Set(relevant.map(({ entry }) => entry.id));
  const promptsServed = new Set(relevant.filter(({ pair }) => served(pair.stage)).map(({ entry }) => entry.id));
  const noisyPrompts = new Set(injected.filter(({ pair }) => pair.label === "irrelevant").map(({ entry }) => entry.id));
  const summary = {
    since, generatedAt: new Date().toISOString(), model: values.model, prompts: cases.length, pairs: pairs.length,
    relevant: relevant.length, recall: percent(relevant.filter(({ pair }) => served(pair.stage)).length, relevant.length),
    stages, injected: injected.length, precision: percent(injected.filter(({ pair }) => pair.label === "relevant").length, injected.length),
    promptsServed: `${String(promptsServed.size)}/${String(promptsWithRelevant.size)}`, noisyPrompts: noisyPrompts.size
  };
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 1));
  const missed = relevant.filter(({ pair }) => !served(pair.stage)).slice(0, 8);
  const lines = [
    `**MemStore 召回审计**（${since.slice(0, 10)} 起，${values.model} 标注）`, "",
    `抽样 ${String(cases.length)} 个提问，标注 ${String(pairs.length)} 对；相关 ${String(relevant.length)} 对。`,
    `- 相关召回 ${summary.recall}（已注入或已在上下文里）；拿到相关记忆的提问 ${summary.promptsServed}`,
    `- 注入精确率 ${summary.precision}（注入 ${String(injected.length)} 条）；带噪音的提问 ${String(noisyPrompts.size)} 个`, "",
    "**相关记忆走到了哪一步**", "",
    "| 环节 | 条数 | 占相关 |", "| --- | ---: | ---: |",
    ...(Object.keys(stageNames) as Stage[]).filter(stage => (stages[stage] ?? 0) > 0)
      .map(stage => `| ${stageNames[stage]} | ${String(stages[stage])} | ${percent(stages[stage] ?? 0, relevant.length)} |`),
    "", "**没召回的例子**",
    ...missed.map(({ entry, pair }) => `- ${stageNames[pair.stage]}${pair.jevScore === undefined ? "" : `（Jev ${pair.jevScore.toFixed(2)}）`}：M:${String(pair.memoryRef)} ← 「${entry.prompt.replace(/\s+/gu, " ").slice(0, 40)}」`)
  ];
  writeFileSync(join(out, "report.md"), `${lines.join("\n")}\n`);
  console.log(JSON.stringify(summary, null, 1));
}

const cases = await buildCases();
const labels = await labelRelevance({ out, cases, model: values.model, effort: values.effort, parallel: Number(values.parallel) });
for (const entry of cases) for (const pair of entry.candidates) {
  const value = labels.get(`${entry.id}|${pair.memoryId}`);
  if (value !== undefined) pair.label = value;
}
report(cases);
