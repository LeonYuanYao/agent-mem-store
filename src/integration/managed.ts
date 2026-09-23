import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rmdir,
  symlink,
  unlink
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

import { writeFileAtomically } from "../contracts/atomic-file.js";
import { lunaModelIdentity } from "../luna/model.js";
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
    model: z.literal(lunaModelIdentity),
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

export interface ManagedActiveAdoptionPreview {
  readonly schemaVersion: 1;
  readonly state: "active_adoption_preview";
  readonly dryRun: true;
  readonly installationId: string;
  readonly requestIdentity: string;
  readonly approvalDigest: string;
  readonly adoptionId: string;
  readonly adoptedAt: string;
  readonly configPath: string;
  readonly hooksPath: string;
  readonly observedDivergedTargetLabels: readonly string[];
  readonly explicitNoEffects: readonly string[];
}

interface NativeMemoryInventoryLocation {
  readonly path: string;
  readonly state: "absent" | "file" | "directory" | "symlink" | "other";
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly totalBytes: number;
  readonly modifiedAt: string | null;
}

interface CutoverHookChange {
  readonly event: Candidate["hookEvents"][number];
  readonly injectionMode: { readonly before: "shadow"; readonly after: "active" };
  readonly hostTimeoutSeconds: { readonly before: number | null; readonly after: number | null };
  readonly additionalContextLimit: {
    readonly before: number | null;
    readonly after: number | null;
  };
}

export interface NativeMemoryCutoverPreview {
  readonly schemaVersion: 1;
  readonly state: "cutover_preview";
  readonly dryRun: true;
  readonly preparedAt: string;
  readonly approvalDigest: string;
  readonly source: {
    readonly configPath: string;
    readonly configSha256: string;
    readonly hooksPath: string;
    readonly hooksSha256: string;
  };
  readonly target: {
    readonly configSha256: string;
    readonly hooksSha256: string;
    readonly nativeMemory: {
      readonly generateMemories: false;
      readonly useMemories: false;
    };
    readonly hookChanges: readonly CutoverHookChange[];
  };
  readonly rollback: {
    readonly expectedConfigSha256: string;
    readonly expectedHooksSha256: string;
  };
  readonly nativeData: {
    readonly operation: "none";
    readonly bodiesRead: 0;
    readonly locations: readonly NativeMemoryInventoryLocation[];
  };
}

const cutoverManifestSchema = z.object({
  schemaVersion: z.literal(1),
  backupId: z.string().min(1),
  state: z.enum(["prepared", "active", "rolled_back"]),
  appliedAt: z.iso.datetime(),
  rolledBackAt: z.iso.datetime().optional(),
  configPath: z.string().min(1),
  hooksPath: z.string().min(1),
  configBackupPath: z.string().min(1),
  hooksBackupPath: z.string().min(1),
  sourceConfigSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  sourceHooksSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  targetConfigSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  targetHooksSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  approvalDigest: z.string().regex(/^[0-9a-f]{64}$/u)
});

type CutoverManifest = z.infer<typeof cutoverManifestSchema>;

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
    ...(request.lunaCodexHome === undefined
      ? []
      : [`MEMSTORE_LUNA_CODEX_HOME = ${tomlString(resolve(request.lunaCodexHome))}`]),
    ...(request.codexExecutable === undefined
      ? []
      : [`MEMSTORE_CODEX_EXECUTABLE = ${tomlString(request.codexExecutable)}`]),
    ""
  ].join("\n");
  return `${source.trimEnd()}\n\n${block}`;
}

function removeMemStoreMcp(source: string): string {
  const lines = source.split("\n");
  const retained: string[] = [];
  let dropping = false;
  let found = false;
  for (const line of lines) {
    const section = /^\s*\[([^\]]+)\]\s*$/u.exec(line)?.[1];
    if (section !== undefined) {
      dropping = section === "mcp_servers.memstore" ||
        section.startsWith("mcp_servers.memstore.");
      if (dropping) found = true;
    }
    if (!dropping) retained.push(line);
  }
  if (!found) throw new Error("Codex config has no managed MemStore MCP section to adopt.");
  return `${retained.join("\n").trimEnd()}\n`;
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
    hooks: [{
      type: "command",
      command,
      timeout: event === "SessionEnd" ? 3 : 2,
      statusMessage: `MemStore (${event})`,
      ...((event === "SessionStart" || event === "UserPromptSubmit")
        ? { additionalContextLimit: event === "SessionStart" ? 1200 : 1024 }
        : {})
    }]
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

function refreshManagedHooks(source: string, request: ManagedRequest, candidate: Candidate): string {
  const document = z.record(z.string(), z.unknown()).parse(JSON.parse(source));
  const hooks = z.record(z.string(), z.unknown()).parse(document.hooks);
  for (const event of candidate.hookEvents) {
    const existing = z.array(z.unknown()).default([]).parse(hooks[event]);
    const marker = `memstore:gate5-shadow-v1:${event}:`;
    const managed = existing.filter((route) => JSON.stringify(route).includes(marker));
    if (managed.length !== 1) {
      throw new Error(`Owned ${event} Hook recipe is missing or ambiguous.`);
    }
    hooks[event] = [
      ...existing.filter((route) => !JSON.stringify(route).includes(marker)),
      managedHookGroup(request, event)
    ];
  }
  document.hooks = hooks;
  return `${JSON.stringify(document, null, 2)}\n`;
}

function activeManagedHookGroup(request: ManagedRequest, event: Candidate["hookEvents"][number]) {
  const group = managedHookGroup(request, event);
  const handler = { ...group.hooks[0] };
  const command = z.string().parse(handler.command);
  const marker = `memstore:gate5-shadow-v1:${event}:shadow`;
  handler.command = command
    .replace("MEMSTORE_INJECTION_MODE=shadow", "MEMSTORE_INJECTION_MODE=active")
    .replace(marker, `memstore:gate5-shadow-v1:${event}:active`);
  if (event === "SessionStart" || event === "UserPromptSubmit") handler.timeout = 2;
  return { ...group, hooks: [handler] };
}

function adoptedHookSources(
  source: string,
  request: ManagedRequest,
  candidate: Candidate
): { readonly shadow: string; readonly withoutMemStore: string } {
  const document = z.record(z.string(), z.unknown()).parse(JSON.parse(source));
  const hooks = z.record(z.string(), z.unknown()).parse(document.hooks);
  const withoutDocument = structuredClone(document);
  const withoutHooks = z.record(z.string(), z.unknown()).parse(withoutDocument.hooks);
  for (const event of candidate.hookEvents) {
    const routes = z.array(z.unknown()).default([]).parse(hooks[event]);
    const marker = `memstore:gate5-shadow-v1:${event}:`;
    const indexes = routes.flatMap((route, index) =>
      JSON.stringify(route).includes(marker) ? [index] : []
    );
    if (indexes.length !== 1) {
      throw new Error(`Owned Active ${event} Hook recipe is missing or ambiguous.`);
    }
    const index = z.number().int().nonnegative().parse(indexes[0]);
    if (JSON.stringify(routes[index]) !== JSON.stringify(activeManagedHookGroup(request, event))) {
      throw new Error(`Owned Active ${event} Hook recipe does not match the current MemStore contract.`);
    }
    const nextRoutes = [...routes];
    nextRoutes[index] = managedHookGroup(request, event);
    hooks[event] = nextRoutes;
    withoutHooks[event] = routes.filter((_route, routeIndex) => routeIndex !== index);
  }
  document.hooks = hooks;
  withoutDocument.hooks = withoutHooks;
  return {
    shadow: `${JSON.stringify(document, null, 2)}\n`,
    withoutMemStore: `${JSON.stringify(withoutDocument, null, 2)}\n`
  };
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
  const source = [
    "#!/bin/sh",
    "if [ -z \"${MEMSTORE_RUNTIME_ROOT:-}\" ]; then",
    `  export MEMSTORE_RUNTIME_ROOT=${shellQuote(resolve(request.runtimeRoot))}`,
    "fi",
    "if [ -z \"${MEMSTORE_VAULT_ROOT:-}\" ]; then",
    `  export MEMSTORE_VAULT_ROOT=${shellQuote(resolve(request.vaultRoot))}`,
    "fi",
    `exec ${shellQuote(resolve(request.nodeExecutable))} ${shellQuote(join(
      resolve(request.repositoryRoot),
      "dist",
      "cli",
      "main.js"
    ))} "$@"`,
    ""
  ].join("\n");
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

async function plannedHooksUpgradeTarget(
  request: ManagedRequest,
  ownedTarget: PlannedTarget
): Promise<PlannedTarget> {
  if (ownedTarget.expectedSource === undefined) {
    throw new Error("Owned Codex Hooks target has no expected source.");
  }
  const { candidate } = await loadCandidate();
  const source = refreshManagedHooks(ownedTarget.expectedSource, request, candidate);
  return {
    ...ownedTarget,
    expectedPost: { state: "file", sha256: sha256(source) },
    expectedSource: source
  };
}

export async function previewManagedIntegration(request: ManagedRequest): Promise<ManagedIntegrationPreview> {
  z.iso.datetime().parse(request.installedAt);
  const { candidate, sha256: candidateSha256 } = await loadCandidate();
  const configPath = join(resolve(request.homeRoot), ".codex", "config.toml");
  const hooksPath = join(resolve(request.homeRoot), ".codex", "hooks.json");
  const notifierSourceRoot = resolve(request.notifierSource);
  const hooksAliasIdentity = await identity(hooksPath);
  const hooksTargetPath = hooksAliasIdentity.state === "symlink"
    ? await realpath(hooksPath)
    : hooksPath;
  const hooksTargetIdentity = await identity(hooksTargetPath);
  const [configSource, hooksSource, notifier, notifierPlist, notifierCodeResources] = await Promise.all([
    readFile(configPath, "utf8"),
    hooksTargetIdentity.state === "absent"
      ? Promise.resolve(`${JSON.stringify({ hooks: {} }, null, 2)}\n`)
      : readFile(hooksTargetPath, "utf8"),
    readFile(join(notifierSourceRoot, "Contents", "MacOS", "memstore-notifier")),
    readFile(join(notifierSourceRoot, "Contents", "Info.plist")),
    readFile(join(notifierSourceRoot, "Contents", "_CodeSignature", "CodeResources"))
  ]);
  const expectedConfig = appendMemStoreMcp(configSource, request);
  const expectedHooks = appendManagedHooks(hooksSource, request, candidate);
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
      before: hooksTargetIdentity,
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

async function writeManifest(
  runtimeRoot: string,
  manifest: OwnershipManifest,
  expectedCurrentSha256?: string
): Promise<void> {
  const path = join(resolve(runtimeRoot), "install", "ownership-manifest.json");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const source = `${JSON.stringify(manifest, null, 2)}\n`;
  const current = await identity(path);
  if (expectedCurrentSha256 !== undefined &&
      (current.state !== "file" || current.sha256 !== expectedCurrentSha256)) {
    throw new Error("Managed ownership manifest changed after preview.");
  }
  await writeFileAtomically(
    path,
    source,
    0o600,
    expectedCurrentSha256 ?? (current.state === "file" ? current.sha256 : undefined)
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

export async function repairManagedIntegration(
  request: ManagedRequest,
  options: { readonly targetLabels?: readonly string[] } = {}
): Promise<{
  readonly state: "healthy" | "repaired";
  readonly installationId: string;
}> {
  const manifest = await readManifest(request.runtimeRoot);
  if (manifest.state !== "installed") throw new Error("Managed integration is not installed.");
  if (manifest.requestIdentity !== requestIdentity(request)) throw new Error("Managed integration request diverged from its ownership manifest.");
  const selectedLabels = options.targetLabels === undefined
    ? undefined
    : new Set(options.targetLabels);
  if (selectedLabels !== undefined) {
    const knownLabels = new Set(manifest.targets.map((target) => target.label));
    for (const label of selectedLabels) {
      if (!knownLabels.has(label)) throw new Error(`Unknown managed repair target: ${label}.`);
    }
  }
  const repairable: PlannedTarget[] = [];
  const nextTargets: (PlannedTarget & { readonly backupPath?: string })[] = [];
  let recipeUpdated = false;
  for (const target of manifest.targets) {
    if (selectedLabels !== undefined && !selectedLabels.has(target.label)) {
      nextTargets.push(target);
      continue;
    }
    const desired = target.label === "memstore_cli"
      ? {
          ...(await plannedCliTarget(request)),
          before: target.before,
          ...(target.backupPath === undefined ? {} : { backupPath: target.backupPath })
        }
      : target.label === "codex_hooks"
        ? await plannedHooksUpgradeTarget(request, target)
      : target;
    const current = await identity(target.path);
    if (sameIdentity(current, target.expectedPost)) {
      if (!sameIdentity(target.expectedPost, desired.expectedPost)) {
        repairable.push({ ...desired, before: target.expectedPost });
        recipeUpdated = true;
      }
      nextTargets.push(desired);
      continue;
    }
    if (sameIdentity(current, target.before)) {
      repairable.push(desired);
      if (!sameIdentity(target.expectedPost, desired.expectedPost)) recipeUpdated = true;
      nextTargets.push(desired);
      continue;
    }
    throw new Error(`${target.label} diverged; repair cannot distinguish the change from user-authored state.`);
  }
  for (const target of repairable) await applyTarget(target);
  await preflightTargets(
    selectedLabels === undefined
      ? nextTargets
      : nextTargets.filter((target) => selectedLabels.has(target.label)),
    "expectedPost"
  );
  if (recipeUpdated) {
    await writeManifest(request.runtimeRoot, {
      ...manifest,
      targets: nextTargets
    });
  }
  return {
    state: repairable.length === 0 && !recipeUpdated ? "healthy" : "repaired",
    installationId: manifest.installationId
  };
}

interface ActiveAdoptionPlan {
  readonly preview: ManagedActiveAdoptionPreview;
  readonly ownershipManifestSha256: string;
  readonly nextOwnershipManifest: OwnershipManifest;
  readonly configBeforeSource: string;
  readonly hooksBeforeSource: string;
  readonly cutoverConfigSource: string;
  readonly cutoverHooksSource: string;
  readonly cutoverManifest: CutoverManifest;
}

async function activeAdoptionPlan(request: ManagedRequest): Promise<ActiveAdoptionPlan> {
  const manifestPath = join(resolve(request.runtimeRoot), "install", "ownership-manifest.json");
  const manifestSource = await readFile(manifestPath, "utf8");
  const manifest = z.custom<OwnershipManifest>((value) => typeof value === "object" && value !== null)
    .parse(JSON.parse(manifestSource));
  if (manifest.state !== "installed") throw new Error("Managed integration is not installed.");
  if (manifest.requestIdentity !== requestIdentity(request)) {
    throw new Error("Managed integration request diverged from its ownership manifest.");
  }
  const observedDivergedTargetLabels = await divergedTargetLabels(manifest.targets);
  const allowedLabels = new Set(["codex_config", "codex_hooks_link", "codex_hooks"]);
  const unexpected = observedDivergedTargetLabels.filter((label) => !allowedLabels.has(label));
  if (unexpected.length > 0) {
    throw new Error(`Unrelated managed targets diverged (${unexpected.join(", ")}); refusing Active adoption.`);
  }
  if (observedDivergedTargetLabels.length === 0) {
    throw new Error("Managed integration has no legacy Active drift to adopt.");
  }

  const { candidate } = await loadCandidate();
  const configPath = join(resolve(request.homeRoot), ".codex", "config.toml");
  const hooksEntryPath = join(resolve(request.homeRoot), ".codex", "hooks.json");
  const hooksEntryIdentity = await identity(hooksEntryPath);
  if (hooksEntryIdentity.state !== "file" && hooksEntryIdentity.state !== "symlink") {
    throw new Error("Codex Hooks must be a regular file or symlink for Active adoption.");
  }
  const hooksPath = hooksEntryIdentity.state === "symlink"
    ? await realpath(hooksEntryPath)
    : hooksEntryPath;
  const [configSource, hooksSource] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(hooksPath, "utf8")
  ]);
  if (memorySetting(configSource, "generate_memories") ||
      memorySetting(configSource, "use_memories")) {
    throw new Error("Codex native memory is not fully disabled; refusing Active adoption.");
  }
  const configBeforeSource = removeMemStoreMcp(configSource);
  const restoredConfig = appendMemStoreMcp(configBeforeSource, request);
  if (!isDeepStrictEqual(parseToml(restoredConfig), parseToml(configSource))) {
    throw new Error("The existing MemStore MCP configuration does not match this setup request.");
  }
  const adoptedHooks = adoptedHookSources(hooksSource, request, candidate);
  const adoptedAt = request.installedAt;
  const adoptionId = `active-adoption-${adoptedAt.replaceAll(":", "-")}-${sha256(manifestSource).slice(0, 12)}`;
  const ownershipBackupRoot = join(
    resolve(request.runtimeRoot),
    "install",
    "backups",
    adoptionId
  );
  const configBackupPath = join(ownershipBackupRoot, "codex_config.backup");
  const hooksBackupPath = join(ownershipBackupRoot, "codex_hooks.backup");
  const configTarget: PlannedTarget & { readonly backupPath: string } = {
    label: "codex_config",
    path: configPath,
    kind: "structured_file",
    before: { state: "file", sha256: sha256(configBeforeSource) },
    expectedPost: { state: "file", sha256: sha256(configSource) },
    expectedSource: configSource,
    backupPath: configBackupPath
  };
  const hooksTarget: PlannedTarget & { readonly backupPath: string } = {
    label: "codex_hooks",
    path: hooksPath,
    kind: "structured_file",
    before: { state: "file", sha256: sha256(adoptedHooks.withoutMemStore) },
    expectedPost: { state: "file", sha256: sha256(adoptedHooks.shadow) },
    expectedSource: adoptedHooks.shadow,
    backupPath: hooksBackupPath
  };
  const hooksGuard: PlannedTarget[] = hooksEntryIdentity.state === "symlink"
    ? [{
        label: "codex_hooks_link",
        path: hooksEntryPath,
        kind: "guard",
        before: hooksEntryIdentity,
        expectedPost: hooksEntryIdentity
      }]
    : [];
  const nextOwnershipManifest: OwnershipManifest = {
    ...manifest,
    targets: [
      ...manifest.targets.filter((target) => !allowedLabels.has(target.label)),
      configTarget,
      ...hooksGuard,
      hooksTarget
    ]
  };
  const cutoverRoot = join(resolve(request.runtimeRoot), "cutover", adoptionId);
  const cutoverConfigBackupPath = join(cutoverRoot, "config.toml.before");
  const cutoverHooksBackupPath = join(cutoverRoot, "hooks.json.before");
  const cutoverManifest: CutoverManifest = {
    schemaVersion: 1,
    backupId: adoptionId,
    state: "active",
    appliedAt: adoptedAt,
    configPath,
    hooksPath,
    configBackupPath: cutoverConfigBackupPath,
    hooksBackupPath: cutoverHooksBackupPath,
    sourceConfigSha256: sha256(configSource),
    sourceHooksSha256: sha256(adoptedHooks.shadow),
    targetConfigSha256: sha256(configSource),
    targetHooksSha256: sha256(hooksSource),
    approvalDigest: "0".repeat(64)
  };
  const approvalDigest = sha256(JSON.stringify({
    ownershipManifestSha256: sha256(manifestSource),
    nextOwnershipManifest,
    cutoverManifest: { ...cutoverManifest, approvalDigest: undefined }
  }));
  const finalCutoverManifest: CutoverManifest = { ...cutoverManifest, approvalDigest };
  return {
    preview: {
      schemaVersion: 1,
      state: "active_adoption_preview",
      dryRun: true,
      installationId: manifest.installationId,
      requestIdentity: manifest.requestIdentity,
      approvalDigest,
      adoptionId,
      adoptedAt,
      configPath,
      hooksPath,
      observedDivergedTargetLabels,
      explicitNoEffects: [
        "No Codex config or Hook content change",
        "No native-memory data read, import, move, or deletion",
        "No Canonical Memory or Runtime database change",
        "No unrelated managed target adoption"
      ]
    },
    ownershipManifestSha256: sha256(manifestSource),
    nextOwnershipManifest,
    configBeforeSource,
    hooksBeforeSource: adoptedHooks.withoutMemStore,
    cutoverConfigSource: configSource,
    cutoverHooksSource: adoptedHooks.shadow,
    cutoverManifest: finalCutoverManifest
  };
}

export async function previewManagedActiveAdoption(
  request: ManagedRequest
): Promise<ManagedActiveAdoptionPreview> {
  return (await activeAdoptionPlan(request)).preview;
}

export async function applyManagedActiveAdoption(
  request: ManagedRequest,
  preview: ManagedActiveAdoptionPreview
): Promise<{
  readonly state: "adopted";
  readonly installationId: string;
  readonly manifestPath: string;
  readonly rollbackManifestPath: string;
}> {
  const plan = await activeAdoptionPlan(request);
  if (JSON.stringify(plan.preview) !== JSON.stringify(preview)) {
    throw new Error("Managed Active adoption inputs diverged after preview; generate a fresh preview.");
  }
  const ownershipBackupRoot = join(
    resolve(request.runtimeRoot),
    "install",
    "backups",
    preview.adoptionId
  );
  const cutoverRoot = join(resolve(request.runtimeRoot), "cutover", preview.adoptionId);
  await Promise.all([
    mkdir(ownershipBackupRoot, { recursive: true, mode: 0o700 }),
    mkdir(cutoverRoot, { recursive: true, mode: 0o700 })
  ]);
  await Promise.all([
    writeFileAtomically(join(ownershipBackupRoot, "codex_config.backup"), plan.configBeforeSource, 0o600),
    writeFileAtomically(join(ownershipBackupRoot, "codex_hooks.backup"), plan.hooksBeforeSource, 0o600),
    writeFileAtomically(join(cutoverRoot, "config.toml.before"), plan.cutoverConfigSource, 0o600),
    writeFileAtomically(join(cutoverRoot, "hooks.json.before"), plan.cutoverHooksSource, 0o600)
  ]);
  const rollbackManifestPath = join(cutoverRoot, "manifest.json");
  await writeManifest(
    request.runtimeRoot,
    plan.nextOwnershipManifest,
    plan.ownershipManifestSha256
  );
  await writeCutoverManifest(rollbackManifestPath, plan.cutoverManifest);
  return {
    state: "adopted",
    installationId: preview.installationId,
    manifestPath: join(resolve(request.runtimeRoot), "install", "ownership-manifest.json"),
    rollbackManifestPath
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
  const existingCli = manifest.targets.find((target) => target.label === "memstore_cli");
  const cli = await plannedCliTarget(request);
  const targets: PlannedTarget[] = [];
  if (existingCli === undefined || !sameIdentity(existingCli.expectedPost, cli.expectedPost)) {
    if (existingCli === undefined) {
      requireInstallableBefore(cli.path, cli.before);
    } else if (!sameIdentity(cli.before, existingCli.expectedPost)) {
      throw new Error(
        "memstore_cli diverged; upgrade cannot distinguish the change from user-authored state."
      );
    }
    targets.push(cli);
  }
  // Upgrade the complete signed notifier recipe; do not rewrite Hooks or restart the Worker.
  for (const [label, relativePath] of [
    ["notifier", "Contents/MacOS/memstore-notifier"],
    ["notifier_info_plist", "Contents/Info.plist"],
    ["notifier_code_resources", "Contents/_CodeSignature/CodeResources"]
  ]) {
    if (label === undefined || relativePath === undefined) throw new Error("Invalid notifier recipe.");
    const previous = manifest.targets.find(target => target.label === label);
    const path = join(resolve(request.runtimeRoot), "bin", "MemStore Notifier.app", relativePath);
    if (previous === undefined || previous.path !== path) throw new Error("Notifier ownership is missing or mismatched.");
    const source = await readFile(join(resolve(request.notifierSource), relativePath));
    const expectedPost = { state: "file" as const, sha256: sha256(source) };
    if (sameIdentity(previous.expectedPost, expectedPost)) continue;
    const before = await identity(path);
    if (!sameIdentity(before, previous.expectedPost)) throw new Error(`${label} diverged; refusing notifier upgrade.`);
    targets.push({ label, path, kind: "owned_file", before, expectedPost, expectedSourceBase64: source.toString("base64") });
  }
  return {
    schemaVersion: 1,
    state: "upgrade_preview",
    dryRun: true,
    installationId: manifest.installationId,
    requestIdentity: manifest.requestIdentity,
    targets,
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
    const replacementLabels = new Set(preview.targets.map((target) => target.label));
    const upgradedTargets = preview.targets.map((target) => {
      const previous = manifest.targets.find((candidate) => candidate.label === target.label);
      return previous === undefined
        ? target
        : {
            ...target,
            before: previous.before,
            ...(previous.backupPath === undefined ? {} : { backupPath: previous.backupPath })
          };
    });
    await writeManifest(request.runtimeRoot, {
      ...manifest,
      targets: [
        ...manifest.targets.filter((target) => !replacementLabels.has(target.label)),
        ...upgradedTargets
      ]
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
  const section = /^\[memories\][ \\t]*$/mu.exec(source);
  if (section === null) throw new Error("Codex config has no [memories] section.");
  const bodyStart = section.index + section[0].length;
  const remainder = source.slice(bodyStart);
  const nextSection = /^\[[^\]]+\][ \\t]*$/mu.exec(remainder);
  const bodyEnd = nextSection === null ? source.length : bodyStart + nextSection.index;
  const body = source.slice(bodyStart, bodyEnd);
  const pattern = new RegExp(`^${key}[ \\t]*=[ \\t]*(?:true|false)[ \\t]*$`, "mu");
  const replacement = `${key} = ${String(value)}`;
  if (pattern.exec(body)?.[0] === replacement) return source;
  const nextBody = pattern.test(body)
    ? body.replace(pattern, replacement)
    : `${body.trimEnd()}\n${replacement}\n`;
  return `${source.slice(0, bodyStart)}${nextBody}${source.slice(bodyEnd)}`;
}

function memorySetting(source: string, key: "generate_memories" | "use_memories"): boolean {
  const document = z.record(z.string(), z.unknown()).parse(parseToml(source));
  const memories = z.record(z.string(), z.unknown()).parse(document.memories);
  return z.boolean().parse(memories[key]);
}

function configIdentityWithoutHookTrustHashes(source: string): string {
  const document = z.record(z.string(), z.unknown()).parse(parseToml(source));
  if (document.hooks !== undefined) {
    const hooks = z.record(z.string(), z.unknown()).parse(document.hooks);
    if (hooks.state !== undefined) {
      const state = z.record(z.string(), z.unknown()).parse(hooks.state);
      for (const [key, value] of Object.entries(state)) {
        const hookState = z.record(z.string(), z.unknown()).parse(value);
        delete hookState.trusted_hash;
        state[key] = hookState;
      }
      hooks.state = state;
    }
    document.hooks = hooks;
  }
  return JSON.stringify(document);
}

function activateInjectionHooks(source: string): {
  readonly source: string;
  readonly changes: readonly CutoverHookChange[];
} {
  const document = z.record(z.string(), z.unknown()).parse(JSON.parse(source));
  const hooks = z.record(z.string(), z.unknown()).parse(document.hooks);
  const changes: CutoverHookChange[] = [];
  const events = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"] as const;
  for (const event of events) {
    const routes = z.array(z.unknown()).default([]).parse(hooks[event]);
    const marker = `memstore:gate5-shadow-v1:${event}:shadow`;
    const routeIndexes = routes.flatMap((route, index) => JSON.stringify(route).includes(marker) ? [index] : []);
    if (routeIndexes.length !== 1) {
      throw new Error(`Owned Shadow ${event} Hook recipe is missing or ambiguous.`);
    }
    const routeIndex = routeIndexes[0];
    if (routeIndex === undefined) throw new Error(`Owned Shadow ${event} Hook recipe is missing.`);
    const route = z.record(z.string(), z.unknown()).parse(routes[routeIndex]);
    const handlers = z.array(z.unknown()).parse(route.hooks);
    const handlerIndexes = handlers.flatMap((handler, index) => JSON.stringify(handler).includes(marker) ? [index] : []);
    if (handlerIndexes.length !== 1) {
      throw new Error(`Owned Shadow ${event} Hook command is missing or ambiguous.`);
    }
    const handlerIndex = handlerIndexes[0];
    if (handlerIndex === undefined) throw new Error(`Owned Shadow ${event} Hook command is missing.`);
    const handler = z.record(z.string(), z.unknown()).parse(handlers[handlerIndex]);
    const command = z.string().parse(handler.command);
    if (!command.includes("MEMSTORE_INJECTION_MODE=shadow")) {
      throw new Error(`Owned Shadow ${event} Hook has no Shadow injection mode.`);
    }
    const beforeLimit = typeof handler.additionalContextLimit === "number"
      ? z.number().int().nonnegative().parse(handler.additionalContextLimit)
      : null;
    const beforeTimeout = typeof handler.timeout === "number"
      ? z.number().int().positive().parse(handler.timeout)
      : null;
    const afterLimit = event === "SessionStart" ? 1200 : event === "UserPromptSubmit" ? 1024 : null;
    const afterTimeout = event === "SessionStart" || event === "UserPromptSubmit" ? 2 : beforeTimeout;
    handler.command = command
      .replace("MEMSTORE_INJECTION_MODE=shadow", "MEMSTORE_INJECTION_MODE=active")
      .replace(marker, `memstore:gate5-shadow-v1:${event}:active`);
    if (afterTimeout === null) delete handler.timeout;
    else handler.timeout = afterTimeout;
    if (afterLimit === null) delete handler.additionalContextLimit;
    else handler.additionalContextLimit = afterLimit;
    const nextHandlers = [...handlers];
    nextHandlers[handlerIndex] = handler;
    route.hooks = nextHandlers;
    const nextRoutes = [...routes];
    nextRoutes[routeIndex] = route;
    hooks[event] = nextRoutes;
    changes.push({
      event,
      injectionMode: { before: "shadow", after: "active" },
      hostTimeoutSeconds: { before: beforeTimeout, after: afterTimeout },
      additionalContextLimit: { before: beforeLimit, after: afterLimit }
    });
  }
  document.hooks = hooks;
  return { source: `${JSON.stringify(document, null, 2)}\n`, changes };
}

async function inspectNativeMemoryLocation(path: string): Promise<NativeMemoryInventoryLocation> {
  const resolvedPath = resolve(path);
  try {
    const metadata = await lstat(resolvedPath);
    if (metadata.isFile()) {
      return {
        path: resolvedPath,
        state: "file",
        fileCount: 1,
        directoryCount: 0,
        totalBytes: metadata.size,
        modifiedAt: metadata.mtime.toISOString()
      };
    }
    if (metadata.isSymbolicLink()) {
      return {
        path: resolvedPath,
        state: "symlink",
        fileCount: 0,
        directoryCount: 0,
        totalBytes: 0,
        modifiedAt: metadata.mtime.toISOString()
      };
    }
    if (!metadata.isDirectory()) {
      return {
        path: resolvedPath,
        state: "other",
        fileCount: 0,
        directoryCount: 0,
        totalBytes: metadata.size,
        modifiedAt: metadata.mtime.toISOString()
      };
    }
    const children = await readdir(resolvedPath);
    const inventory = await Promise.all(children.map((child) => inspectNativeMemoryLocation(join(resolvedPath, child))));
    const timestamps = inventory
      .map((entry) => entry.modifiedAt)
      .filter((value): value is string => value !== null)
      .map((value) => Date.parse(value));
    return {
      path: resolvedPath,
      state: "directory",
      fileCount: inventory.reduce((total, entry) => total + entry.fileCount, 0),
      directoryCount: 1 + inventory.reduce((total, entry) => total + entry.directoryCount, 0),
      totalBytes: inventory.reduce((total, entry) => total + entry.totalBytes, 0),
      modifiedAt: new Date(Math.max(metadata.mtimeMs, ...timestamps)).toISOString()
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        path: resolvedPath,
        state: "absent",
        fileCount: 0,
        directoryCount: 0,
        totalBytes: 0,
        modifiedAt: null
      };
    }
    throw error;
  }
}

export async function previewNativeMemoryCutover(request: {
  readonly configPath: string;
  readonly hooksPath: string;
  readonly nativeStorePaths: readonly string[];
  readonly preparedAt: string;
}): Promise<NativeMemoryCutoverPreview> {
  const preparedAt = z.iso.datetime().parse(request.preparedAt);
  const configPath = resolve(request.configPath);
  const hooksPath = resolve(request.hooksPath);
  const [configSource, hooksSource, locations] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(hooksPath, "utf8"),
    Promise.all(request.nativeStorePaths.map(inspectNativeMemoryLocation))
  ]);
  const cutoverConfig = replaceMemorySetting(
    replaceMemorySetting(configSource, "generate_memories", false),
    "use_memories",
    false
  );
  const cutoverHooks = activateInjectionHooks(hooksSource);
  const sourceIdentity = {
    configPath,
    configSha256: sha256(configSource),
    hooksPath,
    hooksSha256: sha256(hooksSource)
  };
  const targetIdentity = {
    configSha256: sha256(cutoverConfig),
    hooksSha256: sha256(cutoverHooks.source)
  };
  const approvalDigest = sha256(JSON.stringify({ source: sourceIdentity, target: targetIdentity }));
  return {
    schemaVersion: 1,
    state: "cutover_preview",
    dryRun: true,
    preparedAt,
    approvalDigest,
    source: sourceIdentity,
    target: {
      ...targetIdentity,
      nativeMemory: { generateMemories: false, useMemories: false },
      hookChanges: cutoverHooks.changes
    },
    rollback: {
      expectedConfigSha256: sha256(configSource),
      expectedHooksSha256: sha256(hooksSource)
    },
    nativeData: { operation: "none", bodiesRead: 0, locations }
  };
}

async function writeCutoverManifest(path: string, manifest: CutoverManifest, expectedSha256?: string): Promise<void> {
  await writeFileAtomically(path, `${JSON.stringify(manifest, null, 2)}\n`, 0o600, expectedSha256);
}

export async function applyNativeMemoryCutover(request: {
  readonly runtimeRoot: string;
  readonly preview: NativeMemoryCutoverPreview;
  readonly approvalDigest: string;
  readonly appliedAt: string;
}): Promise<{
  readonly state: "active";
  readonly backupId: string;
  readonly manifestPath: string;
  readonly hooksSha256: string;
}> {
  const appliedAt = z.iso.datetime().parse(request.appliedAt);
  if (request.approvalDigest !== request.preview.approvalDigest) {
    throw new Error("Cutover approval digest does not match the reviewed preview.");
  }
  const [configSource, hooksSource] = await Promise.all([
    readFile(request.preview.source.configPath, "utf8"),
    readFile(request.preview.source.hooksPath, "utf8")
  ]);
  if (sha256(configSource) !== request.preview.source.configSha256 ||
      sha256(hooksSource) !== request.preview.source.hooksSha256) {
    throw new Error("Cutover source changed after Review; generate and approve a new preview.");
  }
  const cutoverConfig = replaceMemorySetting(
    replaceMemorySetting(configSource, "generate_memories", false),
    "use_memories",
    false
  );
  const cutoverHooks = activateInjectionHooks(hooksSource).source;
  if (sha256(cutoverConfig) !== request.preview.target.configSha256 ||
      sha256(cutoverHooks) !== request.preview.target.hooksSha256) {
    throw new Error("Cutover target no longer matches the reviewed preview.");
  }

  const backupId = `cutover-${appliedAt.replaceAll(":", "-")}-${randomUUID()}`;
  const backupRoot = join(resolve(request.runtimeRoot), "cutover", backupId);
  const configBackupPath = join(backupRoot, "config.toml.before");
  const hooksBackupPath = join(backupRoot, "hooks.json.before");
  const manifestPath = join(backupRoot, "manifest.json");
  await mkdir(dirname(backupRoot), { recursive: true, mode: 0o700 });
  await mkdir(backupRoot, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeFileAtomically(configBackupPath, configSource, 0o600),
    writeFileAtomically(hooksBackupPath, hooksSource, 0o600)
  ]);
  const prepared: CutoverManifest = {
    schemaVersion: 1,
    backupId,
    state: "prepared",
    appliedAt,
    configPath: request.preview.source.configPath,
    hooksPath: request.preview.source.hooksPath,
    configBackupPath,
    hooksBackupPath,
    sourceConfigSha256: request.preview.source.configSha256,
    sourceHooksSha256: request.preview.source.hooksSha256,
    targetConfigSha256: request.preview.target.configSha256,
    targetHooksSha256: request.preview.target.hooksSha256,
    approvalDigest: request.approvalDigest
  };
  await writeCutoverManifest(manifestPath, prepared);
  const preparedManifestSha256 = sha256(await readFile(manifestPath));
  try {
    if (cutoverConfig !== configSource) {
      await writeFileAtomically(
        request.preview.source.configPath,
        cutoverConfig,
        0o600,
        request.preview.source.configSha256
      );
    }
    await writeFileAtomically(
      request.preview.source.hooksPath,
      cutoverHooks,
      0o600,
      request.preview.source.hooksSha256
    );
  } catch (error) {
    const currentHooks = await readFile(request.preview.source.hooksPath, "utf8");
    if (sha256(currentHooks) === request.preview.target.hooksSha256) {
      await writeFileAtomically(
        request.preview.source.hooksPath,
        hooksSource,
        0o600,
        request.preview.target.hooksSha256
      );
    }
    const currentConfig = await readFile(request.preview.source.configPath, "utf8");
    if (sha256(currentConfig) === request.preview.target.configSha256 && currentConfig !== configSource) {
      await writeFileAtomically(
        request.preview.source.configPath,
        configSource,
        0o600,
        request.preview.target.configSha256
      );
    }
    throw error;
  }
  const active: CutoverManifest = { ...prepared, state: "active" };
  await writeCutoverManifest(manifestPath, active, preparedManifestSha256);
  return {
    state: "active",
    backupId,
    manifestPath,
    hooksSha256: request.preview.target.hooksSha256
  };
}

export async function rollbackNativeMemoryCutover(request: {
  readonly manifestPath: string;
  readonly rolledBackAt: string;
}): Promise<{ readonly state: "rolled_back"; readonly backupId: string }> {
  const rolledBackAt = z.iso.datetime().parse(request.rolledBackAt);
  const manifestPath = resolve(request.manifestPath);
  const manifestSource = await readFile(manifestPath, "utf8");
  const manifest = cutoverManifestSchema.parse(JSON.parse(manifestSource));
  if (manifest.state === "rolled_back") throw new Error("Cutover manifest is already rolled back.");
  const [currentConfig, currentHooks, configBackup, hooksBackup] = await Promise.all([
    readFile(manifest.configPath, "utf8"),
    readFile(manifest.hooksPath, "utf8"),
    readFile(manifest.configBackupPath, "utf8"),
    readFile(manifest.hooksBackupPath, "utf8")
  ]);
  if (sha256(configBackup) !== manifest.sourceConfigSha256 ||
      sha256(hooksBackup) !== manifest.sourceHooksSha256) {
    throw new Error("Cutover backup integrity check failed.");
  }
  if (sha256(currentHooks) !== manifest.targetHooksSha256) {
    throw new Error("Cutover Hooks diverged; refusing automatic rollback.");
  }
  const expectedTargetConfig = replaceMemorySetting(
    replaceMemorySetting(configBackup, "generate_memories", false),
    "use_memories",
    false
  );
  if (sha256(currentConfig) !== manifest.targetConfigSha256 &&
      configIdentityWithoutHookTrustHashes(currentConfig) !== configIdentityWithoutHookTrustHashes(expectedTargetConfig)) {
    throw new Error("Cutover configuration diverged beyond Hook trust state; refusing automatic rollback.");
  }
  const rollbackConfig = replaceMemorySetting(
    replaceMemorySetting(
      currentConfig,
      "generate_memories",
      memorySetting(configBackup, "generate_memories")
    ),
    "use_memories",
    memorySetting(configBackup, "use_memories")
  );
  if (configIdentityWithoutHookTrustHashes(rollbackConfig) !== configIdentityWithoutHookTrustHashes(configBackup)) {
    throw new Error("Rollback configuration does not match the reviewed source outside Hook trust state.");
  }
  await writeFileAtomically(manifest.hooksPath, hooksBackup, 0o600, manifest.targetHooksSha256);
  if (rollbackConfig !== currentConfig) {
    await writeFileAtomically(manifest.configPath, rollbackConfig, 0o600, sha256(currentConfig));
  }
  await writeCutoverManifest(
    manifestPath,
    { ...manifest, state: "rolled_back", rolledBackAt },
    sha256(manifestSource)
  );
  return { state: "rolled_back", backupId: manifest.backupId };
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
  const cutoverHooks = activateInjectionHooks(hooksSource).source;
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
