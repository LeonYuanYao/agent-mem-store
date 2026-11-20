import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { applyMemoryScopeChange, previewMemoryScopeChange } from "../../../src/operations/memory-scope.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { readCanonicalMemory, writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("rescope moves a Memory to another scope through a successor and archives the original", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-rescope-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memoryId = "msmem_123e4567-e89b-42d3-a456-426614179301";
  await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "agent", memory: makeCanonicalMemory({
    memoryId, revisionId: "msrev_123e4567-e89b-42d3-a456-426614179302", authority: "agent_derived", startup: "always",
    body: "Never print files that may hold private keys; print parsed fields or fingerprints only."
  }) });
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare(`INSERT INTO dream_memories(memory_id, statement_key, scope_kind, project_id, created_run_id, updated_run_id, created_at, updated_at)
      VALUES (?, 'neverprint', 'project', 'msproj_x', 'run', 'run', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z')`).run(memoryId);
  } finally {
    database.close();
  }
  const request = { runtimeRoot, vaultRoot, memory: "M:1", scope: { kind: "global" } as const, changedAt: "2026-11-20T10:00:00.000Z" };

  await expect(previewMemoryScopeChange(request)).resolves.toMatchObject({
    dryRun: true, state: "preview", memoryRef: "M:1", from: { kind: "project" }, to: { kind: "global" } });
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId }))?.memory.lifecycle).toBe("active");

  const moved = await applyMemoryScopeChange(request);
  expect(moved).toMatchObject({ dryRun: false, state: "rescoped", memoryRef: "M:1", successor: { memoryRef: "M:2" } });
  const successorId = moved.successor?.memoryId ?? "";
  const successor = (await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId: successorId }))?.memory;
  expect(successor).toMatchObject({
    scope: { kind: "global" }, authority: "agent_derived", lifecycle: "active", startup: "always",
    body: "Never print files that may hold private keys; print parsed fields or fingerprints only.", predecessorMemoryId: memoryId
  });
  expect(successor?.provenance).toContain(`scope:moved-from:${memoryId}`);
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId }))?.memory).toMatchObject({
    lifecycle: "archived", successorMemoryId: successorId, lifecycleDetails: { reason: "rescoped:user_request" } });
  // Dreaming keeps recognising the statement, now as the global Memory.
  const after = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(after.prepare("SELECT memory_id, scope_kind, project_id FROM dream_memories").all())
      .toEqual([{ memory_id: successorId, scope_kind: "global", project_id: null }]);
  } finally {
    after.close();
  }

  await expect(applyMemoryScopeChange(request)).rejects.toThrow("Only an active Memory can change scope");
  await expect(applyMemoryScopeChange({ ...request, memory: "M:2" })).resolves.toMatchObject({ state: "unchanged" });
});

test("a Human-authored Memory stays Human-authored in its new scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-rescope-human-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "human", memory: makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614179311", revisionId: "msrev_123e4567-e89b-42d3-a456-426614179312",
    body: "Reply in Chinese."
  }) });
  const moved = await applyMemoryScopeChange({ runtimeRoot, vaultRoot, memory: "M:1", scope: { kind: "global" }, changedAt: "2026-11-20T10:00:00.000Z" });
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId: moved.successor?.memoryId ?? "" }))?.memory)
    .toMatchObject({ authority: "human_authored", originKind: "direct_human_assertion", scope: { kind: "global" }, body: "Reply in Chinese." });
});
