/**
 * Evaluates automatic injection on real prompts (ADR-0154 method):
 *   A = every candidate Jev scored since --since, with its score;
 *   B = a sample of prompts the local gate found nothing for, with the 3 nearest Memories that
 *       already existed when the prompt was asked;
 * Codex (`--model`, default gpt-6.1-sol; isolated like dreaming, blind to scores) labels each pair
 * relevant / partial / irrelevant; the report compares Jev thresholds and local misses.
 *
 *   tsx scripts/evaluate-injection.ts --since 2026-10-26T09:04:27Z --out ~/eval-dir [--sample 120] [--parallel 4]
 *
 * Labeling is resumable: rerunning with the same --out reuses finished batches.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { isAgentNotification, userPromptText } from "../src/contracts/prompt-text.js";
import { loadConfiguredEmbeddingAdapter } from "../src/retrieval/embeddings/configured.js";
import { inspectUserPromptScoring } from "../src/retrieval/packs.js";
import { labelRelevance, type Label } from "./lib/relevance-labels.js";
import { loadRetrievalSnapshot } from "../src/retrieval/snapshot.js";

interface Candidate { memoryId: string; memoryRef: number | null; text: string; jevScore?: number; kept?: boolean; band?: string; lift?: number; label?: Label }
interface Case { id: string; set: "A" | "B"; at: string; prompt: string; recent: string[]; candidates: Candidate[] }

const { values } = parseArgs({ options: {
  since: { type: "string" }, out: { type: "string" }, sample: { type: "string", default: "120" },
  parallel: { type: "string", default: "4" }, runtime: { type: "string" },
  model: { type: "string", default: "gpt-6.1-sol" }
} });
if (values.since === undefined || values.out === undefined) throw new Error("--since and --out are required.");
const since = new Date(values.since).toISOString();
const out = resolve(values.out.replace(/^~(?=\/|$)/u, homedir()));
const runtime = resolve(values.runtime ?? join(homedir(), "Library", "Application Support", "MemStore"));
mkdirSync(join(out, "labels"), { recursive: true, mode: 0o700 });

function memoryText(path: string): string | undefined {
  try {
    const text = readFileSync(path, "utf8");
    const body = text.indexOf("\n---\n", 4);
    return (body < 0 ? text : text.slice(body + 5)).trim().slice(0, 600);
  } catch { return undefined; }
}

/** When the Memory was first written, from its canonical frontmatter. */
function memoryCreatedAt(path: string): string | undefined {
  try {
    return /^\s*created_at:\s*(\S+)\s*$/mu.exec(readFileSync(path, "utf8").split("\n---\n", 1)[0] ?? "")?.[1];
  } catch { return undefined; }
}

async function buildCases(): Promise<Case[]> {
  const casesPath = join(out, "cases.json");
  if (existsSync(casesPath)) return JSON.parse(readFileSync(casesPath, "utf8")) as Case[];
  const database = new DatabaseSync(join(runtime, "state", "memstore.sqlite"), { readOnly: true });
  const catalog = new Map(database.prepare("SELECT memory_id, memory_ref, canonical_path FROM memory_catalog").all()
    .map(row => [String(row.memory_id), { ref: typeof row.memory_ref === "number" ? row.memory_ref : null, path: String(row.canonical_path) }]));
  const receipts = database.prepare(`SELECT receipt_id, created_at, caller_identity, project_id, normalized_query, empty_reason,
      json_extract(timing_json, '$.jev.state') AS jev FROM retrieval_receipts
    WHERE caller_kind = 'user_prompt' AND created_at >= ? AND project_id IS NOT NULL ORDER BY created_at`).all(since);
  const items = database.prepare(`SELECT memory_id, outcome, reasons_json FROM retrieval_receipt_items
    WHERE receipt_id = ? AND reasons_json LIKE '%jev_score%'`);
  const history = new Map<string, string[]>();
  const cases: Case[] = [];
  const pool: { id: string; at: string; project: string; prompt: string; recent: string[] }[] = [];
  for (const row of receipts) {
    const query = String(row.normalized_query);
    const prompt = userPromptText(query).trim();
    const session = String(row.caller_identity);
    const recent = history.get(session) ?? [];
    if (!isAgentNotification(query) && prompt !== "") history.set(session, [prompt, ...recent].slice(0, 3));
    if (row.jev === "filtered") {
      const candidates = items.all(String(row.receipt_id)).flatMap((item): Candidate[] => {
        const entry = catalog.get(String(item.memory_id));
        const text = entry === undefined ? undefined : memoryText(entry.path);
        const score = /jev_score:([0-9.]+)/u.exec(String(item.reasons_json))?.[1];
        return text === undefined || score === undefined ? [] : [{ memoryId: String(item.memory_id), memoryRef: entry?.ref ?? null, text,
          jevScore: Number(score), kept: item.outcome === "selected" }];
      });
      if (candidates.length > 0) cases.push({ id: String(row.receipt_id), set: "A", at: String(row.created_at), prompt, recent, candidates });
    } else if (row.empty_reason === "no_relevant_memory" && !isAgentNotification(query) && prompt !== "") {
      pool.push({ id: String(row.receipt_id), at: String(row.created_at), project: String(row.project_id), prompt, recent });
    }
  }
  database.close();
  const size = Math.min(Number(values.sample), pool.length);
  const loaded = await loadConfiguredEmbeddingAdapter(runtime);
  if (loaded === undefined) throw new Error("The embedding model is not installed in the runtime.");
  const adapter = loaded.adapter;
  const snapshot = await loadRetrievalSnapshot({ runtimeRoot: runtime });
  for (let index = 0; index < size; index += 1) {
    const entry = pool[Math.floor(index * pool.length / size)];
    if (entry === undefined) continue;
    const scoring = await inspectUserPromptScoring({ runtimeRoot: runtime, projectId: entry.project, prompt: entry.prompt,
      recentPrompts: entry.recent, adapter, requestedAt: new Date().toISOString(), snapshot });
    // Only Memories that existed when the prompt was asked can be missed; later ones (often written
    // by that night's dreaming) are judged against today's corpus otherwise and inflate the miss rate.
    const candidates = [...scoring.items].sort((left, right) => right.score - left.score || right.features.semanticLift - left.features.semanticLift)
      .filter((item) => {
        const catalogEntry = catalog.get(item.memoryId);
        const createdAt = catalogEntry === undefined ? undefined : memoryCreatedAt(catalogEntry.path);
        return createdAt !== undefined && createdAt <= entry.at;
      })
      .slice(0, 3).flatMap((item): Candidate[] => {
        const catalogEntry = catalog.get(item.memoryId);
        const text = catalogEntry === undefined ? undefined : memoryText(catalogEntry.path);
        return text === undefined ? [] : [{ memoryId: item.memoryId, memoryRef: catalogEntry?.ref ?? null, text, band: item.band, lift: item.features.semanticLift }];
      });
    if (candidates.length > 0) cases.push({ id: entry.id, set: "B", at: entry.at, prompt: entry.prompt, recent: entry.recent, candidates });
  }
  writeFileSync(casesPath, JSON.stringify(cases, null, 1), { mode: 0o600 });
  return cases;
}

function report(cases: Case[]): void {
  const percent = (part: number, whole: number): string => whole === 0 ? "-" : `${(100 * part / whole).toFixed(1)}%`;
  const pairs = cases.filter(entry => entry.set === "A").flatMap(entry => entry.candidates.filter(candidate => candidate.label !== undefined)
    .map(candidate => ({ entry, candidate, score: candidate.jevScore ?? 0 })));
  const relevant = pairs.filter(pair => pair.candidate.label === "relevant");
  const irrelevant = pairs.filter(pair => pair.candidate.label === "irrelevant");
  let wins = 0;
  for (const positive of relevant) for (const negative of irrelevant) wins += positive.score > negative.score ? 1 : positive.score === negative.score ? 0.5 : 0;
  const auc = relevant.length * irrelevant.length === 0 ? null : wins / (relevant.length * irrelevant.length);
  const promptsWithRelevant = new Set(relevant.map(pair => pair.entry.id));
  const thresholds = [0.3, 0.4, 0.5].map(threshold => {
    const kept = pairs.filter(pair => pair.score >= threshold);
    return { threshold, kept: kept.length, precision: percent(kept.filter(pair => pair.candidate.label === "relevant").length, kept.length),
      recall: percent(kept.filter(pair => pair.candidate.label === "relevant").length, relevant.length),
      served: `${String(new Set(kept.filter(pair => pair.candidate.label === "relevant").map(pair => pair.entry.id)).size)}/${String(promptsWithRelevant.size)}`,
      promptsWithNoise: new Set(kept.filter(pair => pair.candidate.label === "irrelevant").map(pair => pair.entry.id)).size };
  });
  const promptsB = cases.filter(entry => entry.set === "B");
  const missed = promptsB.filter(entry => entry.candidates.some(candidate => candidate.label === "relevant"));
  const noise = pairs.filter(pair => pair.candidate.label === "irrelevant" && pair.candidate.kept === true);
  const summary = { since, generatedAt: new Date().toISOString(), jevPairs: pairs.length, relevant: relevant.length,
    partial: pairs.filter(pair => pair.candidate.label === "partial").length, irrelevant: irrelevant.length,
    jevAuc: auc === null ? null : Number(auc.toFixed(3)), thresholds,
    localMisses: { prompts: promptsB.length, withRelevantNearby: missed.length, rate: percent(missed.length, promptsB.length) } };
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 1));
  const lines = [`# Injection evaluation since ${since}`, "",
    `Jev pairs ${String(pairs.length)}: relevant ${String(relevant.length)}, partial ${String(summary.partial)}, irrelevant ${String(irrelevant.length)}; AUC ${auc === null ? "-" : auc.toFixed(3)}.`, "",
    "| Threshold | Kept | Precision | Relevant recall | Prompts served | Prompts with noise |", "| ---: | ---: | ---: | ---: | ---: | ---: |",
    ...thresholds.map(row => `| ${String(row.threshold)} | ${String(row.kept)} | ${row.precision} | ${row.recall} | ${row.served} | ${String(row.promptsWithNoise)} |`), "",
    `Local gate: ${String(missed.length)} of ${String(promptsB.length)} prompts without candidates had a relevant Memory among the 3 nearest (${summary.localMisses.rate}).`, "",
    "Noise injected at the live threshold:", ...noise.map(pair => `- ${(pair.candidate.jevScore ?? 0).toFixed(2)} M:${String(pair.candidate.memoryRef)} | ${pair.entry.prompt.replace(/\s+/gu, " ").slice(0, 60)} | ${pair.candidate.text.replace(/\s+/gu, " ").slice(0, 70)}`)];
  writeFileSync(join(out, "report.md"), `${lines.join("\n")}\n`);
  console.log(JSON.stringify(summary, null, 1));
}

const cases = await buildCases();
const labels = await labelRelevance({ out, cases, model: values.model, effort: "high", parallel: Number(values.parallel) });
for (const entry of cases) for (const candidate of entry.candidates) {
  const value = labels.get(`${entry.id}|${candidate.memoryId}`);
  if (value !== undefined) candidate.label = value;
}
report(cases);
