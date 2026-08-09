import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";

interface Step {
  readonly name: string;
  readonly executable: string;
  readonly arguments: readonly string[];
}

interface SourceEntry {
  readonly path: string;
  readonly bytes: number;
  readonly mode: number;
  readonly sha256: string;
}

interface TargetSnapshot {
  readonly label: string;
  readonly path: string;
  readonly state: "absent" | "present";
  readonly entryCount: number;
  readonly digest: string | null;
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const evidenceDirectory = join(repositoryRoot, "artifacts", "evidence");
const evidencePath = join(evidenceDirectory, "purge.json");

const steps: readonly Step[] = [
  { name: "frozen_install", executable: "pnpm", arguments: ["install", "--frozen-lockfile"] },
  { name: "lint", executable: "pnpm", arguments: ["lint"] },
  { name: "typecheck", executable: "pnpm", arguments: ["typecheck"] },
  {
    name: "destructive_purge_tests",
    executable: "pnpm",
    arguments: ["exec", "vitest", "run", "tests/destructive/purge"]
  },
  { name: "full_test", executable: "pnpm", arguments: ["test"] },
  { name: "build", executable: "pnpm", arguments: ["build"] },
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
  const result = spawnSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) throw new Error(`git ${arguments_.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

async function sourceManifest(): Promise<readonly SourceEntry[]> {
  const paths = runGit(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();
  return Promise.all(paths.map(async (path) => {
    const absolute = join(repositoryRoot, path);
    const [source, metadata] = await Promise.all([readFile(absolute), lstat(absolute)]);
    return {
      path,
      bytes: source.byteLength,
      mode: metadata.mode & 0o777,
      sha256: hash(source)
    };
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
  const names = (await readdir(path)).sort();
  const children = await Promise.all(names.map((name) => digestPath(join(path, name))));
  return [`D:${path}`, ...children.flat()];
}

const obsidianSchema = z.object({
  vaults: z.record(z.string(), z.object({
    path: z.string().min(1),
    open: z.boolean().optional()
  }))
});

async function discoverVaultRoot(): Promise<string> {
  const source = await readFile(
    join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json"),
    "utf8"
  );
  const vaults = Object.values(obsidianSchema.parse(JSON.parse(source)).vaults);
  const selected = vaults.find((vault) => vault.open === true) ?? vaults[0];
  if (selected === undefined) throw new Error("Obsidian has no registered Vault.");
  return resolve(selected.path);
}

const realVaultRoot = await discoverVaultRoot();
const externalTargets = [
  { label: "real_vault_memories", path: join(realVaultRoot, "Memories") },
  { label: "real_vault_control", path: join(realVaultRoot, "_MemStore") },
  {
    label: "memstore_application_support",
    path: join(homedir(), "Library", "Application Support", "MemStore")
  },
  { label: "codex_config", path: join(homedir(), ".codex", "config.toml") },
  { label: "codex_hooks", path: join(homedir(), ".codex", "hooks.json") },
  { label: "remember_skill", path: join(homedir(), ".agents", "skills", "memstore-remember") },
  { label: "recall_skill", path: join(homedir(), ".agents", "skills", "memstore-recall") },
  {
    label: "memstore_launch_agent",
    path: join(homedir(), "Library", "LaunchAgents", "com.leonyuanyaoyao.memstore.worker.plist")
  }
] as const;

async function snapshotTargets(): Promise<readonly TargetSnapshot[]> {
  return Promise.all(externalTargets.map(async (target) => {
    const entries = await digestPath(target.path);
    return {
      ...target,
      state: entries.length === 0 ? "absent" : "present",
      entryCount: entries.length,
      digest: entries.length === 0 ? null : hash(entries.join("\n"))
    } as const;
  }));
}

const claimToEvidence = [
  {
    claim: "strict_preview_and_backup_gate",
    evidence: [
      "tests/destructive/purge/ordinary-purge.test.ts",
      "tests/destructive/purge/safety-recheck.test.ts",
      "tests/contract/cli-purge.test.ts"
    ]
  },
  {
    claim: "authority_retention_and_restore_protection",
    evidence: [
      "tests/destructive/purge/protection-policy.test.ts",
      "tests/destructive/purge/safety-recheck.test.ts"
    ]
  },
  {
    claim: "checkpointed_idempotent_crash_recovery",
    evidence: [
      "tests/destructive/purge/crash-recovery.test.ts",
      "tests/destructive/purge/ordinary-purge.test.ts"
    ]
  },
  {
    claim: "bounded_yielding_and_catch_up",
    evidence: [
      "tests/destructive/purge/batch-yield.test.ts",
      "tests/destructive/purge/catch-up-pressure.test.ts"
    ]
  },
  {
    claim: "body_revision_index_and_catalog_agreement",
    evidence: ["tests/destructive/purge/ordinary-purge.test.ts"]
  }
] as const;

const unresolvedLimitations = [
  {
    id: "real_vault_purge_not_executed",
    boundary: "Outcome 12 exercises deletion only in operating-system temporary Vaults."
  },
  {
    id: "managed_scheduler_not_installed",
    boundary: "The executor and catch-up behavior exist, but Worker installation and backup configuration remain behind Outcome 13 managed integration."
  },
  {
    id: "external_backup_retention_outside_memstore",
    boundary: "MemStore verifies the supplied backup identities but does not delete or govern external backup history."
  }
] as const;

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

await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
const [manifest, targetsBefore] = await Promise.all([sourceManifest(), snapshotTargets()]);
const repository = {
  root: repositoryRoot,
  head: runGit(["rev-parse", "HEAD"]).trim(),
  branch: runGit(["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
  gitStatusBefore: runGit(["status", "--short"]),
  sourceManifest: manifest
};
const baseEvidence = {
  schemaVersion: 1,
  milestone: "outcome12_archive_purge",
  generatedAt: new Date().toISOString(),
  repository,
  claimToEvidence,
  destructiveBoundary: {
    realVaultRoot,
    realVaultWritten: false,
    externalTargetsUnchanged: true,
    backupRequired: true,
    testDataLocation: "operating-system temporary directories",
    defaultLimits: {
      bodies: 25,
      bytes: 16_777_216,
      destructiveMilliseconds: 10_000
    },
    safetyMaxima: {
      bodies: 200,
      bytes: 134_217_728,
      destructiveMilliseconds: 60_000
    },
    fullVacuumUsed: false
  },
  unresolvedLimitations
};
await writeFile(evidencePath, `${JSON.stringify({
  ...baseEvidence,
  phase: "running",
  passed: false,
  results: []
}, null, 2)}\n`, { mode: 0o600 });

const results = steps.map(runStep);
const targetsAfter = await snapshotTargets();
const externalTargetsUnchanged = JSON.stringify(targetsBefore) === JSON.stringify(targetsAfter);
const passed = results.every((result) => result.exitCode === 0) && externalTargetsUnchanged;
const evidence = {
  ...baseEvidence,
  generatedAt: new Date().toISOString(),
  phase: "complete",
  passed,
  environment: {
    node: process.versions.node,
    platform: process.platform,
    architecture: process.arch
  },
  repository: {
    ...repository,
    gitStatusAfter: runGit(["status", "--short"])
  },
  destructiveBoundary: {
    ...baseEvidence.destructiveBoundary,
    externalTargetsUnchanged,
    before: targetsBefore,
    after: targetsAfter
  },
  results
};
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
for (const result of results) {
  process.stdout.write(
    `${result.exitCode === 0 ? "PASS" : "FAIL"} ${result.name} ` +
    `(${String(result.durationMilliseconds)} ms, exit ${String(result.exitCode)})\n`
  );
}
process.stdout.write(`External targets unchanged: ${String(externalTargetsUnchanged)}\n`);
process.stdout.write(`Evidence: ${evidencePath}\n`);
process.exitCode = passed ? 0 : 1;
