import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "smol-toml";
import { z } from "zod";

import { openRuntimeDatabase } from "../runtime/database.js";
import { approvedShadowEmbeddingProfile } from "../retrieval/shadow-profile.js";

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

async function programSha256(repositoryRoot: string): Promise<string> {
  const distRoot = join(resolve(repositoryRoot), "dist");
  const files: string[] = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), relative);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        files.push(relative);
      }
    }
  }
  await visit(distRoot, "");
  files.sort((left, right) => left.localeCompare(right, "en-US"));
  if (files.length === 0) throw new Error("The MemStore dist directory has no executable JavaScript.");
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file).update("\0").update(await readFile(join(distRoot, file))).update("\0");
  }
  return hash.digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = z.record(z.string(), z.unknown()).parse(value);
    return Object.fromEntries(
      Object.keys(record)
        .sort((left, right) => left.localeCompare(right, "en-US"))
        .map((key) => [key, canonicalize(record[key])])
    );
  }
  return value;
}

function identitySha256(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

function codexConfigurationIdentity(
  source: string,
  managedHookStateKeys: readonly string[]
): {
  readonly nativeMemory: {
    readonly generateMemories: boolean | undefined;
    readonly useMemories: boolean | undefined;
  };
  readonly memstoreMcp: unknown;
  readonly managedHookStates: unknown;
} {
  const document = z.record(z.string(), z.unknown()).parse(parse(source));
  const memories = document.memories === undefined
    ? {}
    : z.record(z.string(), z.unknown()).parse(document.memories);
  const mcpServers = z.record(z.string(), z.unknown()).parse(document.mcp_servers);
  const memstoreMcp = z.record(z.string(), z.unknown()).parse(mcpServers.memstore);
  const hooks = document.hooks === undefined
    ? {}
    : z.record(z.string(), z.unknown()).parse(document.hooks);
  const hookStates = hooks.state === undefined
    ? {}
    : z.record(z.string(), z.unknown()).parse(hooks.state);
  return {
    nativeMemory: {
      generateMemories: typeof memories.generate_memories === "boolean"
        ? memories.generate_memories
        : undefined,
      useMemories: typeof memories.use_memories === "boolean"
        ? memories.use_memories
        : undefined
    },
    memstoreMcp: canonicalize(memstoreMcp),
    managedHookStates: canonicalize(Object.fromEntries(
      managedHookStateKeys.flatMap((key) =>
        Object.hasOwn(hookStates, key) ? [[key, hookStates[key]]] : []
      )
    ))
  };
}

const shadowIdentityScope = "memstore-v2-native-memory-independent" as const;

function memstoreConfigurationIdentity(identity: ReturnType<typeof codexConfigurationIdentity>): {
  readonly memstoreMcp: unknown;
  readonly managedHookStates: unknown;
} {
  return {
    memstoreMcp: identity.memstoreMcp,
    managedHookStates: identity.managedHookStates
  };
}

const shadowHookEvents = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
  "SessionEnd"
] as const;

function codexHookIdentity(source: string, hookPath: string): {
  readonly routes: Record<string, unknown>;
  readonly stateKeys: readonly string[];
} {
  const document = z.object({
    hooks: z.record(z.string(), z.array(z.unknown()))
  }).parse(JSON.parse(source));
  const stateKeys: string[] = [];
  const routes = Object.fromEntries(shadowHookEvents.map((event) => {
    const marker = `memstore:gate5-shadow-v1:${event}:shadow`;
    const relevant = (document.hooks[event] ?? []).flatMap((routeValue, routeIndex) => {
      const route = z.record(z.string(), z.unknown()).parse(routeValue);
      const hooks = z.array(z.unknown()).parse(route.hooks);
      const routeIdentity = Object.fromEntries(
        Object.entries(route).filter(([key]) => key !== "hooks")
      );
      return hooks.flatMap((hookValue, hookIndex) => {
        const hook = z.record(z.string(), z.unknown()).parse(hookValue);
        if (typeof hook.command !== "string" || !hook.command.includes(marker)) return [];
        const eventKey = event.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
        stateKeys.push(`${hookPath}:${eventKey}:${String(routeIndex)}:${String(hookIndex)}`);
        return [{ route: canonicalize(routeIdentity), hook: canonicalize(hook) }];
      });
    });
    if (relevant.length !== 1) {
      throw new Error(`Installed ${event} Shadow Hook must have exactly one managed route.`);
    }
    return [event, relevant];
  }));
  return { routes, stateKeys };
}

async function validatedBaseline(request: {
  readonly runtimeRoot: string;
  readonly repositoryRoot: string;
  readonly homeRoot: string;
  readonly probeEventId: string;
  readonly startedAt: string;
}): Promise<{
  readonly candidateId: "gate5-shadow-v1";
  readonly candidateSha256: string;
  readonly installationId: string;
  readonly minimumEndAt: string;
  readonly baseline: Record<string, unknown>;
}> {
  const startedAt = z.iso.datetime().parse(request.startedAt);
  const [candidateSource, manifestSource, configSource, hooksSource, programSha] = await Promise.all([
    readFile(join(resolve(request.repositoryRoot), "config", "gate5-shadow-v1.json"), "utf8"),
    readFile(join(resolve(request.runtimeRoot), "install", "ownership-manifest.json"), "utf8"),
    readFile(join(resolve(request.homeRoot), ".codex", "config.toml"), "utf8"),
    readFile(join(resolve(request.homeRoot), ".codex", "hooks.json"), "utf8"),
    programSha256(request.repositoryRoot)
  ]);
  const candidate = z.looseObject({
    candidateId: z.literal("gate5-shadow-v1"),
    mode: z.literal("shadow"),
    automaticInjection: z.literal(false)
  }).parse(JSON.parse(candidateSource));
  const manifest = z.looseObject({
    installationId: z.string().min(1),
    candidateId: z.literal("gate5-shadow-v1"),
    state: z.literal("installed")
  }).parse(JSON.parse(manifestSource));
  const hooksIdentity = codexHookIdentity(
    hooksSource,
    join(resolve(request.homeRoot), ".codex", "hooks.json")
  );
  const configIdentity = codexConfigurationIdentity(configSource, hooksIdentity.stateKeys);
  const { generateMemories, useMemories } = configIdentity.nativeMemory;

  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const probe = database.prepare(
      `SELECT evaluation.state, evaluation.receipt_id, evaluation.updated_at,
              capture.event_kind
       FROM shadow_event_evaluations AS evaluation
       JOIN capture_events AS capture ON capture.event_id = evaluation.event_id
       WHERE evaluation.event_id = ?`
    ).get(request.probeEventId);
    if (probe?.state !== "completed" || typeof probe.receipt_id !== "string") {
      throw new Error("The trusted-Hook probe has no completed Shadow retrieval receipt.");
    }
    if (typeof probe.updated_at !== "string" || probe.updated_at > startedAt) {
      throw new Error("The official Shadow start time must follow its completed probe.");
    }
    const activeIndex = database.prepare(
      `SELECT revision.index_revision_id, revision.adapter_version,
              revision.model_identity, revision.artifact_sha256,
              revision.dimensions, revision.normalization
       FROM active_retrieval_index AS active
       JOIN retrieval_index_revisions AS revision
         ON revision.index_revision_id = active.index_revision_id
       WHERE active.singleton = 1 AND revision.state = 'complete'`
    ).get();
    if (
      activeIndex?.adapter_version !== approvedShadowEmbeddingProfile.adapterVersion ||
      activeIndex.model_identity !== approvedShadowEmbeddingProfile.modelIdentity ||
      activeIndex.artifact_sha256 !== approvedShadowEmbeddingProfile.artifactSha256 ||
      activeIndex.dimensions !== approvedShadowEmbeddingProfile.dimensions ||
      activeIndex.normalization !== approvedShadowEmbeddingProfile.normalization
    ) {
      throw new Error("The active retrieval index does not use the Gate 5 approved embedding profile.");
    }
    const counts = database.prepare(
      `SELECT
         (SELECT COUNT(*) FROM capture_events) AS captured_events,
         (SELECT COUNT(*) FROM retrieval_receipts) AS retrieval_receipts,
         (SELECT COUNT(*) FROM shadow_event_evaluations WHERE state = 'completed') AS completed_evaluations,
         (SELECT COUNT(*) FROM irrelevant_observations) AS irrelevant_observations,
         (SELECT COUNT(*) FROM memory_catalog) AS canonical_memories`
    ).get();
    const baseline = {
      schemaVersion: 2,
      identityScope: shadowIdentityScope,
      configSha256: identitySha256(memstoreConfigurationIdentity(configIdentity)),
      hooksSha256: identitySha256(hooksIdentity.routes),
      programSha256: programSha,
      nativeMemory: { generateMemories, useMemories },
      probe: {
        eventId: request.probeEventId,
        eventKind: probe.event_kind,
        receiptId: probe.receipt_id
      },
      activeIndexRevisionId: activeIndex.index_revision_id,
      counts
    };
    return {
      candidateId: candidate.candidateId,
      candidateSha256: sha256(candidateSource),
      installationId: manifest.installationId,
      minimumEndAt: new Date(Date.parse(startedAt) + 7 * 24 * 60 * 60 * 1000).toISOString(),
      baseline
    };
  } finally {
    database.close();
  }
}

export async function migrateOfficialShadowIdentity(request: {
  readonly runtimeRoot: string;
  readonly repositoryRoot: string;
  readonly homeRoot: string;
  readonly windowId: string;
  readonly migratedAt: string;
  readonly preview?: boolean;
}): Promise<{
  readonly state: "preview" | "migrated";
  readonly dryRun: boolean;
  readonly windowId: string;
  readonly identityScope: typeof shadowIdentityScope;
  readonly previousBaselineSha256: string;
  readonly baselineSha256: string;
}> {
  const migratedAt = z.iso.datetime().parse(request.migratedAt);
  const [candidateSource, manifestSource, configSource, hooksSource, programSha] = await Promise.all([
    readFile(join(resolve(request.repositoryRoot), "config", "gate5-shadow-v1.json"), "utf8"),
    readFile(join(resolve(request.runtimeRoot), "install", "ownership-manifest.json"), "utf8"),
    readFile(join(resolve(request.homeRoot), ".codex", "config.toml"), "utf8"),
    readFile(join(resolve(request.homeRoot), ".codex", "hooks.json"), "utf8"),
    programSha256(request.repositoryRoot)
  ]);
  const manifest = z.looseObject({
    installationId: z.string().min(1),
    candidateId: z.literal("gate5-shadow-v1"),
    state: z.literal("installed")
  }).parse(JSON.parse(manifestSource));
  const hooksIdentity = codexHookIdentity(
    hooksSource,
    join(resolve(request.homeRoot), ".codex", "hooks.json")
  );
  const configIdentity = codexConfigurationIdentity(configSource, hooksIdentity.stateKeys);
  const database = request.preview === true
    ? new DatabaseSync(join(resolve(request.runtimeRoot), "state", "memstore.sqlite"), {
        readOnly: true
      })
    : await openRuntimeDatabase(request.runtimeRoot);
  try {
    const row = database.prepare(
      "SELECT * FROM official_shadow_windows WHERE window_id = ? AND state = 'active'"
    ).get(request.windowId);
    if (row === undefined) throw new Error("The requested active official Shadow window does not exist.");
    const baselineSource = z.string().parse(row.baseline_json);
    const previousBaselineSha256 = z.string().regex(/^[0-9a-f]{64}$/u).parse(row.baseline_sha256);
    if (sha256(baselineSource) !== previousBaselineSha256) {
      throw new Error("The official Shadow baseline digest is invalid.");
    }
    const baseline = z.looseObject({
      identityScope: z.literal("memstore-v1"),
      configSha256: z.string().regex(/^[0-9a-f]{64}$/u),
      hooksSha256: z.string().regex(/^[0-9a-f]{64}$/u),
      programSha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
      nativeMemory: z.object({
        generateMemories: z.boolean(),
        useMemories: z.boolean()
      }),
      activeIndexRevisionId: z.string().min(1),
      counts: z.record(z.string(), z.number()),
      continuityAdjustments: z.array(z.record(z.string(), z.unknown())).optional()
    }).parse(JSON.parse(baselineSource));
    if (
      sha256(candidateSource) !== row.candidate_sha256 ||
      manifest.installationId !== row.installation_id ||
      manifest.candidateId !== row.candidate_id
    ) {
      throw new Error("The installed Shadow candidate changed; identity continuity cannot be proven.");
    }
    if (identitySha256(hooksIdentity.routes) !== baseline.hooksSha256) {
      throw new Error("Managed Shadow Hooks changed; identity continuity cannot be proven.");
    }
    const legacyIdentity = {
      ...configIdentity,
      nativeMemory: baseline.nativeMemory
    };
    if (identitySha256(legacyIdentity) !== baseline.configSha256) {
      throw new Error("MemStore MCP or managed Hook state changed; identity continuity cannot be proven.");
    }
    const activeIndex = database.prepare(
      `SELECT revision.index_revision_id, revision.adapter_version,
              revision.model_identity, revision.artifact_sha256,
              revision.dimensions, revision.normalization
       FROM active_retrieval_index AS active
       JOIN retrieval_index_revisions AS revision
         ON revision.index_revision_id = active.index_revision_id
       WHERE active.singleton = 1 AND revision.state = 'complete'`
    ).get();
    if (
      activeIndex?.adapter_version !== approvedShadowEmbeddingProfile.adapterVersion ||
      activeIndex.model_identity !== approvedShadowEmbeddingProfile.modelIdentity ||
      activeIndex.artifact_sha256 !== approvedShadowEmbeddingProfile.artifactSha256 ||
      activeIndex.dimensions !== approvedShadowEmbeddingProfile.dimensions ||
      activeIndex.normalization !== approvedShadowEmbeddingProfile.normalization
    ) {
      throw new Error("The active retrieval index changed; identity continuity cannot be proven.");
    }
    const continuityAdjustment = {
      kind: "exclude_native_memory_from_shadow_identity",
      migratedAt,
      previousIdentityScope: "memstore-v1",
      previousBaselineSha256,
      previousProgramSha256: baseline.programSha256,
      programSha256: programSha,
      nativeMemoryAtBaseline: baseline.nativeMemory,
      nativeMemoryAtMigration: configIdentity.nativeMemory
    };
    const migratedBaseline = {
      ...baseline,
      schemaVersion: 2,
      identityScope: shadowIdentityScope,
      configSha256: identitySha256(memstoreConfigurationIdentity(configIdentity)),
      programSha256: programSha,
      continuityAdjustments: [
        ...(baseline.continuityAdjustments ?? []),
        continuityAdjustment
      ]
    };
    const migratedSource = JSON.stringify(migratedBaseline);
    const baselineSha256 = sha256(migratedSource);
    if (request.preview !== true) {
      const result = database.prepare(
        `UPDATE official_shadow_windows
         SET baseline_json = ?, baseline_sha256 = ?
         WHERE window_id = ? AND state = 'active' AND baseline_sha256 = ?`
      ).run(migratedSource, baselineSha256, request.windowId, previousBaselineSha256);
      if (result.changes !== 1) throw new Error("The official Shadow baseline changed during migration.");
    }
    return {
      state: request.preview === true ? "preview" : "migrated",
      dryRun: request.preview === true,
      windowId: request.windowId,
      identityScope: shadowIdentityScope,
      previousBaselineSha256,
      baselineSha256
    };
  } finally {
    database.close();
  }
}

export async function acceptOfficialShadowProgramChange(request: {
  readonly runtimeRoot: string;
  readonly repositoryRoot: string;
  readonly homeRoot: string;
  readonly windowId: string;
  readonly acceptedAt: string;
  readonly reason: string;
  readonly preview?: boolean;
}): Promise<{
  readonly state: "preview" | "accepted";
  readonly dryRun: boolean;
  readonly windowId: string;
  readonly reason: string;
  readonly previousProgramSha256: string;
  readonly programSha256: string;
  readonly previousBaselineSha256: string;
  readonly baselineSha256: string;
}> {
  const acceptedAt = z.iso.datetime().parse(request.acceptedAt);
  const reason = z.string().trim().min(5).max(512).parse(request.reason);
  const [candidateSource, manifestSource, configSource, hooksSource, programSha] = await Promise.all([
    readFile(join(resolve(request.repositoryRoot), "config", "gate5-shadow-v1.json"), "utf8"),
    readFile(join(resolve(request.runtimeRoot), "install", "ownership-manifest.json"), "utf8"),
    readFile(join(resolve(request.homeRoot), ".codex", "config.toml"), "utf8"),
    readFile(join(resolve(request.homeRoot), ".codex", "hooks.json"), "utf8"),
    programSha256(request.repositoryRoot)
  ]);
  const manifest = z.looseObject({
    installationId: z.string().min(1),
    candidateId: z.literal("gate5-shadow-v1"),
    state: z.literal("installed")
  }).parse(JSON.parse(manifestSource));
  const hooksIdentity = codexHookIdentity(
    hooksSource,
    join(resolve(request.homeRoot), ".codex", "hooks.json")
  );
  const configIdentity = codexConfigurationIdentity(configSource, hooksIdentity.stateKeys);
  const database = request.preview === true
    ? new DatabaseSync(join(resolve(request.runtimeRoot), "state", "memstore.sqlite"), {
        readOnly: true
      })
    : await openRuntimeDatabase(request.runtimeRoot);
  try {
    const row = database.prepare(
      "SELECT * FROM official_shadow_windows WHERE window_id = ? AND state = 'active'"
    ).get(request.windowId);
    if (row === undefined) {
      throw new Error("The requested active official Shadow window does not exist.");
    }
    const baselineSource = z.string().parse(row.baseline_json);
    const previousBaselineSha256 = z.string().regex(/^[0-9a-f]{64}$/u).parse(
      row.baseline_sha256
    );
    if (sha256(baselineSource) !== previousBaselineSha256) {
      throw new Error("The official Shadow baseline digest is invalid.");
    }
    const baseline = z.looseObject({
      identityScope: z.literal(shadowIdentityScope),
      configSha256: z.string().regex(/^[0-9a-f]{64}$/u),
      hooksSha256: z.string().regex(/^[0-9a-f]{64}$/u),
      programSha256: z.string().regex(/^[0-9a-f]{64}$/u),
      activeIndexRevisionId: z.string().min(1),
      counts: z.record(z.string(), z.number()),
      continuityAdjustments: z.array(z.record(z.string(), z.unknown())).optional()
    }).parse(JSON.parse(baselineSource));
    if (
      sha256(candidateSource) !== row.candidate_sha256 ||
      manifest.installationId !== row.installation_id ||
      manifest.candidateId !== row.candidate_id
    ) {
      throw new Error("The installed Shadow candidate changed; program continuity cannot be accepted.");
    }
    if (identitySha256(hooksIdentity.routes) !== baseline.hooksSha256) {
      throw new Error("Managed Shadow Hooks changed; program continuity cannot be accepted.");
    }
    if (
      identitySha256(memstoreConfigurationIdentity(configIdentity)) !== baseline.configSha256
    ) {
      throw new Error("MemStore MCP or managed Hook state changed; program continuity cannot be accepted.");
    }
    const activeIndex = database.prepare(
      `SELECT revision.adapter_version, revision.model_identity,
              revision.artifact_sha256, revision.dimensions, revision.normalization
       FROM active_retrieval_index AS active
       JOIN retrieval_index_revisions AS revision
         ON revision.index_revision_id = active.index_revision_id
       WHERE active.singleton = 1 AND revision.state = 'complete'`
    ).get();
    if (
      activeIndex?.adapter_version !== approvedShadowEmbeddingProfile.adapterVersion ||
      activeIndex.model_identity !== approvedShadowEmbeddingProfile.modelIdentity ||
      activeIndex.artifact_sha256 !== approvedShadowEmbeddingProfile.artifactSha256 ||
      activeIndex.dimensions !== approvedShadowEmbeddingProfile.dimensions ||
      activeIndex.normalization !== approvedShadowEmbeddingProfile.normalization
    ) {
      throw new Error("The active retrieval index changed; program continuity cannot be accepted.");
    }
    if (programSha === baseline.programSha256) {
      throw new Error("The official Shadow program identity has not changed.");
    }
    const continuityAdjustment = {
      kind: "accept_reviewed_program_change",
      acceptedAt,
      reason,
      previousBaselineSha256,
      previousProgramSha256: baseline.programSha256,
      programSha256: programSha
    };
    const acceptedBaseline = {
      ...baseline,
      programSha256: programSha,
      continuityAdjustments: [
        ...(baseline.continuityAdjustments ?? []),
        continuityAdjustment
      ]
    };
    const acceptedSource = JSON.stringify(acceptedBaseline);
    const baselineSha256 = sha256(acceptedSource);
    if (request.preview !== true) {
      const result = database.prepare(
        `UPDATE official_shadow_windows
         SET baseline_json = ?, baseline_sha256 = ?
         WHERE window_id = ? AND state = 'active' AND baseline_sha256 = ?`
      ).run(acceptedSource, baselineSha256, request.windowId, previousBaselineSha256);
      if (result.changes !== 1) {
        throw new Error("The official Shadow baseline changed during program acceptance.");
      }
    }
    return {
      state: request.preview === true ? "preview" : "accepted",
      dryRun: request.preview === true,
      windowId: request.windowId,
      reason,
      previousProgramSha256: baseline.programSha256,
      programSha256: programSha,
      previousBaselineSha256,
      baselineSha256
    };
  } finally {
    database.close();
  }
}

export async function startOfficialShadowWindow(request: {
  readonly runtimeRoot: string;
  readonly repositoryRoot: string;
  readonly homeRoot: string;
  readonly probeEventId: string;
  readonly startedAt: string;
  readonly preview?: boolean;
}): Promise<{
  readonly state: "preview" | "active";
  readonly dryRun: boolean;
  readonly windowId?: string;
  readonly candidateSha256: string;
  readonly startedAt: string;
  readonly minimumEndAt: string;
  readonly baselineSha256: string;
}> {
  const validated = await validatedBaseline(request);
  const baselineSource = JSON.stringify(validated.baseline);
  const baselineSha256 = sha256(baselineSource);
  if (request.preview === true) {
    return {
      state: "preview",
      dryRun: true,
      candidateSha256: validated.candidateSha256,
      startedAt: request.startedAt,
      minimumEndAt: validated.minimumEndAt,
      baselineSha256
    };
  }
  const existing = await inspectOfficialShadowWindow({
    runtimeRoot: request.runtimeRoot,
    repositoryRoot: request.repositoryRoot,
    homeRoot: request.homeRoot,
    now: request.startedAt
  });
  if (existing?.state === "active") {
    throw new Error("An official Shadow window is already active.");
  }
  const windowId = `msshadow_${randomUUID()}`;
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    if (existing?.state === "invalidated") {
      const reasons = z.array(z.string()).parse(existing.invalidationReasons);
      database.prepare(
        `UPDATE official_shadow_windows
         SET state = 'invalidated', ended_at = ?, invalidation_reason = ?
         WHERE state = 'active'`
      ).run(request.startedAt, reasons.join(","));
    }
    database.prepare(
      `INSERT INTO official_shadow_windows(
         window_id, candidate_id, candidate_sha256, installation_id,
         probe_event_id, state, started_at, minimum_end_at,
         baseline_json, baseline_sha256, ended_at, invalidation_reason
       ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, NULL)`
    ).run(
      windowId,
      validated.candidateId,
      validated.candidateSha256,
      validated.installationId,
      request.probeEventId,
      request.startedAt,
      validated.minimumEndAt,
      baselineSource,
      baselineSha256
    );
  } finally {
    database.close();
  }
  return {
    state: "active",
    dryRun: false,
    windowId,
    candidateSha256: validated.candidateSha256,
    startedAt: request.startedAt,
    minimumEndAt: validated.minimumEndAt,
    baselineSha256
  };
}

export async function inspectOfficialShadowWindow(request: {
  readonly runtimeRoot: string;
  readonly repositoryRoot: string;
  readonly homeRoot: string;
  readonly now: string;
}): Promise<Record<string, unknown> | undefined> {
  const now = z.iso.datetime().parse(request.now);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const row = database.prepare(
      `SELECT * FROM official_shadow_windows
       ORDER BY CASE WHEN state = 'active' THEN 0 ELSE 1 END,
                started_at DESC
       LIMIT 1`
    ).get();
    if (row === undefined) return undefined;
    const [candidateSource, manifestSource, configSource, hooksSource, programSha] = await Promise.all([
      readFile(join(resolve(request.repositoryRoot), "config", "gate5-shadow-v1.json"), "utf8"),
      readFile(join(resolve(request.runtimeRoot), "install", "ownership-manifest.json"), "utf8"),
      readFile(join(resolve(request.homeRoot), ".codex", "config.toml"), "utf8"),
      readFile(join(resolve(request.homeRoot), ".codex", "hooks.json"), "utf8"),
      programSha256(request.repositoryRoot)
    ]);
    const manifest = z.looseObject({
      installationId: z.string().min(1),
      candidateId: z.string().min(1),
      state: z.string().min(1)
    }).parse(JSON.parse(manifestSource));
    const hooksIdentity = codexHookIdentity(
      hooksSource,
      join(resolve(request.homeRoot), ".codex", "hooks.json")
    );
    const configIdentity = codexConfigurationIdentity(configSource, hooksIdentity.stateKeys);
    const baseline = z.looseObject({
      identityScope: z.string().optional(),
      configSha256: z.string().regex(/^[0-9a-f]{64}$/u),
      hooksSha256: z.string().regex(/^[0-9a-f]{64}$/u),
      programSha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
      activeIndexRevisionId: z.string().min(1),
      counts: z.record(z.string(), z.number()),
      continuityAdjustments: z.array(z.record(z.string(), z.unknown())).optional()
    })
      .parse(JSON.parse(z.string().parse(row.baseline_json)));
    const current = z.record(z.string(), z.number()).parse(database.prepare(
      `SELECT
         (SELECT COUNT(*) FROM capture_events) AS captured_events,
         (SELECT COUNT(*) FROM retrieval_receipts) AS retrieval_receipts,
         (SELECT COUNT(*) FROM shadow_event_evaluations WHERE state = 'completed') AS completed_evaluations,
         (SELECT COUNT(*) FROM irrelevant_observations) AS irrelevant_observations,
         (SELECT COUNT(*) FROM memory_catalog) AS canonical_memories`
    ).get());
    const startedAt = z.string().parse(row.started_at);
    const minimumEndAt = z.string().parse(row.minimum_end_at);
    const activeIndex = database.prepare(
      `SELECT revision.index_revision_id, revision.adapter_version,
              revision.model_identity, revision.artifact_sha256,
              revision.dimensions, revision.normalization
       FROM active_retrieval_index AS active
       JOIN retrieval_index_revisions AS revision
         ON revision.index_revision_id = active.index_revision_id
       WHERE active.singleton = 1 AND revision.state = 'complete'`
    ).get();
    const invalidationReasons: string[] = [];
    if (sha256(candidateSource) !== row.candidate_sha256) {
      invalidationReasons.push("candidate_changed");
    }
    if (
      manifest.state !== "installed" ||
      manifest.candidateId !== row.candidate_id ||
      manifest.installationId !== row.installation_id
    ) {
      invalidationReasons.push("installation_changed");
    }
    if (baseline.identityScope !== "memstore-v1" && baseline.identityScope !== shadowIdentityScope) {
      invalidationReasons.push("identity_scope_changed");
    } else {
      const currentConfigIdentity = baseline.identityScope === "memstore-v1"
        ? configIdentity
        : memstoreConfigurationIdentity(configIdentity);
      if (identitySha256(currentConfigIdentity) !== baseline.configSha256) {
        invalidationReasons.push("codex_config_changed");
      }
      if (identitySha256(hooksIdentity.routes) !== baseline.hooksSha256) {
        invalidationReasons.push("hooks_changed");
      }
    }
    if (baseline.programSha256 === undefined) {
      invalidationReasons.push("program_identity_missing");
    } else if (programSha !== baseline.programSha256) {
      invalidationReasons.push("program_changed");
    }
    if (
      activeIndex?.adapter_version !== approvedShadowEmbeddingProfile.adapterVersion ||
      activeIndex.model_identity !== approvedShadowEmbeddingProfile.modelIdentity ||
      activeIndex.artifact_sha256 !== approvedShadowEmbeddingProfile.artifactSha256 ||
      activeIndex.dimensions !== approvedShadowEmbeddingProfile.dimensions ||
      activeIndex.normalization !== approvedShadowEmbeddingProfile.normalization
    ) {
      invalidationReasons.push("retrieval_index_changed");
    }
    const effectiveState = invalidationReasons.length === 0 ? row.state : "invalidated";
    return {
      windowId: row.window_id,
      state: effectiveState,
      invalidationReasons,
      candidateSha256: row.candidate_sha256,
      startedAt,
      minimumEndAt,
      elapsedCalendarDays: Math.max(0, Math.floor((Date.parse(now) - Date.parse(startedAt)) / (24 * 60 * 60 * 1000))),
      minimumDurationMet: now >= minimumEndAt,
      gate6ReviewEligible: effectiveState === "active" && now >= minimumEndAt,
      nativeMemory: configIdentity.nativeMemory,
      continuityAdjustments: baseline.continuityAdjustments ?? [],
      coverage: Object.fromEntries(Object.entries(current).map(([key, value]) => [
        key,
        { baseline: baseline.counts[key] ?? 0, current: value, delta: value - (baseline.counts[key] ?? 0) }
      ]))
    };
  } finally {
    database.close();
  }
}
