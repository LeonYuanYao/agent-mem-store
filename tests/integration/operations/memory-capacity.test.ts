import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { activateConfigurationDocument } from "../../../src/configuration/index.js";
import { createAgentCandidate, evaluateCandidate } from "../../../src/candidates/index.js";
import { captureEvent } from "../../../src/capture/index.js";
import { initializeMemStore } from "../../../src/operations/initialize.js";
import { inspectStatus } from "../../../src/operations/status.js";
import { generateReviewInbox } from "../../../src/review/inbox.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { scheduleDueGovernance } from "../../../src/governance/scheduling.js";
import {
  runNextGovernanceStep,
  type GovernanceAdapter
} from "../../../src/governance/worker.js";
import { readCanonicalMemory } from "../../../src/vault/index.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function configureSmallCapacity(runtimeRoot: string, vaultRoot: string): Promise<void> {
  const policyPath = join(vaultRoot, "_MemStore", "policy.toml");
  const source = (await readFile(policyPath, "utf8"))
    .replace("target = 2500", "target = 2")
    .replace("hard_limit = 3500", "hard_limit = 3")
    .replace("low_water = 2200", "low_water = 1");
  const activated = await activateConfigurationDocument({
    runtimeRoot,
    vaultRoot,
    document: "policy",
    source,
    preview: false
  });
  expect(activated.state).toBe("activated");
}

test("status reports Active Agent-derived capacity per Memory Space", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capacity-status-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const projectId = "msproj_723e4567-e89b-42d3-a456-426614174006";
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  await configureSmallCapacity(runtimeRoot, vaultRoot);

  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    const suffix = String(ordinal).padStart(12, "0");
    await writeCanonicalMemory({
      runtimeRoot,
      vaultRoot,
      actor: "agent",
      memory: makeCanonicalMemory({
        memoryId: `msmem_123e4567-e89b-42d3-a456-${suffix}`,
        revisionId: `msrev_223e4567-e89b-42d3-a456-${suffix}`,
        body: `Durable project rule ${String(ordinal)}.`,
        authority: "agent_derived",
        scope: { kind: "project", projectId }
      })
    });
  }
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_323e4567-e89b-42d3-a456-426614174004",
      revisionId: "msrev_423e4567-e89b-42d3-a456-426614174004",
      body: "Human knowledge remains authoritative.",
      authority: "human_authored",
      scope: { kind: "project", projectId }
    })
  });
  const archived = makeCanonicalMemory({
    memoryId: "msmem_523e4567-e89b-42d3-a456-426614174005",
    revisionId: "msrev_623e4567-e89b-42d3-a456-426614174005",
    body: "An archived rule.",
    authority: "agent_derived",
    scope: { kind: "project", projectId }
  });
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory: {
      ...archived,
      lifecycle: "archived",
      lifecycleDetails: {
        archivedAt: "2026-01-01T00:00:00.000Z",
        reason: "test"
      }
    }
  });

  await expect(inspectStatus({ runtimeRoot, vaultRoot })).resolves.toMatchObject({
    memory_capacity: {
      pressured_space_count: 1,
      hard_limited_space_count: 1,
      spaces: [{
        scope: { kind: "project", project_id: projectId },
        active_agent_memory_count: 3,
        target: 2,
        hard_limit: 3,
        low_water: 1,
        state: "hard_limited"
      }]
    }
  });
});

test("a pressured Memory Space schedules a recoverable capacity governance run", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capacity-schedule-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const projectId = "msproj_823e4567-e89b-42d3-a456-426614174007";
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });

  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    const suffix = String(ordinal + 10).padStart(12, "0");
    await writeCanonicalMemory({
      runtimeRoot,
      vaultRoot,
      actor: "agent",
      memory: makeCanonicalMemory({
        memoryId: `msmem_923e4567-e89b-42d3-a456-${suffix}`,
        revisionId: `msrev_a23e4567-e89b-42d3-a456-${suffix}`,
        body: `Capacity-governed rule ${String(ordinal)}.`,
        authority: "agent_derived",
        importanceTags: [],
        scope: { kind: "project", projectId }
      })
    });
  }
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent_capacity_schedule_foreground",
      deduplicationKey: "capacity:schedule:foreground",
      agent: "codex",
      eventKind: "UserPromptSubmit",
      occurredAt: "2026-08-12T11:59:00.000Z",
      projectId,
      sessionId: "capacity-schedule-session",
      turnId: "capacity-schedule-turn",
      payload: { prompt: "Keep foreground capture durable." }
    }
  });

  await expect(scheduleDueGovernance({
    runtimeRoot,
    now: "2026-08-12T12:00:00.000Z",
    workerStartedAt: "2026-08-12T10:00:00.000Z",
    capacityPolicy: {
      project: { target: 2, hardLimit: 3, lowWater: 1 },
      global: { target: 300, hardLimit: 500, lowWater: 270 },
      coldDays: 180,
      governanceBatchSize: 50
    }
  })).resolves.toMatchObject({
    state: "scheduled",
    kind: "weekly",
    includesWeekly: false,
    capacityTriggered: true,
    recoveredOccurrenceCount: 1
  });
});

test("the Promotion Gate keeps a new Agent Candidate waiting at the hard limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capacity-promotion-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const projectId = "msproj_b23e4567-e89b-42d3-a456-426614174008";
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  await configureSmallCapacity(runtimeRoot, vaultRoot);

  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    const suffix = String(ordinal + 20).padStart(12, "0");
    await writeCanonicalMemory({
      runtimeRoot,
      vaultRoot,
      actor: "agent",
      memory: makeCanonicalMemory({
        memoryId: `msmem_c23e4567-e89b-42d3-a456-${suffix}`,
        revisionId: `msrev_d23e4567-e89b-42d3-a456-${suffix}`,
        body: `Existing durable rule ${String(ordinal)}.`,
        authority: "agent_derived",
        scope: { kind: "project", projectId }
      })
    });
  }
  const occurredAt = "2026-08-12T12:10:00.000Z";
  const payload = { prompt: "Always run typecheck before reporting completion." };
  await captureEvent({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent_capacity_promotion",
      deduplicationKey: "capacity:promotion",
      agent: "codex",
      eventKind: "UserPromptSubmit",
      occurredAt,
      projectId,
      sessionId: "capacity-session",
      turnId: "capacity-turn",
      payload
    }
  });
  const created = await createAgentCandidate({
    runtimeRoot,
    vaultRoot,
    scope: { kind: "project", projectId },
    candidate: {
      statement: "Run typecheck before reporting completion.",
      primaryCategory: "workflow_environment_toolchain",
      categoryTags: ["workflow_environment_toolchain"],
      applicabilitySummary: "This project",
      conditions: [],
      exclusions: [],
      preservedNegations: [],
      certainty: "asserted",
      importanceTags: ["constraint"]
    },
    evidence: [{
      evidenceId: "msevent_capacity_promotion",
      evidenceClass: "explicit_user_statement",
      sourceIdentity: "codex:capacity-session:capacity-turn",
      projectId,
      occurredAt,
      integrity: "intact",
      sourceTruncated: false,
      memoryEcho: false,
      evidenceContentIdentity: createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex")
    }],
    sourceSessionId: "capacity-session",
    createdAt: "2026-08-12T12:10:01.000Z"
  });
  if (created.state !== "candidate" && created.state !== "merged") {
    throw new Error("Expected a Candidate.");
  }

  await expect(evaluateCandidate({
    runtimeRoot,
    vaultRoot,
    candidateId: created.candidateId,
    evaluatedAt: "2026-08-12T12:10:02.000Z"
  })).resolves.toMatchObject({
    state: "wait",
    reason: "memory_space_capacity_hard_limit"
  });
});

test("capacity governance archives only reviewed cold Agent memories until low water", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capacity-governance-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const projectId = "msproj_e23e4567-e89b-42d3-a456-426614174009";
  const memoryIds = [
    "msmem_f23e4567-e89b-42d3-a456-426614174031",
    "msmem_f23e4567-e89b-42d3-a456-426614174032",
    "msmem_f23e4567-e89b-42d3-a456-426614174033"
  ] as const;
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  for (const [index, memoryId] of memoryIds.entries()) {
    await writeCanonicalMemory({
      runtimeRoot,
      vaultRoot,
      actor: "agent",
      memory: {
        ...makeCanonicalMemory({
          memoryId,
          revisionId: `msrev_123e4567-e89b-42d3-a456-42661417404${String(index)}`,
          body: `A cold low-utility rule ${String(index + 1)}.`,
          authority: "agent_derived",
          importanceTags: [],
          scope: { kind: "project", projectId }
        }),
        createdAt: "2026-08-01T00:00:00.000Z",
        revisedAt: "2026-08-01T00:00:00.000Z"
      }
    });
  }
  const capacityPolicy = {
    project: { target: 2, hardLimit: 4, lowWater: 1 },
    global: { target: 300, hardLimit: 500, lowWater: 270 },
    coldDays: 1,
    governanceBatchSize: 50
  } as const;
  const scheduled = await scheduleDueGovernance({
    runtimeRoot,
    now: "2026-08-30T12:00:00.000Z",
    workerStartedAt: "2026-08-30T10:00:00.000Z",
    capacityPolicy
  });
  if (scheduled.state !== "scheduled") throw new Error("Expected capacity governance.");

  const inbox = await generateReviewInbox({
    runtimeRoot,
    vaultRoot,
    generatedAt: "2026-08-30T12:00:30.000Z"
  });
  expect(inbox.counts.memoryCapacityObligations).toBe(1);
  const inboxSource = await readFile(inbox.path, "utf8");
  expect(inboxSource).toContain("Memory Capacity");
  expect(inboxSource).toContain("3 active Agent memories / target 2 / hard limit 4");
  expect(inboxSource).not.toContain("A cold low-utility rule");

  const adapter: GovernanceAdapter = {
    reviewPage(request) {
      expect(request.capacityPressures).toEqual([{
        scope: { kind: "project", projectId },
        activeCount: 3,
        target: 2,
        hardLimit: 4,
        lowWater: 1,
        requiredReduction: 2
      }]);
      expect(request.memories.every((memory) => memory.capacity?.eligible === true)).toBe(true);
      return Promise.resolve({
        schemaVersion: 1,
        kind: "governance_page_review",
        agentActions: memoryIds.slice(0, 2).map((targetMemoryId) => ({
          kind: "archive_for_capacity" as const,
          targetMemoryId,
          reason: "Cold, unreferenced, and not selected during the configured window.",
          evidenceRefs: ["capacity:no-selection", "capacity:no-protection"]
        })),
        reviewSuggestions: [],
        futurePurgeObligations: [],
        summaryItems: ["Archived two capacity-eligible memories."]
      });
    }
  };
  await expect(runNextGovernanceStep({
    runtimeRoot, vaultRoot, now: "2026-08-30T12:01:00.000Z", adapter
  })).resolves.toMatchObject({ state: "reviewed" });
  await expect(runNextGovernanceStep({
    runtimeRoot, vaultRoot, now: "2026-08-30T12:02:00.000Z", adapter
  })).resolves.toMatchObject({ state: "applied" });
  await expect(runNextGovernanceStep({
    runtimeRoot, vaultRoot, now: "2026-08-30T12:03:00.000Z", adapter
  })).resolves.toMatchObject({ state: "phase_advanced", phase: "finalize" });
  await expect(runNextGovernanceStep({
    runtimeRoot, vaultRoot, now: "2026-08-30T12:04:00.000Z", adapter
  })).resolves.toMatchObject({ state: "completed" });

  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId: memoryIds[0] }))?.memory.lifecycle)
    .toBe("archived");
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId: memoryIds[1] }))?.memory.lifecycle)
    .toBe("archived");
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId: memoryIds[2] }))?.memory.lifecycle)
    .toBe("active");
  await expect(inspectStatus({ runtimeRoot, vaultRoot })).resolves.toMatchObject({
    memory_capacity: {
      pressured_space_count: 0,
      hard_limited_space_count: 0,
      open_obligation_count: 0
    }
  });
});

test("local capacity validation rejects a Luna archive against pinned knowledge", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capacity-protection-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const projectId = "msproj_133e4567-e89b-42d3-a456-426614174010";
  const pinnedId = "msmem_233e4567-e89b-42d3-a456-426614174041";
  const recoveryId = "msmem_633e4567-e89b-42d3-a456-426614174043";
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  for (const [memoryId, pinned] of [
    [pinnedId, true],
    ["msmem_333e4567-e89b-42d3-a456-426614174042", false],
    [recoveryId, false]
  ] as const) {
    await writeCanonicalMemory({
      runtimeRoot,
      vaultRoot,
      actor: "agent",
      memory: {
        ...makeCanonicalMemory({
          memoryId,
          revisionId: pinned
            ? "msrev_433e4567-e89b-42d3-a456-426614174041"
            : memoryId === recoveryId
              ? "msrev_633e4567-e89b-42d3-a456-426614174043"
              : "msrev_533e4567-e89b-42d3-a456-426614174042",
          body: pinned
            ? "Keep this rare safety rule."
            : memoryId === recoveryId
              ? "Preserve this expensive recovery procedure."
              : "An ordinary cold rule.",
          authority: "agent_derived",
          importanceTags: memoryId === recoveryId ? ["recovery_procedure"] : [],
          scope: { kind: "project", projectId }
        }),
        lifecycleDetails: pinned ? { pinned: true } : {},
        createdAt: "2026-08-01T00:00:00.000Z",
        revisedAt: "2026-08-01T00:00:00.000Z"
      }
    });
  }
  const scheduled = await scheduleDueGovernance({
    runtimeRoot,
    now: "2026-08-30T12:20:00.000Z",
    workerStartedAt: "2026-08-30T10:00:00.000Z",
    capacityPolicy: {
      project: { target: 1, hardLimit: 3, lowWater: 0 },
      global: { target: 300, hardLimit: 500, lowWater: 270 },
      coldDays: 1,
      governanceBatchSize: 50
    }
  });
  if (scheduled.state !== "scheduled") throw new Error("Expected capacity governance.");
  const adapter: GovernanceAdapter = {
    reviewPage(request) {
      expect(request.memories.find((memory) => memory.memoryId === pinnedId)?.capacity)
        .toMatchObject({ eligible: false, protectionReasons: ["pinned"] });
      expect(request.memories.find((memory) => memory.memoryId === recoveryId)?.capacity)
        .toMatchObject({ eligible: false, protectionReasons: ["protected_importance"] });
      return Promise.resolve({
        schemaVersion: 1,
        kind: "governance_page_review",
        agentActions: [{
          kind: "archive_for_capacity",
          targetMemoryId: pinnedId,
          reason: "The model must not override the pin.",
          evidenceRefs: ["capacity:no-selection"]
        }],
        reviewSuggestions: [],
        futurePurgeObligations: [],
        summaryItems: []
      });
    }
  };

  await expect(runNextGovernanceStep({
    runtimeRoot,
    vaultRoot,
    now: "2026-08-30T12:21:00.000Z",
    adapter
  })).resolves.toMatchObject({ state: "retrying" });
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId: pinnedId }))?.memory.lifecycle)
    .toBe("active");
});

test("a capacity-only run rejects ordinary semantic archive actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capacity-action-boundary-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const projectId = "msproj_633e4567-e89b-42d3-a456-426614174011";
  const memoryIds = [
    "msmem_733e4567-e89b-42d3-a456-426614174051",
    "msmem_833e4567-e89b-42d3-a456-426614174052"
  ] as const;
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  for (const [index, memoryId] of memoryIds.entries()) {
    await writeCanonicalMemory({
      runtimeRoot,
      vaultRoot,
      actor: "agent",
      memory: {
        ...makeCanonicalMemory({
          memoryId,
          revisionId: `msrev_933e4567-e89b-42d3-a456-42661417405${String(index)}`,
          body: `An ordinary cold rule ${String(index + 1)}.`,
          authority: "agent_derived",
          importanceTags: [],
          scope: { kind: "project", projectId }
        }),
        createdAt: "2026-08-01T00:00:00.000Z",
        revisedAt: "2026-08-01T00:00:00.000Z"
      }
    });
  }
  const scheduled = await scheduleDueGovernance({
    runtimeRoot,
    now: "2026-08-30T12:30:00.000Z",
    workerStartedAt: "2026-08-30T10:00:00.000Z",
    capacityPolicy: {
      project: { target: 1, hardLimit: 3, lowWater: 0 },
      global: { target: 300, hardLimit: 500, lowWater: 270 },
      coldDays: 1,
      governanceBatchSize: 50
    }
  });
  if (scheduled.state !== "scheduled") throw new Error("Expected capacity governance.");
  const adapter: GovernanceAdapter = {
    reviewPage() {
      return Promise.resolve({
        schemaVersion: 1,
        kind: "governance_page_review",
        agentActions: [{
          kind: "archive",
          targetMemoryId: memoryIds[0],
          reason: "A capacity-only run must not disguise eviction as semantic governance.",
          evidenceRefs: ["capacity-only"]
        }],
        reviewSuggestions: [],
        futurePurgeObligations: [],
        summaryItems: []
      });
    }
  };

  await expect(runNextGovernanceStep({
    runtimeRoot,
    vaultRoot,
    now: "2026-08-30T12:31:00.000Z",
    adapter
  })).resolves.toMatchObject({ state: "retrying" });
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId: memoryIds[0] }))?.memory.lifecycle)
    .toBe("active");
});

test("capacity governance supersedes an exact reviewed duplicate without losing its successor", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capacity-supersede-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const projectId = "msproj_a33e4567-e89b-42d3-a456-426614174012";
  const targetMemoryId = "msmem_b33e4567-e89b-42d3-a456-426614174061";
  const successorMemoryId = "msmem_c33e4567-e89b-42d3-a456-426614174062";
  const targetRevisionId = "msrev_d33e4567-e89b-42d3-a456-426614174061";
  const successorRevisionId = "msrev_e33e4567-e89b-42d3-a456-426614174062";
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  for (const [memoryId, revisionId, body] of [
    [targetMemoryId, targetRevisionId, "Run the focused verification."],
    [successorMemoryId, successorRevisionId, "Run the focused verification and preserve its evidence."],
    ["msmem_f33e4567-e89b-42d3-a456-426614174063", "msrev_033e4567-e89b-42d3-a456-426614174063", "An unrelated durable rule."]
  ] as const) {
    await writeCanonicalMemory({
      runtimeRoot,
      vaultRoot,
      actor: "agent",
      memory: {
        ...makeCanonicalMemory({
          memoryId,
          revisionId,
          body,
          authority: "agent_derived",
          importanceTags: ["recovery_procedure"],
          scope: { kind: "project", projectId }
        }),
        createdAt: "2026-08-01T00:00:00.000Z",
        revisedAt: "2026-08-01T00:00:00.000Z"
      }
    });
  }
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare(
      `INSERT INTO memory_duplicate_clusters(
         cluster_id, index_revision_id, left_memory_id, left_revision_id,
         right_memory_id, right_revision_id, similarity, state, decision,
         reason_code, created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0.99, 'completed', 'right_subsumes_left',
                 'reviewed_subsumption', ?, ?, ?)`
    ).run(
      "msdupe_capacity_supersede",
      "msindex_capacity_supersede",
      targetMemoryId,
      targetRevisionId,
      successorMemoryId,
      successorRevisionId,
      "2026-08-29T10:00:00.000Z",
      "2026-08-29T10:00:00.000Z",
      "2026-08-29T10:00:00.000Z"
    );
  } finally {
    database.close();
  }
  const scheduled = await scheduleDueGovernance({
    runtimeRoot,
    now: "2026-08-30T13:00:00.000Z",
    workerStartedAt: "2026-08-30T10:00:00.000Z",
    capacityPolicy: {
      project: { target: 2, hardLimit: 4, lowWater: 1 },
      global: { target: 300, hardLimit: 500, lowWater: 270 },
      coldDays: 1,
      governanceBatchSize: 50
    }
  });
  if (scheduled.state !== "scheduled") throw new Error("Expected capacity governance.");
  const adapter: GovernanceAdapter = {
    reviewPage(request) {
      expect(request.memories.find((memory) => memory.memoryId === targetMemoryId)?.capacity)
        .toMatchObject({ redundantByMemoryId: successorMemoryId });
      return Promise.resolve({
        schemaVersion: 1,
        kind: "governance_page_review",
        agentActions: [{
          kind: "supersede_for_capacity",
          targetMemoryId,
          successorMemoryId,
          reason: "A current reviewed duplicate decision proves that the successor subsumes this claim.",
          evidenceRefs: ["capacity.redundantByMemoryId"]
        }],
        reviewSuggestions: [],
        futurePurgeObligations: [],
        summaryItems: []
      });
    }
  };
  await expect(runNextGovernanceStep({
    runtimeRoot, vaultRoot, now: "2026-08-30T13:01:00.000Z", adapter
  })).resolves.toMatchObject({ state: "reviewed" });
  await expect(runNextGovernanceStep({
    runtimeRoot, vaultRoot, now: "2026-08-30T13:02:00.000Z", adapter
  })).resolves.toMatchObject({ state: "applied" });

  const target = await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId: targetMemoryId });
  expect(target?.memory).toMatchObject({
    lifecycle: "archived",
    successorMemoryId
  });
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId: successorMemoryId }))?.memory.lifecycle)
    .toBe("active");
});
import { createHash } from "node:crypto";
