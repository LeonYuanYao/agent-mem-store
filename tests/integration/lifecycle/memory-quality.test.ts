import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  archiveOperationalMemories,
  auditMemoryQuality,
  repairExactCompactRepresentations
} from "../../../src/operations/quality.js";
import { readCanonicalMemory, writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("quality repair validates only exact lossless compact representations", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-memory-quality-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memoryId = "msmem_123e4567-e89b-42d3-a456-426614174071";
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory: makeCanonicalMemory({
      memoryId,
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174071",
      body: "Run the repository typecheck before claiming completion.",
      authority: "agent_derived",
      validatedCompact: false
    })
  });

  await expect(auditMemoryQuality({ runtimeRoot, vaultRoot })).resolves.toMatchObject({
    scannedCount: 1,
    issueCounts: { compact_unvalidated: 1, compact_exact_repairable: 1 }
  });
  await expect(repairExactCompactRepresentations({
    runtimeRoot,
    vaultRoot,
    repairedAt: "2026-08-18T22:00:00.000Z",
    preview: true
  })).resolves.toMatchObject({
    state: "preview",
    eligibleCount: 1,
    changedCount: 0,
    memoryIds: [memoryId]
  });
  const before = await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId });
  expect(before?.memory.representations.compact.validated).toBe(false);

  await expect(repairExactCompactRepresentations({
    runtimeRoot,
    vaultRoot,
    repairedAt: "2026-08-18T22:00:00.000Z",
    preview: false
  })).resolves.toMatchObject({
    state: "applied",
    eligibleCount: 1,
    changedCount: 1
  });
  const after = await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId });
  expect(after?.memory.revisionId).not.toBe(before?.memory.revisionId);
  expect(after?.memory.representations.compact).toMatchObject({
    text: "Run the repository typecheck before claiming completion.",
    validated: true,
    sourceRevisionId: after?.memory.revisionId
  });
  expect(after?.memory.provenance).toContain("quality:exact-compact-backfill-v1");
});

test("quality repair rebuilds an exact compact for Human-authored memory without changing its body", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-human-memory-quality-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memoryId = "msmem_123e4567-e89b-42d3-a456-426614174073";
  const body = "Create acme merge requests on review.example.com unless explicitly told otherwise.";
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId,
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174073",
      body,
      authority: "human_authored",
      validatedCompact: false
    })
  });

  await expect(repairExactCompactRepresentations({
    runtimeRoot,
    vaultRoot,
    repairedAt: "2026-08-18T22:15:00.000Z",
    preview: true
  })).resolves.toMatchObject({
    state: "preview",
    eligibleCount: 1,
    changedCount: 0,
    memoryIds: [memoryId]
  });
  await repairExactCompactRepresentations({
    runtimeRoot,
    vaultRoot,
    repairedAt: "2026-08-18T22:15:00.000Z",
    preview: false
  });
  const repaired = await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId });
  expect(repaired?.memory).toMatchObject({
    authority: "human_authored",
    body,
    representations: { compact: { text: body, validated: true } }
  });
});

test("quality audit reports operational and temporal signals without mutating memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-memory-quality-signals-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memory = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174072",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174072",
    body: "The current Shadow window msshadow_123e4567-e89b-42d3-a456-426614174072 is still pending.",
    authority: "agent_derived",
    validatedCompact: false
  });
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory: { ...memory, provenance: ["codex:latency-probe:turn-1"] }
  });

  const audit = await auditMemoryQuality({ runtimeRoot, vaultRoot });
  expect(audit.issues).toHaveLength(1);
  expect(audit.issues[0]?.codes).toEqual(expect.arrayContaining([
    "operational_provenance",
    "runtime_identity_in_body",
    "temporal_status_language"
  ]));
  const unchanged = await readCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    memoryId: memory.memoryId
  });
  expect(unchanged?.memory.revisionId).toBe(memory.revisionId);
  expect(unchanged?.memory.lifecycle).toBe("active");

  await expect(archiveOperationalMemories({
    runtimeRoot,
    vaultRoot,
    archivedAt: "2026-08-18T22:30:00.000Z",
    preview: true
  })).resolves.toMatchObject({
    state: "preview",
    eligibleCount: 1,
    changedCount: 0,
    memoryIds: [memory.memoryId]
  });
  await expect(archiveOperationalMemories({
    runtimeRoot,
    vaultRoot,
    archivedAt: "2026-08-18T22:30:00.000Z",
    preview: false
  })).resolves.toMatchObject({
    state: "applied",
    eligibleCount: 1,
    changedCount: 1
  });
  const archived = await readCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    memoryId: memory.memoryId
  });
  expect(archived?.memory.lifecycle).toBe("archived");
  expect(archived?.memory.lifecycleDetails.reason).toBe("quality:operational-provenance-v1");
});
