import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  applySingleMemoryPurge,
  previewSingleMemoryPurge
} from "../../../src/purge/index.js";
import { readCanonicalMemory, writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("single-memory purge is preview-bound, backup-verified, and idempotently tombstones one archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-single-purge-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const backupRoot = join(root, "verified-backup");
  const memoryId = "msmem_123e4567-e89b-42d3-a456-426614179101";
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory: makeCanonicalMemory({
      memoryId,
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614179102",
      body: "Temporary obsolete build status.",
      authority: "agent_derived",
      lifecycle: "archived"
    })
  });
  await cp(vaultRoot, backupRoot, { recursive: true });

  const preview = await previewSingleMemoryPurge({
    runtimeRoot,
    vaultRoot,
    backupRoot,
    memory: "M:1",
    purgedAt: "2026-09-02T12:00:00.000Z"
  });
  expect(preview).toMatchObject({
    schemaVersion: 1,
    dryRun: true,
    state: "preview",
    memoryId,
    memoryRef: "M:1"
  });
  expect(preview.approvalDigest).toMatch(/^[0-9a-f]{64}$/u);
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId }))?.memory.lifecycle)
    .toBe("archived");

  await expect(applySingleMemoryPurge({
    runtimeRoot,
    vaultRoot,
    backupRoot,
    memory: "M:1",
    purgedAt: "2026-09-02T12:00:00.000Z",
    approvalDigest: "0".repeat(64)
  })).rejects.toThrow("approval digest");

  const applied = await applySingleMemoryPurge({
    runtimeRoot,
    vaultRoot,
    backupRoot,
    memory: "M:1",
    purgedAt: "2026-09-02T12:00:00.000Z",
    approvalDigest: preview.approvalDigest
  });
  expect(applied).toMatchObject({
    state: "purged",
    memoryId,
    memoryRef: "M:1"
  });
  expect((await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId }))?.memory)
    .toMatchObject({
      lifecycle: "tombstone",
      lifecycleDetails: { reason: "explicit_user_purge" },
      body: ""
    });

  await expect(applySingleMemoryPurge({
    runtimeRoot,
    vaultRoot,
    backupRoot,
    memory: "M:1",
    purgedAt: "2026-09-02T12:00:00.000Z",
    approvalDigest: preview.approvalDigest
  })).resolves.toMatchObject({ state: "purged", memoryId });
});

test("single-memory purge refuses a protected archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-single-purge-protected-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const backupRoot = join(root, "verified-backup");
  const memoryId = "msmem_123e4567-e89b-42d3-a456-426614179111";
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: {
      ...makeCanonicalMemory({
        memoryId,
        revisionId: "msrev_123e4567-e89b-42d3-a456-426614179112",
        body: "Retain this archived rule.",
        lifecycle: "archived"
      }),
      lifecycleDetails: {
        archivedAt: "2026-08-01T00:00:00.000Z",
        reason: "user_request",
        retainForever: true
      }
    }
  });
  await cp(vaultRoot, backupRoot, { recursive: true });

  await expect(previewSingleMemoryPurge({
    runtimeRoot,
    vaultRoot,
    backupRoot,
    memory: "M:1",
    purgedAt: "2026-09-02T12:00:00.000Z"
  })).rejects.toThrow("retain_forever");
});
