import { z } from "zod";

import { inspectHumanConflict } from "../candidates/human.js";
import {
  LunaInvocationError,
  type ConflictAssessmentOutput,
  type ConflictAssessmentRequest
} from "../luna/index.js";
import {
  claimLunaOperation,
  completeLunaOperation,
  enqueueLunaOperation,
  failLunaOperation,
  failLunaOperationLocally,
  type LunaOperationView
} from "../luna/operations.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import { readCanonicalMemory } from "../vault/index.js";

export interface HumanConflictAssessmentAdapter {
  assessHumanConflict(
    request: ConflictAssessmentRequest
  ): Promise<ConflictAssessmentOutput>;
}

export async function enqueueHumanConflictAssessment(request: {
  readonly runtimeRoot: string;
  readonly conflictId: string;
  readonly createdAt: string;
}): Promise<LunaOperationView> {
  await inspectHumanConflict(request.runtimeRoot, request.conflictId);
  return enqueueLunaOperation({
    runtimeRoot: request.runtimeRoot,
    kind: "conflict_assessment",
    idempotencyKey: `human-conflict:${request.conflictId}`,
    payload: { conflictId: request.conflictId },
    createdAt: request.createdAt
  });
}

async function loadConflictInput(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly conflictId: string;
}): Promise<{
  readonly assertionBody: string;
  readonly memories: ConflictAssessmentRequest["existingHumanMemories"];
}> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let row: Record<string, unknown>;
  try {
    const found = database.prepare(
      `SELECT assertion_body, conflicting_memory_ids_json
       FROM human_memory_conflicts WHERE conflict_id = ?`
    ).get(request.conflictId);
    if (found === undefined) throw new Error("Human conflict does not exist.");
    row = found;
  } finally {
    database.close();
  }
  const memoryIds = z.array(z.string()).parse(
    JSON.parse(z.string().parse(row.conflicting_memory_ids_json))
  );
  const memories = await Promise.all(memoryIds.map(async (memoryId) => {
    const memory = await readCanonicalMemory({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      memoryId
    });
    if (memory === undefined || memory.memory.authority !== "human_authored") {
      throw new Error("Conflict assessment requires current Human-authored Memory.");
    }
    return {
      memoryId,
      revisionId: memory.memory.revisionId,
      body: memory.memory.body,
      applicabilitySummary: memory.memory.applicability.summary,
      conditions: memory.memory.applicability.conditions
    };
  }));
  return {
    assertionBody: z.string().parse(row.assertion_body),
    memories
  };
}

async function readPersistedConflictAssessment(
  runtimeRoot: string,
  operationId: string
): Promise<ConflictAssessmentOutput | undefined> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const row = database.prepare(
      `SELECT state, conflicting_memory_ids_json
       FROM human_conflict_assessments WHERE operation_id = ?`
    ).get(operationId);
    if (row === undefined) return undefined;
    return {
      schemaVersion: 1,
      kind: "conflict_assessment",
      state: z.enum(["material_conflict", "no_material_conflict", "uncertain"]).parse(row.state),
      conflictingMemoryIds: z.array(z.string()).parse(
        JSON.parse(z.string().parse(row.conflicting_memory_ids_json))
      )
    };
  } finally {
    database.close();
  }
}

export async function runNextHumanConflictAssessment(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly workerId: string;
  readonly now: string;
  readonly adapter: HumanConflictAssessmentAdapter;
}): Promise<
  | { readonly state: "empty" }
  | {
      readonly state: "completed";
      readonly operationId: string;
      readonly assessmentState: ConflictAssessmentOutput["state"];
    }
  | { readonly state: "retrying" | "blocked"; readonly operationId: string }
> {
  const claimed = await claimLunaOperation({
    runtimeRoot: request.runtimeRoot,
    workerId: request.workerId,
    now: request.now,
    leaseSeconds: 300,
    kinds: ["conflict_assessment"]
  });
  if (claimed.state === "empty") return { state: "empty" };
  const payload = z.object({ conflictId: z.string().min(1) }).parse(
    claimed.operation.payload
  );
  try {
    const input = await loadConflictInput({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      conflictId: payload.conflictId
    });
    const persisted = await readPersistedConflictAssessment(
      request.runtimeRoot,
      claimed.operation.operationId
    );
    const assessment =
      persisted ??
      await request.adapter.assessHumanConflict({
        operationId: claimed.operation.operationId,
        proposedAssertion: input.assertionBody,
        existingHumanMemories: input.memories
      });
    if (persisted === undefined) {
      const database = await openRuntimeDatabase(request.runtimeRoot);
      try {
        database.prepare(
          `INSERT INTO human_conflict_assessments(
             operation_id, conflict_id, state, conflicting_memory_ids_json,
             assessed_at
           ) VALUES (?, ?, ?, ?, ?)`
        ).run(
          claimed.operation.operationId,
          payload.conflictId,
          assessment.state,
          JSON.stringify(assessment.conflictingMemoryIds),
          request.now
        );
      } finally {
        database.close();
      }
    }
    await completeLunaOperation({
      runtimeRoot: request.runtimeRoot,
      operationId: claimed.operation.operationId,
      leaseToken: claimed.leaseToken,
      completedAt: request.now
    });
    return {
      state: "completed",
      operationId: claimed.operation.operationId,
      assessmentState: assessment.state
    };
  } catch (error) {
    const failed =
      error instanceof LunaInvocationError
        ? await failLunaOperation({
            runtimeRoot: request.runtimeRoot,
            operationId: claimed.operation.operationId,
            leaseToken: claimed.leaseToken,
            failedAt: request.now,
            error
          })
        : await failLunaOperationLocally({
            runtimeRoot: request.runtimeRoot,
            operationId: claimed.operation.operationId,
            leaseToken: claimed.leaseToken,
            failedAt: request.now,
            retryable: true
          });
    return { state: failed.state, operationId: claimed.operation.operationId };
  }
}
