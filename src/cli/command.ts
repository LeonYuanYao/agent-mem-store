#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { text as consumeText } from "node:stream/consumers";
import { z } from "zod";

import {
  errorEnvelope,
  MemStoreCommandError,
  successEnvelope
} from "../contracts/envelope.js";
import { initializeMemStore } from "../operations/initialize.js";
import { prepareShadowEmbedding } from "../operations/embedding-install.js";
import { migrateMemoryCategories } from "../operations/category-migration.js";
import {
  inspectOfficialShadowWindow,
  startOfficialShadowWindow
} from "../operations/shadow-window.js";
import { inspectDoctor, retryOperation } from "../operations/maintenance.js";
import {
  archiveOperationalMemories,
  auditMemoryQuality,
  repairExactCompactRepresentations
} from "../operations/quality.js";
import {
  enqueueCompactBackfill,
  inspectMemoryQualityPipeline,
  retryRepairableMemoryQuality,
  scheduleCompactQuality
} from "../quality/pipeline.js";
import {
  discoverDuplicateClusters,
  inspectDuplicateClusters
} from "../quality/duplicates.js";
import {
  createRuntimeBackup,
  inspectMigrationReadiness,
  pauseForMigration,
  resumeAfterMigration,
  validatePortableVault
} from "../operations/portability.js";
import { executeRecall } from "../operations/recall.js";
import { previewArchivePurge, runArchivePurgeBatch } from "../purge/index.js";
import {
  approveRepairGate1,
  approveRepairGate2,
  inspectRepair,
  prepareRepair,
  recordRepairApplication,
  recordRepairProposal,
  recordRepairReplay,
  recordSafetyObservation
} from "../repair/index.js";
import {
  projectCollisions,
  projectLink,
  projectList,
  projectRelinkRoot,
  projectResolveCollision,
  projectStatus,
  projectUnlink
} from "../operations/project.js";
import { inspectOperation, inspectStatus, waitForOperation } from "../operations/status.js";
import { SwiftNotifierAdapter } from "../adapters/macos/notifier.js";
import { CodexLunaAdapter } from "../luna/index.js";
import { CodexTerraRetrievalJudge } from "../retrieval/judge.js";
import { runCodexHook } from "./codex-hook.js";
import {
  applyManagedIntegration,
  applyManagedIntegrationUpgrade,
  previewManagedIntegration,
  previewManagedIntegrationUpgrade,
  rehearseNativeMemoryCutover,
  repairManagedIntegration,
  uninstallManagedIntegration
} from "../integration/managed.js";
import { applyReviewAction, type ReviewAction } from "../review/actions.js";
import { generateReviewInbox } from "../review/inbox.js";
import {
  dispatchNextReminder,
  prepareReviewReminder
} from "../review/reminders.js";
import { runWorker, runWorkerOnce, type WorkerAdapters } from "../worker/main.js";
import {
  EmbeddingArtifactMismatchError,
  loadConfiguredEmbeddingAdapter
} from "../retrieval/embeddings/configured.js";
import {
  rememberAssert,
  rememberExtract,
  type RememberScope,
  type StartupPolicy
} from "../operations/remember.js";

function commandIdentity(arguments_: readonly string[]): string {
  return [arguments_[0], arguments_[1]].filter(Boolean).join(".") || "unknown";
}

function normalizeOptionalWait(arguments_: readonly string[]): string[] {
  const normalized = [...arguments_];
  const index = normalized.indexOf("--wait");
  if (index >= 0 && (normalized[index + 1] === undefined || normalized[index + 1]?.startsWith("--"))) {
    normalized.splice(index + 1, 0, "120");
  }
  return normalized;
}

function parseCommon(arguments_: readonly string[]) {
  return parseArgs({
    args: normalizeOptionalWait(arguments_),
    allowPositionals: true,
    strict: true,
    options: {
      vault: { type: "string" },
      runtime: { type: "string" },
      path: { type: "string" },
      scope: { type: "string" },
      startup: { type: "string" },
      text: { type: "string" },
      stdin: { type: "boolean", default: false },
      file: { type: "string" },
      from: { type: "string" },
      revision: { type: "string" },
      detail: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
      "target-tokens": { type: "string" },
      direction: { type: "string" },
      receipt: { type: "string" },
      memory: { type: "string" },
      to: { type: "string" },
      use: { type: "string" },
      separate: { type: "boolean", default: false },
      wait: { type: "string" },
      deep: { type: "boolean", default: false },
      output: { type: "string" },
      backup: { type: "string" },
      bodies: { type: "string" },
      bytes: { type: "string" },
      "duration-ms": { type: "string" },
      executable: { type: "string" },
      "digest-key": { type: "string" },
      due: { type: "string" },
      days: { type: "string" },
      resolution: { type: "string" },
      replaces: { type: "string" },
      summary: { type: "string" },
      conditions: { type: "string" },
      interval: { type: "string" },
      model: { type: "string" },
      "program-version": { type: "string" },
      "code-revision": { type: "string" },
      gate: { type: "string" },
      home: { type: "string" },
      repo: { type: "string" },
      notifier: { type: "string" },
      node: { type: "string" },
      "luna-codex-home": { type: "string" },
      "codex-executable": { type: "string" },
      "embedding-model-dir": { type: "string" },
      "probe-event": { type: "string" },
      window: { type: "string" },
      reason: { type: "string" },
      target: { type: "string", multiple: true },
      "native-store": { type: "string", multiple: true },
      preview: { type: "boolean", default: false },
      json: { type: "boolean", default: false }
    }
  });
}

async function runIntegration(arguments_: readonly string[]): Promise<unknown> {
  const parsed = parseCommon(arguments_);
  const action = parsed.positionals[1];
  const location = roots(parsed.values);
  const homeRoot = resolve(parsed.values.home ?? homedir());
  const repositoryRoot = resolve(parsed.values.repo ?? process.cwd());
  const notifierSource = parsed.values.notifier === undefined
    ? join(repositoryRoot, "native", "memstore-notifier", ".build", "release", "MemStore Notifier.app")
    : resolve(parsed.values.notifier);
  const request = {
    homeRoot,
    repositoryRoot,
    ...location,
    notifierSource,
    nodeExecutable: resolve(parsed.values.node ?? process.execPath),
    lunaCodexHome: resolve(parsed.values["luna-codex-home"] ?? join(homeRoot, ".codex")),
    codexExecutable: parsed.values["codex-executable"] ?? "codex",
    embeddingModelDirectory: resolve(
      parsed.values["embedding-model-dir"] ?? join(location.runtimeRoot, "models", "e5-base-q8")
    ),
    installedAt: new Date().toISOString()
  };
  if (action === "prepare-model") {
    return prepareShadowEmbedding({
      destination: request.embeddingModelDirectory,
      preview: parsed.values.preview
    });
  }
  if (action === "preview" || (action === "install" && parsed.values.preview)) {
    return previewManagedIntegration(request);
  }
  if (action === "install") {
    const preview = await previewManagedIntegration(request);
    return applyManagedIntegration(request, preview);
  }
  if (action === "upgrade") {
    const preview = await previewManagedIntegrationUpgrade(request);
    return parsed.values.preview
      ? preview
      : applyManagedIntegrationUpgrade(request, preview);
  }
  if (action === "repair") {
    return repairManagedIntegration(request, {
      ...(parsed.values.target === undefined
        ? {}
        : { targetLabels: parsed.values.target })
    });
  }
  if (action === "uninstall") {
    if (parsed.values.preview) {
      return previewResult(["owned_codex_hooks", "owned_mcp", "owned_skills", "owned_launch_agent", "owned_notifier"], {
        preserves: ["vault_data", "runtime_data", "native_memory_data", "unrelated_integrations"]
      });
    }
    return uninstallManagedIntegration({
      homeRoot,
      runtimeRoot: location.runtimeRoot,
      uninstalledAt: new Date().toISOString()
    });
  }
  if (action === "rehearse-cutover") {
    if (parsed.values.preview) {
      return previewResult(["temporary_native_memory_flags", "temporary_memstore_injection_mode", "exact_rollback"], {
        native_data_operation: "none"
      });
    }
    return rehearseNativeMemoryCutover({
      configPath: join(homeRoot, ".codex", "config.toml"),
      hooksPath: join(homeRoot, ".codex", "hooks.json"),
      nativeStorePaths: (parsed.values["native-store"] ?? []).map((path) => resolve(path)),
      rehearsedAt: new Date().toISOString()
    });
  }
  throw new MemStoreCommandError("unknown_command", "Use integration prepare-model, preview, install, upgrade, repair, uninstall, or rehearse-cutover.");
}

async function readJsonFile(path: string | undefined): Promise<Record<string, unknown>> {
  if (path === undefined) {
    throw new MemStoreCommandError("input_file_required", "This repair command requires --file with a reviewed JSON payload.");
  }
  return z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(resolve(path), "utf8")));
}

function repairString(payload: Record<string, unknown>, key: string): string {
  return z.string().parse(payload[key]);
}

function repairStrings(payload: Record<string, unknown>, key: string): readonly string[] {
  return z.array(z.string()).parse(payload[key]);
}

async function runRepair(arguments_: readonly string[]): Promise<unknown> {
  const parsed = parseCommon(arguments_);
  const action = parsed.positionals[1];
  const identifier = parsed.positionals[2];
  const { runtimeRoot } = roots(parsed.values);
  const now = new Date().toISOString();
  if (identifier === undefined) {
    throw new MemStoreCommandError("repair_id_required", `repair ${action ?? "command"} requires an id.`);
  }
  if (action === "prepare") {
    return prepareRepair({
      runtimeRoot,
      badCaseId: identifier,
      activeModel: parsed.values.model ?? process.env.CODEX_MODEL ?? "unknown",
      programVersion: parsed.values["program-version"] ?? "0.1.0",
      codeRevision: parsed.values["code-revision"] ?? process.env.MEMSTORE_CODE_REVISION ?? "unconfirmed",
      preparedAt: now,
      preview: parsed.values.preview
    });
  }
  if (action === "status") return inspectRepair(runtimeRoot, identifier);
  const payload = await readJsonFile(parsed.values.file);
  if (action === "propose") {
    return recordRepairProposal({
      runtimeRoot,
      repairId: identifier,
      rootCause: repairString(payload, "rootCause"),
      riskClass: z.enum(["A", "B", "C"]).parse(payload.riskClass),
      diagnosis: repairString(payload, "diagnosis"),
      proposedChanges: repairStrings(payload, "proposedChanges"),
      expectedImpact: repairString(payload, "expectedImpact"),
      risks: repairStrings(payload, "risks"),
      rollbackMethod: repairString(payload, "rollbackMethod"),
      verificationPlan: repairStrings(payload, "verificationPlan"),
      recordedAt: now
    });
  }
  if (action === "approve" && parsed.values.gate === "1") {
    return approveRepairGate1({
      runtimeRoot,
      repairId: identifier,
      approvedBy: repairString(payload, "approvedBy"),
      authorizedTargets: repairStrings(payload, "authorizedTargets"),
      approvedAt: now
    });
  }
  if (action === "applied") {
    return recordRepairApplication({
      runtimeRoot,
      repairId: identifier,
      beforeVersion: repairString(payload, "beforeVersion"),
      afterVersion: repairString(payload, "afterVersion"),
      changedTargets: repairStrings(payload, "changedTargets"),
      appliedAt: now
    });
  }
  if (action === "replay") {
    return recordRepairReplay({
      runtimeRoot,
      repairId: identifier,
      originalCasesPassed: z.boolean().parse(payload.originalCasesPassed),
      protectedCasesPassed: z.boolean().parse(payload.protectedCasesPassed),
      aggregateTargetMet: z.boolean().parse(payload.aggregateTargetMet),
      irrelevantRetrievalWorsened: z.boolean().parse(payload.irrelevantRetrievalWorsened),
      criticalRecallDecreased: z.boolean().parse(payload.criticalRecallDecreased),
      boundaryRegression: z.boolean().parse(payload.boundaryRegression),
      labelsOrThresholdsWeakened: z.boolean().parse(payload.labelsOrThresholdsWeakened),
      commands: repairStrings(payload, "commands"),
      replayedAt: now
    });
  }
  if (action === "approve" && parsed.values.gate === "2") {
    return approveRepairGate2({
      runtimeRoot,
      repairId: identifier,
      approvedBy: repairString(payload, "approvedBy"),
      approvedAt: now
    });
  }
  if (action === "observe") {
    return recordSafetyObservation({
      runtimeRoot,
      repairId: identifier,
      opportunityCount: z.number().int().nonnegative().parse(payload.opportunityCount),
      violationCount: z.number().int().nonnegative().parse(payload.violationCount),
      observedAt: z.string().default(now).parse(payload.observedAt)
    });
  }
  throw new MemStoreCommandError("unknown_command", "Unknown repair command or Review gate.");
}

function writeResult(command: string, result: unknown, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(successEnvelope(command, result))}\n`);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function previewResult(wouldChange: readonly string[], extra: Record<string, unknown> = {}) {
  return { state: "preview", dry_run: true, would_change: wouldChange, ...extra };
}

async function configuredWorkerAdapters(runtimeRoot: string): Promise<{
  readonly adapters?: WorkerAdapters;
  dispose(): Promise<void>;
}> {
  const codexHome = process.env.MEMSTORE_LUNA_CODEX_HOME;
  const notifierExecutable = process.env.MEMSTORE_NOTIFIER_EXECUTABLE;
  const luna = codexHome === undefined
    ? undefined
    : new CodexLunaAdapter({
        codexExecutable: process.env.MEMSTORE_CODEX_EXECUTABLE ?? "codex",
        codexHome: resolve(codexHome),
        isolatedHome: resolve(runtimeRoot, "luna-home"),
        temporaryRoot: resolve(runtimeRoot, "tmp")
      });
  let embedding: Awaited<ReturnType<typeof loadConfiguredEmbeddingAdapter>>;
  try {
    embedding = await loadConfiguredEmbeddingAdapter(runtimeRoot);
  } catch (error) {
    if (!(error instanceof EmbeddingArtifactMismatchError)) throw error;
    throw new MemStoreCommandError("embedding_artifact_mismatch", error.message);
  }
  const adapters = luna === undefined && notifierExecutable === undefined && embedding === undefined
    ? undefined
    : {
    ...(luna === undefined ? {} : { luna, governance: luna, quality: luna }),
    ...(embedding === undefined ? {} : { embedding: embedding.adapter }),
    ...(notifierExecutable === undefined
      ? {}
      : { notifier: new SwiftNotifierAdapter(resolve(notifierExecutable)) })
  };
  return {
    ...(adapters === undefined ? {} : { adapters }),
    dispose: async () => embedding?.dispose()
  };
}

function reviewAction(
  action: string | undefined,
  identifier: string | undefined,
  values: ReturnType<typeof parseCommon>["values"]
): ReviewAction {
  if (identifier === undefined) {
    throw new MemStoreCommandError("review_id_required", "Review action requires an opaque id.");
  }
  if (action === "dismiss-suggestion") return { kind: "dismiss_suggestion", suggestionId: identifier };
  if (action === "complete-verification") return { kind: "complete_verification", verificationRequestId: identifier };
  if (action === "cancel-verification") return { kind: "cancel_verification", verificationRequestId: identifier };
  if (action === "snooze-reminder") {
    return {
      kind: "snooze_reminder",
      reminderId: identifier,
      ...(values.days === undefined
        ? {}
        : { durationDays: z.coerce.number().int().min(1).max(90).parse(values.days) })
    };
  }
  if (action === "acknowledge-reminder") return { kind: "acknowledge_reminder", reminderId: identifier };
  if (action === "resolve-conflict") {
    const resolution = z.enum(["keep-existing", "adopt-new", "distinguish"]).parse(values.resolution);
    if (resolution === "keep-existing") {
      return { kind: "resolve_human_conflict", conflictId: identifier, resolution: { kind: "keep_existing" } };
    }
    if (resolution === "adopt-new") {
      if (values.replaces === undefined) {
        throw new MemStoreCommandError("replacement_required", "adopt-new requires --replaces.");
      }
      return {
        kind: "resolve_human_conflict",
        conflictId: identifier,
        resolution: { kind: "adopt_new", replacesMemoryId: values.replaces }
      };
    }
    if (values.summary === undefined) {
      throw new MemStoreCommandError("applicability_required", "distinguish requires --summary.");
    }
    const conditions = values.conditions === undefined
      ? []
      : z.array(z.string()).parse(JSON.parse(values.conditions));
    return {
      kind: "resolve_human_conflict",
      conflictId: identifier,
      resolution: { kind: "distinguish", applicabilitySummary: values.summary, conditions }
    };
  }
  throw new MemStoreCommandError("unknown_command", "Unknown typed Review action.");
}

async function runOperations(arguments_: readonly string[]): Promise<{ command: string; result: unknown; json: boolean }> {
  const command = arguments_[0];
  const parsed = parseCommon(arguments_);
  const location = roots(parsed.values);
  const now = new Date().toISOString();
  if (command === "shadow") {
    const action = parsed.positionals[1];
    if (action === "status") {
      return {
        command: "shadow.status",
        result: await inspectOfficialShadowWindow({
          runtimeRoot: location.runtimeRoot,
          repositoryRoot: resolve(parsed.values.repo ?? process.cwd()),
          homeRoot: resolve(parsed.values.home ?? homedir()),
          now
        }),
        json: parsed.values.json
      };
    }
    if (action === "report") {
      return {
        command: "shadow.report",
        result: await inspectOfficialShadowWindow({
          runtimeRoot: location.runtimeRoot,
          repositoryRoot: resolve(parsed.values.repo ?? process.cwd()),
          homeRoot: resolve(parsed.values.home ?? homedir()),
          now,
          includeReadinessReport: true
        }),
        json: parsed.values.json
      };
    }
    if (action === "start") {
      if (parsed.values["probe-event"] === undefined) {
        throw new MemStoreCommandError(
          "shadow_probe_required",
          "shadow start requires --probe-event from a trusted Hook and completed Worker evaluation."
        );
      }
      return {
        command: "shadow.start",
        result: await startOfficialShadowWindow({
          runtimeRoot: location.runtimeRoot,
          repositoryRoot: resolve(parsed.values.repo ?? process.cwd()),
          homeRoot: resolve(parsed.values.home ?? homedir()),
          probeEventId: parsed.values["probe-event"],
          startedAt: now,
          preview: parsed.values.preview
        }),
        json: parsed.values.json
      };
    }
    throw new MemStoreCommandError(
      "unknown_command",
      "Use shadow start, shadow status, or shadow report."
    );
  }
  if (command === "purge") {
    const action = parsed.positionals[1];
    if (parsed.values.backup === undefined) {
      throw new MemStoreCommandError(
        "purge_backup_required",
        "purge preview/run requires --backup pointing to a verified Vault backup."
      );
    }
    const limits = {
      ...(parsed.values.bodies === undefined
        ? {}
        : { bodies: z.coerce.number().int().positive().parse(parsed.values.bodies) }),
      ...(parsed.values.bytes === undefined
        ? {}
        : { bytes: z.coerce.number().int().positive().parse(parsed.values.bytes) }),
      ...(parsed.values["duration-ms"] === undefined
        ? {}
        : {
            destructiveMilliseconds: z.coerce.number().int().positive()
              .parse(parsed.values["duration-ms"])
          })
    };
    const purgeRequest = {
      ...location,
      backupRoot: resolve(parsed.values.backup),
      now,
      limits
    };
    if (action === "preview" || (action === "run" && parsed.values.preview)) {
      return {
        command: "purge.preview",
        result: await previewArchivePurge(purgeRequest),
        json: parsed.values.json
      };
    }
    if (action === "run") {
      return {
        command: "purge.run",
        result: await runArchivePurgeBatch(purgeRequest),
        json: parsed.values.json
      };
    }
    throw new MemStoreCommandError("unknown_command", "Use purge preview or purge run.");
  }
  if (command === "doctor") {
    return {
      command: "doctor",
      result: await inspectDoctor({ ...location, deep: parsed.values.deep }),
      json: parsed.values.json
    };
  }
  if (command === "quality" && parsed.positionals[1] === "audit") {
    const limit = optionalPositiveInteger(parsed.values.limit);
    return {
      command: "quality.audit",
      result: await auditMemoryQuality({
        ...location,
        ...(parsed.values.cursor === undefined ? {} : { cursor: parsed.values.cursor }),
        ...(limit === undefined ? {} : { limit })
      }),
      json: parsed.values.json
    };
  }
  if (command === "quality" && parsed.positionals[1] === "repair-representations") {
    const limit = optionalPositiveInteger(parsed.values.limit);
    return {
      command: "quality.repair-representations",
      result: await repairExactCompactRepresentations({
        ...location,
        repairedAt: now,
        preview: parsed.values.preview,
        ...(parsed.values.cursor === undefined ? {} : { cursor: parsed.values.cursor }),
        ...(limit === undefined ? {} : { limit })
      }),
      json: parsed.values.json
    };
  }
  if (command === "quality" && parsed.positionals[1] === "archive-operational") {
    const limit = optionalPositiveInteger(parsed.values.limit);
    return {
      command: "quality.archive-operational",
      result: await archiveOperationalMemories({
        ...location,
        archivedAt: now,
        preview: parsed.values.preview,
        ...(parsed.values.cursor === undefined ? {} : { cursor: parsed.values.cursor }),
        ...(limit === undefined ? {} : { limit })
      }),
      json: parsed.values.json
    };
  }
  if (command === "quality" && parsed.positionals[1] === "compact-backfill") {
    const limit = optionalPositiveInteger(parsed.values.limit);
    return {
      command: "quality.compact-backfill",
      result: await enqueueCompactBackfill({
        ...location,
        requestedAt: now,
        preview: parsed.values.preview,
        ...(parsed.values.cursor === undefined ? {} : { cursor: parsed.values.cursor }),
        ...(limit === undefined ? {} : { limit })
      }),
      json: parsed.values.json
    };
  }
  if (command === "quality" && parsed.positionals[1] === "status") {
    return {
      command: "quality.status",
      result: await inspectMemoryQualityPipeline({ runtimeRoot: location.runtimeRoot }),
      json: parsed.values.json
    };
  }
  if (command === "quality" && parsed.positionals[1] === "retry") {
    return {
      command: "quality.retry",
      result: await retryRepairableMemoryQuality({
        runtimeRoot: location.runtimeRoot,
        retriedAt: now,
        preview: parsed.values.preview
      }),
      json: parsed.values.json
    };
  }
  if (command === "quality" && parsed.positionals[1] === "start") {
    return {
      command: "quality.start",
      result: await scheduleCompactQuality({
        runtimeRoot: location.runtimeRoot,
        requestedAt: now,
        preview: parsed.values.preview
      }),
      json: parsed.values.json
    };
  }
  if (command === "quality" && parsed.positionals[1] === "duplicate-discovery") {
    const limit = optionalPositiveInteger(parsed.values.limit);
    return {
      command: "quality.duplicate-discovery",
      result: await discoverDuplicateClusters({
        runtimeRoot: location.runtimeRoot,
        requestedAt: now,
        preview: parsed.values.preview,
        ...(parsed.values.cursor === undefined ? {} : { cursor: parsed.values.cursor }),
        ...(limit === undefined ? {} : { limit })
      }),
      json: parsed.values.json
    };
  }
  if (command === "quality" && parsed.positionals[1] === "duplicate-status") {
    return {
      command: "quality.duplicate-status",
      result: await inspectDuplicateClusters({ runtimeRoot: location.runtimeRoot }),
      json: parsed.values.json
    };
  }
  if (command === "category" && parsed.positionals[1] === "migrate") {
    return {
      command: "category.migrate",
      result: await migrateMemoryCategories({
        ...location,
        preview: parsed.values.preview,
        migratedAt: now
      }),
      json: parsed.values.json
    };
  }
  if (command === "vault" && parsed.positionals[1] === "validate") {
    return {
      command: "vault.validate",
      result: await validatePortableVault(location),
      json: parsed.values.json
    };
  }
  if (command === "operation" && parsed.positionals[1] === "retry") {
    const operationId = parsed.positionals[2];
    if (operationId === undefined) throw new MemStoreCommandError("operation_id_required", "operation retry requires an id.");
    return {
      command: "operation.retry",
      result: await retryOperation({
        runtimeRoot: location.runtimeRoot,
        operationId,
        requestedAt: now,
        preview: parsed.values.preview
      }),
      json: parsed.values.json
    };
  }
  if (command === "worker" && parsed.positionals[1] === "once") {
    const configured = await configuredWorkerAdapters(location.runtimeRoot);
    try {
      return {
        command: "worker.once",
        result: parsed.values.preview
          ? previewResult(["worker_queues"])
          : await runWorkerOnce({
              ...location,
              workerId: `cli-${String(process.pid)}`,
              now,
              workerStartedAt: now,
              ...(configured.adapters === undefined ? {} : { adapters: configured.adapters })
            }),
        json: parsed.values.json
      };
    } finally {
      await configured.dispose();
    }
  }
  if (command === "worker" && parsed.positionals[1] === "run") {
    if (parsed.values.preview) {
      return {
        command: "worker.run",
        result: previewResult(["worker_queues"], { continuous: true }),
        json: parsed.values.json
      };
    }
    const controller = new AbortController();
    process.once("SIGINT", () => {
      controller.abort();
    });
    process.once("SIGTERM", () => {
      controller.abort();
    });
    const configured = await configuredWorkerAdapters(location.runtimeRoot);
    try {
      return {
        command: "worker.run",
        result: await runWorker({
          ...location,
          workerId: `cli-${String(process.pid)}`,
          startedAt: now,
          intervalMilliseconds: parsed.values.interval === undefined
            ? 1_000
            : z.coerce.number().int().min(100).max(60_000).parse(parsed.values.interval),
          signal: controller.signal,
          ...(configured.adapters === undefined ? {} : { adapters: configured.adapters })
        }),
        json: parsed.values.json
      };
    } finally {
      await configured.dispose();
    }
  }
  if (command === "review" && parsed.positionals[1] === "generate") {
    return {
      command: "review.generate",
      result: parsed.values.preview
        ? previewResult(["review_inbox"])
        : await generateReviewInbox({ ...location, generatedAt: now }),
      json: parsed.values.json
    };
  }
  if (command === "review" && parsed.positionals[1] === "reminder") {
    const action = parsed.positionals[2];
    if (action === "prepare") {
      if (parsed.values["digest-key"] === undefined || parsed.values.due === undefined) {
        throw new MemStoreCommandError("reminder_schedule_required", "Reminder prepare requires --digest-key and --due.");
      }
      return {
        command: "review.reminder.prepare",
        result: parsed.values.preview
          ? previewResult(["reminder_obligation"])
          : await prepareReviewReminder({
              ...location,
              digestKey: parsed.values["digest-key"],
              dueAt: parsed.values.due,
              createdAt: now
            }),
        json: parsed.values.json
      };
    }
    if (action === "dispatch") {
      if (parsed.values.executable === undefined) {
        throw new MemStoreCommandError("notifier_required", "Reminder dispatch requires --executable.");
      }
      return {
        command: "review.reminder.dispatch",
        result: parsed.values.preview
          ? previewResult(["notification_attempt"])
          : await dispatchNextReminder({
              runtimeRoot: location.runtimeRoot,
              now,
              notifier: new SwiftNotifierAdapter(resolve(parsed.values.executable))
            }),
        json: parsed.values.json
      };
    }
  }
  if (command === "review") {
    const action = reviewAction(parsed.positionals[1], parsed.positionals[2], parsed.values);
    return {
      command: `review.${parsed.positionals[1] ?? "action"}`,
      result: parsed.values.preview
        ? previewResult(["review_state"], { action: action.kind })
        : await applyReviewAction({ ...location, action, appliedAt: now }),
      json: parsed.values.json
    };
  }
  if (command === "runtime" && parsed.positionals[1] === "backup") {
    if (parsed.values.output === undefined) {
      throw new MemStoreCommandError("backup_destination_required", "runtime backup requires --output.");
    }
    const destinationPath = resolve(parsed.values.output);
    return {
      command: "runtime.backup",
      result: parsed.values.preview
        ? previewResult(["runtime_backup"], { destination_path: destinationPath })
        : await createRuntimeBackup({
            runtimeRoot: location.runtimeRoot,
            destinationPath,
            createdAt: now
          }),
      json: parsed.values.json
    };
  }
  if (command === "portability") {
    const action = parsed.positionals[1];
    if (action === "readiness") {
      return { command: "portability.readiness", result: await inspectMigrationReadiness(location), json: parsed.values.json };
    }
    if (action === "pause") {
      return {
        command: "portability.pause",
        result: parsed.values.preview
          ? previewResult(["capture_pause", "worker_pause"])
          : await pauseForMigration({ runtimeRoot: location.runtimeRoot, pausedAt: now }),
        json: parsed.values.json
      };
    }
    if (action === "resume") {
      return {
        command: "portability.resume",
        result: parsed.values.preview
          ? previewResult(["capture_resume", "worker_resume"])
          : await resumeAfterMigration({ runtimeRoot: location.runtimeRoot, resumedAt: now }),
        json: parsed.values.json
      };
    }
    throw new MemStoreCommandError(
      "embedding_adapter_required",
      "Destination rebuild and retrieval verification require a configured embedding adapter."
    );
  }
  throw new MemStoreCommandError("unknown_command", "Unknown MemStore command.");
}

async function runProject(arguments_: readonly string[]): Promise<unknown> {
  const parsed = parseCommon(arguments_);
  const action = parsed.positionals[1];
  const { runtimeRoot } = roots(parsed.values);
  const path = resolve(parsed.values.path ?? process.cwd());
  if (action === "status") return projectStatus({ runtimeRoot, path });
  if (action === "list") return { projects: await projectList(runtimeRoot) };
  if (action === "collisions") return { collisions: await projectCollisions(runtimeRoot) };
  if (action === "link") {
    if (parsed.values.to === undefined) throw new MemStoreCommandError("link_target_required", "project link requires --to.");
    return projectLink({ runtimeRoot, path, target: parsed.values.to, preview: parsed.values.preview });
  }
  if (action === "unlink") {
    return projectUnlink({
      runtimeRoot,
      path,
      preview: parsed.values.preview,
      now: new Date().toISOString()
    });
  }
  if (action === "relink-root") {
    if (parsed.values.from === undefined || parsed.values.to === undefined) {
      throw new MemStoreCommandError("root_paths_required", "relink-root requires --from and --to.");
    }
    return projectRelinkRoot({
      runtimeRoot,
      from: parsed.values.from,
      to: parsed.values.to,
      preview: parsed.values.preview
    });
  }
  if (action === "resolve-collision") {
    return projectResolveCollision({
      runtimeRoot,
      path,
      ...(parsed.values.use === undefined ? {} : { useProjectId: parsed.values.use }),
      separate: parsed.values.separate,
      preview: parsed.values.preview
    });
  }
  throw new MemStoreCommandError("unknown_command", "Unknown project command.");
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  return value === undefined
    ? undefined
    : z.coerce.number().int().positive().parse(value);
}

async function runRecall(arguments_: readonly string[]): Promise<unknown> {
  const parsed = parseCommon(arguments_);
  const action = parsed.positionals[1];
  const location = roots(parsed.values);
  const path = resolve(parsed.values.path ?? process.cwd());
  const context = {
    ...location,
    path,
    callerIdentity: process.env.MEMSTORE_CALLER_IDENTITY ?? `cli:${path}`,
    requestedAt: new Date().toISOString()
  };
  const terraCodexHome = process.env.MEMSTORE_TERRA_CODEX_HOME ??
    process.env.MEMSTORE_LUNA_CODEX_HOME;
  const retrievalJudge = terraCodexHome === undefined
    ? undefined
    : new CodexTerraRetrievalJudge({
        codexExecutable: process.env.MEMSTORE_CODEX_EXECUTABLE ?? "codex",
        codexHome: resolve(terraCodexHome),
        isolatedHome: resolve(location.runtimeRoot, "terra-home"),
        temporaryRoot: resolve(location.runtimeRoot, "tmp")
      });
  if (action === "search") {
    const query = parsed.positionals[2];
    if (query === undefined) throw new MemStoreCommandError("query_required", "recall search requires a query.");
    const rawScope = parsed.values.scope ?? "current";
    const projectMatch = /^project:(.+)$/u.exec(rawScope);
    const normalizedScope = projectMatch === null ? rawScope.replace("all-projects", "all_projects") : "project";
    let embedding: Awaited<ReturnType<typeof loadConfiguredEmbeddingAdapter>>;
    try {
      embedding = await loadConfiguredEmbeddingAdapter(location.runtimeRoot);
      return await executeRecall("search", {
        query,
        scope: normalizedScope,
        ...(projectMatch?.[1] === undefined ? {} : { project_id: projectMatch[1] }),
        ...(optionalPositiveInteger(parsed.values.limit) === undefined
          ? {}
          : { limit: optionalPositiveInteger(parsed.values.limit) }),
        ...(parsed.values.cursor === undefined ? {} : { cursor: parsed.values.cursor }),
        ...(optionalPositiveInteger(parsed.values["target-tokens"]) === undefined
          ? {}
          : { target_tokens: optionalPositiveInteger(parsed.values["target-tokens"]) })
      }, {
        ...context,
        ...(embedding === undefined ? {} : { embeddingAdapter: embedding.adapter }),
        ...(retrievalJudge === undefined ? {} : { retrievalJudge })
      });
    } catch (error) {
      if (!(error instanceof EmbeddingArtifactMismatchError)) throw error;
      throw new MemStoreCommandError("embedding_artifact_mismatch", error.message);
    } finally {
      await embedding?.dispose();
    }
  }
  if (["show", "provenance", "related"].includes(action ?? "")) {
    const memoryId = parsed.positionals[2];
    if (memoryId === undefined) throw new MemStoreCommandError("memory_id_required", `recall ${action ?? "command"} requires a memory id.`);
    const input = {
      memory_id: memoryId,
      ...(parsed.values.revision === undefined ? {} : { revision: parsed.values.revision }),
      ...(parsed.values.detail === undefined ? {} : { detail: parsed.values.detail }),
      ...(parsed.values.direction === undefined ? {} : { direction: parsed.values.direction }),
      ...(optionalPositiveInteger(parsed.values.limit) === undefined
        ? {}
        : { limit: optionalPositiveInteger(parsed.values.limit) }),
      ...(parsed.values.cursor === undefined ? {} : { cursor: parsed.values.cursor }),
      ...(optionalPositiveInteger(parsed.values["target-tokens"]) === undefined
        ? {}
        : { target_tokens: optionalPositiveInteger(parsed.values["target-tokens"]) })
    };
    const operation = action === "show"
      ? "get"
      : action === "provenance"
        ? "provenance"
        : "related";
    return executeRecall(operation, input, context);
  }
  if (action === "report-irrelevant") {
    if (parsed.values.receipt === undefined || parsed.values.memory === undefined) {
      throw new MemStoreCommandError(
        "receipt_and_memory_required",
        "report-irrelevant requires --receipt and --memory."
      );
    }
    return executeRecall("report_irrelevant", {
      receipt_id: parsed.values.receipt,
      memory_id: parsed.values.memory
    }, context);
  }
  throw new MemStoreCommandError("unknown_command", "Unknown recall command.");
}

function roots(values: { readonly vault?: string; readonly runtime?: string }): {
  readonly vaultRoot: string;
  readonly runtimeRoot: string;
} {
  const vaultRoot = values.vault ?? process.env.MEMSTORE_VAULT_ROOT;
  const runtimeRoot = values.runtime ?? process.env.MEMSTORE_RUNTIME_ROOT;
  if (vaultRoot === undefined || runtimeRoot === undefined) {
    throw new MemStoreCommandError(
      "configuration_location_required",
      "Provide --vault and --runtime, or set MEMSTORE_VAULT_ROOT and MEMSTORE_RUNTIME_ROOT."
    );
  }
  return { vaultRoot: resolve(vaultRoot), runtimeRoot: resolve(runtimeRoot) };
}

async function readStandardInput(): Promise<string> {
  return consumeText(process.stdin);
}

async function assertionBody(values: {
  readonly text?: string;
  readonly stdin?: boolean;
  readonly file?: string;
}): Promise<string> {
  const selected = [
    values.text === undefined ? undefined : "text",
    values.stdin === true ? "stdin" : undefined,
    values.file === undefined ? undefined : "file"
  ].filter((value): value is string => value !== undefined);
  if (selected.length !== 1) {
    throw new MemStoreCommandError(
      "invalid_content_input",
      "remember assert requires exactly one of --text, --stdin, or --file."
    );
  }
  if (values.text !== undefined) return values.text;
  if (values.stdin === true) return readStandardInput();
  return readFile(resolve(z.string().parse(values.file)), "utf8");
}

function scope(value: string | undefined): RememberScope {
  return z.enum(["project", "global"]).parse(value ?? "project");
}

function startup(value: string | undefined): StartupPolicy {
  return z.enum(["auto", "always", "never"]).parse(value ?? "auto");
}

async function runRemember(arguments_: readonly string[]): Promise<unknown> {
  const parsed = parseCommon(arguments_);
  const action = parsed.positionals[1];
  const location = roots(parsed.values);
  const workingPath = resolve(parsed.values.path ?? process.cwd());
  if (action === "assert") {
    if (parsed.values.wait !== undefined) {
      throw new MemStoreCommandError("wait_not_supported", "--wait is available only for remember extract.");
    }
    return rememberAssert({
      ...location,
      path: workingPath,
      body: await assertionBody(parsed.values),
      scope: scope(parsed.values.scope),
      startup: startup(parsed.values.startup),
      preview: parsed.values.preview,
      assertedAt: new Date().toISOString()
    });
  }
  if (action === "extract") {
    const source = parsed.values.from;
    if (source === undefined) {
      throw new MemStoreCommandError("source_required", "remember extract requires --from.");
    }
    if (parsed.values.preview && parsed.values.wait !== undefined) {
      throw new MemStoreCommandError("preview_wait_conflict", "--preview and --wait are mutually exclusive.");
    }
    if (parsed.values.wait !== undefined) {
      z.coerce.number().int().min(1).max(3600).parse(parsed.values.wait);
    }
    const result = await rememberExtract({
      ...location,
      path: workingPath,
      source,
      scope: scope(parsed.values.scope),
      startup: startup(parsed.values.startup),
      preview: parsed.values.preview,
      requestedAt: new Date().toISOString()
    });
    if (parsed.values.wait === undefined) return result;
    const operationId = z.string().parse(
      z.record(z.string(), z.unknown()).parse(result).operation_id
    );
    return {
      ...z.record(z.string(), z.unknown()).parse(result),
      wait: await waitForOperation({
        runtimeRoot: location.runtimeRoot,
        operationId,
        timeoutSeconds: z.coerce.number().int().min(1).max(3600).parse(parsed.values.wait)
      })
    };
  }
  throw new MemStoreCommandError("unknown_command", "Unknown remember command.");
}

async function run(arguments_: readonly string[]): Promise<void> {
  const command = arguments_[0];
  if (command === "hook" && arguments_[1] === "codex") {
    await runCodexHook(arguments_[2]);
    return;
  }
  if (command === "init") {
    const parsed = parseCommon(arguments_);
    const location = roots(parsed.values);
    const result = await initializeMemStore({
      ...location,
      preview: parsed.values.preview
    });
    if (parsed.values.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write(`${result.state}: vault=${result.vaultRoot} runtime=${result.runtimeRoot}\n`);
    return;
  }
  if (command === "remember") {
    const result = await runRemember(arguments_);
    const parsed = parseCommon(arguments_);
    if (parsed.values.json) {
      process.stdout.write(`${JSON.stringify(successEnvelope(commandIdentity(arguments_), result))}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    return;
  }
  if (command === "recall") {
    const result = await runRecall(arguments_);
    const parsed = parseCommon(arguments_);
    if (parsed.values.json) {
      process.stdout.write(`${JSON.stringify(successEnvelope(commandIdentity(arguments_), result))}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    return;
  }
  if (command === "project") {
    const result = await runProject(arguments_);
    const parsed = parseCommon(arguments_);
    if (parsed.values.json) process.stdout.write(`${JSON.stringify(successEnvelope(commandIdentity(arguments_), result))}\n`);
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "repair") {
    const result = await runRepair(arguments_);
    const parsed = parseCommon(arguments_);
    if (parsed.values.json) process.stdout.write(`${JSON.stringify(successEnvelope(commandIdentity(arguments_), result))}\n`);
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "integration") {
    const result = await runIntegration(arguments_);
    const parsed = parseCommon(arguments_);
    if (parsed.values.json) process.stdout.write(`${JSON.stringify(successEnvelope(commandIdentity(arguments_), result))}\n`);
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "operation" && arguments_[1] === "status") {
    const parsed = parseCommon(arguments_);
    const operationId = parsed.positionals[2];
    if (operationId === undefined) throw new MemStoreCommandError("operation_id_required", "operation status requires an id.");
    const result = await inspectOperation(roots(parsed.values).runtimeRoot, operationId);
    if (parsed.values.json) process.stdout.write(`${JSON.stringify(successEnvelope("operation.status", result))}\n`);
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "status") {
    const parsed = parseCommon(arguments_);
    const location = roots(parsed.values);
    const result = await inspectStatus(location);
    if (parsed.values.json) process.stdout.write(`${JSON.stringify(successEnvelope("status", result))}\n`);
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (["doctor", "vault", "worker", "review", "runtime", "portability", "purge", "shadow", "category", "quality"].includes(command ?? "") ||
      (command === "operation" && arguments_[1] === "retry")) {
    const output = await runOperations(arguments_);
    writeResult(output.command, output.result, output.json);
    return;
  }
  throw new MemStoreCommandError("unknown_command", "Unknown MemStore command.");
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  const command = commandIdentity(process.argv.slice(2));
  const wantsJson = process.argv.includes("--json");
  if (wantsJson) {
    const envelope = errorEnvelope(command, error);
    process.stderr.write(`${JSON.stringify(envelope)}\n`);
  } else {
    const code = error instanceof MemStoreCommandError ? `${error.code}: ` : "";
    const message = error instanceof Error ? error.message : "Unknown MemStore error.";
    process.stderr.write(`memstore: ${code}${message}\n`);
  }
  process.exitCode = 2;
}
