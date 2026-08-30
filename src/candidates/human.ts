import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { classifyLocalSensitivity } from "../contracts/sensitivity.js";
import { assessExactCompact } from "../memories/representations.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import { memoryCategorySchema, type MemoryCategory } from "../memories/categories.js";
import {
  archiveLifecycleDetails,
  loadArchiveRetentionMonths
} from "../lifecycle/archive-retention.js";
import {
  readCanonicalMemory,
  writeCanonicalMemory,
  type CanonicalMemory
} from "../vault/index.js";

type MemoryScope =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "global" };

export async function recordHumanGlobalAuthorization(request: {
  readonly runtimeRoot: string;
  readonly statement: string;
  readonly maximumSensitivity: "normal" | "private";
  readonly authorizedAt: string;
  readonly operationId?: string;
  readonly sourceIdentity?: string;
}): Promise<{ readonly authorizationId: string; readonly operationId: string }> {
  const authorizedAt = z.iso.datetime().parse(request.authorizedAt);
  if (request.statement.trim().length === 0) {
    throw new Error("A Global authorization must identify a non-empty statement.");
  }
  const authorizationId = `msglobalauth_${randomUUID()}`;
  const operationId = request.operationId ?? `mshumanop_${randomUUID()}`;
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.prepare(
      `INSERT INTO human_global_authorizations(
         authorization_id, operation_id, source_identity, statement_identity,
         maximum_sensitivity, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      authorizationId,
      operationId,
      request.sourceIdentity ?? "direct-human-global-directive",
      createHash("sha256").update(request.statement.trim()).digest("hex"),
      request.maximumSensitivity,
      authorizedAt
    );
  } finally {
    database.close();
  }
  return { authorizationId, operationId };
}

export type HumanAssertionResult =
  | {
      readonly state: "created";
      readonly operationId: string;
      readonly memoryId: string;
      readonly path: string;
      readonly replacedMemoryId?: string;
    }
  | { readonly state: "conflict"; readonly operationId: string; readonly conflictId: string; readonly proposedMemoryId: string }
  | { readonly state: "blocked_secret"; readonly operationId: string; readonly category: string }
  | { readonly state: "quarantined"; readonly operationId: string; readonly category: string };

function createHumanMemory(request: {
  readonly memoryId: string;
  readonly revisionId: string;
  readonly scope: MemoryScope;
  readonly body: string;
  readonly primaryCategory: MemoryCategory;
  readonly sensitivity: "normal" | "private";
  readonly assertedAt: string;
  readonly operationId: string;
  readonly sourceIdentity: string;
  readonly startup: "auto" | "always" | "never";
  readonly applicability?: {
    readonly summary: string;
    readonly conditions: readonly string[];
  };
  readonly predecessorMemoryId?: string;
}): CanonicalMemory {
  const compact = assessExactCompact({
    body: request.body,
    conditions: [
      request.applicability?.summary ?? "",
      ...(request.applicability?.conditions ?? [])
    ],
    exclusions: [],
    preservedNegations: []
  });
  return {
    schemaVersion: 1,
    memoryId: request.memoryId,
    revisionId: request.revisionId,
    scope: request.scope,
    authority: "human_authored",
    originKind: "direct_human_assertion",
    sensitivity: request.sensitivity,
    lifecycle: "active",
    lifecycleDetails: {},
    primaryCategory: request.primaryCategory,
    categoryTags: [request.primaryCategory],
    importanceTags: [],
    startup: request.startup,
    applicability: request.applicability ?? { summary: "", conditions: [] },
    validity: { state: "valid" },
    createdAt: request.assertedAt,
    revisedAt: request.assertedAt,
    semanticContract: {
      schemaVersion: 1,
      claims: [request.body],
      conditions: [],
      exclusions: [],
      preservedNegations: []
    },
    representations: {
      compact: {
        text: compact.text,
        validated: compact.validated,
        generatorIdentity: "direct-human-assertion",
        sourceRevisionId: request.revisionId,
        renderedTokenCount: compact.renderedTokenCount
      },
      standard: {
        text: request.body,
        validated: true,
        generatorIdentity: "direct-human-assertion",
        sourceRevisionId: request.revisionId,
        renderedTokenCount: compact.renderedTokenCount
      }
    },
    provenance: [
      `operation:${request.operationId}`,
      `source:${request.sourceIdentity}`
    ],
    injectionReceiptIds: [],
    relationships: [],
    ...(request.predecessorMemoryId === undefined
      ? {}
      : { predecessorMemoryId: request.predecessorMemoryId }),
    contentIdentity: "0".repeat(64),
    policyVersion: "human-assertion-v1",
    body: request.body
  };
}

export async function assertHumanKnowledge(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly scope: MemoryScope;
  readonly body: string;
  readonly primaryCategory: MemoryCategory;
  readonly sensitivity?: "normal" | "private";
  readonly assertedAt: string;
  readonly operationId?: string;
  readonly operationKind?: "assert" | "resolve";
  readonly sourceIdentity?: string;
  readonly startup?: "auto" | "always" | "never";
  readonly applicability?: {
    readonly summary: string;
    readonly conditions: readonly string[];
  };
  readonly potentialConflictMemoryIds?: readonly string[];
  readonly conflictDetectedBy?: string;
  readonly replacesMemoryId?: string;
}): Promise<HumanAssertionResult> {
  const assertedAt = z.iso.datetime().parse(request.assertedAt);
  const operationId = request.operationId ?? `mshumanop_${randomUUID()}`;
  const sourceIdentity = request.sourceIdentity ?? "direct-human-command";
  if (request.body.length === 0) throw new Error("A Direct Human Assertion cannot be empty.");
  const sensitivity = classifyLocalSensitivity(request.body);
  if (sensitivity.state === "secret") {
    return { state: "blocked_secret", operationId, category: sensitivity.category };
  }
  if (sensitivity.state === "uncertain") {
    return { state: "quarantined", operationId, category: sensitivity.category };
  }
  if (
    request.replacesMemoryId !== undefined &&
    (request.potentialConflictMemoryIds?.length ?? 0) > 0
  ) {
    throw new Error("Explicit replacement and generic conflict input are mutually exclusive.");
  }

  const memoryId = `msmem_${randomUUID()}`;
  const revisionId = `msrev_${randomUUID()}`;
  const operationDatabase = await openRuntimeDatabase(request.runtimeRoot);
  try {
    operationDatabase.prepare(
      `INSERT INTO human_memory_operations(
         operation_id, operation_kind, source_identity, state, created_at
       ) VALUES (?, ?, ?, 'pending', ?)`
    ).run(operationId, request.operationKind ?? "assert", sourceIdentity, assertedAt);
  } finally {
    operationDatabase.close();
  }
  const conflicts = [...new Set(request.potentialConflictMemoryIds ?? [])];
  if (conflicts.length > 0) {
    const database = await openRuntimeDatabase(request.runtimeRoot);
    try {
      for (const conflictingMemoryId of conflicts) {
        const row = database.prepare(
          "SELECT authority FROM memory_catalog WHERE memory_id = ?"
        ).get(conflictingMemoryId);
        if (row?.authority !== "human_authored") {
          throw new Error("A Human conflict must reference existing Human-authored Memory.");
        }
      }
      const conflictId = `mshconflict_${randomUUID()}`;
      database.prepare(
        `INSERT INTO human_memory_conflicts(
           conflict_id, operation_id, source_identity, proposed_memory_id,
           conflicting_memory_ids_json,
           scope_kind, project_id, assertion_body, category, sensitivity, state,
           detected_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
      ).run(
        conflictId,
        operationId,
        sourceIdentity,
        memoryId,
        JSON.stringify(conflicts),
        request.scope.kind,
        request.scope.kind === "project" ? request.scope.projectId : null,
        request.body,
        request.primaryCategory,
        request.sensitivity ?? "normal",
        request.conflictDetectedBy ?? "explicit-human-conflict-input",
        assertedAt
      );
      database.prepare(
        `UPDATE human_memory_operations
         SET state = 'conflict', conflict_id = ?, completed_at = ?
         WHERE operation_id = ?`
      ).run(conflictId, assertedAt, operationId);
      return { state: "conflict", operationId, conflictId, proposedMemoryId: memoryId };
    } finally {
      database.close();
    }
  }

  let predecessor: Awaited<ReturnType<typeof readCanonicalMemory>>;
  if (request.replacesMemoryId !== undefined) {
    predecessor = await readCanonicalMemory({
      vaultRoot: request.vaultRoot,
      runtimeRoot: request.runtimeRoot,
      memoryId: request.replacesMemoryId
    });
    if (predecessor === undefined || predecessor.memory.authority !== "human_authored") {
      throw new Error("Explicit replacement requires existing Human-authored Memory.");
    }
    if (JSON.stringify(predecessor.memory.scope) !== JSON.stringify(request.scope)) {
      throw new Error("A replacement must retain the predecessor scope.");
    }
  }

  const successorSensitivity =
    request.sensitivity === "private" || predecessor?.memory.sensitivity === "private"
      ? "private"
      : "normal";
  const successor = createHumanMemory({
    memoryId,
    revisionId,
    scope: request.scope,
    body: request.body,
    primaryCategory: request.primaryCategory,
    sensitivity: successorSensitivity,
    assertedAt,
    operationId,
    sourceIdentity,
    startup: request.startup ?? "auto",
    ...(request.applicability === undefined
      ? {}
      : { applicability: request.applicability }),
    ...(request.replacesMemoryId === undefined
      ? {}
      : { predecessorMemoryId: request.replacesMemoryId })
  });

  if (predecessor !== undefined) {
    const archivedRevisionId = `msrev_${randomUUID()}`;
    const archiveRetentionMonths = await loadArchiveRetentionMonths(request);
    const archived: CanonicalMemory = {
      ...predecessor.memory,
      revisionId: archivedRevisionId,
      lifecycle: "archived",
      lifecycleDetails: archiveLifecycleDetails({
        previous: predecessor.memory.lifecycleDetails,
        archivedAt: assertedAt,
        reason: "explicit_human_successor",
        archiveRetentionMonths
      }),
      revisedAt: assertedAt,
      successorMemoryId: memoryId,
      predecessorRevisionId: predecessor.memory.revisionId,
      representations: {
        compact: {
          ...predecessor.memory.representations.compact,
          sourceRevisionId: archivedRevisionId
        },
        standard: {
          ...predecessor.memory.representations.standard,
          sourceRevisionId: archivedRevisionId
        }
      }
    };
    await writeCanonicalMemory({
      vaultRoot: request.vaultRoot,
      runtimeRoot: request.runtimeRoot,
      actor: "human",
      memory: archived,
      expectedContentIdentity: predecessor.contentIdentity
    });
  }

  const written = await writeCanonicalMemory({
    vaultRoot: request.vaultRoot,
    runtimeRoot: request.runtimeRoot,
    actor: "human",
    memory: successor
  });
  const completedDatabase = await openRuntimeDatabase(request.runtimeRoot);
  try {
    completedDatabase.prepare(
      `UPDATE human_memory_operations
       SET state = 'completed', memory_id = ?, completed_at = ?
       WHERE operation_id = ?`
    ).run(memoryId, assertedAt, operationId);
  } finally {
    completedDatabase.close();
  }
  return {
    state: "created",
    operationId,
    memoryId,
    path: written.path,
    ...(request.replacesMemoryId === undefined
      ? {}
      : { replacedMemoryId: request.replacesMemoryId })
  };
}

export async function inspectHumanConflict(
  runtimeRoot: string,
  conflictId: string
): Promise<{
  readonly conflictId: string;
  readonly state: "open" | "kept_existing" | "adopted_new" | "distinguished";
  readonly body: string;
  readonly conflictingMemoryIds: readonly string[];
}> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const row = database.prepare(
      `SELECT state, assertion_body, conflicting_memory_ids_json
       FROM human_memory_conflicts WHERE conflict_id = ?`
    ).get(conflictId);
    if (row === undefined) throw new Error("Human conflict does not exist.");
    return {
      conflictId,
      state: z
        .enum(["open", "kept_existing", "adopted_new", "distinguished"])
        .parse(row.state),
      body: z.string().parse(row.assertion_body),
      conflictingMemoryIds: z.array(z.string()).parse(
        JSON.parse(z.string().parse(row.conflicting_memory_ids_json))
      )
    };
  } finally {
    database.close();
  }
}

export type HumanConflictResolution =
  | { readonly kind: "keep_existing" }
  | { readonly kind: "adopt_new"; readonly replacesMemoryId: string }
  | {
      readonly kind: "distinguish";
      readonly applicabilitySummary: string;
      readonly conditions: readonly string[];
    };

export async function resolveHumanConflict(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly conflictId: string;
  readonly resolution: HumanConflictResolution;
  readonly resolvedAt: string;
  readonly operationId?: string;
  readonly sourceIdentity?: string;
}): Promise<
  | { readonly state: "kept_existing"; readonly operationId: string }
  | {
      readonly state: "adopted_new" | "distinguished";
      readonly operationId: string;
      readonly memoryId: string;
    }
> {
  const resolvedAt = z.iso.datetime().parse(request.resolvedAt);
  const operationId = request.operationId ?? `mshumanop_${randomUUID()}`;
  const sourceIdentity = request.sourceIdentity ?? `human-conflict:${request.conflictId}`;
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let conflict: Record<string, unknown>;
  try {
    const row = database.prepare(
      `SELECT assertion_body, category, sensitivity, scope_kind, project_id, state,
              conflicting_memory_ids_json
       FROM human_memory_conflicts WHERE conflict_id = ?`
    ).get(request.conflictId);
    if (row === undefined || row.state !== "open") {
      throw new Error("Only an open Human conflict can be resolved.");
    }
    conflict = row;
  } finally {
    database.close();
  }
  if (request.resolution.kind === "keep_existing") {
    const update = await openRuntimeDatabase(request.runtimeRoot);
    try {
      update.exec("BEGIN IMMEDIATE");
      update.prepare(
        `INSERT INTO human_memory_operations(
           operation_id, operation_kind, source_identity, state,
           conflict_id, created_at, completed_at
         ) VALUES (?, 'resolve', ?, 'completed', ?, ?, ?)`
      ).run(operationId, sourceIdentity, request.conflictId, resolvedAt, resolvedAt);
      update.prepare(
        `UPDATE human_memory_conflicts
         SET state = 'kept_existing', resolved_at = ? WHERE conflict_id = ?`
      ).run(resolvedAt, request.conflictId);
      update.exec("COMMIT");
    } catch (error) {
      update.exec("ROLLBACK");
      throw error;
    } finally {
      update.close();
    }
    return { state: "kept_existing", operationId };
  }
  const scope: MemoryScope =
    conflict.scope_kind === "global"
      ? { kind: "global" }
      : { kind: "project", projectId: z.string().parse(conflict.project_id) };
  if (request.resolution.kind === "adopt_new") {
    const conflictingMemoryIds = z.array(z.string()).parse(
      JSON.parse(z.string().parse(conflict.conflicting_memory_ids_json))
    );
    if (!conflictingMemoryIds.includes(request.resolution.replacesMemoryId)) {
      throw new Error("Adopt-new resolution must replace a Memory named by this conflict.");
    }
  }
  const asserted = await assertHumanKnowledge({
    runtimeRoot: request.runtimeRoot,
    vaultRoot: request.vaultRoot,
    scope,
    body: z.string().parse(conflict.assertion_body),
    primaryCategory: memoryCategorySchema.parse(conflict.category),
    sensitivity: z.enum(["normal", "private"]).parse(conflict.sensitivity),
    assertedAt: resolvedAt,
    operationId,
    operationKind: "resolve",
    sourceIdentity,
    ...(request.resolution.kind === "adopt_new"
      ? { replacesMemoryId: request.resolution.replacesMemoryId }
      : {
          applicability: {
            summary: request.resolution.applicabilitySummary,
            conditions: request.resolution.conditions
          }
        })
  });
  if (asserted.state !== "created") {
    throw new Error("Human conflict resolution did not create the requested Memory.");
  }
  const resolvedState =
    request.resolution.kind === "adopt_new" ? "adopted_new" : "distinguished";
  const update = await openRuntimeDatabase(request.runtimeRoot);
  try {
    update.exec("BEGIN IMMEDIATE");
    update.prepare(
      `UPDATE human_memory_conflicts SET state = ?, resolved_at = ?
       WHERE conflict_id = ? AND state = 'open'`
    ).run(resolvedState, resolvedAt, request.conflictId);
    update.prepare(
      `UPDATE human_memory_operations SET conflict_id = ? WHERE operation_id = ?`
    ).run(request.conflictId, operationId);
    update.exec("COMMIT");
  } catch (error) {
    update.exec("ROLLBACK");
    throw error;
  } finally {
    update.close();
  }
  return {
    state: resolvedState,
    operationId,
    memoryId: asserted.memoryId
  };
}
