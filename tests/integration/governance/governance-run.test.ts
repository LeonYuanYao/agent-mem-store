import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  initializeGovernanceSchedule,
  scheduleDueGovernance
} from "../../../src/governance/scheduling.js";
import {
  runNextGovernanceStep,
  type GovernanceAdapter
} from "../../../src/governance/worker.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { readCanonicalMemory, writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];
const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function memoryId(): string {
  return `msmem_${randomUUID()}`;
}

function revisionId(): string {
  return `msrev_${randomUUID()}`;
}

test("weekly governance applies only authorized Agent changes and suggests Human review", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-governance-run-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const agentArchiveId = memoryId();
  const agentRelationId = memoryId();
  const humanId = memoryId();
  for (const [id, authority, body] of [
    [agentArchiveId, "agent_derived", "An obsolete agent-derived rule."],
    [agentRelationId, "agent_derived", "A related agent-derived rule."],
    [humanId, "human_authored", "The human-authored source of truth."]
  ] as const) {
    await writeCanonicalMemory({
      runtimeRoot,
      vaultRoot,
      actor: authority === "human_authored" ? "human" : "agent",
      memory: makeCanonicalMemory({
        memoryId: id,
        revisionId: revisionId(),
        body,
        authority,
        scope: { kind: "project", projectId }
      })
    });
  }
  await initializeGovernanceSchedule({
    runtimeRoot,
    timeZone: "UTC",
    registeredAt: "2026-08-04T00:00:00.000Z",
    startupDelaySeconds: 600,
    pageSize: 50
  });
  const scheduled = await scheduleDueGovernance({
    runtimeRoot,
    now: "2026-08-10T19:01:00.000Z",
    workerStartedAt: "2026-08-10T18:00:00.000Z"
  });
  if (scheduled.state !== "scheduled") throw new Error("Expected weekly run.");

  const adapter: GovernanceAdapter = {
    reviewPage(request) {
      expect(request.phase).toBe("weekly");
      expect(request.memories).toHaveLength(3);
      return Promise.resolve({
        schemaVersion: 1,
        kind: "governance_page_review",
        agentActions: [
          {
            kind: "supersede",
            targetMemoryId: agentArchiveId,
            successorMemoryId: agentRelationId,
            reason: "Superseded by current evidence.",
            evidenceRefs: ["test:evidence"]
          },
          {
            kind: "add_relationship",
            sourceMemoryId: agentRelationId,
            targetMemoryId: humanId,
            relationshipType: "supports",
            reason: "The rule is grounded by the human source.",
            evidenceRefs: ["test:evidence"]
          },
          {
            kind: "mark_review_due",
            targetMemoryId: agentRelationId,
            reason: "The rule is time-sensitive and requires current-state verification.",
            evidenceRefs: ["test:evidence"]
          }
        ],
        reviewSuggestions: [{
          targetMemoryId: humanId,
          kind: "outdated",
          reason: "The applicability may need recalibration.",
          evidenceRefs: ["test:evidence"]
        }],
        futurePurgeObligations: [],
        summaryItems: ["Reviewed three memories and preserved Human authority."]
      });
    }
  };

  await expect(runNextGovernanceStep({
    runtimeRoot, vaultRoot, now: "2026-08-10T19:02:00.000Z", adapter
  })).resolves.toMatchObject({ state: "reviewed", phase: "weekly" });
  await expect(runNextGovernanceStep({
    runtimeRoot, vaultRoot, now: "2026-08-10T19:03:00.000Z", adapter
  })).resolves.toMatchObject({ state: "applied", phase: "weekly" });
  await expect(runNextGovernanceStep({
    runtimeRoot, vaultRoot, now: "2026-08-10T19:04:00.000Z", adapter
  })).resolves.toMatchObject({ state: "phase_advanced", phase: "finalize" });
  await expect(runNextGovernanceStep({
    runtimeRoot, vaultRoot, now: "2026-08-10T19:05:00.000Z", adapter
  })).resolves.toMatchObject({ state: "completed" });

  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId: agentArchiveId }))?.memory)
    .toMatchObject({
      lifecycle: "archived",
      lifecycleDetails: { purgeAfter: "2026-11-10T19:01:00.000Z" }
    });
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId: agentArchiveId }))?.memory.successorMemoryId)
    .toBe(agentRelationId);
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId: humanId }))?.memory.lifecycle)
    .toBe("active");
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId: agentRelationId }))?.memory.relationships)
    .toContainEqual({ type: "supports", targetMemoryId: humanId });
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId: agentRelationId }))?.memory.validity.state)
    .toBe("review_due");
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(database.prepare(
      "SELECT target_memory_id, state FROM governance_review_suggestions"
    ).get()).toEqual({ target_memory_id: humanId, state: "open" });
    expect(database.prepare(
      "SELECT successful_through FROM governance_cursors WHERE cadence = 'weekly'"
    ).get()).toEqual({ successful_through: scheduled.coverageThrough });
  } finally {
    database.close();
  }
});

test("local authority validation rejects a Luna mutation against Human knowledge", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-governance-human-authority-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const humanId = memoryId();
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: humanId,
      revisionId: revisionId(),
      body: "Human knowledge remains authoritative.",
      authority: "human_authored"
    })
  });
  await initializeGovernanceSchedule({
    runtimeRoot,
    timeZone: "UTC",
    registeredAt: "2026-08-04T00:00:00.000Z",
    startupDelaySeconds: 600
  });
  const scheduled = await scheduleDueGovernance({
    runtimeRoot,
    now: "2026-08-10T19:01:00.000Z",
    workerStartedAt: "2026-08-10T18:00:00.000Z"
  });
  if (scheduled.state !== "scheduled") throw new Error("Expected governance run.");
  const invalidAdapter: GovernanceAdapter = {
    reviewPage() {
      return Promise.resolve({
        schemaVersion: 1,
        kind: "governance_page_review",
        agentActions: [{
          kind: "archive",
          targetMemoryId: humanId,
          reason: "This model proposal must be rejected locally.",
          evidenceRefs: ["test:invalid-authority"]
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
    now: "2026-08-10T19:02:00.000Z",
    adapter: invalidAdapter
  })).resolves.toMatchObject({ state: "retrying" });
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId: humanId }))?.memory.lifecycle)
    .toBe("active");
});
