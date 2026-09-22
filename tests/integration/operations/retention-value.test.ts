import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { initializeMemStore } from "../../../src/operations/initialize.js";
import { readCanonicalMemory, writeCanonicalMemory } from "../../../src/vault/index.js";
import { readRetentionAssessment, recordRetentionAssessment } from "../../../src/capacity/retention-cache.js";
import { retentionValuePolicyVersion, type RetentionAssessment } from "../../../src/capacity/retention-value.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { previewCorpusRetention } from "../../../src/capacity/corpus-retention.js";
import { initializeGovernanceSchedule, scheduleDueGovernance } from "../../../src/governance/scheduling.js";
import { runNextGovernanceStep, type GovernanceAdapter } from "../../../src/governance/worker.js";
import { captureEvent } from "../../../src/capture/index.js";
import { evaluateCandidate, listSessionCandidates } from "../../../src/candidates/index.js";
import { prepareNextDistillationBatch, runNextLunaWork, type LunaWorkerAdapter } from "../../../src/worker/distillation.js";
import { makeLongTermCandidateDurability } from "../../helpers/candidate-durability.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const assessment: RetentionAssessment = {
  policyVersion: "retention-value-v1", contentKind: "failure_mechanism", horizon: "durable",
  priority: "high", futureUse: "Avoid mutating the position before computing its delta.",
  reason: "The mutation changes the subsequent calculation."
};
async function fixture(initialize = true) {
  const root = await mkdtemp(join(tmpdir(), "memstore-retention-value-")); roots.push(root);
  const paths = { runtimeRoot: join(root, "runtime"), vaultRoot: join(root, "vault") };
  if (initialize) await initializeMemStore({ ...paths, preview: false });
  const memory = makeCanonicalMemory({ memoryId: `msmem_${randomUUID()}`, revisionId: `msrev_${randomUUID()}`,
    body: "Vector addition mutates its receiver.", authority: "agent_derived" });
  await writeCanonicalMemory({ ...paths, actor: "agent", memory });
  return { ...paths, memory };
}

test("an assessment is reused without refreshing its age on identical writes or maintenance revisions", async () => {
  const f = await fixture();
  expect(await readRetentionAssessment(f)).toBeUndefined();
  expect(await recordRetentionAssessment({ ...f, assessment, assessedAt: "2026-09-22T00:00:00.000Z" })).toBe("stored");
  expect(await recordRetentionAssessment({ ...f, assessment, assessedAt: "2026-09-23T00:00:00.000Z" })).toBe("unchanged");
  const current = await readCanonicalMemory({ ...f, memoryId: f.memory.memoryId });
  if (current === undefined) throw new Error("Missing fixture.");
  const revised = { ...current.memory, revisedAt: "2026-09-23T00:00:00.000Z", revisionId: `msrev_${randomUUID()}`,
    predecessorRevisionId: current.memory.revisionId, validity: { state: "review_due" as const } };
  await writeCanonicalMemory({ ...f, actor: "agent", memory: revised, expectedContentIdentity: current.contentIdentity });
  expect(await readRetentionAssessment({ ...f, memory: revised })).toMatchObject({
    assessment, assessedAt: "2026-09-22T00:00:00.000Z"
  });
  expect(retentionValuePolicyVersion).toBe("retention-value-v1");
});

test("changed body, applicability or scope invalidates cached value and stale model results cannot overwrite it", async () => {
  const f = await fixture();
  await recordRetentionAssessment({ ...f, assessment, assessedAt: "2026-09-22T00:00:00.000Z" });
  expect(await readRetentionAssessment({ ...f, memory: { ...f.memory, body: "Addition is immutable." } })).toBeUndefined();
  expect(await readRetentionAssessment({ ...f, memory: { ...f.memory,
    applicability: { ...f.memory.applicability, conditions: ["Only version two."] } } })).toBeUndefined();
  expect(await readRetentionAssessment({ ...f, memory: { ...f.memory, scope: { kind: "global" } } })).toBeUndefined();
  const current = await readCanonicalMemory({ ...f, memoryId: f.memory.memoryId });
  if (current === undefined) throw new Error("Missing fixture.");
  const revised = { ...current.memory, revisionId: `msrev_${randomUUID()}`, predecessorRevisionId: current.memory.revisionId,
    applicability: { ...current.memory.applicability, conditions: ["Only version two."] } };
  await writeCanonicalMemory({ ...f, memory: revised, actor: "agent", expectedContentIdentity: current.contentIdentity });
  expect(await recordRetentionAssessment({ ...f, assessment, assessedAt: "2026-09-23T00:00:00.000Z" })).toBe("stale");
  expect(await readRetentionAssessment({ ...f, memory: revised })).toBeUndefined();
});

test("old policy and malformed cache entries fall back to unknown without refreshing all entries", async () => {
  const f = await fixture();
  await recordRetentionAssessment({ ...f, assessment, assessedAt: "2026-09-22T00:00:00.000Z" });
  const database = await openRuntimeDatabase(f.runtimeRoot);
  try {
    database.prepare("UPDATE memory_retention_assessments SET assessment_json=?")
      .run(JSON.stringify({ ...assessment, policyVersion: "retention-value-v0" }));
  } finally { database.close(); }
  expect(await readRetentionAssessment(f)).toBeUndefined();
  expect(await recordRetentionAssessment({ ...f, assessment: { ...assessment, policyVersion: "retention-value-v0" },
    assessedAt: "2026-09-23T00:00:00.000Z" })).toBe("stale");
  expect(await recordRetentionAssessment({ ...f, assessment, assessedAt: "2026-09-23T00:00:00.000Z" })).toBe("stored");
  expect(await readRetentionAssessment(f)).toMatchObject({ assessment });
  const corrupt = await openRuntimeDatabase(f.runtimeRoot);
  try { corrupt.prepare("UPDATE memory_retention_assessments SET assessment_json=?").run(JSON.stringify({ policyVersion: retentionValuePolicyVersion })); }
  finally { corrupt.close(); }
  expect(await readRetentionAssessment(f)).toBeUndefined();
  expect(await recordRetentionAssessment({ ...f, assessment, assessedAt: "2026-09-24T00:00:00.000Z" })).toBe("stored");
});

test("capacity ranks low before unknown before high without granting high immunity", async () => {
  const f = await fixture();
  await recordRetentionAssessment({ ...f, assessment, assessedAt: "2026-09-22T00:00:00.000Z" });
  const unknown = { ...makeCanonicalMemory({ memoryId: `msmem_${randomUUID()}`, revisionId: `msrev_${randomUUID()}`,
    body: "Unassessed project context.", authority: "agent_derived" }), revisedAt: "2026-08-08T00:00:00.000Z" };
  const low = { ...makeCanonicalMemory({ memoryId: `msmem_${randomUUID()}`, revisionId: `msrev_${randomUUID()}`,
    body: "A single preview completed.", authority: "agent_derived" }), revisedAt: "2026-08-09T00:00:00.000Z" };
  for (const memory of [unknown, low]) await writeCanonicalMemory({ ...f, memory, actor: "agent" });
  await recordRetentionAssessment({ ...f, memory: low, assessment: { ...assessment, contentKind: "run_result",
    horizon: "transient", priority: "low" }, assessedAt: "2026-09-22T00:00:00.000Z" });
  const policy = { projectHighWater: 2, projectTarget: 1, aggregateHighWater: 10, aggregateTarget: 9, coldDays: 14, batchSize: 50 };
  const preview = await previewCorpusRetention({ ...f, policy, observedAt: "2026-09-22T00:00:00.000Z" });
  expect(preview.items.map(item => item.memoryId)).toEqual([low.memoryId, unknown.memoryId]);
  await recordRetentionAssessment({ ...f, memory: unknown, assessment, assessedAt: "2026-09-22T00:00:00.000Z" });
  const next = await previewCorpusRetention({ ...f, policy, observedAt: "2026-09-22T00:00:00.000Z" });
  expect(next.items).toHaveLength(2);
  expect(next.items[0]?.memoryId).toBe(low.memoryId);
});

test.each([1, 22])("governance piggybacks at most twenty missing assessments (%s available) without changing canonical knowledge", async (count) => {
  const f = await fixture(false);
  const unknowns = [f.memory];
  for (let i = 1; i < count; i += 1) {
    const memory = makeCanonicalMemory({ memoryId: `msmem_${randomUUID()}`, revisionId: `msrev_${randomUUID()}`,
      body: `Another reusable rule ${String(i)}.`, authority: "agent_derived" });
    await writeCanonicalMemory({ ...f, memory, actor: "agent" }); unknowns.push(memory);
  }
  const cached = makeCanonicalMemory({ memoryId: `msmem_${randomUUID()}`, revisionId: `msrev_${randomUUID()}`,
    body: "An already evaluated rule.", authority: "agent_derived" });
  await writeCanonicalMemory({ ...f, memory: cached, actor: "agent" });
  await recordRetentionAssessment({ ...f, memory: cached, assessment, assessedAt: "2026-08-07T00:00:00.000Z" });
  await initializeGovernanceSchedule({ runtimeRoot: f.runtimeRoot, timeZone: "UTC", registeredAt: "2026-08-04T00:00:00.000Z" });
  await scheduleDueGovernance({ runtimeRoot: f.runtimeRoot, now: "2026-08-10T19:01:00.000Z", workerStartedAt: "2026-08-10T18:00:00.000Z" });
  let requestedIds: string[] = [];
  const adapter: GovernanceAdapter = { reviewPage(request) {
    requestedIds = request.retentionTargets?.map(target => target.memoryId) ?? [];
    expect(requestedIds).toHaveLength(Math.min(count, 20));
    expect(requestedIds).not.toContain(cached.memoryId);
    expect(request.retentionPolicyVersion).toBe("retention-value-v1");
    return Promise.resolve({ schemaVersion: 1, kind: "governance_page_review", agentActions: [], reviewSuggestions: [],
      futurePurgeObligations: [], summaryItems: [],
      retentionAssessments: requestedIds.map(memoryId => ({ memoryId, contentKind: assessment.contentKind,
        horizon: assessment.horizon, priority: assessment.priority, futureUse: assessment.futureUse, reason: assessment.reason })) });
  } };
  for (let i = 0; i < 10; i += 1) {
    const result = await runNextGovernanceStep({ ...f, adapter, now: "2026-08-10T19:02:00.000Z", workerId: "retention-test" });
    if (result.state === "completed") break;
  }
  for (const memory of unknowns) {
    const cachedValue = await readRetentionAssessment({ ...f, memory });
    if (requestedIds.includes(memory.memoryId)) expect(cachedValue).toMatchObject({ assessment });
    else expect(cachedValue).toBeUndefined();
  }
  expect((await readCanonicalMemory({ ...f, memoryId: f.memory.memoryId }))?.memory.revisionId).toBe(f.memory.revisionId);
});

test("Human revisions remove cached model value and cannot be reclassified by an old result", async () => {
  const f = await fixture();
  await recordRetentionAssessment({ ...f, assessment, assessedAt: "2026-09-22T00:00:00.000Z" });
  const current = await readCanonicalMemory({ ...f, memoryId: f.memory.memoryId });
  if (current === undefined) throw new Error("Missing fixture.");
  const human = { ...current.memory, authority: "human_authored" as const, revisionId: `msrev_${randomUUID()}`,
    predecessorRevisionId: current.memory.revisionId };
  await writeCanonicalMemory({ ...f, memory: human, actor: "human", expectedContentIdentity: current.contentIdentity });
  expect(await readRetentionAssessment({ ...f, memory: human })).toBeUndefined();
  expect(await recordRetentionAssessment({ ...f, assessment, assessedAt: "2026-09-23T00:00:00.000Z" })).toBe("stale");
});

test.each(["task_bound", "unknown"] as const)("a high label with %s horizon competes as normal value", async horizon => {
  const f = await fixture();
  await recordRetentionAssessment({ ...f, assessment, assessedAt: "2026-09-22T00:00:00.000Z" });
  for (let i = 0; i < 2; i += 1) {
    const memory = { ...makeCanonicalMemory({ memoryId: `msmem_${randomUUID()}`, revisionId: `msrev_${randomUUID()}`,
      body: `A requirement for one delivery ${String(i)}.`, authority: "agent_derived" }), revisedAt: "2026-08-08T00:00:00.000Z" };
    await writeCanonicalMemory({ ...f, memory, actor: "agent" });
    await recordRetentionAssessment({ ...f, memory, assessment: { ...assessment, contentKind: "task_requirement", horizon },
      assessedAt: "2026-09-22T00:00:00.000Z" });
  }
  const preview = await previewCorpusRetention({ ...f, policy: { projectHighWater: 2, projectTarget: 1,
    aggregateHighWater: 10, aggregateTarget: 9, coldDays: 14, batchSize: 50 }, observedAt: "2026-09-22T00:00:00.000Z" });
  expect(preview.items).toHaveLength(2);
  expect(preview.items.map(item => item.memoryId)).not.toContain(f.memory.memoryId);
});

test("the extraction Worker preserves a value judgment through consolidation, admission and promotion", async () => {
  const f = await fixture(false);
  if (f.memory.scope.kind !== "project") throw new Error("Expected project fixture.");
  for (const eventKind of ["UserPromptSubmit", "Stop", "SessionEnd"] as const) {
    await captureEvent({ runtimeRoot: f.runtimeRoot, event: {
      schemaVersion: 1, eventId: `value-pipeline-${eventKind}`, deduplicationKey: `value-pipeline-${eventKind}`,
      agent: "codex", eventKind, projectId: f.memory.scope.projectId, sessionId: "value-pipeline", turnId: "turn-1",
      occurredAt: "2026-08-07T08:00:00.000Z", payload: eventKind === "UserPromptSubmit"
        ? { prompt: "Always validate changes before declaring completion in this repository." }
        : { assistantMessage: "Acknowledged.", reason: "other" }
    } });
  }
  const adapter: LunaWorkerAdapter = {
    distillBatch(request) {
      const evidence = request.evidence.find(item => item.evidenceClass === "explicit_user_statement");
      if (evidence === undefined) throw new Error("Missing user evidence.");
      return Promise.resolve({ schemaVersion: 1, kind: "distillation", candidates: [{
        statement: "Always validate changes before declaring completion in this repository.",
        primaryCategory: "workflow_environment_toolchain", categoryTags: ["workflow_environment_toolchain"],
        applicabilitySummary: "This repository", conditions: [], exclusions: [], preservedNegations: [],
        certainty: "asserted", sensitivity: "normal", evidenceIds: [evidence.evidenceId], importanceTags: ["constraint"],
        importanceReasons: [{ tag: "constraint", reason: "An explicit standing validation rule.", evidenceIds: [evidence.evidenceId] }],
        durability: makeLongTermCandidateDurability(), retentionAssessment: assessment
      }] });
    },
    consolidateSession(request) {
      return Promise.resolve({ schemaVersion: 1, kind: "consolidation", candidates: request.batchResults.flatMap(batch => [...batch.candidates]) });
    }
  };
  await prepareNextDistillationBatch({ runtimeRoot: f.runtimeRoot, maximumEvents: 64, preparedAt: "2026-08-07T08:01:00.000Z" });
  for (let i = 0; i < 3; i += 1) await runNextLunaWork({ runtimeRoot: f.runtimeRoot, adapter, workerId: "retention-pipeline",
    now: "2026-08-07T08:02:00.000Z", currentTime: () => "2026-08-07T08:02:00.000Z" });
  const candidates = await listSessionCandidates(f.runtimeRoot, "value-pipeline");
  expect(candidates).toHaveLength(1);
  const candidate = candidates[0];
  if (candidate === undefined) throw new Error("Missing candidate.");
  const promoted = await evaluateCandidate({ ...f, candidateId: candidate.candidateId, evaluatedAt: "2026-08-07T08:03:00.000Z" });
  if (promoted.state !== "promoted") throw new Error(`Expected promotion, got ${promoted.state}.`);
  const current = await readCanonicalMemory({ ...f, memoryId: promoted.memoryId });
  if (current === undefined) throw new Error("Missing memory.");
  expect(await readRetentionAssessment({ ...f, memory: current.memory })).toMatchObject({ assessment });
});
