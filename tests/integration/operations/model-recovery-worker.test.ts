import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { initializeMemStore } from "../../../src/operations/initialize.js";
import { inspectDoctor } from "../../../src/operations/maintenance.js";
import { LunaInvocationError } from "../../../src/luna/index.js";
import { enqueueLunaOperation, claimLunaOperation, completeLunaOperation } from "../../../src/luna/operations.js";
import { writeCanonicalMemory, readCanonicalMemory } from "../../../src/vault/index.js";
import { enqueueCompactBackfill } from "../../../src/quality/pipeline.js";
import { runWorkerOnce, type WorkerAdapters } from "../../../src/worker/main.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";
import { initializeGovernanceSchedule, scheduleDueGovernance } from "../../../src/governance/scheduling.js";
import { inspectStatus } from "../../../src/operations/status.js";
import { buildRetrievalIndex } from "../../../src/retrieval/index.js";
import { discoverDuplicateClusters, inspectDuplicateClusters } from "../../../src/quality/duplicates.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function succeedOtherWork(runtimeRoot: string, at: string) {
  await enqueueLunaOperation({ runtimeRoot, kind: "distill_batch", idempotencyKey: at, payload: {}, createdAt: at });
  const claim = await claimLunaOperation({ runtimeRoot, workerId: "independent", now: at, leaseSeconds: 60 });
  if (claim.state !== "claimed") throw new Error("Expected independent work.");
  await completeLunaOperation({ runtimeRoot, operationId: claim.operation.operationId, leaseToken: claim.leaseToken, completedAt: at });
}

test.each(["generation", "validation"])("Worker recovers authentication-blocked compact %s without a manual reset", async (failedStage) => {
  const root = await mkdtemp(join(tmpdir(), "memstore-all-model-recovery-")); roots.push(root);
  const paths = { runtimeRoot: join(root, "runtime"), vaultRoot: join(root, "vault") };
  await initializeMemStore({ ...paths, preview: false });
  const memory = makeCanonicalMemory({ memoryId: `msmem_${randomUUID()}`, revisionId: `msrev_${randomUUID()}`,
    body: "Run typecheck before release.", authority: "agent_derived", validatedCompact: false });
  await writeCanonicalMemory({ ...paths, actor: "agent", memory });
  await enqueueCompactBackfill({ ...paths, preview: false, requestedAt: "2026-08-07T00:00:00.000Z" });
  let fail = true;
  let generationCalls = 0;
  const quality: NonNullable<WorkerAdapters["quality"]> = {
    generateCompacts: request => {
      generationCalls++;
      if (fail && failedStage === "generation") throw new LunaInvocationError("authentication", false, "Synthetic authentication failure.");
      return Promise.resolve({ schemaVersion: 1, kind: "compact_generation", items: request.memories.map(m => ({ memoryId: m.memoryId, compactText: "Run typecheck before release." })) });
    },
    validateCompacts: request => {
      if (fail && failedStage === "validation") throw new LunaInvocationError("authentication", false, "Synthetic authentication failure.");
      return Promise.resolve({ schemaVersion: 1, kind: "compact_validation", items: request.memories.map(m => ({ memoryId: m.memoryId, state: "preserves", reasonCode: "preserved" })) });
    },
    assessDuplicateClusters: () => Promise.reject(new Error("No duplicates expected."))
  };
  const step = (now: string) => runWorkerOnce({ ...paths, workerId: "worker", now, workerStartedAt: now, adapters: { quality } });
  if (failedStage === "validation") expect((await step("2026-08-07T00:00:00.000Z")).activities).toContain("memory-quality:generated");
  expect((await step("2026-08-07T00:01:00.000Z")).activities).toContain("memory-quality:blocked");
  expect((await inspectDoctor({ ...paths, deep: false, now: "2026-08-07T00:02:00.000Z" })).checks.find(c => c.name === "memory_quality")?.state).toBe("warning");
  await succeedOtherWork(paths.runtimeRoot, "2026-08-07T01:00:00.000Z");
  await succeedOtherWork(paths.runtimeRoot, "2026-08-07T02:00:00.000Z");
  fail = false;
  expect((await inspectDoctor({ ...paths, deep: false, now: "2026-08-07T03:00:00.000Z" })).checks.find(c => c.name === "memory_quality")?.state).toBe("info");
  expect((await step("2026-08-07T06:00:59.000Z")).activities ?? []).not.toContain("memory-quality:generated");
  expect((await step("2026-08-07T06:01:00.000Z")).activities ?? []).toContain(failedStage === "generation" ? "memory-quality:generated" : "memory-quality:published");
  if (failedStage === "generation") expect((await step("2026-08-07T06:02:00.000Z")).activities).toContain("memory-quality:published");
  expect(generationCalls).toBe(failedStage === "generation" ? 2 : 1);
  expect((await readCanonicalMemory({ ...paths, memoryId: memory.memoryId }))?.memory.representations.compact.validated).toBe(true);
  expect((await inspectDoctor({ ...paths, deep: false, now: "2026-08-07T06:03:00.000Z" })).checks.find(c => c.name === "luna_operations")?.state).toBe("ok");
});

test("Worker resumes the frozen governance page after authentication recovers", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-governance-auto-recovery-")); roots.push(root);
  const paths = { runtimeRoot: join(root, "runtime"), vaultRoot: join(root, "vault") };
  await initializeGovernanceSchedule({ runtimeRoot: paths.runtimeRoot, timeZone: "Asia/Shanghai", registeredAt: "2026-08-04T00:00:00.000Z", pageSize: 1 });
  await initializeMemStore({ ...paths, preview: false });
  for (const body of ["Keep completed pages.", "Resume the failed page."]) {
    await writeCanonicalMemory({ ...paths, actor: "agent", memory: makeCanonicalMemory({
      memoryId: `msmem_${randomUUID()}`, revisionId: `msrev_${randomUUID()}`, body, authority: "agent_derived"
    }) });
  }
  const start = "2026-08-10T19:02:00.000Z";
  const workerStartedAt = "2026-08-10T18:00:00.000Z";
  expect((await scheduleDueGovernance({ runtimeRoot: paths.runtimeRoot, now: start, workerStartedAt })).state).toBe("scheduled");
  let fail = true;
  let frozen: string | undefined;
  const governance: NonNullable<WorkerAdapters["governance"]> = { reviewPage: input => {
    if (input.pageOrdinal === 1 && fail) {
      frozen = JSON.stringify(input);
      throw new LunaInvocationError("authentication", false, "Synthetic login failure.");
    }
    if (!fail) expect(JSON.stringify(input)).toBe(frozen);
    return Promise.resolve({ schemaVersion: 1, kind: "governance_page_review", agentActions: [], reviewSuggestions: [], futurePurgeObligations: [], summaryItems: [] });
  } };
  const step = (now: string) => runWorkerOnce({ ...paths, workerId: "worker", now, workerStartedAt, adapters: { governance } });
  await step(start); await step(start); await step(start);
  expect((await inspectStatus(paths)).governance?.state).toBe("blocked");
  await succeedOtherWork(paths.runtimeRoot, "2026-08-10T20:00:00.000Z");
  await succeedOtherWork(paths.runtimeRoot, "2026-08-10T21:00:00.000Z");
  fail = false;
  expect((await inspectDoctor({ ...paths, deep: false, now: "2026-08-10T22:00:00.000Z" })).checks.find(c => c.name === "governance")?.state).toBe("info");
  expect((await step("2026-08-11T01:02:00.000Z")).activities ?? []).toContain("governance:reviewed");
  expect((await inspectStatus(paths)).governance).toMatchObject({ consecutive_failure_count: 0, last_error_category: null });
});

test("Worker gives duplicate assessment seven attempts then bounded recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-duplicate-auto-recovery-")); roots.push(root);
  const paths = { runtimeRoot: join(root, "runtime"), vaultRoot: join(root, "vault") };
  await initializeMemStore({ ...paths, preview: false });
  for (const body of ["Run typecheck before release.", "Before release run typecheck."]) {
    await writeCanonicalMemory({ ...paths, actor: "agent", memory: makeCanonicalMemory({ memoryId: `msmem_${randomUUID()}`,
      revisionId: `msrev_${randomUUID()}`, body, authority: "agent_derived" }) });
  }
  const at = (minutes: number) => new Date(Date.parse("2026-08-07T00:00:00.000Z") + minutes * 60_000).toISOString();
  await buildRetrievalIndex({ ...paths, builtAt: at(0), adapter: {
    identity: { adapterVersion: "fixture", modelIdentity: "fixture", artifactSha256: "c".repeat(64), dimensions: 2, normalization: "l2" },
    embed: texts => Promise.resolve(texts.map(() => [1, 0]))
  } });
  await discoverDuplicateClusters({ runtimeRoot: paths.runtimeRoot, requestedAt: at(0), preview: false });
  const quality: NonNullable<WorkerAdapters["quality"]> = {
    generateCompacts: () => Promise.reject(new Error("No compact work expected.")),
    validateCompacts: () => Promise.reject(new Error("No compact work expected.")),
    assessDuplicateClusters: () => Promise.reject(new LunaInvocationError("unavailable", true, "Transient failure."))
  };
  const step = (minutes: number) => runWorkerOnce({ ...paths, workerId: "worker", now: at(minutes), workerStartedAt: at(0), adapters: { quality } });
  for (let attempt = 0; attempt < 7; attempt++) {
    expect((await step(attempt * 20)).activities ?? [])
      .toContain(attempt === 6 ? "memory-duplicates:blocked" : "memory-duplicates:retrying");
  }
  await succeedOtherWork(paths.runtimeRoot, at(121));
  await succeedOtherWork(paths.runtimeRoot, at(122));
  expect((await step(479)).activities ?? []).not.toContain("memory-duplicates:blocked");
  expect((await step(480)).activities ?? []).toContain("memory-duplicates:blocked");
  await succeedOtherWork(paths.runtimeRoot, at(481));
  await succeedOtherWork(paths.runtimeRoot, at(482));
  expect((await step(840)).activities ?? []).toContain("memory-duplicates:blocked");
  await succeedOtherWork(paths.runtimeRoot, at(841));
  await succeedOtherWork(paths.runtimeRoot, at(842));
  expect((await step(1200)).activities ?? []).not.toContain("memory-duplicates:blocked");
  expect(await inspectDuplicateClusters({ runtimeRoot: paths.runtimeRoot })).toMatchObject({ blockedCount: 1 });
  expect((await inspectDoctor({ ...paths, deep: false, now: at(1200) })).checks.find(c => c.name === "memory_duplicates")?.state).toBe("warning");
});

test("Compact validation receives its own retry budget after generation succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-quality-stage-budget-")); roots.push(root);
  const paths = { runtimeRoot: join(root, "runtime"), vaultRoot: join(root, "vault") };
  await initializeMemStore({ ...paths, preview: false });
  const memory = makeCanonicalMemory({ memoryId: `msmem_${randomUUID()}`, revisionId: `msrev_${randomUUID()}`,
    body: "Run typecheck before release.", authority: "agent_derived", validatedCompact: false });
  await writeCanonicalMemory({ ...paths, actor: "agent", memory });
  const at = (minutes: number) => new Date(Date.parse("2026-08-07T00:00:00.000Z") + minutes * 60_000).toISOString();
  await enqueueCompactBackfill({ ...paths, preview: false, requestedAt: at(0) });
  let generations = 0;
  let validations = 0;
  const quality: NonNullable<WorkerAdapters["quality"]> = {
    generateCompacts: request => {
      if (++generations <= 6) throw new LunaInvocationError("unavailable", true, "Transient generation failure.");
      return Promise.resolve({ schemaVersion: 1, kind: "compact_generation", items: request.memories.map(m => ({ memoryId: m.memoryId, compactText: "Run typecheck before release." })) });
    },
    validateCompacts: request => {
      if (++validations <= 6) throw new LunaInvocationError("schema_invalid", true, "Invalid validation response.");
      return Promise.resolve({ schemaVersion: 1, kind: "compact_validation", items: request.memories.map(m => ({ memoryId: m.memoryId, state: "preserves", reasonCode: "preserved" })) });
    },
    assessDuplicateClusters: () => Promise.reject(new Error("No duplicates expected."))
  };
  const step = (minutes: number) => runWorkerOnce({ ...paths, workerId: "worker", now: at(minutes), workerStartedAt: at(0), adapters: { quality } });
  for (let attempt = 0; attempt < 6; attempt++) expect((await step(attempt * 20)).activities).toContain("memory-quality:retrying");
  expect((await step(120)).activities).toContain("memory-quality:generated");
  for (let attempt = 0; attempt < 6; attempt++) expect((await step(140 + attempt * 20)).activities).toContain("memory-quality:retrying");
  expect((await step(260)).activities).toContain("memory-quality:published");
  expect(generations).toBe(7);
  expect(validations).toBe(7);
  expect((await readCanonicalMemory({ ...paths, memoryId: memory.memoryId }))?.memory.representations.compact.validated).toBe(true);
});

test("Worker never reopens exhausted compact schema failures on healthy-model evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-quality-schema-blocked-")); roots.push(root);
  const paths = { runtimeRoot: join(root, "runtime"), vaultRoot: join(root, "vault") };
  await initializeMemStore({ ...paths, preview: false });
  await writeCanonicalMemory({ ...paths, actor: "agent", memory: makeCanonicalMemory({
    memoryId: `msmem_${randomUUID()}`, revisionId: `msrev_${randomUUID()}`,
    body: "Run typecheck before release.", authority: "agent_derived", validatedCompact: false }) });
  const at = (minutes: number) => new Date(Date.parse("2026-08-07T00:00:00.000Z") + minutes * 60_000).toISOString();
  await enqueueCompactBackfill({ ...paths, preview: false, requestedAt: at(0) });
  let calls = 0;
  const quality: NonNullable<WorkerAdapters["quality"]> = {
    generateCompacts: () => { calls++; throw new LunaInvocationError("schema_invalid", true, "Invalid response."); },
    validateCompacts: () => Promise.reject(new Error("No draft expected.")),
    assessDuplicateClusters: () => Promise.reject(new Error("No duplicates expected."))
  };
  const step = (minutes: number) => runWorkerOnce({ ...paths, workerId: "worker", now: at(minutes), workerStartedAt: at(0), adapters: { quality } });
  for (let attempt = 0; attempt < 7; attempt++) await step(attempt * 20);
  await succeedOtherWork(paths.runtimeRoot, at(121));
  await succeedOtherWork(paths.runtimeRoot, at(122));
  await step(480);
  expect(calls).toBe(7);
  expect((await inspectDoctor({ ...paths, deep: false, now: at(480) })).checks.find(c => c.name === "memory_quality")?.state).toBe("warning");
});
