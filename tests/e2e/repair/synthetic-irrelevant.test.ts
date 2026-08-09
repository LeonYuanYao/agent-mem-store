import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  approveRepairGate1,
  approveRepairGate2,
  inspectRepair,
  prepareRepair,
  recordRepairApplication,
  recordRepairProposal,
  recordRepairReplay,
  recordSafetyObservation
} from "../../../src/repair/index.js";
import { buildRetrievalIndex, type EmbeddingAdapter } from "../../../src/retrieval/index.js";
import { recallSearch, reportIrrelevant } from "../../../src/retrieval/recall.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];
const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const adapter: EmbeddingAdapter = {
  identity: {
    adapterVersion: "repair-fixture-v1",
    modelIdentity: "repair-fixture-embedding",
    artifactSha256: "b".repeat(64),
    dimensions: 2,
    normalization: "l2"
  },
  embed: (texts) => Promise.resolve(texts.map(() => [1, 0]))
};

async function badCaseFixture() {
  const root = await mkdtemp(join(tmpdir(), "memstore-repair-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memory = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174401",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174411",
    body: "Use SQLite WAL for the database.",
    compact: "Use SQLite WAL.",
    scope: { kind: "project", projectId }
  });
  await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "human", memory });
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter,
    builtAt: "2026-08-08T10:00:00.000Z"
  });
  const search = await recallSearch({
    runtimeRoot,
    vaultRoot,
    query: "SQLite database",
    scope: "current",
    currentProjectId: projectId,
    callerIdentity: "codex:repair-session",
    adapter,
    requestedAt: "2026-08-08T10:01:00.000Z"
  });
  const selected = search.items[0];
  if (selected === undefined) throw new Error("Expected selected Memory.");
  const badCase = await reportIrrelevant({
    runtimeRoot,
    receiptId: search.receiptId,
    memoryId: selected.memoryId,
    callerIdentity: "codex:repair-session",
    observedAt: "2026-08-08T10:02:00.000Z"
  });
  return { runtimeRoot, vaultRoot, badCase };
}

test("a synthetic irrelevant Bad Case passes the reviewed Class B repair loop", async () => {
  const fixture = await badCaseFixture();
  const prepared = await prepareRepair({
    runtimeRoot: fixture.runtimeRoot,
    badCaseId: fixture.badCase.badCaseId,
    activeModel: "gpt-5.6",
    programVersion: "0.1.0-test",
    codeRevision: "fixture-before",
    preparedAt: "2026-08-08T10:03:00.000Z"
  });

  expect(prepared).toMatchObject({
    state: "diagnosing",
    modelRequirement: { required: "gpt-5.6", satisfied: true }
  });
  expect(JSON.parse(await readFile(join(prepared.bundlePath, "context.json"), "utf8"))).toMatchObject({
    badCaseId: fixture.badCase.badCaseId,
    receiptSamples: [{ modelIdentity: "repair-fixture-embedding" }]
  });

  await recordRepairProposal({
    runtimeRoot: fixture.runtimeRoot,
    repairId: prepared.repairId,
    rootCause: "retrieval_ranking",
    riskClass: "B",
    diagnosis: "The synthetic ranker overweights an irrelevant lexical match.",
    proposedChanges: ["Lower the synthetic irrelevant rank in the fixture."],
    expectedImpact: "The reported result is no longer selected.",
    risks: ["A relevant SQLite result could be demoted."],
    rollbackMethod: "Restore fixture-before.",
    verificationPlan: ["Replay the case.", "Run the protected retrieval set."],
    recordedAt: "2026-08-08T10:04:00.000Z"
  });
  await approveRepairGate1({
    runtimeRoot: fixture.runtimeRoot,
    repairId: prepared.repairId,
    approvedBy: "human:test",
    authorizedTargets: ["tests/e2e/repair/synthetic-irrelevant.test.ts"],
    approvedAt: "2026-08-08T10:05:00.000Z"
  });
  await recordRepairApplication({
    runtimeRoot: fixture.runtimeRoot,
    repairId: prepared.repairId,
    beforeVersion: "fixture-before",
    afterVersion: "fixture-after",
    changedTargets: ["tests/e2e/repair/synthetic-irrelevant.test.ts"],
    appliedAt: "2026-08-08T10:06:00.000Z"
  });
  await recordRepairReplay({
    runtimeRoot: fixture.runtimeRoot,
    repairId: prepared.repairId,
    originalCasesPassed: true,
    protectedCasesPassed: true,
    aggregateTargetMet: true,
    irrelevantRetrievalWorsened: false,
    criticalRecallDecreased: false,
    boundaryRegression: false,
    labelsOrThresholdsWeakened: false,
    commands: ["pnpm test -- tests/e2e/repair"],
    replayedAt: "2026-08-08T10:07:00.000Z"
  });
  const resolved = await approveRepairGate2({
    runtimeRoot: fixture.runtimeRoot,
    repairId: prepared.repairId,
    approvedBy: "human:test",
    approvedAt: "2026-08-08T10:08:00.000Z"
  });

  expect(resolved.state).toBe("resolved");
  expect((await inspectRepair(fixture.runtimeRoot, prepared.repairId)).events.map((event) => event.kind))
    .toEqual(["prepared", "proposal_recorded", "gate1_approved", "application_recorded", "replay_recorded", "gate2_approved"]);
  const database = await openRuntimeDatabase(fixture.runtimeRoot);
  expect(database.prepare("SELECT state FROM bad_cases WHERE bad_case_id = ?")
    .get(fixture.badCase.badCaseId)?.state).toBe("resolved");
  database.close();
});

test("unconfirmed models warn and Class C repairs require runtime observation", async () => {
  const fixture = await badCaseFixture();
  const prepared = await prepareRepair({
    runtimeRoot: fixture.runtimeRoot,
    badCaseId: fixture.badCase.badCaseId,
    activeModel: "unknown",
    programVersion: "0.1.0-test",
    codeRevision: "fixture-before",
    preparedAt: "2026-08-01T10:03:00.000Z"
  });
  expect(prepared.modelRequirement).toMatchObject({ satisfied: false });
  expect(prepared.modelRequirement.warning).toContain("GPT-5.6");

  await recordRepairProposal({
    runtimeRoot: fixture.runtimeRoot,
    repairId: prepared.repairId,
    rootCause: "scope_boundary",
    riskClass: "C",
    diagnosis: "Synthetic Project boundary regression.",
    proposedChanges: ["Restore the Project boundary."],
    expectedImpact: "Cross-Project recall is rejected.",
    risks: ["Safety boundary behavior changes."],
    rollbackMethod: "Restore fixture-before.",
    verificationPlan: ["Replay boundary fixtures."],
    recordedAt: "2026-08-01T10:04:00.000Z"
  });
  await approveRepairGate1({
    runtimeRoot: fixture.runtimeRoot,
    repairId: prepared.repairId,
    approvedBy: "human:test",
    authorizedTargets: ["src/retrieval/recall.ts"],
    approvedAt: "2026-08-01T10:05:00.000Z"
  });
  await recordRepairApplication({
    runtimeRoot: fixture.runtimeRoot,
    repairId: prepared.repairId,
    beforeVersion: "fixture-before",
    afterVersion: "fixture-after",
    changedTargets: ["src/retrieval/recall.ts"],
    appliedAt: "2026-08-01T10:06:00.000Z"
  });
  await recordRepairReplay({
    runtimeRoot: fixture.runtimeRoot,
    repairId: prepared.repairId,
    originalCasesPassed: true,
    protectedCasesPassed: true,
    aggregateTargetMet: true,
    irrelevantRetrievalWorsened: false,
    criticalRecallDecreased: false,
    boundaryRegression: false,
    labelsOrThresholdsWeakened: false,
    commands: ["pnpm test -- tests/fault/automatic-retrieval.test.ts"],
    replayedAt: "2026-08-01T10:07:00.000Z"
  });
  const monitoring = await approveRepairGate2({
    runtimeRoot: fixture.runtimeRoot,
    repairId: prepared.repairId,
    approvedBy: "human:test",
    approvedAt: "2026-08-01T10:08:00.000Z"
  });
  expect(monitoring.state).toBe("monitoring");

  for (let day = 0; day < 7; day += 1) {
    await recordSafetyObservation({
      runtimeRoot: fixture.runtimeRoot,
      repairId: prepared.repairId,
      opportunityCount: day === 6 ? 6 : 4,
      violationCount: 0,
      observedAt: `2026-08-0${String(day + 2)}T12:00:00.000Z`
    });
  }
  const observed = await inspectRepair(fixture.runtimeRoot, prepared.repairId);
  expect(observed).toMatchObject({ state: "resolved", safetyOpportunityCount: 30, safetyViolationCount: 0 });
});
