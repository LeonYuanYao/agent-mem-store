import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rmdir,
  symlink,
  unlink
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

import { writeFileAtomically } from "../contracts/atomic-file.js";
import { initializeMemStore } from "../operations/initialize.js";

const candidateSchema = z.object({
  schemaVersion: z.literal(1),
  candidateId: z.literal("gate5-shadow-v1"),
  mode: z.literal("shadow"),
  embedding: z.object({
    modelIdentity: z.literal("onnx-community/multilingual-e5-base-ONNX"),
    dtype: z.literal("q8"),
    artifactSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    dimensions: z.literal(768),
    normalization: z.literal("l2"),
    batchSize: z.literal(16),
    adapterVersion: z.literal("transformers-4.2.0:q8:mean-l2:batch16:v2"),
    queryPrefix: z.literal("query: "),
    documentPrefix: z.literal("passage: "),
    installation: z.object({
      managedRuntimePath: z.literal("models/e5-base-q8"),
      localFilesOnlyAtRuntime: z.literal(true),
      rejectArtifactDrift: z.literal(true)
    }),
    semanticOnlyMinimumScore: z.literal(0.82),
    semanticOnlyMinimumTop1Margin: z.literal(0.02)
  }),
  luna: z.object({
    provider: z.literal("codex_cli"),
    model: z.literal("gpt-5.6-luna"),
    ephemeral: z.literal(true),
    sandbox: z.literal("read-only"),
    fallbackModel: z.null(),
    timeoutMilliseconds: z.literal(120000),
    maximumConcurrency: z.literal(1),
    authentication: z.literal("named_codex_home_reference")
  }),
  retrieval: z.object({
    sessionStart: z.object({
      tokenLimit: z.literal(1200),
      alwaysTokenLimit: z.literal(600),
      itemLimit: z.literal(12),
      identityLimit: z.literal(4)
    }),
    userPrompt: z.object({
      targetTokens: z.literal(600),
      perTurnHardLimit: z.literal(1024),
      itemLimit: z.literal(6),
      maxProbableItems: z.literal(2),
      semanticDeadlineMilliseconds: z.literal(300)
    }),
    contextEpoch: z.object({
      softTargetTokens: z.literal(8192),
      hardLimitTokens: z.literal(12288),
      shadowSoftTargetComparisons: z.tuple([z.literal(4096), z.literal(8192), z.literal(12288), z.literal(16384)]),
      shadowProbableItemComparisons: z.tuple([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
    })
  }),
  automaticInjection: z.literal(false),
  nativeMemory: z.object({
    generateMemories: z.literal("preserve"),
    useMemories: z.literal("preserve"),
    import: z.literal(false),
    delete: z.literal(false)
  }),
  hookEvents: z.array(z.enum(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"])).length(5),
  excludedHookEvents: z.tuple([z.literal("PreToolUse")]),
  hookContract: z.object({
    provider: z.literal("codex"),
    eventIdentity: z.literal("local_from_official_fields"),
    receivedAt: z.literal("local_clock"),
    captureOnly: z.literal(true),
    failureVisibility: z.literal("systemMessage")
  }),
  skills: z.tuple([
    z.literal("memstore-remember"),
    z.literal("memstore-recall"),
    z.literal("memstore-repair")
  ]),
  notifier: z.object({
    source: z.literal("native/memstore-notifier"),
    manualNotificationProofRequiredBeforeLiveInstall: z.literal(true)
  }),
  worker: z.object({
    launchAgentLabel: z.literal("com.leonyuanyaoyao.memstore.worker"),
    missedRunCatchUp: z.literal(true)
  })
});

type Candidate = z.infer<typeof candidateSchema>;
type ManagedRequest = {
  readonly homeRoot: string;
  readonly repositoryRoot: string;
  readonly vaultRoot: string;
  readonly runtimeRoot: string;
  readonly notifierSource: string;
  readonly nodeExecutable: string;
  readonly lunaCodexHome?: string;
  readonly codexExecutable?: string;
  readonly embeddingModelDirectory?: string;
  readonly installedAt: string;
};

type PathIdentity =
  | { readonly state: "absent" }
  | { readonly state: "file"; readonly sha256: string }
  | { readonly state: "symlink"; readonly target: string }
  | { readonly state: "directory" }
  | { readonly state: "other" };

interface PlannedTarget {
  readonly label: string;
  readonly path: string;
  readonly kind: "structured_file" | "owned_file" | "owned_symlink" | "owned_directory" | "guard";
  readonly before: PathIdentity;
  readonly expectedPost: PathIdentity;
  readonly expectedSource?: string;
  readonly expectedSourceBase64?: string;
  readonly linkTarget?: string;
  readonly writeMode?: number;
}

export interface ManagedIntegrationPreview {
  readonly schemaVersion: 1;
  readonly state: "preview";
  readonly dryRun: true;
  readonly candidateId: "gate5-shadow-v1";
  readonly installationId: string;
  readonly requestIdentity: string;
  readonly candidateSha256: string;
  readonly targets: readonly PlannedTarget[];
  readonly explicitNoEffects: readonly string[];
}

export interface ManagedIntegrationUpgradePreview {
  readonly schemaVersion: 1;
  readonly state: "upgrade_preview";
  readonly dryRun: true;
  readonly installationId: string;
  readonly requestIdentity: string;
  readonly targets: readonly PlannedTarget[];
  readonly observedDivergedTargetLabels: readonly string[];
  readonly explicitNoEffects: readonly string[];
}

interface OwnershipManifest {
  readonly schemaVersion: 1;
  readonly installationId: string;
  readonly candidateId: "gate5-shadow-v1";
  readonly state: "installed" | "uninstalled";
  readonly installedAt: string;
  readonly uninstalledAt?: string;
  readonly requestIdentity: string;
  readonly targets: readonly (PlannedTarget & { readonly backupPath?: string })[];
}

function sha256(source: string | Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}

function requestIdentity(request: ManagedRequest): string {
  return sha256(JSON.stringify({
    homeRoot: resolve(request.homeRoot),
    repositoryRoot: resolve(request.repositoryRoot),
    vaultRoot: resolve(request.vaultRoot),
    runtimeRoot: resolve(request.runtimeRoot),
    notifierSource: resolve(request.notifierSource),
    nodeExecutable: resolve(request.nodeExecutable),
    lunaCodexHome: request.lunaCodexHome === undefined
      ? null
      : resolve(request.lunaCodexHome),
    codexExecutable: request.codexExecutable ?? null,
    embeddingModelDirectory: request.embeddingModelDirectory === undefined
      ? null
      : resolve(request.embeddingModelDirectory)
  }));
}

async function loadCandidate(): Promise<{ readonly candidate: Candidate; readonly source: string; readonly sha256: string }> {
  const source = await readFile(new URL("../../config/gate5-shadow-v1.json", import.meta.url), "utf8");
  return { candidate: candidateSchema.parse(JSON.parse(source)), source, sha256: sha256(source) };
}

async function identity(path: string): Promise<PathIdentity> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return { state: "symlink", target: await readlink(path) };
    if (metadata.isFile()) return { state: "file", sha256: sha256(await readFile(path)) };
    if (metadata.isDirectory()) return { state: "directory" };
    return { state: "other" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    throw error;
  }
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function appendMemStoreMcp(source: string, request: ManagedRequest): string {
  if (/^\[mcp_servers\.memstore\]\s*$/mu.test(source)) {
    throw new Error("mcp_servers.memstore already exists without this installation ownership manifest.");
  }
  const mcpMain = join(resolve(request.repositoryRoot), "dist", "mcp", "main.js");
  const block = [
    "[mcp_servers.memstore]",
    `command = ${tomlString(resolve(request.nodeExecutable))}`,
    `args = [${tomlString(mcpMain)}]`,
    "startup_timeout_sec = 30",
    "",
    "[mcp_servers.memstore.env]",
    `MEMSTORE_RUNTIME_ROOT = ${tomlString(resolve(request.runtimeRoot))}`,
    `MEMSTORE_VAULT_ROOT = ${tomlString(resolve(request.vaultRoot))}`,
    ""
  ].join("\n");
  return `${source.trimEnd()}\n\n${block}`;
}

function managedHookGroup(request: ManagedRequest, event: Candidate["hookEvents"][number]) {
  const command = [
    "MEMSTORE_INJECTION_MODE=shadow",
    `MEMSTORE_RUNTIME_ROOT=${shellQuote(resolve(request.runtimeRoot))}`,
    `MEMSTORE_VAULT_ROOT=${shellQuote(resolve(request.vaultRoot))}`,
    shellQuote(resolve(request.nodeExecutable)),
    shellQuote(join(resolve(request.repositoryRoot), "dist", "cli", "hook.js")),
    "codex",
    event,
    `# memstore:gate5-shadow-v1:${event}:shadow`
  ].join(" ");
  return {
    matcher: "*",
    hooks: [{ type: "command", command, timeout: event === "SessionEnd" ? 3 : 1 }]
  };
}

function appendManagedHooks(source: string, request: ManagedRequest, candidate: Candidate): string {
  const document = z.record(z.string(), z.unknown()).parse(JSON.parse(source));
  const hooks = z.record(z.string(), z.unknown()).parse(document.hooks);
  for (const event of candidate.hookEvents) {
    const existing = z.array(z.unknown()).default([]).parse(hooks[event]);
    const marker = `memstore:gate5-shadow-v1:${event}:`;
    if (JSON.stringify(existing).includes(marker)) {
      throw new Error(`Managed ${event} Hook already exists without this installation ownership manifest.`);
    }
    hooks[event] = [...existing, managedHookGroup(request, event)];
  }
  document.hooks = hooks;
  return `${JSON.stringify(document, null, 2)}\n`;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function launchAgentSource(request: ManagedRequest): string {
  const arguments_ = [
    resolve(request.nodeExecutable),
    join(resolve(request.repositoryRoot), "dist", "cli", "main.js"),
    "worker",
    "run",
    "--vault",
    resolve(request.vaultRoot),
    "--runtime",
    resolve(request.runtimeRoot)
  ];
  const environment = {
    ...(request.lunaCodexHome === undefined
      ? {}
      : { MEMSTORE_LUNA_CODEX_HOME: resolve(request.lunaCodexHome) }),
    ...(request.codexExecutable === undefined
      ? {}
      : { MEMSTORE_CODEX_EXECUTABLE: request.codexExecutable }),
    ...(request.embeddingModelDirectory === undefined
      ? {}
      : { MEMSTORE_EMBEDDING_MODEL_DIR: resolve(request.embeddingModelDirectory) }),
    MEMSTORE_NOTIFIER_EXECUTABLE: join(
      resolve(request.runtimeRoot),
      "bin",
      "MemStore Notifier.app",
      "Contents",
      "MacOS",
      "memstore-notifier"
    ),
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.leonyuanyaoyao.memstore.worker</string>
  <key>ProgramArguments</key><array>${arguments_.map((value) => `<string>${xmlEscape(value)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`).join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
`;
}

function requireInstallableBefore(path: string, before: PathIdentity): void {
  if (before.state !== "absent") {
    throw new Error(`Managed target already exists and is not owned: ${path}.`);
  }
}

async function plannedCliTarget(request: ManagedRequest): Promise<PlannedTarget> {
  const path = join(resolve(request.homeRoot), ".local", "bin", "memstore");
  const source = `#!/bin/sh\nexec ${shellQuote(resolve(request.nodeExecutable))} ${shellQuote(join(resolve(request.repositoryRoot), "dist", "cli", "main.js"))} "$@"\n`;
  return {
    label: "memstore_cli",
    path,
    kind: "owned_file",
    before: await identity(path),
    expectedPost: { state: "file", sha256: sha256(source) },
    expectedSource: source,
    writeMode: 0o700
  };
}

export async function previewManagedIntegration(request: ManagedRequest): Promise<ManagedIntegrationPreview> {
  z.iso.datetime().parse(request.installedAt);
  const { candidate, sha256: candidateSha256 } = await loadCandidate();
  const configPath = join(resolve(request.homeRoot), ".codex", "config.toml");
  const hooksPath = join(resolve(request.homeRoot), ".codex", "hooks.json");
  const notifierSourceRoot = resolve(request.notifierSource);
  const [configSource, hooksSource, notifier, notifierPlist, notifierCodeResources] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(hooksPath, "utf8"),
    readFile(join(notifierSourceRoot, "Contents", "MacOS", "memstore-notifier")),
    readFile(join(notifierSourceRoot, "Contents", "Info.plist")),
    readFile(join(notifierSourceRoot, "Contents", "_CodeSignature", "CodeResources"))
  ]);
  const expectedConfig = appendMemStoreMcp(configSource, request);
  const expectedHooks = appendManagedHooks(hooksSource, request, candidate);
  const hooksAliasIdentity = await identity(hooksPath);
  const hooksTargetPath = hooksAliasIdentity.state === "symlink"
    ? await realpath(hooksPath)
    : hooksPath;
  const notifierBundlePath = join(resolve(request.runtimeRoot), "bin", "MemStore Notifier.app");
  const notifierContentsPath = join(notifierBundlePath, "Contents");
  const notifierMacOsPath = join(notifierContentsPath, "MacOS");
  const notifierSignaturePath = join(notifierContentsPath, "_CodeSignature");
  const notifierPath = join(notifierMacOsPath, "memstore-notifier");
  const notifierPlistPath = join(notifierContentsPath, "Info.plist");
  const notifierCodeResourcesPath = join(notifierSignaturePath, "CodeResources");
  const launchPath = join(resolve(request.homeRoot), "Library", "LaunchAgents", "com.leonyuanyaoyao.memstore.worker.plist");
  const launchSource = launchAgentSource(request);
  const targets: PlannedTarget[] = [
    {
      label: "codex_config",
      path: configPath,
      kind: "structured_file",
      before: { state: "file", sha256: sha256(configSource) },
      expectedPost: { state: "file", sha256: sha256(expectedConfig) },
      expectedSource: expectedConfig
    },
    ...(hooksAliasIdentity.state === "symlink"
      ? [{
          label: "codex_hooks_link",
          path: hooksPath,
          kind: "guard" as const,
          before: hooksAliasIdentity,
          expectedPost: hooksAliasIdentity
        }]
      : []),
    {
      label: "codex_hooks",
      path: hooksTargetPath,
      kind: "structured_file",
      before: { state: "file", sha256: sha256(hooksSource) },
      expectedPost: { state: "file", sha256: sha256(expectedHooks) },
      expectedSource: expectedHooks
    },
    {
      label: "notifier_bundle",
      path: notifierBundlePath,
      kind: "owned_directory",
      before: await identity(notifierBundlePath),
      expectedPost: { state: "directory" }
    },
    {
      label: "notifier_contents",
      path: notifierContentsPath,
      kind: "owned_directory",
      before: await identity(notifierContentsPath),
      expectedPost: { state: "directory" }
    },
    {
      label: "notifier_macos",
      path: notifierMacOsPath,
      kind: "owned_directory",
      before: await identity(notifierMacOsPath),
      expectedPost: { state: "directory" }
    },
    {
      label: "notifier_signature",
      path: notifierSignaturePath,
      kind: "owned_directory",
      before: await identity(notifierSignaturePath),
      expectedPost: { state: "directory" }
    },
    {
      label: "notifier",
      path: notifierPath,
      kind: "owned_file",
      before: await identity(notifierPath),
      expectedPost: { state: "file", sha256: sha256(notifier) },
      expectedSourceBase64: notifier.toString("base64")
    },
    {
      label: "notifier_info_plist",
      path: notifierPlistPath,
      kind: "owned_file",
      before: await identity(notifierPlistPath),
      expectedPost: { state: "file", sha256: sha256(notifierPlist) },
      expectedSourceBase64: notifierPlist.toString("base64")
    },
    {
      label: "notifier_code_resources",
      path: notifierCodeResourcesPath,
      kind: "owned_file",
      before: await identity(notifierCodeResourcesPath),
      expectedPost: { state: "file", sha256: sha256(notifierCodeResources) },
      expectedSourceBase64: notifierCodeResources.toString("base64")
    },
    {
      label: "launch_agent",
      path: launchPath,
      kind: "owned_file",
      before: await identity(launchPath),
      expectedPost: { state: "file", sha256: sha256(launchSource) },
      expectedSource: launchSource
    },
    await plannedCliTarget(request)
  ];
  for (const skill of candidate.skills) {
    const path = join(resolve(request.homeRoot), ".agents", "skills", skill);
    const target = join(resolve(request.repositoryRoot), "skills", skill);
    targets.push({
      label: `skill_${skill}`,
      path,
      kind: "owned_symlink",
      before: await identity(path),
      expectedPost: { state: "symlink", target },
      linkTarget: target
    });
  }
  for (const target of targets.filter((item) =>
    item.kind === "owned_file" || item.kind === "owned_symlink" || item.kind === "owned_directory"
  )) {
    requireInstallableBefore(target.path, target.before);
  }
  return {
    schemaVersion: 1,
    state: "preview",
    dryRun: true,
    candidateId: candidate.candidateId,
    installationId: `msinstall_${randomUUID()}`,
    requestIdentity: requestIdentity(request),
    candidateSha256,
    targets,
    explicitNoEffects: [
      "No PreToolUse Hook",
      "No native-memory setting change",
      "No native-memory import, read, move, or deletion",
      "No automatic foreground injection in Shadow",
      "No unrelated Hook, MCP, plugin, or Skill change"
    ]
  };
}

async function writeBufferAtomically(path: string, source: Buffer, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", mode);
  let committed = false;
  try {
    await handle.writeFile(source);
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, path);
    committed = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!committed) await unlink(temporaryPath).catch(() => undefined);
  }
}

function backupPath(runtimeRoot: string, installationId: string, target: PlannedTarget): string {
  return join(resolve(runtimeRoot), "install", "backups", installationId, `${target.label}.backup`);
}

async function preflightTargets(targets: readonly PlannedTarget[], expected: "before" | "expectedPost"): Promise<void> {
  for (const target of targets) {
    const current = await identity(target.path);
    if (!sameIdentity(current, target[expected])) {
      throw new Error(`${target.label} diverged; aborting before mutation.`);
    }
  }
}

async function divergedTargetLabels(targets: readonly PlannedTarget[]): Promise<readonly string[]> {
  const labels: string[] = [];
  for (const target of targets) {
    if (!sameIdentity(await identity(target.path), target.expectedPost)) labels.push(target.label);
  }
  return labels;
}

async function writeManifest(runtimeRoot: string, manifest: OwnershipManifest): Promise<void> {
  const path = join(resolve(runtimeRoot), "install", "ownership-manifest.json");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const source = `${JSON.stringify(manifest, null, 2)}\n`;
  const current = await identity(path);
  await writeFileAtomically(
    path,
    source,
    0o600,
    current.state === "file" ? current.sha256 : undefined
  );
}

async function readManifest(runtimeRoot: string): Promise<OwnershipManifest> {
  const source = await readFile(join(resolve(runtimeRoot), "install", "ownership-manifest.json"), "utf8");
  return z.custom<OwnershipManifest>((value) => typeof value === "object" && value !== null)
    .parse(JSON.parse(source));
}

async function applyTarget(target: PlannedTarget): Promise<void> {
  if (target.kind === "guard") return;
  if (target.kind === "owned_directory") {
    await mkdir(dirname(target.path), { recursive: true, mode: 0o700 });
    await mkdir(target.path, { recursive: false, mode: 0o700 });
    return;
  }
  await mkdir(dirname(target.path), { recursive: true, mode: 0o700 });
  if (target.kind === "owned_symlink") {
    await symlink(z.string().parse(target.linkTarget), target.path);
    return;
  }
  if (target.expectedSourceBase64 !== undefined) {
    await writeBufferAtomically(target.path, Buffer.from(target.expectedSourceBase64, "base64"), 0o755);
    return;
  }
  const source = z.string().parse(target.expectedSource);
  if (target.kind === "structured_file") {
    await writeFileAtomically(
      target.path,
      source,
      0o600,
      target.before.state === "file" ? target.before.sha256 : undefined
    );
    return;
  }
  await writeFileAtomically(target.path, source, target.writeMode ?? 0o600);
}

export async function applyManagedIntegration(
  request: ManagedRequest,
  preview: ManagedIntegrationPreview
): Promise<{ readonly state: "installed"; readonly installationId: string; readonly manifestPath: string }> {
  if (preview.requestIdentity !== requestIdentity(request)) throw new Error("Managed preview does not match this request.");
  const fresh = await previewManagedIntegration(request);
  if (fresh.candidateSha256 !== preview.candidateSha256 ||
      JSON.stringify(fresh.targets) !== JSON.stringify(preview.targets)) {
    throw new Error("Managed integration inputs diverged after preview; generate a fresh preview.");
  }
  await preflightTargets(preview.targets, "before");
  await initializeMemStore({ vaultRoot: request.vaultRoot, runtimeRoot: request.runtimeRoot, preview: false });
  const manifestTargets: (PlannedTarget & { backupPath?: string })[] = [];
  for (const target of preview.targets) {
    let backup: string | undefined;
    if (target.before.state === "file") {
      backup = backupPath(request.runtimeRoot, preview.installationId, target);
      await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
      await copyFile(target.path, backup);
      await chmod(backup, 0o600);
    }
    await applyTarget(target);
    const current = await identity(target.path);
    if (!sameIdentity(current, target.expectedPost)) throw new Error(`${target.label} failed ownership read-back.`);
    manifestTargets.push({ ...target, ...(backup === undefined ? {} : { backupPath: backup }) });
  }
  const manifest: OwnershipManifest = {
    schemaVersion: 1,
    installationId: preview.installationId,
    candidateId: preview.candidateId,
    state: "installed",
    installedAt: request.installedAt,
    requestIdentity: preview.requestIdentity,
    targets: manifestTargets
  };
  await writeManifest(request.runtimeRoot, manifest);
  return {
    state: "installed",
    installationId: preview.installationId,
    manifestPath: join(resolve(request.runtimeRoot), "install", "ownership-manifest.json")
  };
}

export async function repairManagedIntegration(request: ManagedRequest): Promise<{
  readonly state: "healthy" | "repaired";
  readonly installationId: string;
}> {
  const manifest = await readManifest(request.runtimeRoot);
  if (manifest.state !== "installed") throw new Error("Managed integration is not installed.");
  if (manifest.requestIdentity !== requestIdentity(request)) throw new Error("Managed integration request diverged from its ownership manifest.");
  const repairable: PlannedTarget[] = [];
  for (const target of manifest.targets) {
    const current = await identity(target.path);
    if (sameIdentity(current, target.expectedPost)) continue;
    if (sameIdentity(current, target.before)) {
      repairable.push(target);
      continue;
    }
    throw new Error(`${target.label} diverged; repair cannot distinguish the change from user-authored state.`);
  }
  for (const target of repairable) await applyTarget(target);
  await preflightTargets(manifest.targets, "expectedPost");
  return {
    state: repairable.length === 0 ? "healthy" : "repaired",
    installationId: manifest.installationId
  };
}

export async function previewManagedIntegrationUpgrade(
  request: ManagedRequest
): Promise<ManagedIntegrationUpgradePreview> {
  const manifest = await readManifest(request.runtimeRoot);
  if (manifest.state !== "installed") throw new Error("Managed integration is not installed.");
  if (manifest.requestIdentity !== requestIdentity(request)) {
    throw new Error("Managed integration request diverged from its ownership manifest.");
  }
  const observedDivergedTargetLabels = await divergedTargetLabels(manifest.targets);
  if (manifest.targets.some((target) => target.label === "memstore_cli")) {
    return {
      schemaVersion: 1,
      state: "upgrade_preview",
      dryRun: true,
      installationId: manifest.installationId,
      requestIdentity: manifest.requestIdentity,
      targets: [],
      observedDivergedTargetLabels,
      explicitNoEffects: ["Installation already owns the MemStore CLI"]
    };
  }
  const cli = await plannedCliTarget(request);
  requireInstallableBefore(cli.path, cli.before);
  return {
    schemaVersion: 1,
    state: "upgrade_preview",
    dryRun: true,
    installationId: manifest.installationId,
    requestIdentity: manifest.requestIdentity,
    targets: [cli],
    observedDivergedTargetLabels,
    explicitNoEffects: [
      "No Codex config or Hook change",
      "No Vault or Runtime data change",
      "No worker restart"
    ]
  };
}

export async function applyManagedIntegrationUpgrade(
  request: ManagedRequest,
  preview: ManagedIntegrationUpgradePreview
): Promise<{ readonly state: "healthy" | "upgraded"; readonly installationId: string }> {
  if (preview.requestIdentity !== requestIdentity(request)) {
    throw new Error("Managed upgrade preview does not match this request.");
  }
  const manifest = await readManifest(request.runtimeRoot);
  if (manifest.state !== "installed" || manifest.installationId !== preview.installationId) {
    throw new Error("Managed installation changed after upgrade preview.");
  }
  const fresh = await previewManagedIntegrationUpgrade(request);
  if (
    JSON.stringify(fresh.targets) !== JSON.stringify(preview.targets) ||
    JSON.stringify(fresh.observedDivergedTargetLabels) !==
      JSON.stringify(preview.observedDivergedTargetLabels)
  ) {
    throw new Error("Managed upgrade inputs diverged after preview; generate a fresh preview.");
  }
  await preflightTargets(preview.targets, "before");
  for (const target of preview.targets) {
    await applyTarget(target);
  }
  await preflightTargets(preview.targets, "expectedPost");
  if (preview.targets.length > 0) {
    await writeManifest(request.runtimeRoot, {
      ...manifest,
      targets: [...manifest.targets, ...preview.targets]
    });
  }
  return {
    state: preview.targets.length === 0 ? "healthy" : "upgraded",
    installationId: manifest.installationId
  };
}

export async function uninstallManagedIntegration(request: {
  readonly homeRoot: string;
  readonly runtimeRoot: string;
  readonly uninstalledAt: string;
}): Promise<{ readonly state: "uninstalled"; readonly installationId: string }> {
  const uninstalledAt = z.iso.datetime().parse(request.uninstalledAt);
  const manifest = await readManifest(request.runtimeRoot);
  if (manifest.state !== "installed") throw new Error("Managed integration is not installed.");
  await preflightTargets(manifest.targets, "expectedPost");
  for (const target of [...manifest.targets].reverse()) {
    if (target.kind === "guard") continue;
    if (target.kind === "owned_directory") {
      await rmdir(target.path);
      continue;
    }
    if (target.before.state === "absent") {
      await unlink(target.path);
      continue;
    }
    if (target.before.state === "file" && target.backupPath !== undefined) {
      const source = await readFile(target.backupPath);
      await writeBufferAtomically(target.path, source, 0o600);
      continue;
    }
    throw new Error(`Unsupported owned uninstall state for ${target.label}.`);
  }
  await writeManifest(request.runtimeRoot, {
    ...manifest,
    state: "uninstalled",
    uninstalledAt
  });
  return { state: "uninstalled", installationId: manifest.installationId };
}

function replaceMemorySetting(source: string, key: "generate_memories" | "use_memories", value: boolean): string {
  const section = /^\[memories\]\s*$([\s\S]*?)(?=^\[[^\]]+\]\s*$|\s*$)/mu.exec(source);
  if (section === null) throw new Error("Codex config has no [memories] section.");
  const body = section[1] ?? "";
  const pattern = new RegExp(`^${key}\\s*=\\s*(?:true|false)\\s*$`, "mu");
  const replacement = `${key} = ${String(value)}`;
  const nextBody = pattern.test(body)
    ? body.replace(pattern, replacement)
    : `${body.trimEnd()}\n${replacement}\n`;
  return `${source.slice(0, section.index)}[memories]${nextBody}${source.slice(section.index + section[0].length)}`;
}

function activateInjectionHooks(source: string): string {
  return source
    .replaceAll("MEMSTORE_INJECTION_MODE=shadow", "MEMSTORE_INJECTION_MODE=active")
    .replaceAll(":shadow\"", ":active\"");
}

export async function rehearseNativeMemoryCutover(request: {
  readonly configPath: string;
  readonly hooksPath: string;
  readonly nativeStorePaths: readonly string[];
  readonly rehearsedAt: string;
}): Promise<{
  readonly cutover: { readonly generateMemories: false; readonly useMemories: false; readonly injectionMode: "active" };
  readonly rollback: { readonly restored: true };
  readonly nativeData: { readonly operation: "none"; readonly bodiesRead: 0; readonly locations: readonly { readonly path: string; readonly state: "present" | "absent" }[] };
}> {
  z.iso.datetime().parse(request.rehearsedAt);
  const [configSource, hooksSource] = await Promise.all([
    readFile(resolve(request.configPath), "utf8"),
    readFile(resolve(request.hooksPath), "utf8")
  ]);
  const cutoverConfig = replaceMemorySetting(
    replaceMemorySetting(configSource, "generate_memories", false),
    "use_memories",
    false
  );
  const cutoverHooks = activateInjectionHooks(hooksSource);
  if (cutoverHooks === hooksSource) throw new Error("No frozen MemStore Shadow Hook is available for cutover rehearsal.");
  const locations = await Promise.all(request.nativeStorePaths.map(async (path) => ({
    path: resolve(path),
    state: (await identity(resolve(path))).state === "absent" ? "absent" as const : "present" as const
  })));
  await writeFileAtomically(resolve(request.configPath), cutoverConfig, 0o600, sha256(configSource));
  await writeFileAtomically(resolve(request.hooksPath), cutoverHooks, 0o600, sha256(hooksSource));
  const appliedConfig = await readFile(resolve(request.configPath), "utf8");
  const appliedHooks = await readFile(resolve(request.hooksPath), "utf8");
  if (!appliedConfig.includes("generate_memories = false") ||
      !appliedConfig.includes("use_memories = false") ||
      !appliedHooks.includes("MEMSTORE_INJECTION_MODE=active")) {
    throw new Error("Cutover rehearsal read-back failed.");
  }
  await writeFileAtomically(resolve(request.hooksPath), hooksSource, 0o600, sha256(appliedHooks));
  await writeFileAtomically(resolve(request.configPath), configSource, 0o600, sha256(appliedConfig));
  if (await readFile(resolve(request.configPath), "utf8") !== configSource ||
      await readFile(resolve(request.hooksPath), "utf8") !== hooksSource) {
    throw new Error("Cutover rehearsal rollback did not restore exact configuration bytes.");
  }
  return {
    cutover: { generateMemories: false, useMemories: false, injectionMode: "active" },
    rollback: { restored: true },
    nativeData: { operation: "none", bodiesRead: 0, locations }
  };
}
