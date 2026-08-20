import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import { LunaInvocationError } from "../../src/luna/index.js";
import { initializeMemStore } from "../../src/operations/initialize.js";
import {
  enqueueCompactBackfill,
  runNextMemoryQualityStep,
  type MemoryQualityAdapter
} from "../../src/quality/pipeline.js";
import { writeCanonicalMemory } from "../../src/vault/index.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";
import { makeCanonicalMemory } from "../helpers/canonical-memory.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function cli(arguments_: readonly string[]): Promise<Record<string, unknown>> {
  const result = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "src/cli/main.ts", ...arguments_],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test("doctor and Vault validation expose stable read-only JSON envelopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cli-operations-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const common = ["--runtime", runtimeRoot, "--vault", vaultRoot, "--json"];

  await expect(cli(["doctor", "--deep", ...common])).resolves.toMatchObject({
    schema_version: 1,
    ok: true,
    command: "doctor",
    result: { state: "healthy", repaired: false }
  });
  await expect(cli(["vault", "validate", ...common])).resolves.toMatchObject({
    schema_version: 1,
    ok: true,
    command: "vault.validate",
    result: { state: "valid", memoryCount: 0 }
  });
}, 15_000);

test("mutation previews do not create Review Inbox or backup files", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cli-preview-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const backupPath = join(root, "backup", "runtime.sqlite");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const common = ["--runtime", runtimeRoot, "--vault", vaultRoot, "--preview", "--json"];

  await expect(cli(["review", "generate", ...common])).resolves.toMatchObject({
    result: { state: "preview", dry_run: true, would_change: ["review_inbox"] }
  });
  await expect(cli(["runtime", "backup", "--output", backupPath, ...common])).resolves.toMatchObject({
    result: { state: "preview", dry_run: true, destination_path: backupPath }
  });
  await expect(access(join(vaultRoot, "_MemStore", "Review Inbox.md"))).rejects.toMatchObject({
    code: "ENOENT"
  });
  await expect(access(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
}, 15_000);

test("Shadow status is reachable through the public CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cli-shadow-status-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });

  await expect(cli([
    "shadow",
    "status",
    "--runtime",
    runtimeRoot,
    "--vault",
    vaultRoot,
    "--json"
  ])).resolves.toMatchObject({
    schema_version: 1,
    ok: true,
    command: "shadow.status"
  });
});

test("quality pipeline preview and status are reachable through the public CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cli-quality-status-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const common = ["--runtime", runtimeRoot, "--vault", vaultRoot, "--json"];

  await expect(cli(["quality", "compact-backfill", "--preview", ...common])).resolves.toMatchObject({
    command: "quality.compact-backfill",
    result: { state: "preview", eligibleCount: 0, enqueuedCount: 0 }
  });
  await expect(cli(["quality", "status", ...common])).resolves.toMatchObject({
    command: "quality.status",
    result: { totalCount: 0, pendingCount: 0 }
  });
  await expect(cli(["quality", "duplicate-status", ...common])).resolves.toMatchObject({
    command: "quality.duplicate-status",
    result: { totalCount: 0, pendingCount: 0 }
  });
}, 15_000);

test("quality retry previews and reopens only repairable terminal work in a new epoch", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cli-quality-retry-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const blockedMemory = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174091",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174091",
    authority: "agent_derived",
    body: "Use short aliases for model-facing Memory identities.",
    validatedCompact: false
  });
  await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "agent", memory: blockedMemory });
  await enqueueCompactBackfill({
    runtimeRoot,
    vaultRoot,
    requestedAt: "2026-08-20T11:00:00.000Z",
    preview: false
  });
  const blockedAdapter: MemoryQualityAdapter = {
    generateCompacts: () => Promise.reject(new LunaInvocationError(
      "schema_invalid",
      false,
      "The model-facing Memory identity was invalid.",
      { stage: "evidence_binding", code: "memory_identity_mismatch" }
    )),
    validateCompacts: () => Promise.reject(new Error("Validation is not expected."))
  };
  await runNextMemoryQualityStep({
    runtimeRoot,
    vaultRoot,
    workerId: "quality-worker",
    now: "2026-08-20T11:00:01.000Z",
    adapter: blockedAdapter
  });

  const rejectedMemory = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174092",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174092",
    authority: "agent_derived",
    body: "A compact must remain inside its rendered token budget.",
    validatedCompact: false
  });
  await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "agent", memory: rejectedMemory });
  await enqueueCompactBackfill({
    runtimeRoot,
    vaultRoot,
    requestedAt: "2026-08-20T11:01:00.000Z",
    preview: false
  });
  const rejectedAdapter: MemoryQualityAdapter = {
    generateCompacts: (request) => Promise.resolve({
      schemaVersion: 1,
      kind: "compact_generation",
      items: request.memories.map((memory) => ({
        memoryId: memory.memoryId,
        compactText: "A concise equivalent compact."
      }))
    }),
    validateCompacts: () => Promise.reject(new Error("Validation is not expected."))
  };
  await runNextMemoryQualityStep({
    runtimeRoot,
    vaultRoot,
    workerId: "quality-worker",
    now: "2026-08-20T11:01:01.000Z",
    adapter: rejectedAdapter
  });
  const legacyDatabase = await openRuntimeDatabase(runtimeRoot);
  try {
    legacyDatabase.prepare(
      `UPDATE memory_quality_items SET state = 'rejected',
         validation_reason_code = 'local_gate_failed', completed_at = updated_at
       WHERE memory_id = ?`
    ).run(rejectedMemory.memoryId);
  } finally {
    legacyDatabase.close();
  }
  const common = ["--runtime", runtimeRoot, "--vault", vaultRoot, "--json"];

  await expect(cli(["quality", "retry", "--preview", ...common])).resolves.toMatchObject({
    command: "quality.retry",
    result: {
      state: "preview",
      dryRun: true,
      eligibleCount: 2,
      eligibleCounts: { blockedSchemaInvalid: 1, localGateRejected: 1 },
      restartCounts: { generation: 1, validation: 1 },
      changedCount: 0
    }
  });
  await expect(cli(["quality", "retry", ...common])).resolves.toMatchObject({
    command: "quality.retry",
    result: { state: "retried", dryRun: false, eligibleCount: 2, changedCount: 2 }
  });
  await expect(cli(["quality", "status", ...common])).resolves.toMatchObject({
    result: {
      pendingCount: 2,
      pendingGenerationCount: 1,
      pendingValidationCount: 1,
      blockedCount: 0,
      rejectedCount: 0
    }
  });
}, 15_000);
