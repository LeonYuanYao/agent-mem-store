import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { applyCorpusRetention, previewCorpusRetention, runScheduledCorpusRetention } from "../../../src/capacity/corpus-retention.js";
import { applyMemoryLifecycleChange } from "../../../src/operations/memory-lifecycle.js";
import { runWorkerOnce } from "../../../src/worker/main.js";
import { inspectCorpusRetention } from "../../../src/capacity/corpus-retention.js";
import { activateConfigurationDocument } from "../../../src/configuration/index.js";
import { initializeMemStore } from "../../../src/operations/initialize.js";
import { readCanonicalMemory, writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";
import { openRuntimeDatabase, openRuntimeDatabaseReadOnly } from "../../../src/runtime/database.js";

const roots: string[] = [];
const now = "2026-09-22T00:00:00.000Z";
const policy = { projectHighWater: 3, projectTarget: 2, aggregateHighWater: 20, aggregateTarget: 18, coldDays: 14, batchSize: 50 };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memstore-corpus-retention-"));
  roots.push(root);
  const paths = { runtimeRoot: join(root, "runtime"), vaultRoot: join(root, "vault") };
  await initializeMemStore({ ...paths, preview: false });
  const memories = Array.from({ length: 5 }, (_, i) => ({
    ...makeCanonicalMemory({
      memoryId: `msmem_${randomUUID()}`, revisionId: `msrev_${randomUUID()}`,
      body: `Retained workflow ${String(i)}.`, authority: i === 4 ? "human_authored" : "agent_derived",
      importanceTags: [], startup: i === 3 ? "always" : "auto"
    }),
    createdAt: `2026-08-0${String(i + 1)}T00:00:00.000Z`,
    revisedAt: `2026-08-0${String(i + 1)}T00:00:00.000Z`
  }));
  for (const memory of memories) {
    await writeCanonicalMemory({ ...paths, actor: memory.authority === "human_authored" ? "human" : "agent", memory });
  }
  return { ...paths, memories };
}

test("corpus preview proposes only cold unprotected Agent memories without changing the Vault", async () => {
  const f = await fixture();
  const preview = await previewCorpusRetention({ ...f, policy, observedAt: now });
  expect(preview).toMatchObject({ activeAgentCount: 4, protectedCount: 1, proposedArchiveCount: 2, unresolvedExcess: 0 });
  expect(preview.items.map((item) => item.memoryId)).toEqual(f.memories.slice(0, 2).map((memory) => memory.memoryId));
  for (const memory of f.memories) {
    expect((await readCanonicalMemory({ ...f, memoryId: memory.memoryId }))?.memory.lifecycle).toBe("active");
  }
});

test("fixed capacity counts Human knowledge and drains recent Agent knowledge without per-project quotas", async () => {
  const f = await fixture();
  const fixedPolicy = { ...policy, activeLimit: 5, activeHeadroom: 1 };
  const preview = await previewCorpusRetention({ ...f, policy: fixedPolicy, observedAt: "2026-08-06T00:00:00.000Z" });
  expect(preview).toMatchObject({ activeCount: 5, activeAgentCount: 4, proposedArchiveCount: 1, unresolvedExcess: 0,
    pressure: { projectSpaces: [], aggregate: true } });
  const result = await applyCorpusRetention({ ...f, preview, changedAt: "2026-08-06T00:00:00.000Z", authorizeCapacityArchive: true });
  expect(result.archivedMemoryIds).toHaveLength(1);
  expect(await previewCorpusRetention({ ...f, policy: fixedPolicy, observedAt: now }))
    .toMatchObject({ activeCount: 4, proposedArchiveCount: 0 });
  const human = f.memories[4];
  if (human === undefined) throw new Error("Expected Human memory.");
  expect((await readCanonicalMemory({ ...f, memoryId: human.memoryId }))?.memory.lifecycle).toBe("active");
});

test("capacity selection preserves canonical importance even before retrieval indexes exist", async () => {
  const f = await fixture();
  for (const [index, tag] of [[0, "architecture"], [1, "constraint"]] as const) {
    const source = f.memories[index];
    if (source === undefined) throw new Error("Expected Memory.");
    const current = await readCanonicalMemory({ ...f, memoryId: source.memoryId });
    if (current === undefined) throw new Error("Expected canonical Memory.");
    const revisionId = `msrev_${randomUUID()}`;
    await writeCanonicalMemory({ ...f, actor: "agent", expectedContentIdentity: current.contentIdentity, memory: {
      ...current.memory, revisionId, predecessorRevisionId: current.memory.revisionId, importanceTags: [tag],
      representations: { compact: { ...current.memory.representations.compact, sourceRevisionId: revisionId },
        standard: { ...current.memory.representations.standard, sourceRevisionId: revisionId } }
    } });
  }
  const preview = await previewCorpusRetention({ ...f, observedAt: now, policy: { ...policy, activeLimit: 5, activeHeadroom: 2 } });
  expect(preview.items.map((item) => item.memoryId)).toEqual([f.memories[2]?.memoryId, f.memories[1]?.memoryId]);
});

test("concurrent restores share the last Active slot and full capacity does not lose archived knowledge", async () => {
  const f = await fixture();
  const [first, second] = f.memories;
  if (first === undefined || second === undefined) throw new Error("Expected memories.");
  for (const memory of [first, second]) await applyMemoryLifecycleChange({ ...f, memory: memory.memoryId, action: "archive", changedAt: now });
  const source = await readFile(join(f.vaultRoot, "_MemStore", "policy.toml"), "utf8");
  await activateConfigurationDocument({ ...f, document: "policy", preview: false,
    source: `${source}\n[corpus_retention]\nmode = "apply"\nactive_limit = 4\nactive_headroom = 1\n` });
  const results = await Promise.allSettled([first, second].map((memory) =>
    applyMemoryLifecycleChange({ ...f, memory: memory.memoryId, action: "restore", changedAt: "2026-09-22T00:01:00.000Z" })));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected").map((result) => String(result.reason)))
    .toEqual([expect.stringContaining("Active capacity")]);
  expect(await inspectCorpusRetention(f)).toMatchObject({ activeCount: 4, pendingAdmissions: 0 });
  for (const memory of [first, second]) expect((await readCanonicalMemory({ ...f, memoryId: memory.memoryId }))?.memory.body).toBe(memory.body);
});

test("an abandoned unwritten slot is recovered, while a live writer keeps its reserved slot", async () => {
  const f = await fixture();
  const first = f.memories[0];
  if (first === undefined) throw new Error("Expected Memory.");
  await applyMemoryLifecycleChange({ ...f, memory: first.memoryId, action: "archive", changedAt: now });
  const source = await readFile(join(f.vaultRoot, "_MemStore", "policy.toml"), "utf8");
  await activateConfigurationDocument({ ...f, document: "policy", preview: false,
    source: `${source}\n[corpus_retention]\nmode = "apply"\nactive_limit = 5\nactive_headroom = 1\n` });
  // Inject a crash between slot reservation and the first canonical write.
  const db = await openRuntimeDatabase(f.runtimeRoot);
  db.prepare("INSERT INTO active_capacity_admissions VALUES (?, ?, ?, ?, ?)")
    .run(`msmem_${randomUUID()}`, "crashed-slot", process.pid, join(f.vaultRoot, "unwritten.md"), now);
  db.close();
  await expect(applyMemoryLifecycleChange({ ...f, memory: first.memoryId, action: "restore", changedAt: now })).rejects.toThrow("Active capacity");
  const deadPid = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
  const setup = await openRuntimeDatabase(f.runtimeRoot);
  setup.prepare("UPDATE active_capacity_admissions SET owner_pid=? WHERE token='crashed-slot'").run(deadPid);
  setup.close();
  await applyMemoryLifecycleChange({ ...f, memory: first.memoryId, action: "restore", changedAt: now });
  expect(await inspectCorpusRetention(f)).toMatchObject({ activeCount: 5, pendingAdmissions: 0 });
});

test("read-only corpus previews support the preceding schema without installing the new scheduler", async () => {
  const f = await fixture();
  const setup = await openRuntimeDatabase(f.runtimeRoot);
  setup.exec("DROP TABLE corpus_retention_plans; DROP TABLE corpus_retention_pressure; DROP TABLE corpus_retention_preview_schedule; DELETE FROM schema_migrations WHERE version=62;");
  setup.close();
  expect(await previewCorpusRetention({ ...f, policy, observedAt: now })).toMatchObject({ proposedArchiveCount: 2 });
  expect(await inspectCorpusRetention({ ...f, now })).toMatchObject({ mode: "off", schemaReady: false, activeAgentCount: 4 });
  await expect(openRuntimeDatabaseReadOnly(f.runtimeRoot)).rejects.toThrow("Migration 62 has not been applied");
});

test("an explicitly approved preview archives reversibly with capacity provenance and idempotent replay", async () => {
  const f = await fixture();
  const preview = await previewCorpusRetention({ ...f, policy, observedAt: now });
  const result = await applyCorpusRetention({ ...f, preview, changedAt: now, authorizeCapacityArchive: true });
  expect(result.archivedMemoryIds).toEqual(preview.items.map((item) => item.memoryId));
  const first = preview.items[0];
  if (first === undefined) throw new Error("Expected archive proposal.");
  const archived = await readCanonicalMemory({ ...f, memoryId: first.memoryId });
  expect(archived?.memory).toMatchObject({
    authority: "agent_derived", lifecycle: "archived",
    lifecycleDetails: { reason: `capacity_retention:${preview.digest}`, purgeAfter: "2026-12-22T00:00:00.000Z" }
  });
  expect(archived?.memory.provenance).not.toContain("lifecycle:manual-archive-v1");
  expect(await applyCorpusRetention({ ...f, preview, changedAt: now, authorizeCapacityArchive: true })).toEqual(result);
  await applyMemoryLifecycleChange({ ...f, memory: first.memoryId, action: "restore", changedAt: "2026-09-22T01:00:00.000Z" });
  await applyCorpusRetention({ ...f, preview, changedAt: "2026-09-22T01:01:00.000Z", authorizeCapacityArchive: true });
  expect((await readCanonicalMemory({ ...f, memoryId: first.memoryId }))?.memory).toMatchObject({ lifecycle: "active", body: f.memories[0]?.body });
});

test("expired, unauthorized, modified, and stale previews cannot archive any knowledge", async () => {
  const f = await fixture();
  const preview = await previewCorpusRetention({ ...f, policy, observedAt: now });
  await expect(applyCorpusRetention({ ...f, preview, changedAt: now, authorizeCapacityArchive: false })).rejects.toThrow("authorization");
  await expect(applyCorpusRetention({ ...f, preview, changedAt: "2026-09-22T07:00:00.000Z", authorizeCapacityArchive: true })).rejects.toThrow("expired");
  await expect(applyCorpusRetention({ ...f, preview: { ...preview, items: [] }, changedAt: now, authorizeCapacityArchive: true })).rejects.toThrow("modified");
  const semanticProposal = { ...preview, items: preview.items.map((item) => ({ ...item, successorMemoryId: preview.items[0]?.memoryId })) };
  await expect(applyCorpusRetention({ ...f, preview: semanticProposal, changedAt: now, authorizeCapacityArchive: true })).rejects.toThrow("modified");
  const first = preview.items[0];
  if (first === undefined) throw new Error("Expected proposal.");
  const current = await readCanonicalMemory({ ...f, memoryId: first.memoryId });
  if (current === undefined) throw new Error("Expected current Memory.");
  const revisionId = `msrev_${randomUUID()}`;
  await writeCanonicalMemory({ ...f, actor: "human", expectedContentIdentity: current.contentIdentity, memory: {
    ...current.memory, revisionId, predecessorRevisionId: current.memory.revisionId,
    revisedAt: "2026-09-22T00:01:00.000Z", authority: "human_authored", originKind: "manual_edit",
    lifecycleDetails: { pinned: true },
    representations: {
      compact: { ...current.memory.representations.compact, sourceRevisionId: revisionId },
      standard: { ...current.memory.representations.standard, sourceRevisionId: revisionId }
    }
  } });
  await expect(applyCorpusRetention({ ...f, preview, changedAt: "2026-09-22T00:02:00.000Z", authorizeCapacityArchive: true })).rejects.toThrow("stale");
  for (const memory of f.memories) expect((await readCanonicalMemory({ ...f, memoryId: memory.memoryId }))?.memory.lifecycle).toBe("active");
});

test("aggregate pressure includes all spaces without exceeding the per-run budget", async () => {
  const f = await fixture();
  const preview = await previewCorpusRetention({ ...f, policy: {
    ...policy, projectHighWater: 30, projectTarget: 20, aggregateHighWater: 3, aggregateTarget: 2, batchSize: 1
  }, observedAt: now });
  expect(preview).toMatchObject({ proposedArchiveCount: 1, unresolvedExcess: 1 });
  const protectedPreview = await previewCorpusRetention({ ...f, policy, observedAt: "2026-08-10T00:00:00.000Z" });
  expect(protectedPreview).toMatchObject({ proposedArchiveCount: 0, unresolvedExcess: 2 });
});

test("a pressure episode continues below high water until its target is reached", async () => {
  const f = await fixture();
  const boundedPolicy = { ...policy, batchSize: 1 };
  const first = await previewCorpusRetention({ ...f, policy: boundedPolicy, observedAt: now });
  await applyCorpusRetention({ ...f, preview: first, changedAt: now, authorizeCapacityArchive: true });
  const nextAt = "2026-09-22T00:01:00.000Z";
  const second = await previewCorpusRetention({ ...f, policy: boundedPolicy, observedAt: nextAt });
  expect(second).toMatchObject({ activeAgentCount: 3, proposedArchiveCount: 1, unresolvedExcess: 0 });
  await applyCorpusRetention({ ...f, preview: second, changedAt: nextAt, authorizeCapacityArchive: true });
  expect(await previewCorpusRetention({ ...f, policy: boundedPolicy, observedAt: "2026-09-22T00:02:00.000Z" }))
    .toMatchObject({ activeAgentCount: 2, proposedArchiveCount: 0, unresolvedExcess: 0 });
});

test("foreground pressure pauses an archive batch and a later execution resumes the exact plan", async () => {
  const f = await fixture();
  const preview = await previewCorpusRetention({ ...f, policy, observedAt: now });
  const first = preview.items[0];
  if (first === undefined) throw new Error("Expected proposal.");
  const partial = await applyCorpusRetention({ ...f, preview, changedAt: now, authorizeCapacityArchive: true,
    foregroundPressure: async () => (await readCanonicalMemory({ ...f, memoryId: first.memoryId }))?.memory.lifecycle === "archived"
  });
  expect(partial).toMatchObject({ completed: false, archivedMemoryIds: [first.memoryId] });
  const before = await readCanonicalMemory({ ...f, memoryId: first.memoryId });
  const resumed = await applyCorpusRetention({ ...f, preview, changedAt: "2026-09-22T00:01:00.000Z", authorizeCapacityArchive: true });
  expect(resumed).toMatchObject({ completed: true, archivedMemoryIds: preview.items.map((item) => item.memoryId) });
  expect((await readCanonicalMemory({ ...f, memoryId: first.memoryId }))?.contentIdentity).toBe(before?.contentIdentity);
});

test("the Worker previews corpus pressure only when opted in and coalesces missed six-hour checks", async () => {
  const f = await fixture();
  const base = { ...f, workerId: "corpus-retention-test", workerStartedAt: now };
  const disabled = await runWorkerOnce({ ...base, now });
  expect(disabled.activities ?? []).not.toContain("corpus-retention:preview:2");
  const first = await runWorkerOnce({ ...base, now, corpusRetentionPreviewPolicy: policy });
  expect(first.activities).toContain("corpus-retention:preview:2");
  const cooling = await runWorkerOnce({ ...base, now: "2026-09-22T01:00:00.000Z", corpusRetentionPreviewPolicy: policy });
  expect(cooling.activities ?? []).not.toContain("corpus-retention:preview:2");
  const caughtUp = await runWorkerOnce({ ...base, now: "2026-09-23T01:00:00.000Z", corpusRetentionPreviewPolicy: policy });
  expect(caughtUp.activities?.filter((item) => item.startsWith("corpus-retention:preview:"))).toEqual(["corpus-retention:preview:2"]);
  for (const memory of f.memories) expect((await readCanonicalMemory({ ...f, memoryId: memory.memoryId }))?.memory.lifecycle).toBe("active");
});

test.each(["pinned", "retainForever", "safety", "private"])("%s protection prevents capacity convergence without weakening the rule", async (protection) => {
  const f = await fixture();
  for (const memory of f.memories.slice(0, 3)) {
    const current = await readCanonicalMemory({ ...f, memoryId: memory.memoryId });
    if (current === undefined) throw new Error("Missing fixture Memory.");
    const revisionId = `msrev_${randomUUID()}`;
    await writeCanonicalMemory({ ...f, actor: "agent", expectedContentIdentity: current.contentIdentity, memory: {
      ...current.memory, revisionId, predecessorRevisionId: current.memory.revisionId,
      lifecycleDetails: { pinned: protection === "pinned", retainForever: protection === "retainForever" },
      ...(protection === "safety" ? { primaryCategory: "safety_data_integrity", categoryTags: ["safety_data_integrity"] } : {}),
      ...(protection === "private" ? { sensitivity: "private" } : {}),
      representations: {
        compact: { ...current.memory.representations.compact, sourceRevisionId: revisionId },
        standard: { ...current.memory.representations.standard, sourceRevisionId: revisionId }
      }
    } });
  }
  expect(await previewCorpusRetention({ ...f, policy, observedAt: now }))
    .toMatchObject({ protectedCount: 4, proposedArchiveCount: 0, unresolvedExcess: 2 });
});

test("missing receipt history defers Worker previews rather than assuming inactivity", async () => {
  const f = await fixture();
  const source = (await readFile(join(f.vaultRoot, "_MemStore", "policy.toml"), "utf8"))
    .replace("injection_receipt_days = 30", "injection_receipt_days = 7");
  await activateConfigurationDocument({ ...f, document: "policy", source, preview: false });
  await expect(previewCorpusRetention({ ...f, policy, observedAt: now })).rejects.toThrow("shorter");
  const base = { ...f, workerId: "corpus-retention-short-history", workerStartedAt: now, corpusRetentionPreviewPolicy: policy };
  expect((await runWorkerOnce({ ...base, now })).activities).toContain("corpus-retention:deferred");
  expect((await runWorkerOnce({ ...base, now: "2026-09-22T00:01:00.000Z" })).activities ?? []).not.toContain("corpus-retention:deferred");
  for (const memory of f.memories) expect((await readCanonicalMemory({ ...f, memoryId: memory.memoryId }))?.memory.lifecycle).toBe("active");
});

test("configured Worker application drains a pressure episode in bounded batches then sleeps", async () => {
  const f = await fixture();
  const source = await readFile(join(f.vaultRoot, "_MemStore", "policy.toml"), "utf8");
  await activateConfigurationDocument({ ...f, document: "policy", preview: false, source: `${source}\n[corpus_retention]\nmode = "apply"\nproject_high_water = 3\nproject_target = 2\naggregate_high_water = 20\naggregate_target = 18\nbatch_size = 1\n` });
  const base = { ...f, workerId: "corpus-retention-configured", workerStartedAt: now };
  expect((await runWorkerOnce({ ...base, now })).activities).toContain("corpus-retention:applied:1");
  expect(await inspectCorpusRetention({ ...f, now })).toMatchObject({ mode: "apply", activeAgentCount: 3, remainingExcess: 1 });
  expect((await runWorkerOnce({ ...base, now: "2026-09-22T00:00:10.000Z" })).activities ?? []).not.toContain("corpus-retention:applied:1");
  expect((await runWorkerOnce({ ...base, now: "2026-09-22T00:00:30.000Z" })).activities).toContain("corpus-retention:applied:1");
  expect(await inspectCorpusRetention({ ...f, now: "2026-09-22T00:00:31.000Z" })).toMatchObject({ activeAgentCount: 2, remainingExcess: 0 });
});

test("an interrupted archive plan rechecks Human revisions before resuming", async () => {
  const f = await fixture();
  const preview = await previewCorpusRetention({ ...f, policy, observedAt: now });
  const [first, second] = preview.items;
  if (first === undefined || second === undefined) throw new Error("Expected two proposals.");
  await expect(applyCorpusRetention({ ...f, preview, changedAt: now, authorizeCapacityArchive: true,
    foregroundPressure: async () => {
      if ((await readCanonicalMemory({ ...f, memoryId: first.memoryId }))?.memory.lifecycle === "archived") throw new Error("Executor interrupted");
      return false;
    }
  })).rejects.toThrow("Executor interrupted");
  const firstArchived = await readCanonicalMemory({ ...f, memoryId: first.memoryId });
  const current = await readCanonicalMemory({ ...f, memoryId: second.memoryId });
  if (current === undefined) throw new Error("Missing fixture.");
  const revisionId = `msrev_${randomUUID()}`;
  await writeCanonicalMemory({ ...f, actor: "human", expectedContentIdentity: current.contentIdentity, memory: {
    ...current.memory, revisionId, predecessorRevisionId: current.memory.revisionId,
    revisedAt: "2026-09-22T00:01:00.000Z", authority: "human_authored", originKind: "manual_edit",
    lifecycleDetails: { pinned: true },
    representations: {
      compact: { ...current.memory.representations.compact, sourceRevisionId: revisionId },
      standard: { ...current.memory.representations.standard, sourceRevisionId: revisionId }
    }
  } });
  expect(await applyCorpusRetention({ ...f, preview, changedAt: "2026-09-22T00:02:00.000Z", authorizeCapacityArchive: true }))
    .toEqual({ completed: true, archivedMemoryIds: [first.memoryId], skippedMemoryIds: [second.memoryId] });
  expect((await readCanonicalMemory({ ...f, memoryId: first.memoryId }))?.contentIdentity).toBe(firstArchived?.contentIdentity);
  expect((await readCanonicalMemory({ ...f, memoryId: second.memoryId }))?.memory).toMatchObject({ lifecycle: "active", authority: "human_authored" });
});

test("disabling configured corpus retention stops a remaining pressure episode", async () => {
  const f = await fixture();
  const source = await readFile(join(f.vaultRoot, "_MemStore", "policy.toml"), "utf8");
  const enabled = `${source}\n[corpus_retention]\nmode = "apply"\nproject_high_water = 3\nproject_target = 2\naggregate_high_water = 20\naggregate_target = 18\nbatch_size = 1\n`;
  await activateConfigurationDocument({ ...f, document: "policy", preview: false, source: enabled });
  expect(await runScheduledCorpusRetention({ ...f, now })).toMatchObject({ state: "applied", count: 1 });
  await activateConfigurationDocument({ ...f, document: "policy", preview: false, source: enabled.replace('mode = "apply"', 'mode = "off"') });
  expect(await runScheduledCorpusRetention({ ...f, now: "2026-09-23T00:00:00.000Z" })).toEqual({ state: "off" });
  expect(await inspectCorpusRetention({ ...f, now })).toMatchObject({ mode: "off", activeAgentCount: 3, remainingExcess: 1 });
});

test("last-known-good apply configuration cannot authorize archives while current policy is invalid", async () => {
  const f = await fixture();
  const path = join(f.vaultRoot, "_MemStore", "policy.toml");
  const source = await readFile(path, "utf8");
  await activateConfigurationDocument({ ...f, document: "policy", preview: false,
    source: `${source}\n[corpus_retention]\nmode = "apply"\nproject_high_water = 3\nproject_target = 2\n` });
  await writeFile(path, "[invalid TOML");
  const result = await runWorkerOnce({ ...f, now, workerId: "corpus-invalid-config", workerStartedAt: now });
  expect(result.activities).toContain("corpus-retention:deferred");
  expect(await inspectCorpusRetention({ ...f, now })).toMatchObject({ state: "configuration_unavailable" });
  for (const memory of f.memories) expect((await readCanonicalMemory({ ...f, memoryId: memory.memoryId }))?.memory.lifecycle).toBe("active");
});

test("a resumed plan stops at target after independent archives reduce the same corpus", async () => {
  const f = await fixture();
  const preview = await previewCorpusRetention({ ...f, policy, observedAt: now });
  const [first, second] = preview.items;
  const other = f.memories[2];
  if (first === undefined || second === undefined || other === undefined) throw new Error("Missing fixture.");
  await applyCorpusRetention({ ...f, preview, changedAt: now, authorizeCapacityArchive: true,
    foregroundPressure: async () => (await readCanonicalMemory({ ...f, memoryId: first.memoryId }))?.memory.lifecycle === "archived"
  });
  await applyMemoryLifecycleChange({ ...f, memory: other.memoryId, action: "archive", changedAt: "2026-09-22T00:01:00.000Z" });
  expect(await applyCorpusRetention({ ...f, preview, changedAt: "2026-09-22T00:02:00.000Z", authorizeCapacityArchive: true }))
    .toEqual({ completed: true, archivedMemoryIds: [first.memoryId], skippedMemoryIds: [second.memoryId] });
  expect((await readCanonicalMemory({ ...f, memoryId: second.memoryId }))?.memory.lifecycle).toBe("active");
});

test("scheduled application persists a paused plan and resumes it on the next due run", async () => {
  const f = await fixture();
  const source = await readFile(join(f.vaultRoot, "_MemStore", "policy.toml"), "utf8");
  await activateConfigurationDocument({ ...f, document: "policy", preview: false,
    source: `${source}\n[corpus_retention]\nmode = "apply"\nproject_high_water = 3\nproject_target = 2\n` });
  const first = f.memories[0];
  if (first === undefined) throw new Error("Missing fixture.");
  expect(await runScheduledCorpusRetention({ ...f, now,
    foregroundPressure: async () => (await readCanonicalMemory({ ...f, memoryId: first.memoryId }))?.memory.lifecycle === "archived"
  })).toMatchObject({ state: "applied", count: 1 });
  const paused = await inspectCorpusRetention({ ...f, now });
  if (paused.state !== "ready") throw new Error("Expected readable retention status.");
  expect(typeof paused.pendingDigest).toBe("string");
  expect(paused.activeAgentCount).toBe(3);
  expect(await runScheduledCorpusRetention({ ...f, now: "2026-09-22T00:00:30.000Z" })).toMatchObject({ state: "applied", count: 2 });
  expect(await inspectCorpusRetention({ ...f, now })).toMatchObject({ pendingDigest: null, activeAgentCount: 2, remainingExcess: 0 });
});
