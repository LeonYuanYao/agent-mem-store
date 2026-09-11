import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { initializeGovernanceSchedule, scheduleDueGovernance } from "../../../src/governance/scheduling.js";
import { runNextGovernanceStep, type GovernanceAdapter } from "../../../src/governance/worker.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { readCanonicalMemory, writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

test.each([false, true])("monthly cross-page supersession respects frozen evidence (changed partner: %s)", async changedPartner => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cross-page-"));
  const runtimeRoot = join(root, "runtime"), vaultRoot = join(root, "vault");
  try {
    const memories = [1, 2, 3, 4].map(n => makeCanonicalMemory({
      memoryId: `msmem_123e4567-e89b-42d3-a456-42661417400${String(n)}`,
      revisionId: `msrev_123e4567-e89b-42d3-a456-42661417400${String(n)}`,
      authority: "agent_derived", body: "Use a fixed clock for deterministic tests."
    }));
    for (const memory of memories) await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "agent", memory });
    const [left, unrelatedLeft, unrelatedRight, right] = memories;
    if (!left || !right || !unrelatedLeft || !unrelatedRight) throw Error("Missing fixture");
    await initializeGovernanceSchedule({ runtimeRoot, timeZone: "UTC", registeredAt: "2026-08-04T00:00:00.000Z", pageSize: 1 });
    const db = await openRuntimeDatabase(runtimeRoot);
    try {
      for (const [a, b] of [[left, right], [unrelatedLeft, unrelatedRight]]) {
        if (!a || !b) throw Error("Missing pair");
        db.prepare(`INSERT INTO memory_duplicate_clusters(cluster_id,index_revision_id,left_memory_id,left_revision_id,right_memory_id,right_revision_id,similarity,state,decision,reason_code,created_at,updated_at,completed_at)
          VALUES (?,?,?,?,?,?,1,'completed','equivalent','same_claim',?,?,?)`).run(a.memoryId, "test-index", a.memoryId, a.revisionId, b.memoryId, b.revisionId,
          "2026-08-07T00:00:00.000Z", "2026-08-07T00:00:00.000Z", "2026-08-07T00:00:00.000Z");
      }
      db.prepare("INSERT INTO governance_obligations(obligation_id,cadence,due_at,state,created_at) VALUES ('manual','monthly',?,'pending',?)")
        .run("2026-08-08T00:00:00.000Z", "2026-08-08T00:00:00.000Z");
    } finally { db.close(); }
    expect(await scheduleDueGovernance({ runtimeRoot, now: "2026-08-08T01:00:00.000Z", workerStartedAt: "2026-08-08T00:00:00.000Z" }))
      .toMatchObject({ state: "scheduled", kind: "monthly" });
    if (changedPartner) {
      const observed = await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId: right.memoryId });
      if (observed === undefined) throw Error("Missing partner");
      await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "agent", expectedContentIdentity: observed.contentIdentity, memory: {
        ...observed.memory, predecessorRevisionId: observed.memory.revisionId,
        revisionId: "msrev_123e4567-e89b-42d3-a456-426614174009", body: "A revised rule."
      } });
    }
    const adapter: GovernanceAdapter = { reviewPage(request) {
      if (changedPartner) {
        expect(request.memories.map(m => m.memoryId)).toEqual([left.memoryId]);
        expect(request.auditSignals?.reviewedDuplicateClusters).toEqual([]);
        return Promise.resolve({ schemaVersion: 1, kind: "governance_page_review", agentActions: [], decisionEvidence: [], reviewSuggestions: [], futurePurgeObligations: [], summaryItems: [] });
      }
      expect(request.memories.map(m => m.memoryId)).toEqual([left.memoryId, right.memoryId]);
      expect(request.auditSignals?.reviewedDuplicateClusters.map(c => c.memoryIds)).toEqual([[left.memoryId, right.memoryId]]);
      return Promise.resolve({ schemaVersion: 1, kind: "governance_page_review", agentActions: [{ kind: "supersede", targetMemoryId: left.memoryId,
        successorMemoryId: right.memoryId, reason: "Reviewed equivalent claim", evidenceRefs: [right.memoryId] }],
        decisionEvidence: [{ targetMemoryId: left.memoryId, kind: "supersede", basis: "reviewed_successor", remainingDurableValue: "preserved_by_successor",
          citations: [{ memoryId: right.memoryId, revisionId: right.revisionId, quote: right.body }] }],
        reviewSuggestions: [], futurePurgeObligations: [], summaryItems: [] });
    } };
    expect(await runNextGovernanceStep({ runtimeRoot, vaultRoot, now: "2026-08-08T01:01:00.000Z", adapter })).toMatchObject({ state: "reviewed" });
    expect(await runNextGovernanceStep({ runtimeRoot, vaultRoot, now: "2026-08-08T01:02:00.000Z", adapter })).toMatchObject({ state: "applied" });
    expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId: left.memoryId }))?.memory)
      .toMatchObject(changedPartner ? { lifecycle: "active" } : { lifecycle: "archived", successorMemoryId: right.memoryId });
  } finally { await rm(root, { recursive: true, force: true }); }
});
