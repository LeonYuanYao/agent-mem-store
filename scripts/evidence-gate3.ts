import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

interface EvidenceStep {
  readonly name: string;
  readonly executable: string;
  readonly arguments: readonly string[];
}

interface EvidenceResult {
  readonly name: string;
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMilliseconds: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

interface SourceManifestEntry {
  readonly path: string;
  readonly bytes: number;
  readonly mode: number;
  readonly sha256: string;
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const evidenceDirectory = join(repositoryRoot, "artifacts", "evidence");
const evidencePath = join(evidenceDirectory, "gate3.json");
const maximumTailCharacters = 1_000_000;

const steps: readonly EvidenceStep[] = [
  {
    name: "frozen_install",
    executable: "pnpm",
    arguments: ["install", "--frozen-lockfile"]
  },
  { name: "lint", executable: "pnpm", arguments: ["lint"] },
  { name: "typecheck", executable: "pnpm", arguments: ["typecheck"] },
  { name: "test", executable: "pnpm", arguments: ["test"] },
  { name: "build", executable: "pnpm", arguments: ["build"] },
  {
    name: "production_audit",
    executable: "pnpm",
    arguments: ["audit", "--prod", "--json"]
  },
  {
    name: "production_licenses",
    executable: "pnpm",
    arguments: ["licenses", "list", "--prod", "--json"]
  }
];

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function tail(value: string): string {
  return value.slice(-maximumTailCharacters);
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function runStep(step: EvidenceStep): EvidenceResult {
  const startedAt = performance.now();
  const result = spawnSync(step.executable, step.arguments, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  const stdout = result.stdout;
  const stderr = result.stderr;
  return {
    name: step.name,
    command: [step.executable, ...step.arguments].map(shellQuote).join(" "),
    exitCode: result.status,
    signal: result.signal,
    durationMilliseconds: Math.round(performance.now() - startedAt),
    stdoutSha256: hash(stdout),
    stderrSha256: hash(stderr),
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr)
  };
}

function readGitStatus(): string {
  return runGit(["status", "--short"]);
}

function runGit(arguments_: readonly string[]): string {
  const result = spawnSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(
      `Git command failed: git ${arguments_.join(" ")}\n${result.stderr}`
    );
  }
  return result.stdout;
}

async function createSourceManifest(): Promise<readonly SourceManifestEntry[]> {
  const paths = runGit([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z"
  ])
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();

  return Promise.all(
    paths.map(async (path) => {
      const absolutePath = join(repositoryRoot, path);
      const [contents, metadata] = await Promise.all([
        readFile(absolutePath),
        lstat(absolutePath)
      ]);
      return {
        path,
        bytes: contents.byteLength,
        mode: metadata.mode & 0o777,
        sha256: hash(contents)
      };
    })
  );
}

interface TargetSnapshot {
  readonly label: string;
  readonly path: string;
  readonly state: "absent" | "present";
  readonly entryCount: number;
  readonly digest: string | null;
}

async function digestPath(path: string): Promise<{ readonly entries: readonly string[] }> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    return { entries: [`L:${path}:${await readlink(path)}`] };
  }
  if (metadata.isFile()) {
    return {
      entries: [
        `F:${path}:${String(metadata.mode & 0o777)}:${hash(await readFile(path))}`
      ]
    };
  }
  if (!metadata.isDirectory()) return { entries: [`O:${path}`] };
  const names = (await readdir(path)).sort();
  const children = await Promise.all(names.map((name) => digestPath(join(path, name))));
  return { entries: [`D:${path}`, ...children.flatMap((child) => child.entries)] };
}

const externalTargets = [
  {
    label: "real_vault_memories",
    path: join(homedir(), "Documents", "MemStore", "Memories")
  },
  {
    label: "real_vault_control",
    path: join(homedir(), "Documents", "MemStore", "_MemStore")
  },
  {
    label: "memstore_application_support",
    path: join(homedir(), "Library", "Application Support", "MemStore")
  },
  { label: "codex_config", path: join(homedir(), ".codex", "config.toml") },
  { label: "claude_settings", path: join(homedir(), ".claude", "settings.json") },
  {
    label: "memstore_remember_skill",
    path: join(homedir(), ".agents", "skills", "memstore-remember")
  },
  {
    label: "memstore_recall_skill",
    path: join(homedir(), ".agents", "skills", "memstore-recall")
  },
  {
    label: "memstore_repair_skill",
    path: join(homedir(), ".agents", "skills", "memstore-repair")
  },
  { label: "launch_agents", path: join(homedir(), "Library", "LaunchAgents") }
] as const;

const claimToEvidence = [
  {
    claim: "runtime_compatible",
    evidence: ["tests/contract/runtime-compatibility.test.ts"]
  },
  {
    claim: "configuration_safe",
    evidence: ["tests/contract/initialization.test.ts"]
  },
  {
    claim: "project_identity_conservative",
    evidence: ["tests/integration/projects/project-resolution.test.ts"]
  },
  {
    claim: "capture_is_durable_and_fail_open",
    evidence: [
      "tests/contract/codex-hook.test.ts",
      "tests/integration/outbox/capture.test.ts",
      "tests/fault/outbox-replay.test.ts"
    ]
  },
  {
    claim: "secrets_are_excluded_from_durable_content",
    evidence: [
      "tests/integration/outbox/capture.test.ts",
      "tests/integration/vault/canonical-memory.test.ts"
    ]
  },
  {
    claim: "human_authority_preserved",
    evidence: [
      "tests/integration/vault/canonical-memory.test.ts",
      "tests/fault/vault-cas.test.ts"
    ]
  },
  {
    claim: "program_data_separated",
    evidence: ["tests/contract/program-data-separation.test.ts"]
  }
] as const;

const knownRisks = [
  {
    id: "node_sqlite_experimental",
    treatment:
      "Accepted for Gate 3 and covered by the pinned Node runtime compatibility test."
  },
  {
    id: "bounded_check_to_rename_race",
    treatment:
      "Accepted lightweight MVP risk; reconciliation prevents stale Agent revisions before writes and repairs detectable divergence."
  },
  {
    id: "future_native_transformer_dependencies",
    treatment:
      "No transformer runtime is activated in Gate 3; native build and license review remains an Outcome 6 gate."
  },
  {
    id: "outcome_6_integrations_not_active",
    treatment:
      "No global hooks, skills, launch agents, real Vault writes, or application-support state are installed by Gate 3."
  }
] as const;

async function snapshotExternalTargets(): Promise<readonly TargetSnapshot[]> {
  return Promise.all(
    externalTargets.map(async (target) => {
      const digest = await digestPath(target.path);
      return {
        ...target,
        state: digest.entries.length === 0 ? "absent" : "present",
        entryCount: digest.entries.length,
        digest: digest.entries.length === 0 ? null : hash(digest.entries.join("\n"))
      } as const;
    })
  );
}

const packageSource = await readFile(join(repositoryRoot, "package.json"), "utf8");
const lockfileSource = await readFile(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
const gitStatusBefore = readGitStatus();
const gitHead = runGit(["rev-parse", "HEAD"]).trim();
const trackedDiff = runGit(["diff", "--binary", "HEAD", "--"]);
const sourceManifest = await createSourceManifest();
const externalTargetsBefore = await snapshotExternalTargets();
const repositoryEvidence = {
  root: repositoryRoot,
  head: gitHead,
  packageSha256: hash(packageSource),
  lockfileSha256: hash(lockfileSource),
  trackedDiffSha256: hash(trackedDiff),
  trackedDiffBytes: Buffer.byteLength(trackedDiff),
  gitStatusBefore,
  sourceManifest
};

await mkdir(evidenceDirectory, { recursive: true });
await writeFile(
  evidencePath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      gate: 3,
      generatedAt: new Date().toISOString(),
      phase: "running",
      passed: false,
      repository: repositoryEvidence,
      claimToEvidence,
      knownRisks,
      results: []
    },
    null,
    2
  )}\n`,
  "utf8"
);

const results = steps.map(runStep);
const externalTargetsAfter = await snapshotExternalTargets();
const gitStatusAfter = readGitStatus();
const externalTargetsUnchanged =
  JSON.stringify(externalTargetsBefore) === JSON.stringify(externalTargetsAfter);
const passed =
  results.every((result) => result.exitCode === 0) && externalTargetsUnchanged;
const evidence = {
  schemaVersion: 1,
  gate: 3,
  generatedAt: new Date().toISOString(),
  passed,
  environment: {
    node: process.versions.node,
    platform: process.platform,
    architecture: process.arch
  },
  repository: {
    ...repositoryEvidence,
    gitStatusAfter
  },
  claimToEvidence,
  knownRisks,
  machineEffectBoundary: {
    externalTargetsUnchanged,
    before: externalTargetsBefore,
    after: externalTargetsAfter,
    testDataLocation: "operating-system temporary directories",
    limitation:
      "The Vault snapshot covers the reviewed default real-Vault path from the specification; no undisclosed Vault path is inferred or scanned."
  },
  results
};

await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

for (const result of results) {
  const state = result.exitCode === 0 ? "PASS" : "FAIL";
  process.stdout.write(
    `${state} ${result.name} (${String(result.durationMilliseconds)} ms, exit ${String(result.exitCode)})\n`
  );
}
process.stdout.write(`Evidence: ${evidencePath}\n`);
process.exitCode = passed ? 0 : 1;
