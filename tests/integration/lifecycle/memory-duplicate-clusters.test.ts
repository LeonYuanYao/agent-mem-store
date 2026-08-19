import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  discoverDuplicateClusters,
  inspectDuplicateClusters,
  runNextDuplicateAssessment,
  type DuplicateAssessmentAdapter
} from "../../../src/quality/duplicates.js";
import { buildRetrievalIndex, type EmbeddingAdapter } from "../../../src/retrieval/index.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];
const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("duplicate clustering gates Luna assessment by scope and applicability", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-duplicate-cluster-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memories = [
    makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174091",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174091",
      scope: { kind: "project", projectId },
      authority: "agent_derived",
      body: "Run TypeScript typecheck before release."
    }),
    makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174092",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174092",
      scope: { kind: "project", projectId },
      authority: "agent_derived",
      body: "Before publishing a release, execute the TypeScript typecheck."
    }),
    {
      ...makeCanonicalMemory({
        memoryId: "msmem_123e4567-e89b-42d3-a456-426614174093",
        revisionId: "msrev_123e4567-e89b-42d3-a456-426614174093",
        scope: { kind: "project", projectId },
        authority: "agent_derived",
        body: "Run TypeScript typecheck before release."
      }),
      applicability: { summary: "Only the legacy package", conditions: ["legacy package"] }
    }
  ];
  for (const memory of memories) {
    await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "agent", memory });
  }
  const embedding: EmbeddingAdapter = {
    identity: {
      adapterVersion: "fixture-v1",
      modelIdentity: "fixture",
      artifactSha256: "c".repeat(64),
      dimensions: 2,
      normalization: "l2"
    },
    embed: (texts) => Promise.resolve(texts.map((text) =>
      /legacy package/iu.test(text) ? [0, 1] : [1, 0]
    ))
  };
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: embedding,
    builtAt: "2026-08-18T23:10:00.000Z"
  });

  await expect(discoverDuplicateClusters({
    runtimeRoot,
    requestedAt: "2026-08-18T23:10:01.000Z",
    preview: true
  })).resolves.toMatchObject({ candidatePairCount: 1, enqueuedCount: 0 });
  await expect(discoverDuplicateClusters({
    runtimeRoot,
    requestedAt: "2026-08-18T23:10:01.000Z",
    preview: false
  })).resolves.toMatchObject({ candidatePairCount: 1, enqueuedCount: 1 });

  const adapter: DuplicateAssessmentAdapter = {
    assessDuplicateClusters: (request) => Promise.resolve({
      schemaVersion: 1,
      kind: "duplicate_assessment",
      items: request.clusters.map((cluster) => ({
        clusterId: cluster.clusterId,
        decision: "equivalent" as const,
        reasonCode: "same_rule_same_applicability"
      }))
    })
  };
  await expect(runNextDuplicateAssessment({
    runtimeRoot,
    vaultRoot,
    workerId: "duplicate-worker",
    now: "2026-08-18T23:10:02.000Z",
    adapter
  })).resolves.toMatchObject({ state: "assessed", clusterCount: 1 });
  await expect(inspectDuplicateClusters({ runtimeRoot })).resolves.toMatchObject({
    completedCount: 1,
    decisionCounts: { equivalent: 1 }
  });
});
