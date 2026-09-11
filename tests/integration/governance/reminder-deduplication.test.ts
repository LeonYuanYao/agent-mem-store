import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { initializeGovernanceSchedule, scheduleDueGovernance } from "../../../src/governance/scheduling.js";
import { runNextGovernanceStep, type GovernanceAdapter } from "../../../src/governance/worker.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

test("monthly scans do not repeat a human reminder for unchanged revision evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-governance-reminder-"));
  const location = { runtimeRoot: join(root, "runtime"), vaultRoot: join(root, "vault") };
  try {
    const human = makeCanonicalMemory({ memoryId: `msmem_${randomUUID()}`, revisionId: `msrev_${randomUUID()}`, body: "Use endpoint A.", authority: "human_authored" });
    const change = makeCanonicalMemory({ memoryId: `msmem_${randomUUID()}`, revisionId: `msrev_${randomUUID()}`, body: "Endpoint A was retired; endpoint B replaces it.", authority: "agent_derived" });
    for (const memory of [human, change]) await writeCanonicalMemory({ ...location, memory, actor: memory.authority === "human_authored" ? "human" : "agent" });
    await initializeGovernanceSchedule({ runtimeRoot: location.runtimeRoot, timeZone: "UTC", registeredAt: "2026-08-04T00:00:00.000Z" });
    let wording = 0;
    const adapter: GovernanceAdapter = { reviewPage: () => Promise.resolve({
      schemaVersion: 1, kind: "governance_page_review", agentActions: [], futurePurgeObligations: [], summaryItems: [],
      reviewSuggestions: [{ targetMemoryId: human.memoryId, kind: "outdated", reason: `Confirm changed endpoint, wording ${String(++wording)}.`, evidenceRefs: [change.memoryId] }],
      decisionEvidence: [{ targetMemoryId: human.memoryId, kind: "review_suggestion", basis: "concrete_change", remainingDurableValue: "still_present", citations: [{ memoryId: change.memoryId, revisionId: change.revisionId, quote: change.body }] }]
    }) };
    for (const now of ["2026-08-10T19:01:00.000Z", "2026-09-07T19:01:00.000Z"]) {
      const result = await scheduleDueGovernance({ runtimeRoot: location.runtimeRoot, now, workerStartedAt: "2026-08-10T18:00:00.000Z" });
      expect(result.state).toBe("scheduled");
      let completed = false;
      for (let n = 0; n < 12; n += 1) {
        const step = await runNextGovernanceStep({ ...location, now, adapter });
        if (step.state === "completed") { completed = true; break; }
      }
      expect(completed).toBe(true);
    }
    const database = await openRuntimeDatabase(location.runtimeRoot);
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM governance_review_suggestions").get()?.count).toBe(1);
    } finally { database.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
