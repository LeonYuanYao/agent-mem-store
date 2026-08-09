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
import { parse } from "smol-toml";
import { z } from "zod";

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

interface TargetSnapshot {
  readonly label: string;
  readonly path: string;
  readonly state: "absent" | "present";
  readonly entryCount: number;
  readonly digest: string | null;
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const evidenceDirectory = join(repositoryRoot, "artifacts", "evidence");
const evidencePath = join(evidenceDirectory, "gate4.json");
const latencyPath = join(evidenceDirectory, "gate4-latency.json");
const embeddingPath = join(evidenceDirectory, "gate4-embedding.json");
const maximumTailCharacters = 1_000_000;

const steps: readonly EvidenceStep[] = [
  { name: "frozen_install", executable: "pnpm", arguments: ["install", "--frozen-lockfile"] },
  { name: "lint", executable: "pnpm", arguments: ["lint"] },
  { name: "typecheck", executable: "pnpm", arguments: ["typecheck"] },
  { name: "test", executable: "pnpm", arguments: ["test"] },
  { name: "build", executable: "pnpm", arguments: ["build"] },
  {
    name: "native_notifier_test",
    executable: "swift",
    arguments: ["test", "--package-path", "native/memstore-notifier"]
  },
  {
    name: "shadow_latency",
    executable: "pnpm",
    arguments: ["exec", "tsx", "scripts/benchmark-shadow-latency.ts", "--output", latencyPath]
  },
  {
    name: "embedding_benchmark",
    executable: "pnpm",
    arguments: ["exec", "tsx", "scripts/benchmark-retrieval.ts", "--output", embeddingPath]
  },
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
    maxBuffer: 32 * 1024 * 1024
  });
  return {
    name: step.name,
    command: [step.executable, ...step.arguments].map(shellQuote).join(" "),
    exitCode: result.status,
    signal: result.signal,
    durationMilliseconds: Math.round(performance.now() - startedAt),
    stdoutSha256: hash(result.stdout),
    stderrSha256: hash(result.stderr),
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr)
  };
}

function runGit(arguments_: readonly string[]): string {
  const result = spawnSync("git", arguments_, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Git command failed: git ${arguments_.join(" ")}\n${result.stderr}`);
  }
  return result.stdout;
}

async function createSourceManifest(): Promise<readonly SourceManifestEntry[]> {
  const paths = runGit(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();
  return Promise.all(paths.map(async (path) => {
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
  }));
}

async function digestPath(path: string): Promise<{ readonly entries: readonly string[] }> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
    throw error;
  }
  if (metadata.isSymbolicLink()) return { entries: [`L:${path}:${await readlink(path)}`] };
  if (metadata.isFile()) {
    return { entries: [`F:${path}:${String(metadata.mode & 0o777)}:${hash(await readFile(path))}`] };
  }
  if (!metadata.isDirectory()) return { entries: [`O:${path}`] };
  const names = (await readdir(path)).sort();
  const children = await Promise.all(names.map((name) => digestPath(join(path, name))));
  return { entries: [`D:${path}`, ...children.flatMap((child) => child.entries)] };
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

const vaultRoot = await discoverVaultRoot();
const applicationSupport = join(homedir(), "Library", "Application Support", "MemStore");
const codexConfigPath = join(homedir(), ".codex", "config.toml");
const codexHooksPath = join(homedir(), ".codex", "hooks.json");
const launchAgentPath = join(
  homedir(),
  "Library",
  "LaunchAgents",
  "com.leonyuanyaoyao.memstore.worker.plist"
);

const externalTargets = [
  { label: "real_vault_memories", path: join(vaultRoot, "Memories") },
  { label: "real_vault_control", path: join(vaultRoot, "_MemStore") },
  { label: "memstore_application_support", path: applicationSupport },
  { label: "codex_config", path: codexConfigPath },
  { label: "codex_hooks", path: codexHooksPath },
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
  { label: "memstore_launch_agent", path: launchAgentPath }
] as const;

async function snapshotExternalTargets(): Promise<readonly TargetSnapshot[]> {
  return Promise.all(externalTargets.map(async (target) => {
    const digest = await digestPath(target.path);
    return {
      ...target,
      state: digest.entries.length === 0 ? "absent" : "present",
      entryCount: digest.entries.length,
      digest: digest.entries.length === 0 ? null : hash(digest.entries.join("\n"))
    } as const;
  }));
}

function record(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}

async function codexTopology() {
  const config = record(parse(await readFile(codexConfigPath, "utf8")));
  const memories = record(config.memories);
  const mcpServers = record(config.mcp_servers);
  const hooksDocument = record(JSON.parse(await readFile(codexHooksPath, "utf8")));
  const hooks = record(hooksDocument.hooks);
  const hookEntryCounts = Object.fromEntries(Object.entries(hooks).map(([event, groups]) => [
    event,
    Array.isArray(groups) ? groups.length : 0
  ]));
  return {
    mcpServerNames: Object.keys(mcpServers).sort(),
    hookEntryCounts,
    nativeMemory: {
      generateMemories: memories.generate_memories,
      useMemories: memories.use_memories,
      disableOnExternalContext: memories.disable_on_external_context
    }
  };
}

const claimToEvidence = [
  {
    claim: "complete_uninstalled_shadow_loop",
    evidence: ["tests/e2e/gate4-shadow-loop.test.ts"]
  },
  {
    claim: "luna_candidate_and_human_authority",
    evidence: [
      "tests/e2e/distillation.test.ts",
      "tests/integration/lifecycle/semantic-worker.test.ts",
      "tests/integration/lifecycle/human-conflict-worker.test.ts"
    ]
  },
  {
    claim: "retrieval_and_mcp_are_shadow_only",
    evidence: [
      "tests/integration/retrieval/shadow-packs.test.ts",
      "tests/contract/mcp/parity.test.ts",
      "tests/contract/mcp/stdio.test.ts"
    ]
  },
  {
    claim: "governance_review_and_notification_are_durable",
    evidence: [
      "tests/integration/governance/governance-run.test.ts",
      "tests/integration/governance/monthly-audit.test.ts",
      "tests/integration/review/review-inbox.test.ts",
      "tests/integration/review/reminder-delivery.test.ts",
      "tests/fault/recovery/reminder-retry.test.ts"
    ]
  },
  {
    claim: "failure_exercises",
    evidence: [
      "tests/integration/outbox/capture.test.ts",
      "tests/fault/outbox-replay.test.ts",
      "tests/fault/automatic-retrieval.test.ts",
      "tests/fault/luna-health.test.ts",
      "tests/fault/luna-worker.test.ts",
      "tests/fault/vault-cas.test.ts",
      "tests/fault/index.test.ts",
      "tests/fault/governance/governance-checkpoint.test.ts",
      "tests/fault/governance/governance-retry.test.ts"
    ]
  },
  {
    claim: "portable_recovery_without_runtime_import",
    evidence: [
      "tests/e2e/portability/vault-handoff.test.ts",
      "tests/fault/recovery/runtime-backup.test.ts"
    ]
  },
  {
    claim: "automatic_injection_disabled",
    evidence: [
      "tests/e2e/gate4-shadow-loop.test.ts",
      "tests/integration/retrieval/shadow-packs.test.ts"
    ]
  }
] as const;

const unresolvedLimitations = [
  {
    id: "archive_purge_not_executable",
    boundary: "Outcome 11 records future purge obligations only; Outcome 12 implements reviewed execution."
  },
  {
    id: "bad_case_repair_not_implemented",
    boundary: "Bad Cases are retained and reported; the user-started GPT-5.6 repair Skill is Outcome 13."
  },
  {
    id: "native_notification_manual_proof_pending",
    boundary: "Swift contracts pass, but permission, live delivery, click callback, and Obsidian opening require pre-install manual proof."
  },
  {
    id: "embedding_quality_is_synthetic",
    boundary: "E5-base q8 evidence uses a small synthetic corpus and cannot substitute for the official seven-day Shadow labels."
  },
  {
    id: "node_sqlite_experimental",
    boundary: "Node 22 still labels node:sqlite experimental; pinned compatibility, WAL, FTS5, backup, and fault tests pass."
  }
] as const;

const topologyBefore = await codexTopology();
const machineEffectPreview = {
  previewOnly: true,
  installationAuthorized: false,
  vaultRoot,
  automaticInjection: "disabled",
  codexNativeMemoryChange: "none",
  existingCodexTopology: topologyBefore,
  effects: [
    {
      target: join(vaultRoot, "_MemStore", "policy.toml"),
      operation: "create_if_absent_after_validation",
      ownership: "memstore_owned"
    },
    {
      target: join(vaultRoot, "Memories", "Global"),
      operation: "create_canonical_directory",
      ownership: "memstore_owned"
    },
    {
      target: join(vaultRoot, "Memories", "Projects"),
      operation: "create_canonical_directory",
      ownership: "memstore_owned"
    },
    {
      target: applicationSupport,
      operation: "create_mode_0700_runtime_config_sqlite_indexes_logs_manifests",
      ownership: "memstore_owned"
    },
    {
      target: join(applicationSupport, "models", "multilingual-e5-base-q8"),
      operation: "install_reviewed_embedding_artifact_after_checksum_verification",
      ownership: "memstore_owned"
    },
    {
      target: join(applicationSupport, "bin", "memstore-notifier"),
      operation: "install_signed_or_locally_built_notifier_after_manual_proof",
      ownership: "memstore_owned"
    },
    {
      target: codexHooksPath,
      operation: "managed_append_one_entry_to_SessionStart_UserPromptSubmit_PostToolUse_Stop_SessionEnd_preserving_all_existing_entries_no_PreToolUse",
      ownership: "memstore_owned"
    },
    {
      target: codexConfigPath,
      operation: "managed_add_mcp_servers.memstore_preserving_native_memories_and_existing_servers",
      ownership: "memstore_owned"
    },
    {
      target: join(homedir(), ".agents", "skills", "memstore-remember"),
      operation: `create_symlink_to_${join(repositoryRoot, "skills", "memstore-remember")}`,
      ownership: "memstore_owned"
    },
    {
      target: join(homedir(), ".agents", "skills", "memstore-recall"),
      operation: `create_symlink_to_${join(repositoryRoot, "skills", "memstore-recall")}`,
      ownership: "memstore_owned"
    },
    {
      target: launchAgentPath,
      operation: "create_worker_launch_agent_after_exact_plist_preview",
      ownership: "memstore_owned"
    }
  ],
  explicitNoEffects: [
    `${join(vaultRoot, ".obsidian")}: no change`,
    `${join(homedir(), ".claude", "settings.json")}: no change in Codex development Shadow`,
    `${codexHooksPath}: no PreToolUse entry and no existing-entry rewrite`,
    `${codexConfigPath}: no change to memories.generate_memories or memories.use_memories`,
    "No automatic Memory injection during development Shadow"
  ]
} as const;

const managedOwnershipDesign = {
  manifestPath: join(applicationSupport, "install", "ownership-manifest.json"),
  manifestFields: [
    "schema_version",
    "installation_id",
    "target",
    "kind",
    "preexisting_identity",
    "expected_post_identity",
    "backup_path",
    "created_at"
  ],
  writeProtocol: [
    "parse and validate current document",
    "compute exact managed diff",
    "strict preview with zero mutation",
    "revision compare-and-swap",
    "timestamped recoverable backup",
    "atomic replacement",
    "parse and ownership read-back"
  ],
  rollbackProtocol: [
    "operate only on manifest-owned entries",
    "restore an edited file only when current identity matches expected post identity",
    "remove a symlink only when its target still matches",
    "never delete Vault, Runtime Data, unrelated hooks, MCP servers, Skills, or native-memory data",
    "abort on concurrent or user-authored divergence"
  ]
} as const;

const packageSource = await readFile(join(repositoryRoot, "package.json"), "utf8");
const lockfileSource = await readFile(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
const sourceManifest = await createSourceManifest();
const trackedDiff = runGit(["diff", "--binary", "HEAD", "--"]);
const repositoryEvidence = {
  root: repositoryRoot,
  head: runGit(["rev-parse", "HEAD"]).trim(),
  branch: runGit(["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
  packageSha256: hash(packageSource),
  lockfileSha256: hash(lockfileSource),
  trackedDiffSha256: hash(trackedDiff),
  trackedDiffBytes: Buffer.byteLength(trackedDiff),
  gitStatusBefore: runGit(["status", "--short"]),
  sourceManifest
};
const externalTargetsBefore = await snapshotExternalTargets();

await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
await writeFile(evidencePath, `${JSON.stringify({
  schemaVersion: 1,
  gate: 4,
  generatedAt: new Date().toISOString(),
  phase: "running",
  passed: false,
  repository: repositoryEvidence,
  claimToEvidence,
  machineEffectPreview,
  managedOwnershipDesign,
  unresolvedLimitations,
  results: []
}, null, 2)}\n`, { mode: 0o600 });

const results = steps.map(runStep);
const [externalTargetsAfter, topologyAfter] = await Promise.all([
  snapshotExternalTargets(),
  codexTopology()
]);
const externalTargetsUnchanged =
  JSON.stringify(externalTargetsBefore) === JSON.stringify(externalTargetsAfter);
const codexTopologyUnchanged = JSON.stringify(topologyBefore) === JSON.stringify(topologyAfter);

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

let latencyEvidence: unknown = null;
let embeddingEvidence: unknown = null;
try {
  latencyEvidence = await readJson(latencyPath);
} catch {
  latencyEvidence = { unavailable: true };
}
try {
  embeddingEvidence = await readJson(embeddingPath);
} catch {
  embeddingEvidence = { unavailable: true };
}
const latencyPassed = record(latencyEvidence).passed === true;
const embeddingDocument = record(embeddingEvidence);
const embeddingResults = Array.isArray(embeddingDocument.results)
  ? embeddingDocument.results.map(record)
  : [];
const reviewedEmbeddingPresent = embeddingResults.some((result) =>
  result.role === "quality" &&
  result.modelIdentity === "onnx-community/multilingual-e5-base-ONNX" &&
  result.dtype === "q8"
);
const passed = results.every((result) => result.exitCode === 0) &&
  externalTargetsUnchanged && codexTopologyUnchanged && latencyPassed &&
  reviewedEmbeddingPresent;

const evidence = {
  schemaVersion: 1,
  gate: 4,
  generatedAt: new Date().toISOString(),
  phase: "complete",
  passed,
  environment: {
    node: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    vaultDiscovery: "Obsidian registered open Vault"
  },
  repository: {
    ...repositoryEvidence,
    gitStatusAfter: runGit(["status", "--short"])
  },
  claimToEvidence,
  machineEffectPreview,
  managedOwnershipDesign,
  unresolvedLimitations,
  qualityEvidence: {
    latency: latencyEvidence,
    embedding: embeddingEvidence
  },
  machineEffectBoundary: {
    externalTargetsUnchanged,
    codexTopologyUnchanged,
    before: externalTargetsBefore,
    after: externalTargetsAfter,
    nativeMemoryBefore: topologyBefore.nativeMemory,
    nativeMemoryAfter: topologyAfter.nativeMemory,
    testDataLocation: "repository artifacts and operating-system temporary directories",
    realNotificationDelivered: false,
    realLunaInvoked: false,
    realVaultWritten: false
  },
  results
};
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });

for (const result of results) {
  const state = result.exitCode === 0 ? "PASS" : "FAIL";
  process.stdout.write(
    `${state} ${result.name} (${String(result.durationMilliseconds)} ms, exit ${String(result.exitCode)})\n`
  );
}
process.stdout.write(`External targets unchanged: ${String(externalTargetsUnchanged)}\n`);
process.stdout.write(`Codex topology unchanged: ${String(codexTopologyUnchanged)}\n`);
process.stdout.write(`Evidence: ${evidencePath}\n`);
process.exitCode = passed ? 0 : 1;
