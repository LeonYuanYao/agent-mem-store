import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  applyNativeMemoryCutover,
  previewNativeMemoryCutover,
  rehearseNativeMemoryCutover,
  rollbackNativeMemoryCutover
} from "../../../src/integration/managed.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const events = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"] as const;

function hookSource(): string {
  return `${JSON.stringify({
    hooks: Object.fromEntries(events.map((event) => [event, [
      { matcher: "keep", hooks: [{ type: "command", command: `keep-${event}` }] },
      {
        matcher: "*",
        hooks: [{
          type: "command",
          command: `MEMSTORE_INJECTION_MODE=shadow memstore hook # memstore:gate5-shadow-v1:${event}:shadow`,
          timeout: 1
        }]
      }
    ]]))
  }, null, 2)}\n`;
}

test("cutover and rollback rehearsal restores configuration without reading or changing native data", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cutover-"));
  roots.push(root);
  const configPath = join(root, "config.toml");
  const hooksPath = join(root, "hooks.json");
  const nativeStorePath = join(root, "native-memories", "opaque.bin");
  await mkdir(join(root, "native-memories"));
  const originalConfig = "[memories]\ngenerate_memories = true\nuse_memories = true\ndisable_on_external_context = false\n\n[mcp_servers.keep]\ncommand = \"keep\"\n";
  const originalHooks = hookSource();
  await writeFile(configPath, originalConfig);
  await writeFile(hooksPath, originalHooks);
  await writeFile(nativeStorePath, "opaque native body must not be inventoried or read");

  const result = await rehearseNativeMemoryCutover({
    configPath,
    hooksPath,
    nativeStorePaths: [join(root, "native-memories")],
    rehearsedAt: "2026-08-08T13:00:00.000Z"
  });

  expect(result).toMatchObject({
    cutover: { generateMemories: false, useMemories: false, injectionMode: "active" },
    rollback: { restored: true },
    nativeData: { operation: "none", bodiesRead: 0 }
  });
  expect(await readFile(configPath, "utf8")).toBe(originalConfig);
  expect(await readFile(hooksPath, "utf8")).toBe(originalHooks);
  expect(await readFile(nativeStorePath, "utf8")).toBe("opaque native body must not be inventoried or read");
});

test("cutover preview is read-only, inventory-only, and changes only owned hook fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cutover-preview-"));
  roots.push(root);
  const configPath = join(root, "config.toml");
  const hooksPath = join(root, "hooks.json");
  const nativeStorePath = join(root, "native-memories");
  const originalConfig = "[memories]\ngenerate_memories = false\nuse_memories = false\n\n[mcp_servers.keep]\ncommand = \"keep\"\n";
  const originalHooks = hookSource();
  await mkdir(nativeStorePath);
  await writeFile(join(nativeStorePath, "opaque.bin"), "body must remain unread and unchanged");
  await writeFile(configPath, originalConfig);
  await writeFile(hooksPath, originalHooks);

  const preview = await previewNativeMemoryCutover({
    configPath,
    hooksPath,
    nativeStorePaths: [nativeStorePath],
    preparedAt: "2026-08-25T21:00:00.000Z"
  });

  expect(preview).toMatchObject({
    state: "cutover_preview",
    dryRun: true,
    target: {
      nativeMemory: { generateMemories: false, useMemories: false },
      hookChanges: [
        {
          event: "SessionStart",
          hostTimeoutSeconds: { before: 1, after: 2 },
          additionalContextLimit: { before: null, after: 1200 }
        },
        {
          event: "UserPromptSubmit",
          hostTimeoutSeconds: { before: 1, after: 2 },
          additionalContextLimit: { before: null, after: 1024 }
        },
        { event: "PostToolUse", additionalContextLimit: { before: null, after: null } },
        { event: "Stop", additionalContextLimit: { before: null, after: null } },
        { event: "SessionEnd", additionalContextLimit: { before: null, after: null } }
      ]
    },
    nativeData: {
      operation: "none",
      bodiesRead: 0,
      locations: [{ state: "directory", fileCount: 1, directoryCount: 1 }]
    }
  });
  expect(preview.source.configSha256).toBe(preview.target.configSha256);
  expect(preview.source.hooksSha256).not.toBe(preview.target.hooksSha256);
  expect(await readFile(configPath, "utf8")).toBe(originalConfig);
  expect(await readFile(hooksPath, "utf8")).toBe(originalHooks);
  expect(await readFile(join(nativeStorePath, "opaque.bin"), "utf8")).toBe("body must remain unread and unchanged");
});

test("approved cutover writes exact reviewed targets and restores exact bytes through its manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-approved-cutover-"));
  roots.push(root);
  const configPath = join(root, "config.toml");
  const hooksPath = join(root, "hooks.json");
  const runtimeRoot = join(root, "runtime");
  const originalConfig = "[memories]\ngenerate_memories = true\nuse_memories = true\n\n[mcp_servers.keep]\ncommand = \"keep\"\n";
  const originalHooks = hookSource();
  await writeFile(configPath, originalConfig);
  await writeFile(hooksPath, originalHooks);
  const preview = await previewNativeMemoryCutover({
    configPath,
    hooksPath,
    nativeStorePaths: [],
    preparedAt: "2026-08-25T21:00:00.000Z"
  });

  const applied = await applyNativeMemoryCutover({
    runtimeRoot,
    preview,
    approvalDigest: preview.approvalDigest,
    appliedAt: "2026-08-25T21:01:00.000Z"
  });

  expect(applied.state).toBe("active");
  expect(await readFile(configPath, "utf8")).toContain("generate_memories = false\nuse_memories = false");
  const activeHooks = JSON.parse(await readFile(hooksPath, "utf8")) as {
    hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
  };
  for (const event of events) {
    const handlers = activeHooks.hooks[event]?.flatMap((route) => route.hooks) ?? [];
    const owned = handlers.find((handler) => String(handler.command).includes(`memstore:gate5-shadow-v1:${event}:active`));
    expect(owned).toBeDefined();
    expect(handlers.some((handler) => handler.command === `keep-${event}`)).toBe(true);
    if (event === "SessionStart") {
      expect(owned?.additionalContextLimit).toBe(1200);
      expect(owned?.timeout).toBe(2);
    } else if (event === "UserPromptSubmit") {
      expect(owned?.additionalContextLimit).toBe(1024);
      expect(owned?.timeout).toBe(2);
    }
    else expect(owned).not.toHaveProperty("additionalContextLimit");
  }

  await rollbackNativeMemoryCutover({
    manifestPath: applied.manifestPath,
    rolledBackAt: "2026-08-25T21:02:00.000Z"
  });
  expect(await readFile(configPath, "utf8")).toBe(originalConfig);
  expect(await readFile(hooksPath, "utf8")).toBe(originalHooks);
  expect(JSON.parse(await readFile(applied.manifestPath, "utf8"))).toMatchObject({ state: "rolled_back" });
});

test("rollback preserves Codex Hook trust updates while restoring Memory settings and Hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cutover-trust-rollback-"));
  roots.push(root);
  const configPath = join(root, "config.toml");
  const hooksPath = join(root, "hooks.json");
  const runtimeRoot = join(root, "runtime");
  const originalConfig = [
    "[memories]",
    "generate_memories = true",
    "use_memories = true",
    "",
    "[hooks.state.\"managed-hook\"]",
    "trusted_hash = \"sha256:shadow\"",
    ""
  ].join("\n");
  const originalHooks = hookSource();
  await writeFile(configPath, originalConfig);
  await writeFile(hooksPath, originalHooks);
  const preview = await previewNativeMemoryCutover({
    configPath,
    hooksPath,
    nativeStorePaths: [],
    preparedAt: "2026-08-26T01:00:00.000Z"
  });
  const applied = await applyNativeMemoryCutover({
    runtimeRoot,
    preview,
    approvalDigest: preview.approvalDigest,
    appliedAt: "2026-08-26T01:01:00.000Z"
  });
  const trustedActiveConfig = (await readFile(configPath, "utf8"))
    .replace("trusted_hash = \"sha256:shadow\"", "trusted_hash = \"sha256:active\"");
  await writeFile(configPath, trustedActiveConfig);

  await rollbackNativeMemoryCutover({
    manifestPath: applied.manifestPath,
    rolledBackAt: "2026-08-26T01:02:00.000Z"
  });

  const rolledBackConfig = await readFile(configPath, "utf8");
  expect(rolledBackConfig).toContain("generate_memories = true\nuse_memories = true");
  expect(rolledBackConfig).toContain("trusted_hash = \"sha256:active\"");
  expect(await readFile(hooksPath, "utf8")).toBe(originalHooks);
});

test("rollback still rejects configuration drift outside Codex Hook trust state", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cutover-config-drift-"));
  roots.push(root);
  const configPath = join(root, "config.toml");
  const hooksPath = join(root, "hooks.json");
  const runtimeRoot = join(root, "runtime");
  await writeFile(configPath, "model = \"before\"\n\n[memories]\ngenerate_memories = true\nuse_memories = true\n");
  await writeFile(hooksPath, hookSource());
  const preview = await previewNativeMemoryCutover({
    configPath,
    hooksPath,
    nativeStorePaths: [],
    preparedAt: "2026-08-26T02:00:00.000Z"
  });
  const applied = await applyNativeMemoryCutover({
    runtimeRoot,
    preview,
    approvalDigest: preview.approvalDigest,
    appliedAt: "2026-08-26T02:01:00.000Z"
  });
  await writeFile(configPath, (await readFile(configPath, "utf8")).replace("model = \"before\"", "model = \"changed\""));

  await expect(rollbackNativeMemoryCutover({
    manifestPath: applied.manifestPath,
    rolledBackAt: "2026-08-26T02:02:00.000Z"
  })).rejects.toThrow("diverged beyond Hook trust state");
});

test("rollback rejects non-hash changes inside Codex Hook state", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cutover-hook-state-drift-"));
  roots.push(root);
  const configPath = join(root, "config.toml");
  const hooksPath = join(root, "hooks.json");
  const runtimeRoot = join(root, "runtime");
  await writeFile(configPath, [
    "[memories]",
    "generate_memories = true",
    "use_memories = true",
    "",
    "[hooks.state.\"managed-hook\"]",
    "trusted_hash = \"sha256:shadow\"",
    "enabled = true",
    ""
  ].join("\n"));
  await writeFile(hooksPath, hookSource());
  const preview = await previewNativeMemoryCutover({
    configPath,
    hooksPath,
    nativeStorePaths: [],
    preparedAt: "2026-08-26T03:00:00.000Z"
  });
  const applied = await applyNativeMemoryCutover({
    runtimeRoot,
    preview,
    approvalDigest: preview.approvalDigest,
    appliedAt: "2026-08-26T03:01:00.000Z"
  });
  await writeFile(configPath, (await readFile(configPath, "utf8")).replace("enabled = true", "enabled = false"));

  await expect(rollbackNativeMemoryCutover({
    manifestPath: applied.manifestPath,
    rolledBackAt: "2026-08-26T03:02:00.000Z"
  })).rejects.toThrow("diverged beyond Hook trust state");
});
