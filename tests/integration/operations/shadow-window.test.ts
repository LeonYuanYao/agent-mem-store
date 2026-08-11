import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { handleCodexHook } from "../../../src/adapters/codex/hook.js";
import { initializeMemStore } from "../../../src/operations/initialize.js";
import {
  inspectOfficialShadowWindow,
  startOfficialShadowWindow
} from "../../../src/operations/shadow-window.js";
import type { EmbeddingAdapter } from "../../../src/retrieval/index.js";
import { approvedShadowEmbeddingProfile } from "../../../src/retrieval/shadow-profile.js";
import { runWorkerOnce } from "../../../src/worker/main.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const approvedEmbedding: EmbeddingAdapter = {
  identity: {
    adapterVersion: approvedShadowEmbeddingProfile.adapterVersion,
    modelIdentity: approvedShadowEmbeddingProfile.modelIdentity,
    artifactSha256: approvedShadowEmbeddingProfile.artifactSha256,
    dimensions: approvedShadowEmbeddingProfile.dimensions,
    normalization: approvedShadowEmbeddingProfile.normalization
  },
  embed: (texts) => Promise.resolve(texts.map(() => {
    const vector = Array.from({ length: approvedShadowEmbeddingProfile.dimensions }, () => 0);
    vector[0] = 1;
    return vector;
  }))
};

test("an official Shadow window requires a completed real-Hook probe and records a frozen baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-official-shadow-"));
  roots.push(root);
  const homeRoot = join(root, "home");
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const projectRoot = join(root, "project");
  const repositoryRoot = join(root, "repository");
  await Promise.all([
    mkdir(join(homeRoot, ".codex"), { recursive: true }),
    mkdir(join(runtimeRoot, "install"), { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
    mkdir(join(repositoryRoot, "config"), { recursive: true }),
    mkdir(join(repositoryRoot, "dist", "cli"), { recursive: true })
  ]);
  await writeFile(
    join(repositoryRoot, "config", "gate5-shadow-v1.json"),
    await readFile(join(process.cwd(), "config", "gate5-shadow-v1.json"), "utf8")
  );
  const programPath = join(repositoryRoot, "dist", "cli", "main.js");
  await writeFile(programPath, "export const fixture = true;\n");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  await writeFile(join(projectRoot, ".memstore-project"), JSON.stringify({
    schema_version: 1,
    project_id: "msproj_123e4567-e89b-42d3-a456-426614174970"
  }));
  await writeFile(join(homeRoot, ".codex", "config.toml"), [
    "[memories]",
    "generate_memories = true",
    "use_memories = true",
    ""
  ].join("\n"));
  await writeFile(join(homeRoot, ".codex", "hooks.json"), JSON.stringify({
    hooks: Object.fromEntries(
      ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"].map((event) => [
        event,
        [{ hooks: [{ command: `memstore:gate5-shadow-v1:${event}:shadow` }] }]
      ])
    )
  }));
  await writeFile(join(runtimeRoot, "install", "ownership-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    installationId: "msinstall_shadow_fixture",
    candidateId: "gate5-shadow-v1",
    state: "installed"
  }));

  const captured = await handleCodexHook({
    runtimeRoot,
    receivedAt: "2026-08-09T03:00:00.000Z",
    input: {
      hook_event_name: "UserPromptSubmit",
      session_id: "official-shadow-session",
      turn_id: "official-shadow-turn",
      cwd: projectRoot,
      prompt: "Verify the official Shadow baseline."
    }
  });
  if (!captured.captured) throw new Error("Expected the trusted Hook probe to be captured.");
  await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "official-shadow-worker",
    now: "2026-08-09T03:00:01.000Z",
    workerStartedAt: "2026-08-09T03:00:01.000Z",
    adapters: { embedding: approvedEmbedding }
  });

  const request = {
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    probeEventId: captured.eventId,
    startedAt: "2026-08-09T03:00:02.000Z"
  };
  await expect(startOfficialShadowWindow({ ...request, preview: true })).resolves.toMatchObject({
    state: "preview",
    dryRun: true,
    minimumEndAt: "2026-08-16T03:00:02.000Z"
  });
  await expect(startOfficialShadowWindow(request)).resolves.toMatchObject({
    state: "active",
    dryRun: false,
    minimumEndAt: "2026-08-16T03:00:02.000Z"
  });
  await expect(startOfficialShadowWindow({
    ...request,
    startedAt: "2026-08-09T03:00:03.000Z"
  })).rejects.toThrow("An official Shadow window is already active.");
  await expect(inspectOfficialShadowWindow({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    now: "2026-08-16T03:00:02.000Z"
  })).resolves.toMatchObject({
    state: "active",
    elapsedCalendarDays: 7,
    minimumDurationMet: true,
    gate6ReviewEligible: true,
    coverage: {
      completed_evaluations: { baseline: 1, current: 1, delta: 0 }
    }
  });
  await writeFile(programPath, "export const fixture = false;\n");
  await expect(inspectOfficialShadowWindow({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    now: "2026-08-16T03:00:02.500Z"
  })).resolves.toMatchObject({
    state: "invalidated",
    gate6ReviewEligible: false,
    invalidationReasons: ["program_changed"]
  });
  await writeFile(programPath, "export const fixture = true;\n");
  await writeFile(join(homeRoot, ".codex", "config.toml"), [
    "[memories]",
    "generate_memories = true",
    "use_memories = true",
    "# user changed another Codex setting during Shadow",
    ""
  ].join("\n"));
  await expect(inspectOfficialShadowWindow({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    now: "2026-08-16T03:00:03.000Z"
  })).resolves.toMatchObject({
    state: "invalidated",
    gate6ReviewEligible: false,
    invalidationReasons: ["codex_config_changed"]
  });
  await expect(startOfficialShadowWindow({
    ...request,
    startedAt: "2026-08-16T03:00:04.000Z"
  })).resolves.toMatchObject({
    state: "active",
    dryRun: false,
    minimumEndAt: "2026-08-23T03:00:04.000Z"
  });
  await expect(inspectOfficialShadowWindow({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    now: "2026-08-16T03:00:05.000Z"
  })).resolves.toMatchObject({
    state: "active",
    invalidationReasons: [],
    gate6ReviewEligible: false
  });
});
