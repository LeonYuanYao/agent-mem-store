import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { initializeMemStore } from "../src/operations/initialize.js";
import { loadConfiguredEmbeddingAdapter } from "../src/retrieval/embeddings/configured.js";
import { startForegroundRetrievalServer } from "../src/retrieval/foreground-ipc.js";
import { buildRetrievalIndex } from "../src/retrieval/index.js";
import { writeCanonicalMemory } from "../src/vault/index.js";
import { makeCanonicalMemory } from "../tests/helpers/canonical-memory.js";

const configuredRuntimeIndex = process.argv.indexOf("--configured-runtime");
const configuredRuntime = resolve(
  configuredRuntimeIndex >= 0 && process.argv[configuredRuntimeIndex + 1] !== undefined
    ? process.argv[configuredRuntimeIndex + 1] as string
    : process.env.MEMSTORE_RUNTIME_ROOT ?? ""
);
if (configuredRuntime.length === 0) {
  throw new Error("--configured-runtime or MEMSTORE_RUNTIME_ROOT is required.");
}
const outputIndex = process.argv.indexOf("--output");
const outputPath = resolve(
  outputIndex >= 0 && process.argv[outputIndex + 1] !== undefined
    ? process.argv[outputIndex + 1] as string
    : "artifacts/evidence/gate6-active-injection-latency.json"
);
const samplesIndex = process.argv.indexOf("--samples");
const sampleCount = samplesIndex >= 0 && process.argv[samplesIndex + 1] !== undefined
  ? Number.parseInt(process.argv[samplesIndex + 1] as string, 10)
  : 30;
if (!Number.isInteger(sampleCount) || sampleCount < 10 || sampleCount > 200) {
  throw new Error("--samples must be an integer between 10 and 200.");
}

const root = await mkdtemp("/tmp/memstore-active-benchmark-");
const runtimeRoot = join(root, "runtime");
const vaultRoot = join(root, "vault");
const projectRoot = join(root, "project");
const projectId = "msproj_123e4567-e89b-42d3-a456-426614175601";
const hookEntrypointIndex = process.argv.indexOf("--hook-entrypoint");
const hookEntrypoint = resolve(
  hookEntrypointIndex >= 0 && process.argv[hookEntrypointIndex + 1] !== undefined
    ? process.argv[hookEntrypointIndex + 1] as string
    : join("dist", "cli", "hook.js")
);
const observedAttempts: unknown[] = [];

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function summarize(values: readonly number[]) {
  return {
    samples: values.length,
    p50Milliseconds: percentile(values, 0.50),
    p95Milliseconds: percentile(values, 0.95),
    p99Milliseconds: percentile(values, 0.99),
    maximumMilliseconds: Math.max(...values)
  };
}

async function invokeHook(event: "SessionStart" | "UserPromptSubmit", input: Record<string, unknown>) {
  const started = performance.now();
  const child = spawn(process.execPath, [hookEntrypoint, "codex", event], {
    cwd: resolve("."),
    env: {
      ...process.env,
      MEMSTORE_RUNTIME_ROOT: runtimeRoot,
      MEMSTORE_INJECTION_MODE: "active"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(input));
  const status = await new Promise<number | null>((resolveExit) => child.once("close", resolveExit));
  const latencyMilliseconds = performance.now() - started;
  if (status !== 0) throw new Error(`Active Hook failed: ${stderr}`);
  const output = JSON.parse(stdout) as {
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
  };
  if (output.hookSpecificOutput?.hookEventName !== event ||
      typeof output.hookSpecificOutput.additionalContext !== "string" ||
      output.hookSpecificOutput.additionalContext.length === 0) {
    throw new Error(
      `Active ${event} did not return additionalContext; output=${stdout.trim()}; ` +
      `lastAttempt=${JSON.stringify(observedAttempts.at(-1) ?? null)}.`
    );
  }
  return latencyMilliseconds;
}

const loaded = await loadConfiguredEmbeddingAdapter(configuredRuntime);
if (loaded === undefined) throw new Error("The configured embedding adapter is unavailable.");
try {
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, ".memstore-project"), `${JSON.stringify({
    schema_version: 1,
    project_id: projectId
  })}\n`);
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614175611",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614175621",
      scope: { kind: "project", projectId },
      body: "Use owner-only Unix sockets for foreground MemStore retrieval.",
      compact: "Use owner-only Unix sockets for foreground MemStore retrieval.",
      startup: "always"
    })
  });
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614175612",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614175622",
      scope: { kind: "project", projectId },
      body: "SQLite WAL integrity must be checked during durable queue recovery.",
      compact: "Check SQLite WAL integrity during durable queue recovery.",
      startup: "never"
    })
  });
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: loaded.adapter,
    builtAt: new Date().toISOString()
  });
  const server = await startForegroundRetrievalServer({
    runtimeRoot,
    vaultRoot,
    adapter: loaded.adapter,
    onAttempt: (attempt) => { observedAttempts.push(attempt); }
  });
  try {
    const sessionStart: number[] = [];
    const userPrompt: number[] = [];
    for (let ordinal = 0; ordinal < sampleCount; ordinal += 1) {
      const sessionId = `active-benchmark-${String(ordinal)}`;
      sessionStart.push(await invokeHook("SessionStart", {
        session_id: sessionId,
        cwd: projectRoot,
        source: "startup"
      }));
      userPrompt.push(await invokeHook("UserPromptSubmit", {
        session_id: sessionId,
        turn_id: `active-benchmark-turn-${String(ordinal)}`,
        cwd: projectRoot,
        prompt: "How should SQLite WAL integrity be checked during queue recovery?"
      }));
    }
    const metrics = {
      sessionStart: summarize(sessionStart),
      userPromptSubmit: summarize(userPrompt)
    };
    const passed = Object.values(metrics).every((metric) => metric.p95Milliseconds <= 300 &&
      metric.p99Milliseconds <= 1_000);
    const artifact = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      passed,
      targets: { p95Milliseconds: 300, hardDeadlineMilliseconds: 1_000 },
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        embeddingIdentity: loaded.adapter.identity
      },
      measurementsInclude: [
        "Hook process startup",
        "Project resolution and durable Capture",
        "Unix socket request and response",
        "resident E5 query embedding",
        "deterministic ranking and packing",
        "Receipt persistence",
        "official hook JSON serialization"
      ],
      metrics
    };
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ outputPath, passed, metrics }, null, 2)}\n`);
    process.exitCode = passed ? 0 : 1;
  } finally {
    await server.close();
  }
} finally {
  await loaded.dispose();
  await rm(root, { recursive: true, force: true });
}
