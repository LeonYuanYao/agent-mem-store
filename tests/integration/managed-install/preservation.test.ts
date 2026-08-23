import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
    [
      "if (process.argv[2] === 'probe-config') {",
      "  process.stdout.write(JSON.stringify({",
      "    runtimeRoot: process.env.MEMSTORE_RUNTIME_ROOT,",
      "    vaultRoot: process.env.MEMSTORE_VAULT_ROOT",
      "  }));",
      "} else {",
      "  process.stdout.write(JSON.stringify(process.argv.slice(2)));",
      "}",
      ""
    ].join("\n")
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

async function replaceManagedCliWithLegacyRecipe(data: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const cliPath = join(data.homeRoot, ".local", "bin", "memstore");
  const legacySource = `#!/bin/sh\nexec '${data.nodeExecutable}' '${join(
    data.repositoryRoot,
    "dist",
    "cli",
    "main.js"
  )}' "$@"\n`;
  await writeFile(cliPath, legacySource, { mode: 0o700 });
  const manifestPath = join(data.runtimeRoot, "install", "ownership-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    targets: Array<{
      label: string;
      expectedPost: { state: string; sha256?: string };
      expectedSource?: string;
    }>;
  };
  const cliTarget = manifest.targets.find((target) => target.label === "memstore_cli");
  if (cliTarget === undefined) throw new Error("Fixture has no managed CLI target.");
  cliTarget.expectedPost = {
    state: "file",
    sha256: createHash("sha256").update(legacySource).digest("hex")
  };
  cliTarget.expectedSource = legacySource;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function replaceManagedHooksWithLegacyRecipe(
  data: Awaited<ReturnType<typeof fixture>>
): Promise<void> {
  const document = JSON.parse(await readFile(data.hooksTargetPath, "utf8")) as {
    hooks: Record<string, Array<{ hooks?: Array<{ command?: string; timeout?: number }> }>>;
  };
  for (const [event, routes] of Object.entries(document.hooks)) {
    for (const hook of routes.flatMap((route) => route.hooks ?? [])) {
      if (hook.command?.includes(`memstore:gate5-shadow-v1:${event}:shadow`) !== true) continue;
      hook.command = hook.command.replace("dist/cli/hook.js' codex", "dist/cli/main.js' hook codex");
      if (event === "PostToolUse") hook.timeout = 1;
    }
  }
  const legacySource = `${JSON.stringify(document, null, 2)}\n`;
  await writeFile(data.hooksTargetPath, legacySource);
  const manifestPath = join(data.runtimeRoot, "install", "ownership-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    targets: Array<{
      label: string;
      expectedPost: { state: string; sha256?: string };
      expectedSource?: string;
    }>;
  };
  const hooksTarget = manifest.targets.find((target) => target.label === "codex_hooks");
  if (hooksTarget === undefined) throw new Error("Fixture has no managed Hooks target.");
  hooksTarget.expectedPost = {
    state: "file",
    sha256: createHash("sha256").update(legacySource).digest("hex")
  };
  hooksTarget.expectedSource = legacySource;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
  expect(installedConfig).toContain("MEMSTORE_LUNA_CODEX_HOME");
  expect(installedConfig).toContain("MEMSTORE_CODEX_EXECUTABLE");
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
  const managedPostToolUse = (installedHooks.hooks as Record<
    string,
    Array<{ hooks?: Array<{ command?: string; timeout?: number }> }>
  >).PostToolUse
    ?.flatMap((route) => route.hooks ?? [])
    .find((hook) => hook.command?.includes("memstore:gate5-shadow-v1:PostToolUse:shadow") === true);
  expect(managedPostToolUse).toMatchObject({ timeout: 2 });
  const installedHooksSource = await readFile(data.hooksPath, "utf8");
  expect(installedHooksSource.match(/dist\/cli\/hook\.js/gu)).toHaveLength(5);
  expect(installedHooksSource).not.toContain("dist/cli/main.js' hook codex");
  expect(installedHooks.hooks).not.toHaveProperty("PreToolUse.1");
  expect(await readlink(join(data.homeRoot, ".agents", "skills", "memstore-repair")))
    .toBe(join(data.repositoryRoot, "skills", "memstore-repair"));
  const cliPath = join(data.homeRoot, ".local", "bin", "memstore");
  await expect(execFileAsync(cliPath, ["probe"], { encoding: "utf8" }))
    .resolves.toMatchObject({ stdout: "[\"probe\"]" });
  await expect(execFileAsync(cliPath, ["probe-config"], {
    encoding: "utf8",
    env: {}
  })).resolves.toMatchObject({
    stdout: JSON.stringify({
      runtimeRoot: data.runtimeRoot,
      vaultRoot: data.vaultRoot
    })
  });
  await expect(execFileAsync(cliPath, ["probe-config"], {
    encoding: "utf8",
    env: {
      MEMSTORE_RUNTIME_ROOT: "/explicit/runtime",
      MEMSTORE_VAULT_ROOT: "/explicit/vault"
    }
  })).resolves.toMatchObject({
    stdout: JSON.stringify({
      runtimeRoot: "/explicit/runtime",
      vaultRoot: "/explicit/vault"
    })
  });
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

test("repair upgrades an owned legacy CLI recipe with machine-local defaults", async () => {
  const data = await fixture();
  const request = {
    ...data,
    lunaCodexHome: join(data.homeRoot, ".codex"),
    codexExecutable: "/opt/homebrew/bin/codex",
    embeddingModelDirectory: join(data.runtimeRoot, "models", "e5-base-q8"),
    installedAt: "2026-08-08T12:00:00.000Z"
  };
  await applyManagedIntegration(request, await previewManagedIntegration(request));
  await replaceManagedCliWithLegacyRecipe(data);

  await expect(repairManagedIntegration(request)).resolves.toMatchObject({ state: "repaired" });
  const cliPath = join(data.homeRoot, ".local", "bin", "memstore");
  await expect(execFileAsync(cliPath, ["probe-config"], {
    encoding: "utf8",
    env: {}
  })).resolves.toMatchObject({
    stdout: JSON.stringify({
      runtimeRoot: data.runtimeRoot,
      vaultRoot: data.vaultRoot
    })
  });
  await expect(repairManagedIntegration(request)).resolves.toMatchObject({ state: "healthy" });
});

test("upgrade previews and replaces an owned legacy CLI recipe", async () => {
  const data = await fixture();
  const request = {
    ...data,
    lunaCodexHome: join(data.homeRoot, ".codex"),
    codexExecutable: "/opt/homebrew/bin/codex",
    embeddingModelDirectory: join(data.runtimeRoot, "models", "e5-base-q8"),
    installedAt: "2026-08-08T12:00:00.000Z"
  };
  await applyManagedIntegration(request, await previewManagedIntegration(request));
  await replaceManagedCliWithLegacyRecipe(data);
  const cliPath = join(data.homeRoot, ".local", "bin", "memstore");

  const preview = await previewManagedIntegrationUpgrade(request);
  expect(preview).toMatchObject({
    state: "upgrade_preview",
    dryRun: true,
    observedDivergedTargetLabels: []
  });
  expect(preview.targets.map((target) => target.label)).toEqual(["memstore_cli"]);
  await expect(execFileAsync(cliPath, ["probe-config"], {
    encoding: "utf8",
    env: {}
  })).resolves.toMatchObject({ stdout: "{}" });

  await expect(applyManagedIntegrationUpgrade(request, preview)).resolves.toMatchObject({
    state: "upgraded"
  });
  await expect(execFileAsync(cliPath, ["probe-config"], {
    encoding: "utf8",
    env: {}
  })).resolves.toMatchObject({
    stdout: JSON.stringify({
      runtimeRoot: data.runtimeRoot,
      vaultRoot: data.vaultRoot
    })
  });
  const manifest = JSON.parse(await readFile(
    join(data.runtimeRoot, "install", "ownership-manifest.json"),
    "utf8"
  )) as { targets: Array<{ label: string }> };
  expect(manifest.targets.filter((target) => target.label === "memstore_cli")).toHaveLength(1);
});

test("repair upgrades owned legacy Hook recipes without changing unrelated Hooks", async () => {
  const data = await fixture();
  const request = {
    ...data,
    lunaCodexHome: join(data.homeRoot, ".codex"),
    codexExecutable: "/opt/homebrew/bin/codex",
    embeddingModelDirectory: join(data.runtimeRoot, "models", "e5-base-q8"),
    installedAt: "2026-08-08T12:00:00.000Z"
  };
  const preview = await previewManagedIntegration(request);
  await applyManagedIntegration(request, preview);
  await replaceManagedHooksWithLegacyRecipe(data);
  const userConfig = `${await readFile(data.configPath, "utf8")}\n[plugins.user]\nenabled = true\n`;
  await writeFile(data.configPath, userConfig);

  await expect(repairManagedIntegration(request, {
    targetLabels: ["codex_hooks"]
  })).resolves.toMatchObject({ state: "repaired" });
  expect(await readFile(data.configPath, "utf8")).toBe(userConfig);
  const repaired = JSON.parse(await readFile(data.hooksTargetPath, "utf8")) as {
    hooks: Record<string, Array<{ hooks?: Array<{ command?: string; timeout?: number }> }>>;
  };
  expect(repaired.hooks.PreToolUse).toEqual(data.hooks.hooks.PreToolUse);
  const managed = Object.values(repaired.hooks)
    .flatMap((routes) => routes)
    .flatMap((route) => route.hooks ?? [])
    .filter((hook) => hook.command?.includes("memstore:gate5-shadow-v1:") === true);
  expect(managed).toHaveLength(5);
  expect(managed.every((hook) => hook.command?.includes("dist/cli/hook.js' codex") === true))
    .toBe(true);
  expect(managed.find((hook) => hook.command?.includes(":PostToolUse:shadow") === true))
    .toMatchObject({ timeout: 2 });
});
