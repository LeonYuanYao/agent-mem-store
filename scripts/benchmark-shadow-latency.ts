import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { handleCodexHook } from "../src/adapters/codex/hook.js";
import { initializeMemStore } from "../src/operations/initialize.js";
import { buildRetrievalIndex, type EmbeddingAdapter } from "../src/retrieval/index.js";
import {
  prepareSessionStartShadowPack,
  prepareUserPromptShadowPack
} from "../src/retrieval/packs.js";
import { writeCanonicalMemory } from "../src/vault/index.js";
import { makeCanonicalMemory } from "../tests/helpers/canonical-memory.js";

const outputIndex = process.argv.indexOf("--output");
const outputPath = resolve(
  outputIndex >= 0 && process.argv[outputIndex + 1] !== undefined
    ? process.argv[outputIndex + 1] as string
    : "artifacts/evidence/gate4-latency.json"
);
const root = await mkdtemp(join(tmpdir(), "memstore-gate4-latency-"));
const runtimeRoot = join(root, "runtime");
const vaultRoot = join(root, "vault");
const projectRoot = join(root, "project");
const projectId = "msproj_123e4567-e89b-42d3-a456-426614175001";

function percentile(values: readonly number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)
  );
  return sorted[index] ?? 0;
}

function summary(values: readonly number[]) {
  return {
    samples: values.length,
    p50Milliseconds: percentile(values, 0.50),
    p95Milliseconds: percentile(values, 0.95),
    p99Milliseconds: percentile(values, 0.99),
    maximumMilliseconds: Math.max(...values)
  };
}

const adapter: EmbeddingAdapter = {
  identity: {
    adapterVersion: "gate4-latency-fixture-v1",
    modelIdentity: "gate4-latency-fixture",
    artifactSha256: "e".repeat(64),
    dimensions: 2,
    normalization: "l2"
  },
  embed: (texts) => Promise.resolve(texts.map((text) =>
    /sqlite|wal/iu.test(text) ? [1, 0] : [0, 1]
  ))
};

try {
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, ".memstore-project"), JSON.stringify({
    schema_version: 1,
    project_id: projectId
  }));
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });

  const hookLatencies: number[] = [];
  for (let ordinal = 0; ordinal < 100; ordinal += 1) {
    const startedAt = performance.now();
    const result = await handleCodexHook({
      runtimeRoot,
      receivedAt: `2026-08-09T02:${String(Math.floor(ordinal / 60)).padStart(2, "0")}:${String(ordinal % 60).padStart(2, "0")}.000Z`,
      input: {
        hook_event_name: "UserPromptSubmit",
        session_id: `gate4-latency-${String(ordinal)}`,
        turn_id: `turn-${String(ordinal)}`,
        cwd: projectRoot,
        prompt: "Synthetic latency prompt without durable secrets."
      }
    });
    hookLatencies.push(performance.now() - startedAt);
    if (!result.captured) throw new Error("Synthetic Hook latency capture failed.");
  }

  for (let ordinal = 0; ordinal < 5; ordinal += 1) {
    await writeCanonicalMemory({
      runtimeRoot,
      vaultRoot,
      actor: "human",
      memory: makeCanonicalMemory({
        memoryId: `msmem_123e4567-e89b-42d3-a456-42661417501${String(ordinal)}`,
        revisionId: `msrev_123e4567-e89b-42d3-a456-42661417502${String(ordinal)}`,
        scope: { kind: "project", projectId },
        body: ordinal === 0
          ? "Use SQLite WAL and short write transactions."
          : `Synthetic unrelated durable rule ${String(ordinal)}.`,
        startup: "never"
      })
    });
  }
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter,
    builtAt: "2026-08-09T03:00:00.000Z"
  });

  const sessionStartLatencies: number[] = [];
  const userPromptLatencies: number[] = [];
  for (let ordinal = 0; ordinal < 40; ordinal += 1) {
    const sessionId = `gate4-pack-${String(ordinal)}`;
    const startAt = performance.now();
    const start = await prepareSessionStartShadowPack({
      runtimeRoot,
      vaultRoot,
      projectId,
      sessionId,
      requestedAt: `2026-08-09T04:00:${String(ordinal).padStart(2, "0")}.000Z`
    });
    sessionStartLatencies.push(performance.now() - startAt);
    void start;

    const promptAt = performance.now();
    const prompt = await prepareUserPromptShadowPack({
      runtimeRoot,
      vaultRoot,
      projectId,
      sessionId,
      prompt: "How should SQLite WAL transactions be structured?",
      signals: { files: [], symbols: [], errors: [], commands: [] },
      adapter,
      requestedAt: `2026-08-09T04:01:${String(ordinal).padStart(2, "0")}.000Z`
    });
    userPromptLatencies.push(performance.now() - promptAt);
    void prompt;
  }

  const metrics = {
    hookCapture: summary(hookLatencies),
    sessionStartPack: summary(sessionStartLatencies),
    userPromptPack: summary(userPromptLatencies)
  };
  const passed = Object.values(metrics).every((metric) => metric.p99Milliseconds < 500);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    passed,
    targetP99Milliseconds: 500,
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      dataLocation: "operating-system temporary directory"
    },
    metrics,
    limitations: [
      "Synthetic local workload; it does not include a real Luna network call.",
      "Pack measurements use the deterministic embedding boundary fixture.",
      "Gate 4 measures preparation only because automatic injection remains disabled."
    ]
  }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ outputPath, passed, metrics }, null, 2)}\n`);
  process.exitCode = passed ? 0 : 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
