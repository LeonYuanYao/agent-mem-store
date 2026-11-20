import { randomUUID } from "node:crypto";
import { z } from "zod";

import { archiveLifecycleDetails, loadArchiveRetentionMonths } from "../lifecycle/archive-retention.js";
import { formatMemoryReference, resolveMemoryReference } from "../memories/reference.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import { readCanonicalMemory, writeCanonicalMemory, type CanonicalMemory } from "../vault/index.js";

/**
 * `memstore rescope` (ADR-0186): moves one active Memory to another scope on the user's request.
 *
 * A Canonical revision cannot change scope: the scope decides where the Memory lives in the Vault
 * and which retrieval space holds it. So the Memory is succeeded, as an explicit Human successor
 * is: a new Memory in the target scope carries the same body, authority, origin, startup,
 * categories, relationships and provenance, and the old one is archived pointing at it. The new
 * Memory is written first, so an interruption leaves both active rather than neither. Dreaming's
 * record of the statement follows the new Memory, so dreaming keeps recognising it.
 */
export type MemoryScope = CanonicalMemory["scope"];

export interface MemoryScopeChangeRequest {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly memory: string;
  readonly scope: MemoryScope;
  readonly changedAt: string;
  readonly reason?: string;
  /** The uncertain-sensitivity match the user already reviewed for this Memory. */
  readonly reviewedSensitiveValue?: string;
}

export interface MemoryScopeChangeResult {
  readonly schemaVersion: 1;
  readonly dryRun: boolean;
  readonly state: "preview" | "rescoped" | "unchanged";
  readonly memoryId: string;
  readonly memoryRef: string;
  readonly from: MemoryScope;
  readonly to: MemoryScope;
  /** The Memory that holds the knowledge in the target scope; set once applied. */
  readonly successor?: { readonly memoryId: string; readonly memoryRef: string; readonly revisionId: string };
}

function scopeLabel(scope: MemoryScope): string {
  return scope.kind === "global" ? "global" : `project:${scope.projectId}`;
}

function rebound(representations: CanonicalMemory["representations"], revisionId: string): CanonicalMemory["representations"] {
  return {
    ...(representations.identity === undefined ? {} : { identity: { ...representations.identity, sourceRevisionId: revisionId } }),
    compact: { ...representations.compact, sourceRevisionId: revisionId },
    standard: { ...representations.standard, sourceRevisionId: revisionId }
  };
}

async function prepare(request: MemoryScopeChangeRequest) {
  const changedAt = z.iso.datetime().parse(request.changedAt);
  const reason = z.string().min(1).max(200).parse(request.reason ?? "user_request");
  const resolved = await resolveMemoryReference(request.runtimeRoot, request.memory);
  const current = await readCanonicalMemory({ runtimeRoot: request.runtimeRoot, vaultRoot: request.vaultRoot, memoryId: resolved.memoryId });
  if (current === undefined) throw new Error("Memory is not present in the Canonical Vault.");
  if (current.memory.lifecycle !== "active") {
    throw new Error("Only an active Memory can change scope; restore it first.");
  }
  return { changedAt, reason, current, reference: formatMemoryReference(resolved.memoryRef),
    unchanged: scopeLabel(current.memory.scope) === scopeLabel(request.scope) };
}

export async function previewMemoryScopeChange(request: MemoryScopeChangeRequest): Promise<MemoryScopeChangeResult> {
  const prepared = await prepare(request);
  return { schemaVersion: 1, dryRun: true, state: prepared.unchanged ? "unchanged" : "preview",
    memoryId: prepared.current.memory.memoryId, memoryRef: prepared.reference, from: prepared.current.memory.scope, to: request.scope };
}

export async function applyMemoryScopeChange(request: MemoryScopeChangeRequest): Promise<MemoryScopeChangeResult> {
  const { changedAt, reason, current, reference, unchanged } = await prepare(request);
  const memory = current.memory;
  const result = { schemaVersion: 1 as const, memoryId: memory.memoryId, memoryRef: reference, from: memory.scope, to: request.scope };
  if (unchanged) return { ...result, dryRun: false, state: "unchanged" };
  const actor = memory.authority === "human_authored" ? "human" as const : "agent" as const;

  const successorId = `msmem_${randomUUID()}`;
  const successorRevision = `msrev_${randomUUID()}`;
  const successor: { -readonly [Key in keyof CanonicalMemory]: CanonicalMemory[Key] } = {
    ...memory,
    memoryId: successorId,
    revisionId: successorRevision,
    scope: request.scope,
    lifecycleDetails: { ...(memory.lifecycleDetails.retainForever === true ? { retainForever: true } : {}),
      ...(memory.lifecycleDetails.pinned === true ? { pinned: true } : {}) },
    revisedAt: changedAt,
    predecessorMemoryId: memory.memoryId,
    representations: rebound(memory.representations, successorRevision),
    provenance: [...memory.provenance.filter((entry) => !entry.startsWith("scope:moved-from:")), `scope:moved-from:${memory.memoryId}`],
    injectionReceiptIds: [],
    contentIdentity: "0".repeat(64)
  };
  // The successor starts its own revision chain and receives its own M: reference.
  delete successor.memoryRef;
  delete successor.predecessorRevisionId;
  delete successor.successorMemoryId;
  const written = await writeCanonicalMemory({ runtimeRoot: request.runtimeRoot, vaultRoot: request.vaultRoot, actor, memory: successor,
    ...(request.reviewedSensitiveValue === undefined ? {} : { reviewedSensitiveValue: request.reviewedSensitiveValue }) });

  const archivedRevision = `msrev_${randomUUID()}`;
  await writeCanonicalMemory({
    runtimeRoot: request.runtimeRoot, vaultRoot: request.vaultRoot, actor, expectedContentIdentity: current.contentIdentity,
    ...(request.reviewedSensitiveValue === undefined ? {} : { reviewedSensitiveValue: request.reviewedSensitiveValue }),
    memory: {
      ...memory,
      revisionId: archivedRevision,
      predecessorRevisionId: memory.revisionId,
      revisedAt: changedAt,
      lifecycle: "archived",
      lifecycleDetails: archiveLifecycleDetails({ previous: memory.lifecycleDetails, archivedAt: changedAt,
        reason: `rescoped:${reason}`, archiveRetentionMonths: await loadArchiveRetentionMonths(request) }),
      successorMemoryId: successorId,
      representations: rebound(memory.representations, archivedRevision)
    }
  });

  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.prepare("UPDATE dream_memories SET memory_id = ?, scope_kind = ?, project_id = ?, updated_at = ? WHERE memory_id = ?")
      .run(successorId, request.scope.kind, request.scope.kind === "project" ? request.scope.projectId : null, changedAt, memory.memoryId);
  } finally {
    database.close();
  }
  return { ...result, dryRun: false, state: "rescoped",
    successor: { memoryId: written.memoryId, memoryRef: formatMemoryReference(written.memoryRef), revisionId: written.revisionId } };
}
