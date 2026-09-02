import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createConnection } from "node:net";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

import { MemStoreCommandError } from "../contracts/envelope.js";
import { prepareShadowEmbedding } from "../operations/embedding-install.js";
import { foregroundRetrievalSocketPath } from "../retrieval/foreground-protocol.js";
import {
  applyManagedIntegration,
  applyManagedActiveAdoption,
  applyManagedIntegrationUpgrade,
  applyNativeMemoryCutover,
  previewManagedIntegration,
  previewManagedActiveAdoption,
  previewManagedIntegrationUpgrade,
  repairManagedIntegration,
  previewNativeMemoryCutover
} from "./managed.js";

const execFileAsync = promisify(execFile);
const launchAgentLabel = "com.leonyuanyaoyao.memstore.worker";

export type FriendlySetupMode = "active" | "shadow";

export interface FriendlySetupInput {
  readonly homeRoot?: string;
  readonly repositoryRoot?: string;
  readonly vaultRoot?: string;
  readonly runtimeRoot?: string;
  readonly notifierSource?: string;
  readonly nodeExecutable?: string;
  readonly lunaCodexHome?: string;
  readonly codexExecutable?: string;
  readonly embeddingModelDirectory?: string;
  readonly mode?: FriendlySetupMode;
  readonly preparedAt?: string;
}

type ManagedRequest = Parameters<typeof previewManagedIntegration>[0];
type ManagedPreview = Awaited<ReturnType<typeof previewManagedIntegration>>;
type ManagedUpgradePreview = Awaited<ReturnType<typeof previewManagedIntegrationUpgrade>>;
type ManagedActiveAdoptionPreview = Awaited<ReturnType<typeof previewManagedActiveAdoption>>;

export interface FriendlySetupPreview {
  readonly schemaVersion: 1;
  readonly state: "preview";
  readonly dryRun: true;
  readonly mode: FriendlySetupMode;
  readonly paths: {
    readonly homeRoot: string;
    readonly repositoryRoot: string;
    readonly vaultRoot: string;
    readonly runtimeRoot: string;
    readonly embeddingModelDirectory: string;
    readonly notifierSource: string;
    readonly codexExecutable: string;
    readonly nodeExecutable: string;
  };
  readonly embedding: {
    readonly state: "missing" | "present";
    readonly action: "download_and_verify" | "verify";
  };
  readonly integration: {
    readonly targetCount: number;
    readonly createsCodexHooks: boolean;
    readonly action:
      | "install_owned_surfaces"
      | "resume_owned_installation"
      | "verify_active_installation"
      | "adopt_legacy_active_installation";
  };
  readonly cutover: {
    readonly action:
      | "activate_memstore_and_disable_codex_memory"
      | "keep_shadow"
      | "keep_active";
    readonly nativeMemoryDataOperation: "none";
  };
  readonly worker: {
    readonly action: "bootstrap_and_verify";
    readonly launchAgentPath: string;
  };
}

export interface FriendlySetupAdapters {
  readonly prepareEmbedding: (
    destination: string
  ) => Promise<{ readonly state: "installed" | "verified" }>;
  readonly activateLaunchAgent: (
    path: string
  ) => Promise<"bootstrapped" | "restarted">;
  readonly waitForForeground: (
    runtimeRoot: string,
    timeoutMilliseconds: number
  ) => Promise<boolean>;
  readonly authorizeNotifications: (
    notifierExecutable: string
  ) => Promise<"authorized" | "denied" | "unavailable">;
}

const obsidianSchema = z.object({
  vaults: z.record(z.string(), z.object({
    path: z.string().min(1),
    open: z.boolean().optional()
  }))
});

const previewInternals = new WeakMap<
  FriendlySetupPreview,
  | {
      readonly action: "install";
      readonly request: ManagedRequest;
      readonly managedPreview: ManagedPreview;
    }
  | {
      readonly action: "resume";
      readonly request: ManagedRequest;
    }
  | {
      readonly action: "active";
      readonly request: ManagedRequest;
      readonly upgradePreview: ManagedUpgradePreview;
      readonly rollbackManifestPath: string;
    }
  | {
      readonly action: "adopt";
      readonly request: ManagedRequest;
      readonly adoptionPreview: ManagedActiveAdoptionPreview;
    }
>();

const activeCutoverSchema = z.object({
  schemaVersion: z.literal(1),
  state: z.literal("active"),
  appliedAt: z.iso.datetime(),
  configPath: z.string().min(1),
  hooksPath: z.string().min(1),
  targetConfigSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  targetHooksSha256: z.string().regex(/^[0-9a-f]{64}$/u)
});

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
}

async function resolvedHooksPath(homeRoot: string): Promise<string> {
  const hooksPath = join(homeRoot, ".codex", "hooks.json");
  try {
    return (await lstat(hooksPath)).isSymbolicLink()
      ? await realpath(hooksPath)
      : hooksPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return hooksPath;
    throw error;
  }
}

async function matchingActiveCutover(request: {
  readonly runtimeRoot: string;
  readonly configPath: string;
  readonly hooksPath: string;
}): Promise<{ readonly state: "matching"; readonly manifestPath: string } | { readonly state: "diverged" } | undefined> {
  const cutoverRoot = join(request.runtimeRoot, "cutover");
  const directories = await readdir(cutoverRoot, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const candidates = (await Promise.all(directories
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const manifestPath = join(cutoverRoot, entry.name, "manifest.json");
      try {
        const manifest = activeCutoverSchema.safeParse(JSON.parse(await readFile(manifestPath, "utf8")));
        return manifest.success ? { manifestPath, manifest: manifest.data } : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    })))
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
    .filter(({ manifest }) =>
      resolve(manifest.configPath) === resolve(request.configPath) &&
      resolve(manifest.hooksPath) === resolve(request.hooksPath)
    )
    .sort((left, right) => right.manifest.appliedAt.localeCompare(left.manifest.appliedAt));
  if (candidates.length === 0) return undefined;
  const [configSource, hooksSource] = await Promise.all([
    readFile(request.configPath, "utf8"),
    readFile(request.hooksPath, "utf8")
  ]);
  const configSha256 = sha256(configSource);
  const hooksSha256 = sha256(hooksSource);
  const matching = candidates.find(({ manifest }) =>
    configSha256 === manifest.targetConfigSha256 &&
    hooksSha256 === manifest.targetHooksSha256
  );
  return matching === undefined
    ? { state: "diverged" }
    : { state: "matching", manifestPath: matching.manifestPath };
}

async function requirePath(path: string, description: string): Promise<void> {
  if (!await pathExists(path)) {
    throw new MemStoreCommandError(
      "setup_prerequisite_missing",
      `${description} is missing at ${path}. Run ./install.sh from a complete MemStore checkout.`
    );
  }
}

async function discoverObsidianVault(homeRoot: string): Promise<string> {
  const registryPath = join(
    homeRoot,
    "Library",
    "Application Support",
    "obsidian",
    "obsidian.json"
  );
  let source: string;
  try {
    source = await readFile(registryPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MemStoreCommandError(
        "obsidian_vault_not_found",
        "No Obsidian Vault registry was found. Open the intended Vault in Obsidian or pass --vault explicitly."
      );
    }
    throw error;
  }
  const vaults = Object.values(obsidianSchema.parse(JSON.parse(source)).vaults);
  if (vaults.length === 0) {
    throw new MemStoreCommandError(
      "obsidian_vault_not_found",
      "Obsidian has no registered Vault. Open the intended Vault or pass --vault explicitly."
    );
  }
  const openVaults = vaults.filter((vault) => vault.open === true);
  const selected = openVaults.length === 1
    ? openVaults[0]
    : vaults.length === 1
      ? vaults[0]
      : undefined;
  if (selected === undefined) {
    throw new MemStoreCommandError(
      "obsidian_vault_ambiguous",
      `Obsidian has multiple eligible Vaults (${vaults.map((vault) => vault.path).join(", ")}). Pass --vault with the intended Memory Vault.`
    );
  }
  return resolve(selected.path);
}

async function requireExecutable(path: string, description: string): Promise<void> {
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new MemStoreCommandError(
      "setup_executable_missing",
      `${description} is not executable at ${path}. Pass its absolute path explicitly.`
    );
  }
}

async function resolveExecutable(nameOrPath: string): Promise<string> {
  if (nameOrPath.includes("/")) return resolve(nameOrPath);
  for (const directory of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = join(directory, nameOrPath);
    try {
      await access(candidate, constants.X_OK);
      return resolve(candidate);
    } catch {
      // Continue searching the configured PATH.
    }
  }
  throw new MemStoreCommandError(
    "setup_executable_missing",
    `${nameOrPath} was not found on PATH. Install it or pass its absolute path explicitly.`
  );
}

async function validateRepositoryArtifacts(repositoryRoot: string, notifierSource: string): Promise<void> {
  await Promise.all([
    requirePath(join(repositoryRoot, "dist", "cli", "main.js"), "Built MemStore CLI"),
    requirePath(join(repositoryRoot, "dist", "cli", "hook.js"), "Built MemStore Hook"),
    requirePath(join(repositoryRoot, "dist", "mcp", "main.js"), "Built MemStore MCP server"),
    requirePath(join(repositoryRoot, "skills", "memstore-remember"), "MemStore remember Skill"),
    requirePath(join(repositoryRoot, "skills", "memstore-recall"), "MemStore recall Skill"),
    requirePath(join(repositoryRoot, "skills", "memstore-repair"), "MemStore repair Skill"),
    requirePath(join(notifierSource, "Contents", "MacOS", "memstore-notifier"), "Built MemStore Notifier"),
    requirePath(join(notifierSource, "Contents", "Info.plist"), "MemStore Notifier Info.plist"),
    requirePath(join(notifierSource, "Contents", "_CodeSignature", "CodeResources"), "Signed MemStore Notifier")
  ]);
}

function assertSupportedHost(): void {
  if (process.platform !== "darwin") {
    throw new MemStoreCommandError(
      "setup_platform_unsupported",
      "Friendly setup currently supports macOS only."
    );
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 22 || (minor ?? 0) < 17) {
    throw new MemStoreCommandError(
      "setup_node_unsupported",
      `MemStore requires Node.js >=22.17.0 <23; current version is ${process.version}.`
    );
  }
}

async function requireActiveMemoryBaseline(configPath: string): Promise<void> {
  const document = z.record(z.string(), z.unknown()).parse(
    parseToml(await readFile(configPath, "utf8"))
  );
  const memories = document.memories === undefined
    ? undefined
    : z.record(z.string(), z.unknown()).parse(document.memories);
  if (typeof memories?.generate_memories !== "boolean" ||
      typeof memories.use_memories !== "boolean") {
    throw new MemStoreCommandError(
      "setup_codex_memory_baseline_missing",
      "Active setup needs explicit [memories] generate_memories and use_memories boolean settings in the Codex config.toml so rollback can restore the exact prior state. Add them or use --mode shadow."
    );
  }
}

export async function previewFriendlySetup(
  input: FriendlySetupInput = {}
): Promise<FriendlySetupPreview> {
  assertSupportedHost();
  const homeRoot = resolve(input.homeRoot ?? homedir());
  const repositoryRoot = resolve(input.repositoryRoot ?? process.cwd());
  const vaultRoot = resolve(input.vaultRoot ?? await discoverObsidianVault(homeRoot));
  const runtimeRoot = resolve(
    input.runtimeRoot ?? join(homeRoot, "Library", "Application Support", "MemStore")
  );
  const notifierSource = resolve(
    input.notifierSource ?? join(
      repositoryRoot,
      "native",
      "memstore-notifier",
      ".build",
      "release",
      "MemStore Notifier.app"
    )
  );
  const nodeExecutable = resolve(input.nodeExecutable ?? process.execPath);
  const codexExecutable = await resolveExecutable(
    input.codexExecutable ?? process.env.MEMSTORE_CODEX_EXECUTABLE ?? "codex"
  );
  const embeddingModelDirectory = resolve(
    input.embeddingModelDirectory ?? join(runtimeRoot, "models", "e5-base-q8")
  );
  const preparedAt = z.iso.datetime().parse(input.preparedAt ?? new Date().toISOString());
  const mode = input.mode ?? "active";
  await Promise.all([
    requirePath(vaultRoot, "Memory Vault"),
    requirePath(join(homeRoot, ".codex", "config.toml"), "Codex configuration"),
    requireExecutable(nodeExecutable, "Node.js"),
    requireExecutable(codexExecutable, "Codex CLI"),
    validateRepositoryArtifacts(repositoryRoot, notifierSource)
  ]);
  if (mode === "active") {
    await requireActiveMemoryBaseline(join(homeRoot, ".codex", "config.toml"));
  }
  const request: ManagedRequest = {
    homeRoot,
    repositoryRoot,
    vaultRoot,
    runtimeRoot,
    notifierSource,
    nodeExecutable,
    lunaCodexHome: resolve(input.lunaCodexHome ?? join(homeRoot, ".codex")),
    codexExecutable,
    embeddingModelDirectory,
    installedAt: preparedAt
  };
  const ownershipManifestPath = join(runtimeRoot, "install", "ownership-manifest.json");
  const existingInstallation = await pathExists(ownershipManifestPath);
  const managedPreview = existingInstallation
    ? undefined
    : await previewManagedIntegration(request);
  let upgradePreview: ManagedUpgradePreview | undefined;
  let activeCutover: { readonly state: "matching"; readonly manifestPath: string } | undefined;
  let adoptionPreview: ManagedActiveAdoptionPreview | undefined;
  if (existingInstallation) {
    upgradePreview = await previewManagedIntegrationUpgrade(request);
    if (mode === "active") {
      const hooksPath = await resolvedHooksPath(homeRoot);
      const observedCutover = await matchingActiveCutover({
        runtimeRoot,
        configPath: join(homeRoot, ".codex", "config.toml"),
        hooksPath
      });
      if (observedCutover?.state === "matching") activeCutover = observedCutover;
      else if (observedCutover?.state === "diverged") {
        try {
          adoptionPreview = await previewManagedActiveAdoption(request);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown Active adoption failure.";
          throw new MemStoreCommandError(
            "setup_existing_cutover_diverged",
            `An active MemStore cutover exists, but the current Codex config or Hooks no longer match it and cannot be safely adopted: ${message}`
          );
        }
      }
    }
    const allowedCutoverLabels = adoptionPreview !== undefined
      ? new Set(["codex_config", "codex_hooks_link", "codex_hooks"])
      : activeCutover !== undefined
        ? new Set(["codex_config", "codex_hooks"])
        : new Set<string>();
    const unexpectedDivergence = upgradePreview.observedDivergedTargetLabels.filter(
      (label) => !allowedCutoverLabels.has(label)
    );
    if (unexpectedDivergence.length > 0) {
      throw new MemStoreCommandError(
        "setup_existing_installation_diverged",
        `The owned installation has diverged targets (${unexpectedDivergence.join(", ")}). Run memstore doctor --deep and review the changes before repair.`
      );
    }
  }
  const embeddingPresent = await stat(embeddingModelDirectory)
    .then((metadata) => metadata.isDirectory())
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
  const launchAgentPath = join(
    homeRoot,
    "Library",
    "LaunchAgents",
    `${launchAgentLabel}.plist`
  );
  const preview: FriendlySetupPreview = {
    schemaVersion: 1,
    state: "preview",
    dryRun: true,
    mode,
    paths: {
      homeRoot,
      repositoryRoot,
      vaultRoot,
      runtimeRoot,
      embeddingModelDirectory,
      notifierSource,
      codexExecutable,
      nodeExecutable
    },
    embedding: {
      state: embeddingPresent ? "present" : "missing",
      action: embeddingPresent ? "verify" : "download_and_verify"
    },
    integration: {
      targetCount: managedPreview?.targets.length ?? 0,
      createsCodexHooks: managedPreview?.targets.some((target) =>
        target.label === "codex_hooks" && target.before.state === "absent"
      ) ?? false,
      action: !existingInstallation
        ? "install_owned_surfaces"
        : adoptionPreview !== undefined
          ? "adopt_legacy_active_installation"
        : activeCutover === undefined
          ? "resume_owned_installation"
          : "verify_active_installation"
    },
    cutover: {
      action: activeCutover !== undefined || adoptionPreview !== undefined
        ? "keep_active"
        : mode === "active"
        ? "activate_memstore_and_disable_codex_memory"
        : "keep_shadow",
      nativeMemoryDataOperation: "none"
    },
    worker: { action: "bootstrap_and_verify", launchAgentPath }
  };
  previewInternals.set(preview, managedPreview !== undefined
    ? { action: "install", request, managedPreview }
    : adoptionPreview !== undefined
      ? { action: "adopt", request, adoptionPreview }
    : activeCutover !== undefined && upgradePreview !== undefined
      ? {
          action: "active",
          request,
          upgradePreview,
          rollbackManifestPath: activeCutover.manifestPath
        }
      : { action: "resume", request });
  return preview;
}

async function foregroundAvailable(runtimeRoot: string): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    const socket = createConnection(foregroundRetrievalSocketPath(runtimeRoot));
    let complete = false;
    const finish = (available: boolean): void => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(available);
    };
    const timer = setTimeout(() => { finish(false); }, 100);
    socket.once("connect", () => { finish(true); });
    socket.once("error", () => { finish(false); });
  });
}

async function waitForForeground(
  runtimeRoot: string,
  timeoutMilliseconds: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  do {
    if (await foregroundAvailable(runtimeRoot)) return true;
    await new Promise<void>((resolveWait) => { setTimeout(resolveWait, 250); });
  } while (Date.now() < deadline);
  return false;
}

async function launchAgentLoaded(service: string): Promise<boolean> {
  try {
    await execFileAsync("/bin/launchctl", ["print", service]);
    return true;
  } catch {
    return false;
  }
}

async function activateLaunchAgent(path: string): Promise<"bootstrapped" | "restarted"> {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new MemStoreCommandError("setup_launch_agent_failed", "Cannot determine the current macOS user ID.");
  }
  const domain = `gui/${String(uid)}`;
  const service = `${domain}/${launchAgentLabel}`;
  const loaded = await launchAgentLoaded(service);
  if (!loaded) await execFileAsync("/bin/launchctl", ["bootstrap", domain, path]);
  await execFileAsync("/bin/launchctl", ["kickstart", "-k", service]);
  return loaded ? "restarted" : "bootstrapped";
}

async function authorizeNotifications(
  notifierExecutable: string
): Promise<"authorized" | "denied" | "unavailable"> {
  return new Promise((resolveAuthorization) => {
    execFile(notifierExecutable, ["authorize"], { encoding: "utf8" }, (_error, stdout) => {
      try {
        const response = z.object({ state: z.string() }).parse(JSON.parse(stdout));
        resolveAuthorization(response.state === "delivered"
          ? "authorized"
          : response.state === "permission_denied"
            ? "denied"
            : "unavailable");
      } catch {
        resolveAuthorization("unavailable");
      }
    });
  });
}

const defaultAdapters: FriendlySetupAdapters = {
  prepareEmbedding: async (destination) => {
    const result = await prepareShadowEmbedding({ destination, preview: false });
    return { state: result.state === "verified" ? "verified" : "installed" };
  },
  activateLaunchAgent,
  waitForForeground,
  authorizeNotifications
};

export async function applyFriendlySetup(
  preview: FriendlySetupPreview,
  adapters: FriendlySetupAdapters = defaultAdapters
): Promise<{
  readonly schemaVersion: 1;
  readonly state: "ready";
  readonly mode: FriendlySetupMode;
  readonly embedding: { readonly state: "installed" | "verified" };
  readonly integration: {
    readonly state: "installed" | "healthy" | "repaired" | "upgraded" | "adopted";
    readonly manifestPath: string;
  };
  readonly cutover: { readonly state: "active" | "shadow"; readonly rollbackManifestPath: string | null };
  readonly worker: { readonly state: "running"; readonly activation: "bootstrapped" | "restarted" };
  readonly notifications: { readonly state: "authorized" | "denied" | "unavailable" };
}> {
  const internals = previewInternals.get(preview);
  if (internals === undefined) {
    throw new MemStoreCommandError(
      "setup_preview_required",
      "Generate a fresh friendly setup preview before applying the installation."
    );
  }
  const embedding = await adapters.prepareEmbedding(preview.paths.embeddingModelDirectory);
  let integrationState: "installed" | "healthy" | "repaired" | "upgraded" | "adopted";
  let adoptedRollbackManifestPath: string | null = null;
  if (internals.action === "install") {
    integrationState = (await applyManagedIntegration(
      internals.request,
      internals.managedPreview
    )).state;
  } else if (internals.action === "adopt") {
    const adoption = await applyManagedActiveAdoption(
      internals.request,
      internals.adoptionPreview
    );
    integrationState = adoption.state;
    adoptedRollbackManifestPath = adoption.rollbackManifestPath;
  } else if (internals.action === "active") {
    integrationState = (await applyManagedIntegrationUpgrade(
      internals.request,
      internals.upgradePreview
    )).state;
  } else {
    integrationState = (await repairManagedIntegration(internals.request)).state;
  }
  const manifestPath = join(preview.paths.runtimeRoot, "install", "ownership-manifest.json");
  let activation: "bootstrapped" | "restarted";
  try {
    activation = await adapters.activateLaunchAgent(preview.worker.launchAgentPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown launchctl failure.";
    throw new MemStoreCommandError(
      "setup_launch_agent_failed",
      `MemStore files were installed in Shadow mode, but the Worker could not start: ${message} Codex native memory remains unchanged. Fix the reported launch error, then rerun the same setup command to resume.`
    );
  }
  if (!await adapters.waitForForeground(preview.paths.runtimeRoot, 30_000)) {
    throw new MemStoreCommandError(
      "setup_worker_unavailable",
      "MemStore files were installed in Shadow mode and the Worker was started, but foreground retrieval did not become ready within 30 seconds. Codex native memory remains unchanged. Run memstore doctor --deep, then rerun the same setup command to resume."
    );
  }
  let rollbackManifestPath: string | null = internals.action === "active"
    ? internals.rollbackManifestPath
    : adoptedRollbackManifestPath;
  if (preview.mode === "active" && internals.action !== "active" && internals.action !== "adopt") {
    const hooksTargetPath = await resolvedHooksPath(preview.paths.homeRoot);
    const cutoverPreview = await previewNativeMemoryCutover({
      configPath: join(preview.paths.homeRoot, ".codex", "config.toml"),
      hooksPath: hooksTargetPath,
      nativeStorePaths: [],
      preparedAt: new Date().toISOString()
    });
    const cutover = await applyNativeMemoryCutover({
      runtimeRoot: preview.paths.runtimeRoot,
      preview: cutoverPreview,
      approvalDigest: cutoverPreview.approvalDigest,
      appliedAt: new Date().toISOString()
    });
    rollbackManifestPath = cutover.manifestPath;
  }
  const notificationState = await adapters.authorizeNotifications(join(
    preview.paths.runtimeRoot,
    "bin",
    "MemStore Notifier.app",
    "Contents",
    "MacOS",
    "memstore-notifier"
  ));
  return {
    schemaVersion: 1,
    state: "ready",
    mode: preview.mode,
    embedding,
    integration: { state: integrationState, manifestPath },
    cutover: {
      state: preview.mode,
      rollbackManifestPath
    },
    worker: { state: "running", activation },
    notifications: { state: notificationState }
  };
}
