import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import {
  applyFriendlySetup,
  previewFriendlySetup
} from "../../src/integration/setup.js";
import { inspectDoctor } from "../../src/operations/maintenance.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memstore-friendly-setup-"));
  roots.push(root);
  const homeRoot = join(root, "home");
  const repositoryRoot = join(root, "repo");
  const vaultRoot = join(root, "vault");
  const notifierSource = join(
    repositoryRoot,
    "native",
    "memstore-notifier",
    ".build",
    "release",
    "MemStore Notifier.app"
  );
  const codexExecutable = join(root, "bin", "codex");
  await Promise.all([
    mkdir(join(homeRoot, ".codex"), { recursive: true }),
    mkdir(join(homeRoot, "Library", "Application Support", "obsidian"), { recursive: true }),
    mkdir(join(repositoryRoot, "dist", "cli"), { recursive: true }),
    mkdir(join(repositoryRoot, "dist", "mcp"), { recursive: true }),
    mkdir(join(repositoryRoot, "skills", "memstore-remember"), { recursive: true }),
    mkdir(join(repositoryRoot, "skills", "memstore-recall"), { recursive: true }),
    mkdir(join(repositoryRoot, "skills", "memstore-repair"), { recursive: true }),
    mkdir(join(notifierSource, "Contents", "MacOS"), { recursive: true }),
    mkdir(join(notifierSource, "Contents", "_CodeSignature"), { recursive: true }),
    mkdir(join(root, "bin"), { recursive: true }),
    mkdir(vaultRoot, { recursive: true })
  ]);
  await Promise.all([
    writeFile(
      join(homeRoot, ".codex", "config.toml"),
      "model = \"fixture\"\n\n[memories]\ngenerate_memories = true\nuse_memories = true\n"
    ),
    writeFile(
      join(homeRoot, "Library", "Application Support", "obsidian", "obsidian.json"),
      `${JSON.stringify({ vaults: { selected: { path: vaultRoot, open: true } } })}\n`
    ),
    writeFile(join(repositoryRoot, "dist", "cli", "main.js"), "process.exit(0);\n"),
    writeFile(join(repositoryRoot, "dist", "cli", "hook.js"), "process.exit(0);\n"),
    writeFile(join(repositoryRoot, "dist", "mcp", "main.js"), "process.exit(0);\n"),
    writeFile(join(notifierSource, "Contents", "MacOS", "memstore-notifier"), "fixture\n"),
    writeFile(join(notifierSource, "Contents", "Info.plist"), "fixture plist\n"),
    writeFile(join(notifierSource, "Contents", "_CodeSignature", "CodeResources"), "fixture signature\n"),
    writeFile(codexExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  ]);
  return { root, homeRoot, repositoryRoot, vaultRoot, notifierSource, codexExecutable };
}

test("friendly setup discovers the open Obsidian Vault and previews a zero-write active installation", async () => {
  const data = await fixture();
  const runtimeRoot = join(data.homeRoot, "Library", "Application Support", "MemStore");

  const preview = await previewFriendlySetup({
    homeRoot: data.homeRoot,
    repositoryRoot: data.repositoryRoot,
    codexExecutable: data.codexExecutable,
    nodeExecutable: process.execPath,
    mode: "active",
    preparedAt: "2026-09-02T06:00:00.000Z"
  });

  expect(preview).toMatchObject({
    schemaVersion: 1,
    state: "preview",
    dryRun: true,
    mode: "active",
    paths: {
      vaultRoot: data.vaultRoot,
      runtimeRoot,
      repositoryRoot: data.repositoryRoot
    },
    embedding: { state: "missing", action: "download_and_verify" },
    worker: { action: "bootstrap_and_verify" },
    integration: { targetCount: 14 }
  });
  expect(preview.integration.createsCodexHooks).toBe(true);
  await expect(access(join(data.homeRoot, ".codex", "hooks.json"))).rejects.toMatchObject({
    code: "ENOENT"
  });
  await expect(access(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

test("friendly setup applies the reviewed plan and reports an active ready Worker", async () => {
  const data = await fixture();
  const preview = await previewFriendlySetup({
    homeRoot: data.homeRoot,
    repositoryRoot: data.repositoryRoot,
    codexExecutable: data.codexExecutable,
    nodeExecutable: process.execPath,
    mode: "active",
    preparedAt: "2026-09-02T06:10:00.000Z"
  });
  const activatedPaths: string[] = [];
  const notificationPaths: string[] = [];

  const result = await applyFriendlySetup(preview, {
    prepareEmbedding: async (destination) => {
      await mkdir(destination, { recursive: true });
      return { state: "installed" as const };
    },
    activateLaunchAgent: (path) => {
      activatedPaths.push(path);
      return Promise.resolve("bootstrapped" as const);
    },
    waitForForeground: () => Promise.resolve(true),
    authorizeNotifications: (path) => {
      notificationPaths.push(path);
      return Promise.resolve("authorized" as const);
    }
  });

  expect(result).toMatchObject({
    schemaVersion: 1,
    state: "ready",
    mode: "active",
    embedding: { state: "installed" },
    worker: { state: "running", activation: "bootstrapped" },
    notifications: { state: "authorized" }
  });
  expect(activatedPaths).toEqual([
    join(data.homeRoot, "Library", "LaunchAgents", "com.leonyuanyaoyao.memstore.worker.plist")
  ]);
  expect(notificationPaths).toEqual([
    join(
      preview.paths.runtimeRoot,
      "bin",
      "MemStore Notifier.app",
      "Contents",
      "MacOS",
      "memstore-notifier"
    )
  ]);
  expect(await readFile(join(data.homeRoot, ".codex", "hooks.json"), "utf8"))
    .toContain("MEMSTORE_INJECTION_MODE=active");
  expect(await readFile(join(data.homeRoot, ".codex", "config.toml"), "utf8"))
    .toContain("use_memories = false");
});

test("the setup CLI defaults to a readable zero-write preview", async () => {
  const data = await fixture();

  const execution = await execFileAsync("pnpm", [
    "exec",
    "tsx",
    "src/cli/main.ts",
    "setup",
    "--home",
    data.homeRoot,
    "--repo",
    data.repositoryRoot,
    "--codex-executable",
    data.codexExecutable,
    "--json"
  ], { cwd: process.cwd(), encoding: "utf8" });
  const output = JSON.parse(execution.stdout) as {
    ok: boolean;
    command: string;
    result: { state: string; mode: string; paths: { vaultRoot: string } };
  };

  expect(output).toMatchObject({
    ok: true,
    command: "setup",
    result: {
      state: "preview",
      mode: "active",
      paths: { vaultRoot: data.vaultRoot }
    }
  });
  await expect(access(join(data.homeRoot, ".codex", "hooks.json"))).rejects.toMatchObject({
    code: "ENOENT"
  });
});

test("active setup rejects a missing Codex memory baseline before creating installation state", async () => {
  const data = await fixture();
  await writeFile(join(data.homeRoot, ".codex", "config.toml"), "model = \"fixture\"\n");

  await expect(previewFriendlySetup({
    homeRoot: data.homeRoot,
    repositoryRoot: data.repositoryRoot,
    codexExecutable: data.codexExecutable,
    nodeExecutable: process.execPath,
    mode: "active",
    preparedAt: "2026-09-02T06:20:00.000Z"
  })).rejects.toMatchObject({
    code: "setup_codex_memory_baseline_missing"
  });
  await expect(access(join(data.homeRoot, ".codex", "hooks.json"))).rejects.toMatchObject({
    code: "ENOENT"
  });
  await expect(access(join(data.homeRoot, "Library", "Application Support", "MemStore")))
    .rejects.toMatchObject({ code: "ENOENT" });
});

test("deep doctor reports a managed installation whose Worker socket is unavailable", async () => {
  const data = await fixture();
  const preview = await previewFriendlySetup({
    homeRoot: data.homeRoot,
    repositoryRoot: data.repositoryRoot,
    codexExecutable: data.codexExecutable,
    nodeExecutable: process.execPath,
    mode: "shadow",
    preparedAt: "2026-09-02T06:30:00.000Z"
  });
  await applyFriendlySetup(preview, {
    prepareEmbedding: async (destination) => {
      await mkdir(destination, { recursive: true });
      return { state: "installed" as const };
    },
    activateLaunchAgent: () => Promise.resolve("bootstrapped" as const),
    waitForForeground: () => Promise.resolve(true),
    authorizeNotifications: () => Promise.resolve("denied" as const)
  });

  const diagnosis = await inspectDoctor({
    runtimeRoot: preview.paths.runtimeRoot,
    vaultRoot: preview.paths.vaultRoot,
    deep: true
  });

  expect(diagnosis.state).toBe("degraded");
  expect(diagnosis.checks).toContainEqual({
    name: "managed_worker",
    state: "warning",
    detail: "Managed installation exists, but the foreground Worker socket is unavailable.",
    recoveryCondition: "The managed foreground Worker endpoint accepts local connections again."
  });
});

test("automatic Vault discovery refuses to guess when multiple Obsidian Vaults are equally eligible", async () => {
  const data = await fixture();
  const secondVault = join(data.root, "second-vault");
  await mkdir(secondVault);
  await writeFile(
    join(data.homeRoot, "Library", "Application Support", "obsidian", "obsidian.json"),
    `${JSON.stringify({
      vaults: {
        first: { path: data.vaultRoot },
        second: { path: secondVault }
      }
    })}\n`
  );

  await expect(previewFriendlySetup({
    homeRoot: data.homeRoot,
    repositoryRoot: data.repositoryRoot,
    codexExecutable: data.codexExecutable,
    nodeExecutable: process.execPath,
    mode: "shadow",
    preparedAt: "2026-09-02T06:40:00.000Z"
  })).rejects.toMatchObject({ code: "obsidian_vault_ambiguous" });
});

test("active setup preserves a Codex Hooks symlink while activating its real target", async () => {
  const data = await fixture();
  const hooksTarget = join(data.root, "codex-config", "hooks.json");
  await mkdir(join(data.root, "codex-config"));
  await writeFile(hooksTarget, `${JSON.stringify({ hooks: {} }, null, 2)}\n`);
  await symlink(hooksTarget, join(data.homeRoot, ".codex", "hooks.json"));
  const preview = await previewFriendlySetup({
    homeRoot: data.homeRoot,
    repositoryRoot: data.repositoryRoot,
    codexExecutable: data.codexExecutable,
    nodeExecutable: process.execPath,
    mode: "active",
    preparedAt: "2026-09-02T06:50:00.000Z"
  });

  await applyFriendlySetup(preview, {
    prepareEmbedding: async (destination) => {
      await mkdir(destination, { recursive: true });
      return { state: "installed" as const };
    },
    activateLaunchAgent: () => Promise.resolve("bootstrapped" as const),
    waitForForeground: () => Promise.resolve(true),
    authorizeNotifications: () => Promise.resolve("authorized" as const)
  });

  expect((await lstat(join(data.homeRoot, ".codex", "hooks.json"))).isSymbolicLink()).toBe(true);
  expect(await readFile(hooksTarget, "utf8")).toContain("MEMSTORE_INJECTION_MODE=active");
});

test("a Worker readiness failure stays in Shadow and the same setup command can resume", async () => {
  const data = await fixture();
  const preview = await previewFriendlySetup({
    homeRoot: data.homeRoot,
    repositoryRoot: data.repositoryRoot,
    codexExecutable: data.codexExecutable,
    nodeExecutable: process.execPath,
    mode: "active",
    preparedAt: "2026-09-02T07:00:00.000Z"
  });

  await expect(applyFriendlySetup(preview, {
    prepareEmbedding: async (destination) => {
      await mkdir(destination, { recursive: true });
      return { state: "installed" as const };
    },
    activateLaunchAgent: () => Promise.resolve("bootstrapped" as const),
    waitForForeground: () => Promise.resolve(false),
    authorizeNotifications: () => Promise.resolve("authorized" as const)
  })).rejects.toMatchObject({ code: "setup_worker_unavailable" });

  expect(await readFile(join(data.homeRoot, ".codex", "config.toml"), "utf8"))
    .toContain("use_memories = true");
  expect(await readFile(join(data.homeRoot, ".codex", "hooks.json"), "utf8"))
    .toContain("MEMSTORE_INJECTION_MODE=shadow");

  const resumedPreview = await previewFriendlySetup({
    homeRoot: data.homeRoot,
    repositoryRoot: data.repositoryRoot,
    codexExecutable: data.codexExecutable,
    nodeExecutable: process.execPath,
    mode: "active",
    preparedAt: "2026-09-02T07:05:00.000Z"
  });
  expect(resumedPreview.integration).toMatchObject({
    action: "resume_owned_installation",
    targetCount: 0
  });
  const resumed = await applyFriendlySetup(resumedPreview, {
    prepareEmbedding: () => Promise.resolve({ state: "verified" as const }),
    activateLaunchAgent: () => Promise.resolve("restarted" as const),
    waitForForeground: () => Promise.resolve(true),
    authorizeNotifications: () => Promise.resolve("authorized" as const)
  });

  expect(resumed).toMatchObject({
    state: "ready",
    mode: "active",
    integration: { state: "healthy" },
    worker: { state: "running", activation: "restarted" }
  });
  expect(await readFile(join(data.homeRoot, ".codex", "config.toml"), "utf8"))
    .toContain("use_memories = false");
});

test("an already active friendly installation can be previewed and applied again", async () => {
  const data = await fixture();
  const firstPreview = await previewFriendlySetup({
    homeRoot: data.homeRoot,
    repositoryRoot: data.repositoryRoot,
    codexExecutable: data.codexExecutable,
    nodeExecutable: process.execPath,
    mode: "active",
    preparedAt: "2026-09-02T07:10:00.000Z"
  });
  const adapters = {
    prepareEmbedding: async (destination: string) => {
      await mkdir(destination, { recursive: true });
      return { state: "installed" as const };
    },
    activateLaunchAgent: () => Promise.resolve("restarted" as const),
    waitForForeground: () => Promise.resolve(true),
    authorizeNotifications: () => Promise.resolve("authorized" as const)
  };
  const first = await applyFriendlySetup(firstPreview, adapters);

  const repeatedPreview = await previewFriendlySetup({
    homeRoot: data.homeRoot,
    repositoryRoot: data.repositoryRoot,
    codexExecutable: data.codexExecutable,
    nodeExecutable: process.execPath,
    mode: "active",
    preparedAt: "2026-09-02T07:15:00.000Z"
  });

  expect(repeatedPreview.integration.action).toBe("verify_active_installation");
  expect(repeatedPreview.cutover.action).toBe("keep_active");
  const repeated = await applyFriendlySetup(repeatedPreview, adapters);
  expect(repeated).toMatchObject({
    state: "ready",
    mode: "active",
    integration: { state: "healthy" },
    cutover: {
      state: "active",
      rollbackManifestPath: first.cutover.rollbackManifestPath
    }
  });
});

test("a semantically valid legacy Active installation can adopt its current safe baseline", async () => {
  const data = await fixture();
  const firstPreview = await previewFriendlySetup({
    homeRoot: data.homeRoot,
    repositoryRoot: data.repositoryRoot,
    codexExecutable: data.codexExecutable,
    nodeExecutable: process.execPath,
    mode: "active",
    preparedAt: "2026-09-02T07:20:00.000Z"
  });
  const adapters = {
    prepareEmbedding: async (destination: string) => {
      await mkdir(destination, { recursive: true });
      return { state: "installed" as const };
    },
    activateLaunchAgent: () => Promise.resolve("restarted" as const),
    waitForForeground: () => Promise.resolve(true),
    authorizeNotifications: () => Promise.resolve("authorized" as const)
  };
  await applyFriendlySetup(firstPreview, adapters);
  const configPath = join(data.homeRoot, ".codex", "config.toml");
  const evolvedConfig = `${await readFile(configPath, "utf8")}\n[unrelated]\npreserved = true\n`;
  await writeFile(configPath, evolvedConfig);

  const adoptionPreview = await previewFriendlySetup({
    homeRoot: data.homeRoot,
    repositoryRoot: data.repositoryRoot,
    codexExecutable: data.codexExecutable,
    nodeExecutable: process.execPath,
    mode: "active",
    preparedAt: "2026-09-02T07:25:00.000Z"
  });

  expect(adoptionPreview.integration.action).toBe("adopt_legacy_active_installation");
  const adopted = await applyFriendlySetup(adoptionPreview, adapters);
  expect(adopted).toMatchObject({
    state: "ready",
    mode: "active",
    integration: { state: "adopted" },
    cutover: { state: "active" }
  });
  expect(await readFile(configPath, "utf8")).toBe(evolvedConfig);

  const verifiedPreview = await previewFriendlySetup({
    homeRoot: data.homeRoot,
    repositoryRoot: data.repositoryRoot,
    codexExecutable: data.codexExecutable,
    nodeExecutable: process.execPath,
    mode: "active",
    preparedAt: "2026-09-02T07:30:00.000Z"
  });
  expect(verifiedPreview.integration.action).toBe("verify_active_installation");
});

test("legacy Active adoption rejects a modified managed Hook command", async () => {
  const data = await fixture();
  const preview = await previewFriendlySetup({
    homeRoot: data.homeRoot,
    repositoryRoot: data.repositoryRoot,
    codexExecutable: data.codexExecutable,
    nodeExecutable: process.execPath,
    mode: "active",
    preparedAt: "2026-09-02T07:35:00.000Z"
  });
  await applyFriendlySetup(preview, {
    prepareEmbedding: async (destination) => {
      await mkdir(destination, { recursive: true });
      return { state: "installed" as const };
    },
    activateLaunchAgent: () => Promise.resolve("restarted" as const),
    waitForForeground: () => Promise.resolve(true),
    authorizeNotifications: () => Promise.resolve("authorized" as const)
  });
  const hooksPath = join(data.homeRoot, ".codex", "hooks.json");
  const modifiedHooks = (await readFile(hooksPath, "utf8"))
    .replace(" codex Stop # memstore:", " codex Stop --unexpected # memstore:");
  await writeFile(hooksPath, modifiedHooks);

  await expect(previewFriendlySetup({
    homeRoot: data.homeRoot,
    repositoryRoot: data.repositoryRoot,
    codexExecutable: data.codexExecutable,
    nodeExecutable: process.execPath,
    mode: "active",
    preparedAt: "2026-09-02T07:40:00.000Z"
  })).rejects.toMatchObject({ code: "setup_existing_cutover_diverged" });
});
