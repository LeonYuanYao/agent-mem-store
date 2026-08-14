import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { handleCodexHook } from "../../../src/adapters/codex/hook.js";
import { initializeMemStore } from "../../../src/operations/initialize.js";
import {
  inspectOfficialShadowWindow,
  migrateOfficialShadowIdentity,
  startOfficialShadowWindow
} from "../../../src/operations/shadow-window.js";
import {
  buildRetrievalIndex,
  type EmbeddingAdapter
} from "../../../src/retrieval/index.js";
import { approvedShadowEmbeddingProfile } from "../../../src/retrieval/shadow-profile.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { runWorkerOnce } from "../../../src/worker/main.js";

const roots: string[] = [];

function identitySha256(value: unknown): string {
  function canonicalize(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([left], [right]) => left.localeCompare(right, "en-US"))
          .map(([key, child]) => [key, canonicalize(child)])
      );
    }
    return input;
  }
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

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
    "model = \"fixture\"",
    "",
    "[memories]",
    "generate_memories = true",
    "use_memories = true",
    "",
    "[mcp_servers.memstore]",
    "command = \"node\"",
    "args = [\"dist/mcp/main.js\"]",
    "startup_timeout_sec = 30",
    "",
    "[mcp_servers.memstore.env]",
    "MEMSTORE_RUNTIME_ROOT = \"/fixture/runtime\"",
    "MEMSTORE_VAULT_ROOT = \"/fixture/vault\"",
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
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: approvedEmbedding,
    builtAt: "2026-08-09T03:00:04.000Z"
  });
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

  const legacyDatabase = await openRuntimeDatabase(runtimeRoot);
  let legacyWindowId: string;
  let legacyBaselineSha256: string;
  try {
    const row = legacyDatabase.prepare(
      "SELECT window_id, baseline_json FROM official_shadow_windows WHERE state = 'active'"
    ).get();
    legacyWindowId = String(row?.window_id);
    const baseline = JSON.parse(String(row?.baseline_json)) as Record<string, unknown>;
    const legacyBaseline = {
      ...baseline,
      identityScope: "memstore-v1",
      configSha256: identitySha256({
        nativeMemory: { generateMemories: true, useMemories: true },
        memstoreMcp: {
          command: "node",
          args: ["dist/mcp/main.js"],
          startup_timeout_sec: 30,
          env: {
            MEMSTORE_RUNTIME_ROOT: "/fixture/runtime",
            MEMSTORE_VAULT_ROOT: "/fixture/vault"
          }
        },
        managedHookStates: {}
      }),
      nativeMemory: { generateMemories: true, useMemories: true }
    };
    const legacySource = JSON.stringify(legacyBaseline);
    legacyBaselineSha256 = createHash("sha256").update(legacySource).digest("hex");
    legacyDatabase.prepare(
      "UPDATE official_shadow_windows SET baseline_json = ?, baseline_sha256 = ? WHERE window_id = ?"
    ).run(legacySource, legacyBaselineSha256, legacyWindowId);
  } finally {
    legacyDatabase.close();
  }
  await writeFile(join(homeRoot, ".codex", "config.toml"), [
    "model = \"fixture\"",
    "",
    "[memories]",
    "generate_memories = false",
    "use_memories = false",
    "",
    "[mcp_servers.memstore]",
    "command = \"node\"",
    "args = [\"dist/mcp/main.js\"]",
    "startup_timeout_sec = 30",
    "",
    "[mcp_servers.memstore.env]",
    "MEMSTORE_RUNTIME_ROOT = \"/fixture/runtime\"",
    "MEMSTORE_VAULT_ROOT = \"/fixture/vault\"",
    ""
  ].join("\n"));
  await expect(migrateOfficialShadowIdentity({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    windowId: legacyWindowId,
    migratedAt: "2026-08-16T03:00:02.050Z",
    preview: true
  })).resolves.toMatchObject({
    state: "preview",
    dryRun: true,
    windowId: legacyWindowId,
    previousBaselineSha256: legacyBaselineSha256,
    identityScope: "memstore-v2-native-memory-independent"
  });
  const afterPreview = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(afterPreview.prepare(
      "SELECT baseline_sha256 FROM official_shadow_windows WHERE window_id = ?"
    ).get(legacyWindowId)?.baseline_sha256).toBe(legacyBaselineSha256);
  } finally {
    afterPreview.close();
  }
  await expect(migrateOfficialShadowIdentity({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    windowId: legacyWindowId,
    migratedAt: "2026-08-16T03:00:02.060Z"
  })).resolves.toMatchObject({
    state: "migrated",
    dryRun: false,
    windowId: legacyWindowId,
    identityScope: "memstore-v2-native-memory-independent"
  });
  await expect(inspectOfficialShadowWindow({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    now: "2026-08-16T03:00:02.070Z"
  })).resolves.toMatchObject({
    windowId: legacyWindowId,
    state: "active",
    invalidationReasons: [],
    startedAt: "2026-08-09T03:00:02.000Z",
    minimumEndAt: "2026-08-16T03:00:02.000Z",
    nativeMemory: { generateMemories: false, useMemories: false },
    continuityAdjustments: [{
      kind: "exclude_native_memory_from_shadow_identity",
      migratedAt: "2026-08-16T03:00:02.060Z",
      previousBaselineSha256: legacyBaselineSha256
    }],
    coverage: {
      completed_evaluations: { baseline: 1, current: 1, delta: 0 }
    }
  });
  const changedAdapter: EmbeddingAdapter = {
    ...approvedEmbedding,
    identity: {
      ...approvedEmbedding.identity,
      adapterVersion: "transformers-changed-for-test"
    }
  };
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: changedAdapter,
    builtAt: "2026-08-16T03:00:02.100Z"
  });
  await expect(inspectOfficialShadowWindow({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    now: "2026-08-16T03:00:02.200Z"
  })).resolves.toMatchObject({
    state: "invalidated",
    gate6ReviewEligible: false,
    invalidationReasons: ["retrieval_index_changed"]
  });
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: approvedEmbedding,
    builtAt: "2026-08-16T03:00:02.300Z"
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
    "model = \"unrelated-change\"",
    "",
    "[memories]",
    "generate_memories = true",
    "use_memories = true",
    "",
    "[mcp_servers.memstore]",
    "command = \"node\"",
    "args = [\"dist/mcp/main.js\"]",
    "startup_timeout_sec = 30",
    "",
    "[mcp_servers.memstore.env]",
    "MEMSTORE_RUNTIME_ROOT = \"/fixture/runtime\"",
    "MEMSTORE_VAULT_ROOT = \"/fixture/vault\"",
    ""
  ].join("\n"));
  await expect(inspectOfficialShadowWindow({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    now: "2026-08-16T03:00:03.000Z"
  })).resolves.toMatchObject({
    state: "active",
    gate6ReviewEligible: true,
    invalidationReasons: []
  });

  const hooksPath = join(homeRoot, ".codex", "hooks.json");
  const hooksWithUnrelatedChange = JSON.parse(await readFile(hooksPath, "utf8")) as {
    hooks: Record<string, unknown[]>;
  };
  hooksWithUnrelatedChange.hooks.PostToolUse?.unshift({
    matcher: "unrelated",
    hooks: [{ command: "unrelated-hook", timeout: 99 }]
  });
  await writeFile(hooksPath, JSON.stringify(hooksWithUnrelatedChange));
  await expect(inspectOfficialShadowWindow({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    now: "2026-08-16T03:00:03.100Z"
  })).resolves.toMatchObject({
    state: "active",
    invalidationReasons: []
  });

  await writeFile(join(homeRoot, ".codex", "config.toml"), [
    "model = \"unrelated-change\"",
    "",
    "[memories]",
    "generate_memories = true",
    "use_memories = true",
    "",
    "[mcp_servers.memstore]",
    "command = \"node\"",
    "args = [\"dist/mcp/main.js\"]",
    "startup_timeout_sec = 31",
    "",
    "[mcp_servers.memstore.env]",
    "MEMSTORE_RUNTIME_ROOT = \"/fixture/runtime\"",
    "MEMSTORE_VAULT_ROOT = \"/fixture/vault\"",
    ""
  ].join("\n"));
  await expect(inspectOfficialShadowWindow({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    now: "2026-08-16T03:00:03.200Z"
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
  const continuityDatabase = await openRuntimeDatabase(runtimeRoot);
  try {
    continuityDatabase.prepare(
      `UPDATE official_shadow_windows
       SET started_at = '2026-08-08T03:00:02.000Z'
       WHERE state = 'active'`
    ).run();
  } finally {
    continuityDatabase.close();
  }
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

  const currentConfig = await readFile(join(homeRoot, ".codex", "config.toml"), "utf8");
  await writeFile(join(homeRoot, ".codex", "config.toml"), [
    currentConfig.trimEnd(),
    "",
    `[hooks.state."${hooksPath}:post_tool_use:1:0"]`,
    "enabled = false",
    ""
  ].join("\n"));
  await expect(inspectOfficialShadowWindow({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    now: "2026-08-16T03:00:06.000Z"
  })).resolves.toMatchObject({
    state: "invalidated",
    gate6ReviewEligible: false,
    invalidationReasons: ["codex_config_changed"]
  });

  await writeFile(join(homeRoot, ".codex", "config.toml"), currentConfig);
  const hooksWithManagedChange = JSON.parse(await readFile(hooksPath, "utf8")) as {
    hooks: Record<string, Array<{ hooks?: Array<Record<string, unknown>> }>>;
  };
  const managedPostToolUse = hooksWithManagedChange.hooks.PostToolUse
    ?.flatMap((route) => route.hooks ?? [])
    .find((hook) =>
      typeof hook.command === "string" &&
      hook.command.includes("memstore:gate5-shadow-v1:PostToolUse:shadow")
    );
  if (managedPostToolUse === undefined) throw new Error("Expected managed PostToolUse Hook.");
  managedPostToolUse.timeout = 2;
  await writeFile(hooksPath, JSON.stringify(hooksWithManagedChange));
  await expect(inspectOfficialShadowWindow({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    now: "2026-08-16T03:00:07.000Z"
  })).resolves.toMatchObject({
    state: "invalidated",
    gate6ReviewEligible: false,
    invalidationReasons: ["hooks_changed"]
  });
});
