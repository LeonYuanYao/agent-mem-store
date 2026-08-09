import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { loadTransformersEmbeddingAdapter } from "../src/retrieval/embeddings/transformers.js";
import { approvedShadowEmbeddingProfile } from "../src/retrieval/shadow-profile.js";

const documents = [
  { id: "zh-batch", text: "长时间运行的编码任务需要分批保存进度，并在会话结束时统一合并知识。" },
  { id: "en-sqlite", text: "Use SQLite WAL and short transactions for durable local state." },
  { id: "code-typescript", text: "TypeScript code must avoid `any` and preserve exact optional property types." },
  { id: "path-marker", text: "The project marker is stored at .memstore-project in the repository root." },
  { id: "error-busy", text: "SQLITE_BUSY means another writer holds the database lock; retry within the bounded deadline." },
  { id: "zh-secret", text: "密码、访问令牌和私钥不得写入长期记忆、索引或日志。" },
  { id: "git-worktree", text: "Git worktrees that share repository identity should share Project Memory." },
  { id: "obsidian", text: "Canonical Memory remains human-readable Markdown in an Obsidian Vault." },
  { id: "test-command", text: "Run pnpm typecheck and pnpm test before claiming implementation completion." },
  { id: "noise", text: "The cafeteria menu changes every day and is unrelated to coding memory retrieval." }
] as const;

const queries = [
  { kind: "chinese", text: "一个小时的长任务如何分批沉淀知识", expected: "zh-batch" },
  { kind: "english", text: "durable SQLite concurrency configuration", expected: "en-sqlite" },
  { kind: "code", text: "avoid unsafe any in TypeScript", expected: "code-typescript" },
  { kind: "path", text: "where is .memstore-project located", expected: "path-marker" },
  { kind: "error", text: "database failed with SQLITE_BUSY", expected: "error-busy" },
  { kind: "chinese", text: "哪些敏感凭据不能保存到记忆中", expected: "zh-secret" },
  { kind: "git", text: "do worktrees share project knowledge", expected: "git-worktree" },
  { kind: "obsidian", text: "human editable canonical markdown vault", expected: "obsidian" },
  { kind: "command", text: "verification commands before completion", expected: "test-command" }
] as const;

const negativeQueries = [
  "quantum chemistry orbital symmetry",
  "NBA playoff ticket prices",
  "medieval European painting restoration"
] as const;
const semanticOnlyGate = {
  minimumScore: approvedShadowEmbeddingProfile.semanticOnlyMinimumScore,
  minimumTop1Margin: approvedShadowEmbeddingProfile.semanticOnlyMinimumTop1Margin
} as const;

const candidates = [
  {
    role: "lightweight",
    modelIdentity: "onnx-community/minilm-student-L6_uniform_distilled-ONNX",
    queryPrefix: "",
    documentPrefix: ""
  },
  {
    role: "quality",
    modelIdentity: "onnx-community/multilingual-e5-base-ONNX",
    queryPrefix: "query: ",
    documentPrefix: "passage: "
  }
] as const;

function cosine(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

function percentile(values: readonly number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1));
  return sorted[index] ?? 0;
}

const outputIndex = process.argv.indexOf("--output");
const outputPath = resolve(
  outputIndex >= 0 && process.argv[outputIndex + 1] !== undefined
    ? process.argv[outputIndex + 1] as string
    : "docs/evidence/outcome7-embedding-benchmark.json"
);
const cacheRoot = resolve(
  process.env.MEMSTORE_BENCHMARK_CACHE ?? join(tmpdir(), "memstore-outcome7-models")
);

const results = [];
for (const candidate of candidates) {
  const cacheDirectory = join(cacheRoot, candidate.role);
  const rssBefore = process.memoryUsage().rss;
  const loaded = await loadTransformersEmbeddingAdapter({
    modelIdentity: candidate.modelIdentity,
    cacheDirectory,
    dtype: "q8",
    queryPrefix: candidate.queryPrefix,
    documentPrefix: candidate.documentPrefix
  });
  try {
    const documentStarted = performance.now();
    const documentVectors = await (loaded.adapter.embedDocuments ?? loaded.adapter.embed)(
      documents.map((document) => document.text)
    );
    const documentMilliseconds = performance.now() - documentStarted;
    const queryLatencies: number[] = [];
    let reciprocalRankTotal = 0;
    let recallAt1 = 0;
    let recallAt3 = 0;
    let semanticOnlyGateRecall = 0;
    const samples = [];
    for (const query of queries) {
      const queryStarted = performance.now();
      const queryVector = (await (loaded.adapter.embedQuery ?? loaded.adapter.embed)([query.text]))[0];
      queryLatencies.push(performance.now() - queryStarted);
      if (queryVector === undefined) throw new Error("Benchmark query returned no embedding.");
      const ranking = documents.map((document, index) => ({
        id: document.id,
        score: cosine(queryVector, documentVectors[index] ?? [])
      })).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
      const expectedRank = ranking.findIndex((item) => item.id === query.expected) + 1;
      const top1Margin = (ranking[0]?.score ?? 0) - (ranking[1]?.score ?? 0);
      const semanticOnlyGatePassed = expectedRank === 1 &&
        (ranking[0]?.score ?? 0) >= semanticOnlyGate.minimumScore &&
        top1Margin >= semanticOnlyGate.minimumTop1Margin;
      reciprocalRankTotal += expectedRank === 0 ? 0 : 1 / expectedRank;
      if (expectedRank === 1) recallAt1 += 1;
      if (expectedRank > 0 && expectedRank <= 3) recallAt3 += 1;
      if (semanticOnlyGatePassed) semanticOnlyGateRecall += 1;
      samples.push({
        kind: query.kind,
        query: query.text,
        expected: query.expected,
        expectedRank,
        top1Margin,
        semanticOnlyGatePassed,
        top3: ranking.slice(0, 3)
      });
    }
    const rssAfter = process.memoryUsage().rss;
    results.push({
      role: candidate.role,
      modelIdentity: candidate.modelIdentity,
      dtype: "q8",
      adapterIdentity: loaded.adapter.identity,
      pipelineLoadMilliseconds: loaded.pipelineLoadMilliseconds,
      artifactFingerprintMilliseconds: loaded.artifactFingerprintMilliseconds,
      artifactBytes: loaded.artifact.bytes,
      artifactFileCount: loaded.artifact.fileCount,
      artifactCandidateSha256: loaded.artifact.sha256,
      rssDeltaBytes: Math.max(0, rssAfter - rssBefore),
      corpusDocuments: documents.length,
      corpusEmbeddingMilliseconds: documentMilliseconds,
      corpusDocumentsPerSecond: documents.length / (documentMilliseconds / 1000),
      warmQueryP50Milliseconds: percentile(queryLatencies, 0.5),
      warmQueryP95Milliseconds: percentile(queryLatencies, 0.95),
      recallAt1: recallAt1 / queries.length,
      recallAt3: recallAt3 / queries.length,
      meanReciprocalRank: reciprocalRankTotal / queries.length,
      semanticOnlyGate,
      semanticOnlyGateRecall: semanticOnlyGateRecall / queries.length,
      negativeCalibration: await Promise.all(negativeQueries.map(async (query) => {
        const queryVector = (await (loaded.adapter.embedQuery ?? loaded.adapter.embed)([query]))[0];
        if (queryVector === undefined) throw new Error("Negative query returned no embedding.");
        const ranking = documents.map((document, index) => ({
          id: document.id,
          score: cosine(queryVector, documentVectors[index] ?? [])
        })).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
        const top1Margin = (ranking[0]?.score ?? 0) - (ranking[1]?.score ?? 0);
        return {
          query,
          top: ranking[0],
          top1Margin,
          semanticOnlyGatePassed: (ranking[0]?.score ?? 0) >= semanticOnlyGate.minimumScore &&
            top1Margin >= semanticOnlyGate.minimumTop1Margin
        };
      })),
      samples
    });
  } finally {
    await loaded.dispose();
  }
}

const evidence = {
  schemaVersion: 1,
  status: "candidate_only_not_activated",
  generatedAt: new Date().toISOString(),
  environment: {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    transformers: "4.2.0",
    cacheLocationClass: "operating_system_temporary_directory"
  },
  corpus: {
    documentCount: documents.length,
    queryCount: queries.length,
    coverage: ["Chinese", "English", "code", "path", "error", "Git", "Obsidian", "command"]
  },
  limitations: [
    "Synthetic corpus with ten documents and nine positive queries is directional evidence only.",
    "No real Shadow workload or task-outcome labels were available in Outcome 7.",
    "Artifact checksums are benchmark candidates and are not frozen or activated.",
    "Model thresholds require review because cosine score calibration differs by adapter."
  ],
  activationDecision: null,
  results
};
await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ outputPath, results }, null, 2)}\n`);
