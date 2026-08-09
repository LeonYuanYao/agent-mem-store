import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  applyManagedIntegration,
  previewManagedIntegration,
  repairManagedIntegration,
  uninstallManagedIntegration
} from "../../../src/integration/managed.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memstore-managed-fault-"));
  roots.push(root);
  const homeRoot = join(root, "home");
  const repositoryRoot = join(root, "repo");
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(homeRoot, "runtime");
  await mkdir(join(homeRoot, ".codex"), { recursive: true });
  for (const path of ["memstore-remember", "memstore-recall", "memstore-repair"]) {
    await mkdir(join(repositoryRoot, "skills", path), { recursive: true });
  }
  await mkdir(join(repositoryRoot, "dist", "cli"), { recursive: true });
  await mkdir(join(repositoryRoot, "dist", "mcp"), { recursive: true });
  const notifierSource = join(root, "MemStore Notifier.app");
  await mkdir(join(notifierSource, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(notifierSource, "Contents", "_CodeSignature"), { recursive: true });
  await writeFile(join(notifierSource, "Contents", "MacOS", "memstore-notifier"), "notifier");
  await writeFile(join(notifierSource, "Contents", "Info.plist"), "plist");
  await writeFile(join(notifierSource, "Contents", "_CodeSignature", "CodeResources"), "signature");
  await writeFile(join(homeRoot, ".codex", "config.toml"), "[memories]\ngenerate_memories = true\nuse_memories = true\n");
  await writeFile(join(homeRoot, ".codex", "hooks.json"), '{"hooks":{}}\n');
  const request = { homeRoot, repositoryRoot, vaultRoot, runtimeRoot, notifierSource, nodeExecutable: process.execPath, installedAt: "2026-08-08T12:00:00.000Z" };
  await applyManagedIntegration(request, await previewManagedIntegration(request));
  return { ...request, hooksPath: join(homeRoot, ".codex", "hooks.json"), configPath: join(homeRoot, ".codex", "config.toml") };
}

test("repair and uninstall abort before mutation when a managed file diverges", async () => {
  const data = await fixture();
  const configBefore = await readFile(data.configPath, "utf8");
  const modifiedHooks = `${(await readFile(data.hooksPath, "utf8")).trimEnd()}\n# user edit\n`;
  await writeFile(data.hooksPath, modifiedHooks);

  await expect(repairManagedIntegration(data)).rejects.toThrow(/diverged/u);
  await expect(uninstallManagedIntegration({
    homeRoot: data.homeRoot,
    runtimeRoot: data.runtimeRoot,
    uninstalledAt: "2026-08-08T12:10:00.000Z"
  })).rejects.toThrow(/diverged/u);
  expect(await readFile(data.configPath, "utf8")).toBe(configBefore);
  expect(await readFile(data.hooksPath, "utf8")).toBe(modifiedHooks);
});
