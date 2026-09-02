import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  applyMemoryLifecycleChange,
  previewMemoryLifecycleChange
} from "../../../src/operations/memory-lifecycle.js";
import { readCanonicalMemory, writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("archive previews without writes, applies a retained revision, and restore starts a clean active cycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-lifecycle-entry-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memoryId = "msmem_123e4567-e89b-42d3-a456-426614179001";
  const created = await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId,
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614179002",
      body: "Use the internal review platform for this repository."
    })
  });

  const preview = await previewMemoryLifecycleChange({
    runtimeRoot,
    vaultRoot,
    memory: "M:1",
    action: "archive",
    changedAt: "2026-09-02T10:00:00.000Z",
    reason: "user_request"
  });
  expect(preview).toMatchObject({
    schemaVersion: 1,
    dryRun: true,
    state: "preview",
    action: "archive",
    memoryId,
    memoryRef: "M:1",
    from: "active",
    to: "archived",
    purgeAfter: "2026-12-02T10:00:00.000Z"
  });
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId }))?.contentIdentity)
    .toBe(created.contentIdentity);

  const archived = await applyMemoryLifecycleChange({
    runtimeRoot,
    vaultRoot,
    memory: "M:1",
    action: "archive",
    changedAt: "2026-09-02T10:00:00.000Z",
    reason: "user_request"
  });
  expect(archived).toMatchObject({
    state: "archived",
    action: "archive",
    memoryId,
    memoryRef: "M:1",
    purgeAfter: "2026-12-02T10:00:00.000Z"
  });
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId }))?.memory)
    .toMatchObject({
      authority: "human_authored",
      lifecycle: "archived",
      lifecycleDetails: {
        archivedAt: "2026-09-02T10:00:00.000Z",
        reason: "manual:user_request",
        purgeAfter: "2026-12-02T10:00:00.000Z"
      },
      body: "Use the internal review platform for this repository."
    });
  const archivedIdentity = (await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId }))
    ?.contentIdentity;
  await expect(applyMemoryLifecycleChange({
    runtimeRoot,
    vaultRoot,
    memory: "M:1",
    action: "archive",
    changedAt: "2026-09-02T11:00:00.000Z",
    reason: "duplicate_retry"
  })).resolves.toMatchObject({ state: "already_archived" });
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId }))?.contentIdentity)
    .toBe(archivedIdentity);

  const restorePreview = await previewMemoryLifecycleChange({
    runtimeRoot,
    vaultRoot,
    memory: memoryId,
    action: "restore",
    changedAt: "2026-09-03T10:00:00.000Z"
  });
  expect(restorePreview).toMatchObject({
    state: "preview",
    action: "restore",
    from: "archived",
    to: "active"
  });

  const restored = await applyMemoryLifecycleChange({
    runtimeRoot,
    vaultRoot,
    memory: memoryId,
    action: "restore",
    changedAt: "2026-09-03T10:00:00.000Z"
  });
  expect(restored).toMatchObject({ state: "restored", memoryRef: "M:1" });
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId }))?.memory)
    .toMatchObject({
      authority: "human_authored",
      lifecycle: "active",
      lifecycleDetails: {},
      body: "Use the internal review platform for this repository."
    });
  const restoredIdentity = (await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId }))
    ?.contentIdentity;
  await expect(applyMemoryLifecycleChange({
    runtimeRoot,
    vaultRoot,
    memory: "M:1",
    action: "restore",
    changedAt: "2026-09-03T11:00:00.000Z"
  })).resolves.toMatchObject({ state: "already_active" });
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId }))?.contentIdentity)
    .toBe(restoredIdentity);
});

test("restore refuses a body-free tombstone", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-lifecycle-tombstone-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memoryId = "msmem_123e4567-e89b-42d3-a456-426614179011";
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: {
      ...makeCanonicalMemory({
        memoryId,
        revisionId: "msrev_123e4567-e89b-42d3-a456-426614179012",
        body: ""
      }),
      lifecycle: "tombstone",
      lifecycleDetails: {
        archivedAt: "2026-01-01T00:00:00.000Z",
        tombstonedAt: "2026-04-01T00:00:00.000Z",
        reason: "archive_retention_elapsed",
        purgedContentIdentity: "b".repeat(64),
        purgedRevisionIds: []
      },
      primaryCategory: "tombstone",
      categoryTags: [],
      importanceTags: [],
      startup: "never",
      applicability: { summary: "", conditions: [] },
      validity: { state: "invalid" },
      semanticContract: {
        schemaVersion: 1,
        claims: [],
        conditions: [],
        exclusions: [],
        preservedNegations: []
      },
      representations: {
        compact: {
          text: "",
          validated: false,
          generatorIdentity: "purge-v1",
          sourceRevisionId: "msrev_123e4567-e89b-42d3-a456-426614179012",
          renderedTokenCount: 0
        },
        standard: {
          text: "",
          validated: false,
          generatorIdentity: "purge-v1",
          sourceRevisionId: "msrev_123e4567-e89b-42d3-a456-426614179012",
          renderedTokenCount: 0
        }
      },
      provenance: [],
      relationships: []
    }
  });

  await expect(previewMemoryLifecycleChange({
    runtimeRoot,
    vaultRoot,
    memory: "M:1",
    action: "restore",
    changedAt: "2026-09-03T10:00:00.000Z"
  })).rejects.toThrow("cannot be restored");
});
