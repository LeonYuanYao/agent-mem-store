import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  archiveLifecycleDetails,
  loadArchiveRetentionMonths
} from "../lifecycle/archive-retention.js";
import {
  formatMemoryReference,
  resolveMemoryReference
} from "../memories/reference.js";
import {
  readCanonicalMemory,
  writeCanonicalMemory,
  type CanonicalMemory
} from "../vault/index.js";

export type MemoryLifecycleAction = "archive" | "restore";

export interface MemoryLifecycleChangeRequest {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly memory: string;
  readonly action: MemoryLifecycleAction;
  readonly changedAt: string;
  readonly reason?: string;
}

interface PreparedMemoryLifecycleChange {
  readonly current: CanonicalMemory;
  readonly contentIdentity: string;
  readonly next: CanonicalMemory;
  readonly from: "active" | "archived";
  readonly to: "active" | "archived";
  readonly noChange: boolean;
  readonly memoryRef: number;
  readonly reference: string;
  readonly purgeAfter?: string;
}

function reboundRepresentations(
  memory: CanonicalMemory,
  revisionId: string
): CanonicalMemory["representations"] {
  return {
    ...(memory.representations.identity === undefined
      ? {}
      : {
          identity: {
            ...memory.representations.identity,
            sourceRevisionId: revisionId
          }
        }),
    compact: { ...memory.representations.compact, sourceRevisionId: revisionId },
    standard: { ...memory.representations.standard, sourceRevisionId: revisionId }
  };
}

function restoredLifecycleDetails(
  previous: CanonicalMemory["lifecycleDetails"]
): CanonicalMemory["lifecycleDetails"] {
  return {
    ...(previous.retainForever === true ? { retainForever: true } : {}),
    ...(previous.pinned === true ? { pinned: true } : {})
  };
}

async function prepareMemoryLifecycleChange(
  request: MemoryLifecycleChangeRequest
): Promise<PreparedMemoryLifecycleChange> {
  const changedAt = z.iso.datetime().parse(request.changedAt);
  const action = z.enum(["archive", "restore"]).parse(request.action);
  const resolved = await resolveMemoryReference(request.runtimeRoot, request.memory);
  const current = await readCanonicalMemory({
    runtimeRoot: request.runtimeRoot,
    vaultRoot: request.vaultRoot,
    memoryId: resolved.memoryId
  });
  if (current === undefined) {
    throw new Error("Memory is not present in the Canonical Vault.");
  }
  if (current.memory.lifecycle === "tombstone") {
    throw new Error("A body-free Tombstone cannot be restored or archived.");
  }
  const noChange = (action === "archive" && current.memory.lifecycle === "archived") ||
    (action === "restore" && current.memory.lifecycle === "active");
  const revisionId = noChange ? current.memory.revisionId : `msrev_${randomUUID()}`;
  const reason = z.string().min(1).max(256).parse(request.reason ?? "user_request");
  const lifecycleDetails = noChange
    ? current.memory.lifecycleDetails
    : action === "archive"
    ? archiveLifecycleDetails({
        previous: current.memory.lifecycleDetails,
        archivedAt: changedAt,
        reason: `manual:${reason}`,
        archiveRetentionMonths: await loadArchiveRetentionMonths(request)
      })
    : restoredLifecycleDetails(current.memory.lifecycleDetails);
  const marker = action === "archive"
    ? "lifecycle:manual-archive-v1"
    : "lifecycle:manual-restore-v1";
  const next: CanonicalMemory = noChange
    ? current.memory
    : {
        ...current.memory,
        revisionId,
        predecessorRevisionId: current.memory.revisionId,
        revisedAt: changedAt,
        lifecycle: action === "archive" ? "archived" : "active",
        lifecycleDetails,
        representations: reboundRepresentations(current.memory, revisionId),
        provenance: current.memory.provenance.includes(marker)
          ? current.memory.provenance
          : [...current.memory.provenance, marker]
      };
  return {
    current: current.memory,
    contentIdentity: current.contentIdentity,
    next,
    from: current.memory.lifecycle,
    to: action === "archive" ? "archived" : "active",
    noChange,
    memoryRef: resolved.memoryRef,
    reference: formatMemoryReference(resolved.memoryRef),
    ...(lifecycleDetails.purgeAfter === undefined
      ? {}
      : { purgeAfter: lifecycleDetails.purgeAfter })
  };
}

export async function previewMemoryLifecycleChange(
  request: MemoryLifecycleChangeRequest
): Promise<{
  readonly schemaVersion: 1;
  readonly dryRun: true;
  readonly state: "preview";
  readonly action: MemoryLifecycleAction;
  readonly memoryId: string;
  readonly memoryRef: string;
  readonly from: "active" | "archived";
  readonly to: "active" | "archived";
  readonly purgeAfter?: string;
}> {
  const prepared = await prepareMemoryLifecycleChange(request);
  return {
    schemaVersion: 1,
    dryRun: true,
    state: "preview",
    action: request.action,
    memoryId: prepared.current.memoryId,
    memoryRef: prepared.reference,
    from: prepared.from,
    to: prepared.to,
    ...(prepared.purgeAfter === undefined ? {} : { purgeAfter: prepared.purgeAfter })
  };
}

export async function applyMemoryLifecycleChange(
  request: MemoryLifecycleChangeRequest
): Promise<{
  readonly schemaVersion: 1;
  readonly dryRun: false;
  readonly state: "archived" | "restored" | "already_archived" | "already_active";
  readonly action: MemoryLifecycleAction;
  readonly memoryId: string;
  readonly memoryRef: string;
  readonly revisionId: string;
  readonly purgeAfter?: string;
}> {
  const prepared = await prepareMemoryLifecycleChange(request);
  if (prepared.noChange) {
    return {
      schemaVersion: 1,
      dryRun: false,
      state: request.action === "archive" ? "already_archived" : "already_active",
      action: request.action,
      memoryId: prepared.current.memoryId,
      memoryRef: prepared.reference,
      revisionId: prepared.current.revisionId,
      ...(prepared.purgeAfter === undefined ? {} : { purgeAfter: prepared.purgeAfter })
    };
  }
  const written = await writeCanonicalMemory({
    runtimeRoot: request.runtimeRoot,
    vaultRoot: request.vaultRoot,
    actor: prepared.current.authority === "human_authored" ? "human" : "agent",
    expectedContentIdentity: prepared.contentIdentity,
    memory: prepared.next
  });
  return {
    schemaVersion: 1,
    dryRun: false,
    state: request.action === "archive" ? "archived" : "restored",
    action: request.action,
    memoryId: written.memoryId,
    memoryRef: prepared.reference,
    revisionId: written.revisionId,
    ...(prepared.purgeAfter === undefined ? {} : { purgeAfter: prepared.purgeAfter })
  };
}
