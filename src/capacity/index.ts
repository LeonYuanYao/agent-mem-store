import { access } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import {
  loadConfiguration,
  type LoadedConfiguration
} from "../configuration/index.js";
import { openRuntimeDatabase } from "../runtime/database.js";

export type MemoryCapacityPolicy = LoadedConfiguration["policy"]["memoryCapacity"];

export const defaultMemoryCapacityPolicy: MemoryCapacityPolicy = {
  project: { target: 2_500, hardLimit: 3_500, lowWater: 2_200 },
  global: { target: 300, hardLimit: 500, lowWater: 270 },
  coldDays: 180,
  governanceBatchSize: 50
};

export async function loadMemoryCapacityPolicy(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
}): Promise<MemoryCapacityPolicy> {
  try {
    await access(join(request.vaultRoot, "_MemStore", "policy.toml"));
  } catch {
    return defaultMemoryCapacityPolicy;
  }
  const configuration = await loadConfiguration(request);
  return configuration.mode === "read_write"
    ? configuration.policy.memoryCapacity
    : defaultMemoryCapacityPolicy;
}

export function capacityLimitsForScope(
  policy: MemoryCapacityPolicy,
  scope: { readonly kind: "project" } | { readonly kind: "global" }
): MemoryCapacityPolicy["project"] {
  return scope.kind === "global" ? policy.global : policy.project;
}

export interface MemorySpaceCapacity {
  readonly scope:
    | { readonly kind: "project"; readonly project_id: string }
    | { readonly kind: "global" };
  readonly active_agent_memory_count: number;
  readonly target: number;
  readonly hard_limit: number;
  readonly low_water: number;
  readonly state: "available" | "pressured" | "hard_limited";
  readonly obligation_state?: "pending" | "linked";
  readonly next_review_at?: string | null;
  readonly governance_run_id?: string | null;
}

export interface MemoryCapacityStatus {
  readonly pressured_space_count: number;
  readonly hard_limited_space_count: number;
  readonly open_obligation_count: number;
  readonly spaces: readonly MemorySpaceCapacity[];
}

export interface MemoryCapacityReconciliation extends MemoryCapacityStatus {
  readonly pending_obligation_count: number;
}

function spaceKey(scope: MemorySpaceCapacity["scope"]): string {
  return scope.kind === "global" ? "global" : `project:${scope.project_id}`;
}

function capacityState(
  count: number,
  target: number,
  hardLimit: number
): MemorySpaceCapacity["state"] {
  if (count >= hardLimit) return "hard_limited";
  if (count > target) return "pressured";
  return "available";
}

export function inspectMemoryCapacity(request: {
  readonly runtimeRoot: string;
  readonly policy: MemoryCapacityPolicy;
}): MemoryCapacityStatus {
  const database = new DatabaseSync(
    join(request.runtimeRoot, "state", "memstore.sqlite"),
    { readOnly: true }
  );
  try {
    const countRows = database.prepare(
      `SELECT scope_kind, project_id, COUNT(*) AS active_count
       FROM memory_catalog
       WHERE lifecycle = 'active' AND authority = 'agent_derived'
       GROUP BY scope_kind, project_id
       ORDER BY active_count DESC, scope_kind, project_id`
    ).all();
    const obligationRows = database.prepare(
      `SELECT space_key, state, next_review_at, run_id
       FROM memory_capacity_obligations
       WHERE state IN ('pending', 'linked')`
    ).all();
    const obligations = new Map(obligationRows.map((row) => [
      z.string().parse(row.space_key),
      {
        state: z.enum(["pending", "linked"]).parse(row.state),
        nextReviewAt: typeof row.next_review_at === "string" ? row.next_review_at : null,
        runId: typeof row.run_id === "string" ? row.run_id : null
      }
    ]));
    const spacesByKey = new Map<string, MemorySpaceCapacity>();
    for (const row of countRows) {
      const kind = z.enum(["project", "global"]).parse(row.scope_kind);
      const count = z.number().int().nonnegative().parse(row.active_count);
      const policy = kind === "global" ? request.policy.global : request.policy.project;
      const scope: MemorySpaceCapacity["scope"] = kind === "global"
        ? { kind: "global" }
        : { kind: "project", project_id: z.string().min(1).parse(row.project_id) };
      const obligation = obligations.get(spaceKey(scope));
      spacesByKey.set(spaceKey(scope), {
        scope,
        active_agent_memory_count: count,
        target: policy.target,
        hard_limit: policy.hardLimit,
        low_water: policy.lowWater,
        state: capacityState(count, policy.target, policy.hardLimit),
        ...(obligation === undefined ? {} : {
          obligation_state: obligation.state,
          next_review_at: obligation.nextReviewAt,
          governance_run_id: obligation.runId
        })
      });
    }
    for (const [key, obligation] of obligations) {
      if (spacesByKey.has(key)) continue;
      const isGlobal = key === "global";
      const policy = isGlobal ? request.policy.global : request.policy.project;
      spacesByKey.set(key, {
        scope: isGlobal
          ? { kind: "global" }
          : { kind: "project", project_id: key.slice("project:".length) },
        active_agent_memory_count: 0,
        target: policy.target,
        hard_limit: policy.hardLimit,
        low_water: policy.lowWater,
        state: "available",
        obligation_state: obligation.state,
        next_review_at: obligation.nextReviewAt,
        governance_run_id: obligation.runId
      });
    }
    const allSpaces = [...spacesByKey.values()];
    const pressured = allSpaces.filter((space) => space.state !== "available");
    const visible = allSpaces
      .filter((space) => space.state !== "available" || space.obligation_state !== undefined)
      .sort((left, right) =>
        right.active_agent_memory_count - left.active_agent_memory_count
        || spaceKey(left.scope).localeCompare(spaceKey(right.scope))
      );
    return {
      pressured_space_count: pressured.length,
      hard_limited_space_count: pressured.filter((space) => space.state === "hard_limited").length,
      open_obligation_count: obligations.size,
      spaces: visible
    };
  } finally {
    database.close();
  }
}

export async function reconcileMemoryCapacity(request: {
  readonly runtimeRoot: string;
  readonly policy: MemoryCapacityPolicy;
  readonly observedAt: string;
}): Promise<MemoryCapacityReconciliation> {
  const observedAt = z.iso.datetime().parse(request.observedAt);
  const status = inspectMemoryCapacity(request);
  if (status.spaces.length === 0 && status.open_obligation_count === 0) {
    return { ...status, pending_obligation_count: 0 };
  }
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const liveKeys = new Set<string>();
      for (const space of status.spaces) {
        if (space.state === "available" && space.active_agent_memory_count <= space.low_water) {
          continue;
        }
        const key = spaceKey(space.scope);
        liveKeys.add(key);
        database.prepare(
           `INSERT INTO memory_capacity_obligations(
             space_key, scope_kind, project_id, state, active_count,
             target_count, hard_limit, low_water, cold_days,
             governance_batch_size, first_exceeded_at, last_observed_at, next_review_at
           ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(space_key) DO UPDATE SET
             active_count = excluded.active_count,
             target_count = excluded.target_count,
             hard_limit = excluded.hard_limit,
             low_water = excluded.low_water,
             cold_days = excluded.cold_days,
             governance_batch_size = excluded.governance_batch_size,
             last_observed_at = excluded.last_observed_at,
             state = CASE
               WHEN memory_capacity_obligations.state = 'linked' THEN 'linked'
               ELSE 'pending'
             END,
             next_review_at = CASE
               WHEN memory_capacity_obligations.state = 'linked'
                 THEN memory_capacity_obligations.next_review_at
               WHEN memory_capacity_obligations.state = 'satisfied'
                 THEN excluded.next_review_at
               ELSE COALESCE(memory_capacity_obligations.next_review_at, excluded.next_review_at)
             END,
             run_id = CASE
               WHEN memory_capacity_obligations.state = 'linked'
                 THEN memory_capacity_obligations.run_id
               ELSE NULL
             END,
             satisfied_at = NULL`
        ).run(
          key,
          space.scope.kind,
          space.scope.kind === "project" ? space.scope.project_id : null,
          space.active_agent_memory_count,
          space.target,
          space.hard_limit,
          space.low_water,
          request.policy.coldDays,
          request.policy.governanceBatchSize,
          observedAt,
          observedAt,
          observedAt
        );
      }
      const existing = database.prepare(
        `SELECT space_key, scope_kind, project_id, state, low_water
         FROM memory_capacity_obligations WHERE state != 'satisfied'`
      ).all();
      for (const obligation of existing) {
        const key = z.string().parse(obligation.space_key);
        if (liveKeys.has(key) || obligation.state === "linked") continue;
        const scopeKind = z.enum(["project", "global"]).parse(obligation.scope_kind);
        const projectId = typeof obligation.project_id === "string"
          ? obligation.project_id
          : null;
        const countRow = database.prepare(
          `SELECT COUNT(*) AS count FROM memory_catalog
           WHERE lifecycle = 'active' AND authority = 'agent_derived'
             AND scope_kind = ?
             AND (? = 'global' OR project_id = ?)`
        ).get(scopeKind, scopeKind, projectId);
        const count = z.number().int().nonnegative().parse(countRow?.count);
        const lowWater = z.number().int().nonnegative().parse(obligation.low_water);
        if (count <= lowWater) {
          database.prepare(
            `UPDATE memory_capacity_obligations
             SET state = 'satisfied', active_count = ?, last_observed_at = ?,
                 next_review_at = NULL, run_id = NULL, satisfied_at = ?
             WHERE space_key = ?`
          ).run(count, observedAt, observedAt, key);
        } else {
          database.prepare(
            `UPDATE memory_capacity_obligations
             SET active_count = ?, last_observed_at = ? WHERE space_key = ?`
          ).run(count, observedAt, key);
        }
      }
      const pending = database.prepare(
        "SELECT COUNT(*) AS count FROM memory_capacity_obligations WHERE state = 'pending'"
      ).get();
      database.exec("COMMIT");
      return {
        ...status,
        pending_obligation_count: z.number().int().nonnegative().parse(pending?.count)
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}
