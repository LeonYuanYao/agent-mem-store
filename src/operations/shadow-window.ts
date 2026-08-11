import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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

function memoryFlag(source: string, key: "generate_memories" | "use_memories"): boolean {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === "[memories]");
  if (start < 0) throw new Error("Codex config has no [memories] section.");
  const endOffset = lines.slice(start + 1).findIndex((line) => /^\[[^\]]+\]\s*$/u.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  const section = lines.slice(start + 1, end).join("\n");
  const match = new RegExp(`^${key}\\s*=\\s*(true|false)\\s*$`, "mu").exec(section);
  if (match?.[1] === undefined) throw new Error(`Codex config has no ${key} value.`);
  return match[1] === "true";
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
  const generateMemories = memoryFlag(configSource, "generate_memories");
  const useMemories = memoryFlag(configSource, "use_memories");
  if (!generateMemories || !useMemories) {
    throw new Error("Official Shadow requires Codex native generation and recall to remain enabled as its baseline.");
  }
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]) {
    if (!hooksSource.includes(`memstore:gate5-shadow-v1:${event}:shadow`)) {
      throw new Error(`Installed ${event} Shadow Hook is missing.`);
    }
  }

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
      `SELECT revision.index_revision_id, revision.artifact_sha256
       FROM active_retrieval_index AS active
       JOIN retrieval_index_revisions AS revision
         ON revision.index_revision_id = active.index_revision_id
       WHERE active.singleton = 1 AND revision.state = 'complete'`
    ).get();
    if (activeIndex?.artifact_sha256 !== approvedShadowEmbeddingProfile.artifactSha256) {
      throw new Error("The active retrieval index does not use the Gate 5 approved embedding artifact.");
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
      schemaVersion: 1,
      configSha256: sha256(configSource),
      hooksSha256: sha256(hooksSource),
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
       ORDER BY started_at DESC LIMIT 1`
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
    const baseline = z.looseObject({
      configSha256: z.string().regex(/^[0-9a-f]{64}$/u),
      hooksSha256: z.string().regex(/^[0-9a-f]{64}$/u),
      programSha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
      activeIndexRevisionId: z.string().min(1),
      counts: z.record(z.string(), z.number())
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
      `SELECT revision.index_revision_id, revision.artifact_sha256
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
    if (sha256(configSource) !== baseline.configSha256) {
      invalidationReasons.push("codex_config_changed");
    }
    if (sha256(hooksSource) !== baseline.hooksSha256) {
      invalidationReasons.push("hooks_changed");
    }
    if (baseline.programSha256 === undefined) {
      invalidationReasons.push("program_identity_missing");
    } else if (programSha !== baseline.programSha256) {
      invalidationReasons.push("program_changed");
    }
    if (
      activeIndex?.index_revision_id !== baseline.activeIndexRevisionId ||
      activeIndex.artifact_sha256 !== approvedShadowEmbeddingProfile.artifactSha256
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
      coverage: Object.fromEntries(Object.entries(current).map(([key, value]) => [
        key,
        { baseline: baseline.counts[key] ?? 0, current: value, delta: value - (baseline.counts[key] ?? 0) }
      ]))
    };
  } finally {
    database.close();
  }
}
