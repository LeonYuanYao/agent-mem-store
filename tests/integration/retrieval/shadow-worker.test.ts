import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { handleCodexHook } from "../../../src/adapters/codex/hook.js";
import type { EmbeddingAdapter } from "../../../src/retrieval/index.js";
import { inspectShadowEvaluation } from "../../../src/retrieval/shadow-worker.js";
import { runWorkerOnce } from "../../../src/worker/main.js";

const roots: string[] = [];
const projectId = "msproj_123e4567-e89b-42d3-a456-426614174950";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const embedding: EmbeddingAdapter = {
  identity: {
    adapterVersion: "shadow-worker-fixture-v1",
    modelIdentity: "shadow-worker-fixture",
    artifactSha256: "e".repeat(64),
    dimensions: 2,
    normalization: "l2"
  },
  embed: (texts) => Promise.resolve(texts.map(() => [1, 0]))
};

test("the Worker builds the index and evaluates official Codex Shadow events asynchronously", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-shadow-worker-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, ".memstore-project"), JSON.stringify({
    schema_version: 1,
    project_id: projectId
  }));

  const start = await handleCodexHook({
    runtimeRoot,
    receivedAt: "2026-08-09T02:00:00.000Z",
    input: {
      hook_event_name: "SessionStart",
      session_id: "shadow-worker-session",
      transcript_path: null,
      cwd: projectRoot,
      model: "gpt-5.6",
      source: "startup"
    }
  });
  const prompt = await handleCodexHook({
    runtimeRoot,
    receivedAt: "2026-08-09T02:00:01.000Z",
    input: {
      hook_event_name: "UserPromptSubmit",
      session_id: "shadow-worker-session",
      turn_id: "shadow-worker-turn",
      transcript_path: null,
      cwd: projectRoot,
      model: "gpt-5.6",
      prompt: "How should durable memory be retrieved?"
    }
  });
  if (!start.captured || !prompt.captured) throw new Error("Expected both Hook events to be captured.");

  await expect(runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "shadow-worker",
    now: "2026-08-09T02:01:00.000Z",
    workerStartedAt: "2026-08-09T02:01:00.000Z",
    adapters: { embedding }
  })).resolves.toMatchObject({
    state: "worked",
    activities: ["capture-inbox:imported:2", "retrieval-index:published", "shadow:completed"]
  });
  await expect(inspectShadowEvaluation(runtimeRoot, start.eventId)).resolves.toMatchObject({
    state: "completed",
    attemptCount: 1
  });

  await expect(runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "shadow-worker",
    now: "2026-08-09T02:01:01.000Z",
    workerStartedAt: "2026-08-09T02:01:00.000Z",
    adapters: { embedding }
  })).resolves.toMatchObject({
    state: "worked",
    activities: ["shadow:completed"]
  });
  await expect(inspectShadowEvaluation(runtimeRoot, prompt.eventId)).resolves.toMatchObject({
    state: "completed",
    attemptCount: 1
  });

  await expect(runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "shadow-worker",
    now: "2026-08-09T02:01:02.000Z",
    workerStartedAt: "2026-08-09T02:01:00.000Z",
    adapters: { embedding }
  })).resolves.toEqual({ state: "idle" });
});
