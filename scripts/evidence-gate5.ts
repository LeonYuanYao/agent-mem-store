import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parse } from "smol-toml";
import { z } from "zod";

import {
  applyManagedIntegration,
  previewManagedIntegration,
  rehearseNativeMemoryCutover,
  repairManagedIntegration,
  uninstallManagedIntegration
} from "../src/integration/managed.js";

interface Step {
  readonly name: string;
  readonly executable: string;
  readonly arguments: readonly string[];
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const evidenceDirectory = join(repositoryRoot, "artifacts", "evidence");
const evidencePath = join(evidenceDirectory, "gate5.json");
const candidatePath = join(repositoryRoot, "config", "gate5-shadow-v1.json");

const steps: readonly Step[] = [
  { name: "frozen_install", executable: "pnpm", arguments: ["install", "--frozen-lockfile"] },
  { name: "lint", executable: "pnpm", arguments: ["lint"] },
  { name: "typecheck", executable: "pnpm", arguments: ["typecheck"] },
  {
    name: "gate5_targeted_tests",
    executable: "pnpm",
    arguments: [
      "exec", "vitest", "run",
      "tests/e2e/repair",
      "tests/integration/managed-install",
      "tests/fault/managed-install",
      "tests/contract/codex-hook.test.ts",
      "tests/integration/retrieval/shadow-worker.test.ts",
      "tests/integration/operations/shadow-window.test.ts"
    ]
  },
  {
    name: "archive_purge_prerequisite",
    executable: "pnpm",
    arguments: ["exec", "vitest", "run", "tests/destructive/purge"]
  },
  { name: "full_test", executable: "pnpm", arguments: ["test"] },
  { name: "build", executable: "pnpm", arguments: ["build"] },
  {
    name: "native_notifier_test",
    executable: "swift",
    arguments: ["test", "--package-path", "native/memstore-notifier"]
  },
  { name: "native_notifier_app", executable: "pnpm", arguments: ["build:notifier"] },
  { name: "production_audit", executable: "pnpm", arguments: ["audit", "--prod", "--json"] },
  {
    name: "production_licenses",
    executable: "pnpm",
    arguments: ["licenses", "list", "--prod", "--json"]
  }
];

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function runGit(arguments_: readonly string[]): string {
  const result = spawnSync("git", arguments_, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${arguments_.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

async function sourceManifest() {
  const paths = runGit(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();
  return Promise.all(paths.map(async (path) => {
    const absolute = join(repositoryRoot, path);
    const [source, metadata] = await Promise.all([readFile(absolute), lstat(absolute)]);
    return { path, bytes: source.byteLength, mode: metadata.mode & 0o777, sha256: hash(source) };
  }));
}

async function digestPath(path: string): Promise<readonly string[]> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (metadata.isSymbolicLink()) return [`L:${path}:${await readlink(path)}`];
  if (metadata.isFile()) return [`F:${path}:${String(metadata.mode & 0o777)}:${hash(await readFile(path))}`];
  if (!metadata.isDirectory()) return [`O:${path}`];
  const children = await Promise.all((await readdir(path)).sort().map((name) => digestPath(join(path, name))));
  return [`D:${path}`, ...children.flat()];
}

const obsidianSchema = z.object({
  vaults: z.record(z.string(), z.object({ path: z.string().min(1), open: z.boolean().optional() }))
});

async function discoverVaultRoot(): Promise<string> {
  const source = await readFile(join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json"), "utf8");
  const vaults = Object.values(obsidianSchema.parse(JSON.parse(source)).vaults);
  const selected = vaults.find((vault) => vault.open === true) ?? vaults[0];
  if (selected === undefined) throw new Error("Obsidian has no registered Vault.");
  return resolve(selected.path);
}

const realVaultRoot = await discoverVaultRoot();
const liveManifestPath = join(
  homedir(),
  "Library",
  "Application Support",
  "MemStore",
  "install",
  "ownership-manifest.json"
);
const externalTargets = [
  { label: "real_vault_memories", path: join(realVaultRoot, "Memories") },
  { label: "real_vault_control", path: join(realVaultRoot, "_MemStore") },
  { label: "runtime", path: join(homedir(), "Library", "Application Support", "MemStore") },
  { label: "codex_config", path: join(homedir(), ".codex", "config.toml") },
  { label: "codex_hooks", path: join(homedir(), ".codex", "hooks.json") },
  { label: "remember_skill", path: join(homedir(), ".agents", "skills", "memstore-remember") },
  { label: "recall_skill", path: join(homedir(), ".agents", "skills", "memstore-recall") },
  { label: "repair_skill", path: join(homedir(), ".agents", "skills", "memstore-repair") },
  { label: "launch_agent", path: join(homedir(), "Library", "LaunchAgents", "com.leonyuanyaoyao.memstore.worker.plist") }
] as const;

async function snapshotExternalTargets() {
  return Promise.all(externalTargets.map(async (target) => {
    const entries = await digestPath(target.path);
    return {
      ...target,
      state: entries.length === 0 ? "absent" : "present",
      entryCount: entries.length,
      digest: entries.length === 0 ? null : hash(entries.join("\n"))
    };
  }));
}

async function liveManagedIntegrationInstalled(): Promise<boolean> {
  try {
    const source = await readFile(liveManifestPath, "utf8");
    return z.looseObject({ state: z.string() }).parse(JSON.parse(source)).state === "installed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}

function hooksPreserved(beforeSource: string, installedSource: string): boolean {
  const before = record(record(JSON.parse(beforeSource)).hooks);
  const installed = record(record(JSON.parse(installedSource)).hooks);
  return Object.entries(before).every(([event, groups]) => {
    const beforeGroups = z.array(z.unknown()).parse(groups);
    const installedGroups = z.array(z.unknown()).parse(installed[event]);
    return JSON.stringify(installedGroups.slice(0, beforeGroups.length)) === JSON.stringify(beforeGroups);
  });
}

async function readManagedExerciseBaseline(): Promise<{
  readonly config: string;
  readonly hooks: string;
}> {
  const liveConfigPath = join(homedir(), ".codex", "config.toml");
  const liveHooksPath = join(homedir(), ".codex", "hooks.json");
  let manifestSource: string;
  try {
    manifestSource = await readFile(liveManifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const [config, hooks] = await Promise.all([
        readFile(liveConfigPath, "utf8"),
        readFile(liveHooksPath, "utf8")
      ]);
      return { config, hooks };
    }
    throw error;
  }
  const manifest = z.looseObject({
    state: z.literal("installed"),
    targets: z.array(z.looseObject({
      label: z.string(),
      path: z.string(),
      backupPath: z.string().optional()
    }))
  }).parse(JSON.parse(manifestSource));
  const configTarget = manifest.targets.find((target) => target.label === "codex_config");
  const hooksTarget = manifest.targets.find((target) => target.label === "codex_hooks");
  if (configTarget?.path !== liveConfigPath || configTarget.backupPath === undefined ||
      hooksTarget?.backupPath === undefined) {
    throw new Error("Installed ownership manifest has no exact pre-install Codex baseline.");
  }
  return {
    config: await readFile(configTarget.backupPath, "utf8"),
    hooks: await readFile(hooksTarget.backupPath, "utf8")
  };
}

async function exerciseManagedIntegration() {
  const root = await mkdtemp(join(tmpdir(), "memstore-gate5-"));
  try {
    const homeRoot = join(root, "home");
    const vaultRoot = join(root, "vault");
    const runtimeRoot = join(homeRoot, "Library", "Application Support", "MemStore");
    const codexRoot = join(homeRoot, ".codex");
    const notifierSource = join(root, "MemStore Notifier.app");
    await mkdir(codexRoot, { recursive: true });
    await mkdir(join(notifierSource, "Contents", "MacOS"), { recursive: true });
    await mkdir(join(notifierSource, "Contents", "_CodeSignature"), { recursive: true });
    const baseline = await readManagedExerciseBaseline();
    const realConfig = baseline.config;
    const realHooks = baseline.hooks;
    await Promise.all([
      writeFile(join(codexRoot, "config.toml"), realConfig),
      writeFile(join(codexRoot, "hooks.json"), realHooks),
      writeFile(join(notifierSource, "Contents", "MacOS", "memstore-notifier"), "synthetic notifier artifact\n", { mode: 0o755 }),
      writeFile(join(notifierSource, "Contents", "Info.plist"), "synthetic plist\n"),
      writeFile(join(notifierSource, "Contents", "_CodeSignature", "CodeResources"), "synthetic signature\n")
    ]);
    const request = {
      homeRoot,
      repositoryRoot,
      vaultRoot,
      runtimeRoot,
      notifierSource,
      nodeExecutable: process.execPath,
      lunaCodexHome: codexRoot,
      codexExecutable: "codex",
      embeddingModelDirectory: join(runtimeRoot, "models", "e5-base-q8"),
      installedAt: new Date().toISOString()
    };
    const beforeDigest = hash(`${await readFile(join(codexRoot, "config.toml"), "utf8")}\0${await readFile(join(codexRoot, "hooks.json"), "utf8")}`);
    const preview = await previewManagedIntegration(request);
    const previewDigest = hash(`${await readFile(join(codexRoot, "config.toml"), "utf8")}\0${await readFile(join(codexRoot, "hooks.json"), "utf8")}`);
    const installed = await applyManagedIntegration(request, preview);
    const installedConfig = await readFile(join(codexRoot, "config.toml"), "utf8");
    const installedHooks = await readFile(join(codexRoot, "hooks.json"), "utf8");
    const installedLaunchAgent = await readFile(
      join(homeRoot, "Library", "LaunchAgents", "com.leonyuanyaoyao.memstore.worker.plist"),
      "utf8"
    );
    const beforeToml = record(parse(realConfig));
    const afterToml = record(parse(installedConfig));
    const beforeMcp = record(beforeToml.mcp_servers);
    const afterMcp = record(afterToml.mcp_servers);
    const beforePlugins = record(beforeToml.plugins);
    const afterPlugins = record(afterToml.plugins);
    const nativeMemoryBefore = record(beforeToml.memories);
    const nativeMemoryAfter = record(afterToml.memories);
    const nativeDirectory = join(root, "native-memory-data");
    await mkdir(nativeDirectory);
    await writeFile(join(nativeDirectory, "opaque.bin"), "synthetic opaque native body");
    const rehearsal = await rehearseNativeMemoryCutover({
      configPath: join(codexRoot, "config.toml"),
      hooksPath: join(codexRoot, "hooks.json"),
      nativeStorePaths: [nativeDirectory],
      rehearsedAt: new Date().toISOString()
    });
    const afterRehearsalConfig = await readFile(join(codexRoot, "config.toml"), "utf8");
    const afterRehearsalHooks = await readFile(join(codexRoot, "hooks.json"), "utf8");
    const repair = await repairManagedIntegration(request);
    const uninstalled = await uninstallManagedIntegration({
      homeRoot,
      runtimeRoot,
      uninstalledAt: new Date().toISOString()
    });
    return {
      installationId: installed.installationId,
      uninstallInstallationId: uninstalled.installationId,
      repairState: repair.state,
      previewMutationFree: beforeDigest === previewDigest,
      unrelatedStatePreserved:
        Object.keys(beforeMcp).every((key) => JSON.stringify(afterMcp[key]) === JSON.stringify(beforeMcp[key])) &&
        Object.keys(beforePlugins).every((key) => JSON.stringify(afterPlugins[key]) === JSON.stringify(beforePlugins[key])) &&
        hooksPreserved(realHooks, installedHooks),
      nativeSettingsPreservedInShadow:
        JSON.stringify(nativeMemoryBefore) === JSON.stringify(nativeMemoryAfter),
      workerAdaptersConfigured:
        installedLaunchAgent.includes("MEMSTORE_LUNA_CODEX_HOME") &&
        installedLaunchAgent.includes("MEMSTORE_EMBEDDING_MODEL_DIR") &&
        installedLaunchAgent.includes("MEMSTORE_NOTIFIER_EXECUTABLE"),
      cutoverRollbackRestoredExactConfiguration:
        afterRehearsalConfig === installedConfig && afterRehearsalHooks === installedHooks && rehearsal.rollback.restored,
      uninstallRestoredExactConfiguration:
        await readFile(join(codexRoot, "config.toml"), "utf8") === realConfig &&
        await readFile(join(codexRoot, "hooks.json"), "utf8") === realHooks,
      nativeBodiesRead: rehearsal.nativeData.bodiesRead,
      nativeDataOperation: rehearsal.nativeData.operation,
      vaultRetainedAfterUninstall: (await digestPath(vaultRoot)).length > 0,
      runtimeRetainedAfterUninstall: (await digestPath(runtimeRoot)).length > 0,
      candidateId: preview.candidateId,
      targetCount: preview.targets.length
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runStep(step: Step) {
  const started = performance.now();
  const result = spawnSync(step.executable, step.arguments, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  return {
    name: step.name,
    command: [step.executable, ...step.arguments].join(" "),
    exitCode: result.status,
    signal: result.signal,
    durationMilliseconds: Math.round(performance.now() - started),
    stdoutSha256: hash(result.stdout),
    stderrSha256: hash(result.stderr),
    stdoutTail: result.stdout.slice(-250_000),
    stderrTail: result.stderr.slice(-250_000)
  };
}

const claimToEvidence = [
  {
    claim: "archive_purge_prerequisite",
    evidence: ["tests/destructive/purge/ordinary-purge.test.ts", "tests/destructive/purge/crash-recovery.test.ts"]
  },
  {
    claim: "reviewed_foreground_repair_loop",
    evidence: ["tests/e2e/repair/synthetic-irrelevant.test.ts", "skills/memstore-repair/SKILL.md"]
  },
  {
    claim: "managed_install_repair_uninstall",
    evidence: ["tests/integration/managed-install/preservation.test.ts", "tests/fault/managed-install/divergence.test.ts"]
  },
  {
    claim: "cutover_and_rollback_rehearsal",
    evidence: ["tests/integration/managed-install/cutover-rehearsal.test.ts"]
  },
  {
    claim: "frozen_candidate_configuration",
    evidence: ["config/gate5-shadow-v1.json", "tests/contract/gate5-evidence.test.ts"]
  },
  {
    claim: "official_hook_and_shadow_runtime",
    evidence: [
      "tests/contract/codex-hook.test.ts",
      "tests/integration/retrieval/shadow-worker.test.ts",
      "tests/integration/operations/shadow-window.test.ts"
    ]
  }
] as const;

const [manifest, externalBefore, candidateSource, managedExercise, liveInstallationPresent] = await Promise.all([
  sourceManifest(),
  snapshotExternalTargets(),
  readFile(candidatePath, "utf8"),
  exerciseManagedIntegration(),
  liveManagedIntegrationInstalled()
]);
const candidate = record(JSON.parse(candidateSource));
const frozenCandidate = {
  candidateId: candidate.candidateId,
  sha256: hash(candidateSource),
  automaticInjection: candidate.automaticInjection,
  nativeMemory: candidate.nativeMemory,
  path: "config/gate5-shadow-v1.json"
};
const repository = {
  root: repositoryRoot,
  head: runGit(["rev-parse", "HEAD"]).trim(),
  branch: runGit(["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
  gitStatusBefore: runGit(["status", "--short"]),
  sourceManifest: manifest
};
const machineBoundary = {
  externalTargetsUnchanged: true,
  liveInstallationPresent,
  allowedOperationalDrift: liveInstallationPresent ? ["runtime", "real_vault_control"] : [],
  realInstallationApplied: false,
  officialShadowStarted: false,
  automaticInjectionEnabled: false,
  nativeMemoryConfigurationChanged: false,
  nativeMemoryDataOperation: "none"
};
await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
await writeFile(evidencePath, `${JSON.stringify({
  schemaVersion: 1,
  gate: 5,
  phase: "running",
  passed: false,
  generatedAt: new Date().toISOString(),
  repository,
  claimToEvidence,
  frozenCandidate,
  managedExercise,
  machineBoundary,
  results: []
}, null, 2)}\n`, { mode: 0o600 });

const results = steps.map(runStep);
const externalAfter = await snapshotExternalTargets();
const operationalTargets = new Set(liveInstallationPresent ? ["runtime", "real_vault_control"] : []);
const externalTargetsUnchanged = externalBefore.every((before, index) => {
  const after = externalAfter[index];
  if (after === undefined || before.label !== after.label) return false;
  if (operationalTargets.has(before.label)) return before.state === after.state;
  return JSON.stringify(before) === JSON.stringify(after);
});
const exercisePassed = managedExercise.previewMutationFree &&
  managedExercise.unrelatedStatePreserved &&
  managedExercise.nativeSettingsPreservedInShadow &&
  managedExercise.workerAdaptersConfigured &&
  managedExercise.cutoverRollbackRestoredExactConfiguration &&
  managedExercise.uninstallRestoredExactConfiguration &&
  managedExercise.vaultRetainedAfterUninstall &&
  managedExercise.runtimeRetainedAfterUninstall;
const passed = results.every((result) => result.exitCode === 0) &&
  externalTargetsUnchanged && exercisePassed;
const finalEvidence = {
  schemaVersion: 1,
  gate: 5,
  phase: "complete",
  passed,
  generatedAt: new Date().toISOString(),
  repository,
  claimToEvidence,
  frozenCandidate,
  managedExercise,
  machineBoundary: { ...machineBoundary, externalTargetsUnchanged },
  externalTargetsBefore: externalBefore,
  externalTargetsAfter: externalAfter,
  results,
  approvalBoundary: "Gate 5 review required before installing the frozen candidate or starting the official seven-day Shadow window."
};
await writeFile(evidencePath, `${JSON.stringify(finalEvidence, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ evidencePath, passed, candidateSha256: frozenCandidate.sha256 }, null, 2)}\n`);
if (!passed) process.exitCode = 1;
