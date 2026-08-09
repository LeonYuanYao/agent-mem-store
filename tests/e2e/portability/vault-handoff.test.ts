import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { captureEvent } from "../../../src/capture/index.js";
import {
  createRuntimeBackup,
  inspectMigrationReadiness,
  pauseForMigration,
  rebuildDestination,
  validatePortableVault,
  verifyDestinationRetrieval
} from "../../../src/operations/portability.js";
import type { EmbeddingAdapter } from "../../../src/retrieval/index.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const adapter: EmbeddingAdapter = {
  identity: {
    adapterVersion: "portability-fixture-v1",
    modelIdentity: "portability-fixture",
    artifactSha256: "c".repeat(64),
    dimensions: 3,
    normalization: "l2"
  },
  embed: (texts) => Promise.resolve(texts.map(() => [1, 0, 0]))
};

test("Vault handoff blocks unfinished work, then rebuilds knowledge without Runtime state", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-handoff-"));
  roots.push(root);
  const sourceRuntimeRoot = join(root, "source-runtime");
  const destinationRuntimeRoot = join(root, "destination-runtime");
  const vaultRoot = join(root, "portable-vault");
  const memory = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174701",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174711",
    body: "Use SQLite WAL for portable Canonical validation.",
    compact: "Use SQLite WAL for Canonical validation."
  });
  await writeCanonicalMemory({ vaultRoot, runtimeRoot: sourceRuntimeRoot, actor: "human", memory });
  await captureEvent({
    runtimeRoot: sourceRuntimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent-portability-pending",
      deduplicationKey: "portability:pending",
      agent: "codex",
      eventKind: "UserPromptSubmit",
      occurredAt: "2026-08-08T04:00:00.000Z",
      payload: { text: "Unfinished capture blocks migration readiness." }
    }
  });
  await expect(inspectMigrationReadiness({ runtimeRoot: sourceRuntimeRoot })).resolves.toMatchObject({
    state: "blocked",
    pending: { capture: 1 }
  });
  await expect(pauseForMigration({
    runtimeRoot: sourceRuntimeRoot,
    pausedAt: "2026-08-08T04:01:00.000Z"
  })).rejects.toThrow("unfinished work");

  const database = await openRuntimeDatabase(sourceRuntimeRoot);
  try {
    database.prepare("UPDATE capture_events SET state = 'completed'").run();
  } finally {
    database.close();
  }
  await expect(pauseForMigration({
    runtimeRoot: sourceRuntimeRoot,
    pausedAt: "2026-08-08T04:02:00.000Z"
  })).resolves.toMatchObject({ state: "paused" });
  await expect(createRuntimeBackup({
    runtimeRoot: sourceRuntimeRoot,
    destinationPath: join(root, "backups", "source.sqlite"),
    createdAt: "2026-08-08T04:03:00.000Z"
  })).resolves.toMatchObject({ state: "complete" });
  await expect(validatePortableVault({
    runtimeRoot: sourceRuntimeRoot,
    vaultRoot
  })).resolves.toEqual({
    state: "valid",
    memoryCount: 1,
    revisionCount: 1,
    brokenRelationshipTargets: []
  });

  const rebuilt = await rebuildDestination({
    vaultRoot,
    destinationRuntimeRoot,
    adapter,
    rebuiltAt: "2026-08-08T04:04:00.000Z"
  });
  expect(rebuilt).toMatchObject({
    state: "rebuilt",
    memoryCount: 1,
    sourceRuntimeStateImported: false
  });
  await expect(verifyDestinationRetrieval({
    runtimeRoot: destinationRuntimeRoot,
    vaultRoot,
    adapter,
    query: "SQLite WAL",
    verifiedAt: "2026-08-08T04:05:00.000Z"
  })).resolves.toMatchObject({ state: "verified", matchedMemoryIds: [memory.memoryId] });
});
