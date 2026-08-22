import { randomUUID } from "node:crypto";
import { z } from "zod";

import { assessExactCompact } from "../memories/representations.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import {
  readCanonicalMemory,
  writeCanonicalMemory,
  type CanonicalMemory
} from "../vault/index.js";

export type MemoryQualityIssueCode =
  | "compact_unvalidated"
  | "compact_exact_repairable"
  | "operational_provenance"
  | "runtime_identity_in_body"
  | "temporal_status_language";

export interface MemoryQualityIssue {
  readonly memoryId: string;
  readonly revisionId: string;
  readonly codes: readonly MemoryQualityIssueCode[];
}

const operationalProvenance = /(?:^|[:/_-])(?:probe|benchmark|latency-probe|exact-response)(?:$|[:/_-])/iu;
const runtimeIdentity = /\bms(?:shadow|govrun|op|operation|receipt|index|repair)_[0-9a-f-]{8,}\b/iu;
const temporalStatus = /(?:\b(?:currently|not yet|still|already|pending|retrying)\b|(?:当前|目前|仍需|仍未|尚未|已经|已完成|待完成|正在重试).{0,32}(?:状态|修复|实现|完成|运行|窗口|批准|信任|积压|可用|健康)?)/iu;

function exactCompact(memory: CanonicalMemory) {
  return assessExactCompact({
    body: memory.body,
    conditions: memory.semanticContract.conditions,
    exclusions: memory.semanticContract.exclusions,
    preservedNegations: memory.semanticContract.preservedNegations
  });
}

function qualityCodes(memory: CanonicalMemory): MemoryQualityIssueCode[] {
  const codes: MemoryQualityIssueCode[] = [];
  const compact = exactCompact(memory);
  const currentCompactValid =
    memory.representations.compact.validated &&
    memory.representations.compact.sourceRevisionId === memory.revisionId &&
    memory.representations.compact.text.trim().length > 0;
  if (!currentCompactValid) codes.push("compact_unvalidated");
  if (!currentCompactValid && compact.validated) codes.push("compact_exact_repairable");
  if (memory.provenance.some((source) => operationalProvenance.test(source))) {
    codes.push("operational_provenance");
  }
  if (runtimeIdentity.test(memory.body)) codes.push("runtime_identity_in_body");
  if (temporalStatus.test(memory.body)) codes.push("temporal_status_language");
  return codes;
}

function isTransientRuntimeState(memory: CanonicalMemory): boolean {
  return runtimeIdentity.test(memory.body) && temporalStatus.test(memory.body);
}

function isOperationalArchiveEligible(memory: CanonicalMemory): boolean {
  return qualityCodes(memory).includes("operational_provenance") ||
    isTransientRuntimeState(memory);
}

async function pageActiveMemories(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly authority?: CanonicalMemory["authority"];
  readonly cursor?: string;
  readonly limit: number;
}): Promise<{ readonly memories: readonly CanonicalMemory[]; readonly nextCursor?: string }> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let rows: readonly Record<string, unknown>[];
  try {
    rows = database.prepare(
      `SELECT memory_id FROM memory_catalog
       WHERE lifecycle = 'active' AND memory_id > ?
         AND (? IS NULL OR authority = ?)
       ORDER BY memory_id LIMIT ?`
    ).all(
      request.cursor ?? "",
      request.authority ?? null,
      request.authority ?? null,
      request.limit + 1
    );
  } finally {
    database.close();
  }
  const selected = rows.slice(0, request.limit);
  const memories = (await Promise.all(selected.map(async (row) => {
    const result = await readCanonicalMemory({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      memoryId: z.string().parse(row.memory_id)
    });
    return result?.memory;
  }))).filter((memory): memory is CanonicalMemory => memory !== undefined);
  const nextCursor = rows.length > request.limit
    ? z.string().parse(selected.at(-1)?.memory_id)
    : undefined;
  return { memories, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

export async function auditMemoryQuality(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly cursor?: string;
  readonly limit?: number;
}): Promise<{
  readonly state: "audited";
  readonly scannedCount: number;
  readonly issueCount: number;
  readonly issueCounts: Readonly<Record<MemoryQualityIssueCode, number>>;
  readonly issues: readonly MemoryQualityIssue[];
  readonly nextCursor?: string;
}> {
  const page = await pageActiveMemories({
    ...request,
    authority: "agent_derived",
    limit: z.number().int().min(1).max(1000).parse(request.limit ?? 200)
  });
  const issues = page.memories.flatMap((memory) => {
    const codes = qualityCodes(memory);
    return codes.length === 0
      ? []
      : [{ memoryId: memory.memoryId, revisionId: memory.revisionId, codes }];
  });
  const issueCounts: Record<MemoryQualityIssueCode, number> = {
    compact_unvalidated: 0,
    compact_exact_repairable: 0,
    operational_provenance: 0,
    runtime_identity_in_body: 0,
    temporal_status_language: 0
  };
  for (const issue of issues) {
    for (const code of issue.codes) issueCounts[code] += 1;
  }
  return {
    state: "audited",
    scannedCount: page.memories.length,
    issueCount: issues.length,
    issueCounts,
    issues,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor })
  };
}

function nextRepresentations(memory: CanonicalMemory, revisionId: string) {
  const compact = exactCompact(memory);
  return {
    ...(memory.representations.identity === undefined ? {} : {
      identity: { ...memory.representations.identity, sourceRevisionId: revisionId }
    }),
    compact: {
      text: compact.text,
      validated: compact.validated,
      generatorIdentity: "memstore-exact-compact-v1",
      sourceRevisionId: revisionId,
      renderedTokenCount: compact.renderedTokenCount
    },
    standard: { ...memory.representations.standard, sourceRevisionId: revisionId }
  };
}

function reboundRepresentations(memory: CanonicalMemory, revisionId: string) {
  return {
    ...(memory.representations.identity === undefined ? {} : {
      identity: { ...memory.representations.identity, sourceRevisionId: revisionId }
    }),
    compact: { ...memory.representations.compact, sourceRevisionId: revisionId },
    standard: { ...memory.representations.standard, sourceRevisionId: revisionId }
  };
}

export async function repairExactCompactRepresentations(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly repairedAt: string;
  readonly preview: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}): Promise<{
  readonly state: "preview" | "applied";
  readonly dryRun: boolean;
  readonly scannedCount: number;
  readonly eligibleCount: number;
  readonly changedCount: number;
  readonly memoryIds: readonly string[];
  readonly nextCursor?: string;
}> {
  const repairedAt = z.iso.datetime().parse(request.repairedAt);
  const page = await pageActiveMemories({
    runtimeRoot: request.runtimeRoot,
    vaultRoot: request.vaultRoot,
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    limit: z.number().int().min(1).max(1000).parse(request.limit ?? 50)
  });
  const eligible = page.memories.filter((memory) => {
    const compact = exactCompact(memory);
    return compact.validated && !(
      memory.representations.compact.validated &&
      memory.representations.compact.sourceRevisionId === memory.revisionId &&
      memory.representations.compact.text.trim().length > 0
    );
  });
  let changedCount = 0;
  if (!request.preview) {
    for (const memory of eligible) {
      const revisionId = `msrev_${randomUUID()}`;
      await writeCanonicalMemory({
        runtimeRoot: request.runtimeRoot,
        vaultRoot: request.vaultRoot,
        actor: memory.authority === "human_authored" ? "human" : "agent",
        expectedContentIdentity: memory.contentIdentity,
        memory: {
          ...memory,
          revisionId,
          predecessorRevisionId: memory.revisionId,
          revisedAt: repairedAt,
          representations: nextRepresentations(memory, revisionId),
          provenance: memory.provenance.includes("quality:exact-compact-backfill-v1")
            ? memory.provenance
            : [...memory.provenance, "quality:exact-compact-backfill-v1"]
        }
      });
      changedCount += 1;
    }
  }
  return {
    state: request.preview ? "preview" : "applied",
    dryRun: request.preview,
    scannedCount: page.memories.length,
    eligibleCount: eligible.length,
    changedCount,
    memoryIds: eligible.map((memory) => memory.memoryId),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor })
  };
}

export async function archiveOperationalMemories(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly archivedAt: string;
  readonly preview: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}): Promise<{
  readonly state: "preview" | "applied";
  readonly dryRun: boolean;
  readonly scannedCount: number;
  readonly eligibleCount: number;
  readonly changedCount: number;
  readonly memoryIds: readonly string[];
  readonly nextCursor?: string;
}> {
  const archivedAt = z.iso.datetime().parse(request.archivedAt);
  const page = await pageActiveMemories({
    runtimeRoot: request.runtimeRoot,
    vaultRoot: request.vaultRoot,
    authority: "agent_derived",
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    limit: z.number().int().min(1).max(1000).parse(request.limit ?? 200)
  });
  const eligible = page.memories.filter(isOperationalArchiveEligible);
  let changedCount = 0;
  if (!request.preview) {
    for (const memory of eligible) {
      const revisionId = `msrev_${randomUUID()}`;
      const hasOperationalProvenance = qualityCodes(memory).includes("operational_provenance");
      const reason = hasOperationalProvenance
        ? "quality:operational-provenance-v1"
        : "quality:transient-runtime-state-v2";
      const provenance = hasOperationalProvenance
        ? "quality:operational-archive-v1"
        : "quality:transient-runtime-archive-v2";
      await writeCanonicalMemory({
        runtimeRoot: request.runtimeRoot,
        vaultRoot: request.vaultRoot,
        actor: "agent",
        expectedContentIdentity: memory.contentIdentity,
        memory: {
          ...memory,
          revisionId,
          predecessorRevisionId: memory.revisionId,
          revisedAt: archivedAt,
          lifecycle: "archived",
          lifecycleDetails: {
            archivedAt,
            reason
          },
          representations: reboundRepresentations(memory, revisionId),
          provenance: memory.provenance.includes(provenance)
            ? memory.provenance
            : [...memory.provenance, provenance]
        }
      });
      changedCount += 1;
    }
  }
  return {
    state: request.preview ? "preview" : "applied",
    dryRun: request.preview,
    scannedCount: page.memories.length,
    eligibleCount: eligible.length,
    changedCount,
    memoryIds: eligible.map((memory) => memory.memoryId),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor })
  };
}
