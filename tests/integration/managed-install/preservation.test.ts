import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import {
  applyManagedIntegration,
  applyManagedIntegrationUpgrade,
  previewManagedIntegration,
  previewManagedIntegrationUpgrade,
  repairManagedIntegration,
  uninstallManagedIntegration
} from "../../../src/integration/managed.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memstore-managed-"));
  roots.push(root);
  const homeRoot = join(root, "home");
  const repositoryRoot = join(root, "repo");
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(homeRoot, "Library", "Application Support", "MemStore");
  await mkdir(join(homeRoot, ".codex"), { recursive: true });
  await mkdir(join(repositoryRoot, "dist", "cli"), { recursive: true });
  await mkdir(join(repositoryRoot, "dist", "mcp"), { recursive: true });
  await mkdir(join(repositoryRoot, "skills", "memstore-remember"), { recursive: true });
  await mkdir(join(repositoryRoot, "skills", "memstore-recall"), { recursive: true });
  await mkdir(join(repositoryRoot, "skills", "memstore-repair"), { recursive: true });
  await writeFile(
    join(repositoryRoot, "dist", "cli", "main.js"),
    "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n"
  );
  const notifierSource = join(root, "artifacts", "MemStore Notifier.app");
  await mkdir(join(notifierSource, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(notifierSource, "Contents", "_CodeSignature"), { recursive: true });
  await writeFile(join(notifierSource, "Contents", "MacOS", "memstore-notifier"), "fixture notifier\n", { mode: 0o755 });
  await writeFile(join(notifierSource, "Contents", "Info.plist"), "fixture plist\n");
  await writeFile(join(notifierSource, "Contents", "_CodeSignature", "CodeResources"), "fixture signature\n");
  const configPath = join(homeRoot, ".codex", "config.toml");
  const hooksPath = join(homeRoot, ".codex", "hooks.json");
  const hooksTargetPath = join(root, "codex-config", "hooks.json");
  const configSource = `model = "fixture"\n\n[plugins.keep]\nenabled = true\n\n[memories]\ngenerate_memories = true\nuse_memories = true\ndisable_on_external_context = false\n\n[mcp_servers.keep]\ncommand = "keep"\n`;
  const hooks = {
    future_top_level: { keep: true },
    hooks: {
      PreToolUse: [{ matcher: "*", future_group_field: 7, hooks: [{ type: "command", command: "keep pre", future_hook_field: true }] }],
      SessionStart: [{ matcher: "keep", hooks: [{ type: "command", command: "keep start" }] }],
      FutureEvent: [{ matcher: "*", hooks: [{ type: "command", command: "keep future" }] }]
    }
  };
  await writeFile(configPath, configSource);
  await mkdir(join(root, "codex-config"), { recursive: true });
  await writeFile(hooksTargetPath, `${JSON.stringify(hooks, null, 2)}\n`);
  await symlink(hooksTargetPath, hooksPath);
  return {
    homeRoot,
    repositoryRoot,
    vaultRoot,
    runtimeRoot,
    notifierSource,
    nodeExecutable: process.execPath,
    configPath,
    hooksPath,
    hooksTargetPath,
    configSource,
    hooks
  };
}

test("preview is mutation-free and install, repair, and uninstall preserve unrelated state", async () => {
  const data = await fixture();
  const beforeConfig = await readFile(data.configPath, "utf8");
  const beforeHooks = await readFile(data.hooksPath, "utf8");
  const request = {
    ...data,
    lunaCodexHome: join(data.homeRoot, ".codex"),
    codexExecutable: "/opt/homebrew/bin/codex",
    embeddingModelDirectory: join(data.runtimeRoot, "models", "e5-base-q8"),
    installedAt: "2026-08-08T12:00:00.000Z"
  };
  const preview = await previewManagedIntegration(request);

  expect(preview).toMatchObject({ state: "preview", dryRun: true, candidateId: "gate5-shadow-v1" });
  expect(await readFile(data.configPath, "utf8")).toBe(beforeConfig);
  expect(await readFile(data.hooksPath, "utf8")).toBe(beforeHooks);
  await expect(lstat(join(data.runtimeRoot, "install"))).rejects.toMatchObject({ code: "ENOENT" });

  const installed = await applyManagedIntegration(request, preview);
  expect(installed.state).toBe("installed");
  const installedConfig = await readFile(data.configPath, "utf8");
  expect(installedConfig).toContain("[plugins.keep]");
  expect(installedConfig).toContain("[mcp_servers.keep]");
  expect(installedConfig).toContain("[mcp_servers.memstore]");
  expect(installedConfig).toContain("generate_memories = true");
  const installedHooks = JSON.parse(await readFile(data.hooksPath, "utf8")) as typeof data.hooks;
  expect((await lstat(data.hooksPath)).isSymbolicLink()).toBe(true);
  expect(await readlink(data.hooksPath)).toBe(data.hooksTargetPath);
  expect(installedHooks.future_top_level).toEqual({ keep: true });
  expect(installedHooks.hooks.PreToolUse).toEqual(data.hooks.hooks.PreToolUse);
  expect(installedHooks.hooks.FutureEvent).toEqual(data.hooks.hooks.FutureEvent);
  expect(installedHooks.hooks.SessionStart).toHaveLength(2);
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]) {
    expect(installedHooks.hooks[event as keyof typeof installedHooks.hooks]).toHaveLength(
      event === "SessionStart" ? 2 : 1
    );
  }
  const installedHooksSource = await readFile(data.hooksPath, "utf8");
  expect(installedHooksSource.match(/dist\/cli\/hook\.js/gu)).toHaveLength(5);
  expect(installedHooksSource).not.toContain("dist/cli/main.js' hook codex");
  expect(installedHooks.hooks).not.toHaveProperty("PreToolUse.1");
  expect(await readlink(join(data.homeRoot, ".agents", "skills", "memstore-repair")))
    .toBe(join(data.repositoryRoot, "skills", "memstore-repair"));
  const cliPath = join(data.homeRoot, ".local", "bin", "memstore");
  await expect(execFileAsync(cliPath, ["probe"], { encoding: "utf8" }))
    .resolves.toMatchObject({ stdout: "[\"probe\"]" });
  const launchAgent = await readFile(
    join(data.homeRoot, "Library", "LaunchAgents", "com.leonyuanyaoyao.memstore.worker.plist"),
    "utf8"
  );
  expect(launchAgent).toContain("MEMSTORE_NOTIFIER_EXECUTABLE");
  expect(launchAgent).toContain(join(
    data.runtimeRoot,
    "bin",
    "MemStore Notifier.app",
    "Contents",
    "MacOS",
    "memstore-notifier"
  ));
  expect(launchAgent).toContain("MEMSTORE_LUNA_CODEX_HOME");
  expect(launchAgent).toContain("MEMSTORE_EMBEDDING_MODEL_DIR");

  const notifierPath = join(
    data.runtimeRoot,
    "bin",
    "MemStore Notifier.app",
    "Contents",
    "MacOS",
    "memstore-notifier"
  );
  await unlink(notifierPath);
  expect((await repairManagedIntegration(request)).state).toBe("repaired");
  expect(await readFile(notifierPath, "utf8")).toBe("fixture notifier\n");
  expect((await repairManagedIntegration(request)).state).toBe("healthy");
  const uninstalled = await uninstallManagedIntegration({
    homeRoot: data.homeRoot,
    runtimeRoot: data.runtimeRoot,
    uninstalledAt: "2026-08-08T12:10:00.000Z"
  });
  expect(uninstalled.state).toBe("uninstalled");
  expect(await readFile(data.configPath, "utf8")).toBe(data.configSource);
  expect(await readFile(data.hooksPath, "utf8")).toBe(beforeHooks);
  expect((await lstat(data.hooksPath)).isSymbolicLink()).toBe(true);
  await expect(lstat(join(data.homeRoot, ".agents", "skills", "memstore-repair")))
    .rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(cliPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(data.vaultRoot)).resolves.toBeDefined();
  await expect(lstat(data.runtimeRoot)).resolves.toBeDefined();
});

test("upgrade safely adds the CLI to a legacy managed installation", async () => {
  const data = await fixture();
  const request = {
    ...data,
    lunaCodexHome: join(data.homeRoot, ".codex"),
    codexExecutable: "/opt/homebrew/bin/codex",
    embeddingModelDirectory: join(data.runtimeRoot, "models", "e5-base-q8"),
    installedAt: "2026-08-08T12:00:00.000Z"
  };
  await applyManagedIntegration(request, await previewManagedIntegration(request));

  const manifestPath = join(data.runtimeRoot, "install", "ownership-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    targets: Array<{ label: string }>;
  };
  manifest.targets = manifest.targets.filter((target) => target.label !== "memstore_cli");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const cliPath = join(data.homeRoot, ".local", "bin", "memstore");
  await unlink(cliPath);
  const userEditedConfig = `${await readFile(data.configPath, "utf8")}\n# user edit after installation\n`;
  await writeFile(data.configPath, userEditedConfig);

  const preview = await previewManagedIntegrationUpgrade(request);
  expect(preview).toMatchObject({ state: "upgrade_preview", dryRun: true });
  expect(preview.targets.map((target) => target.label)).toEqual(["memstore_cli"]);
  expect(preview.observedDivergedTargetLabels).toEqual(["codex_config"]);
  await expect(lstat(cliPath)).rejects.toMatchObject({ code: "ENOENT" });

  await expect(applyManagedIntegrationUpgrade(request, preview)).resolves.toMatchObject({
    state: "upgraded"
  });
  await expect(execFileAsync(cliPath, ["probe"], { encoding: "utf8" }))
    .resolves.toMatchObject({ stdout: "[\"probe\"]" });
  expect(await readFile(data.configPath, "utf8")).toBe(userEditedConfig);
  const upgraded = JSON.parse(await readFile(manifestPath, "utf8")) as {
    targets: Array<{ label: string }>;
  };
  expect(upgraded.targets.filter((target) => target.label === "memstore_cli")).toHaveLength(1);
});
