import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { initializeMemStore } from "../../../src/operations/initialize.js";
import { inspectStatus } from "../../../src/operations/status.js";
import { runWorkerOnce } from "../../../src/worker/main.js";
import {
  readCanonicalMemory,
  writeCanonicalMemory
} from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("the Worker materializes missing deadlines and purges due archives through managed staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-archive-retention-worker-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const memory = {
    ...makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174901",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614175901",
      body: "An expired archived body that should be removed automatically.",
      authority: "agent_derived",
      lifecycle: "archived"
    }),
    createdAt: "2026-01-01T00:00:00.000Z",
    revisedAt: "2026-01-15T00:00:00.000Z",
    lifecycleDetails: {
      archivedAt: "2026-01-15T00:00:00.000Z",
      reason: "superseded"
    }
  } as const;
  await writeCanonicalMemory({ runtimeRoot, vaultRoot, actor: "agent", memory });

  const result = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "archive-retention-test-worker",
    now: "2026-04-15T00:00:00.000Z",
    workerStartedAt: "2026-04-14T23:00:00.000Z"
  });

  expect(result.activities).toContain("archive-retention:deadlines:1");
  expect(result.activities).toContain("archive-purge:purged:1");
  const purged = await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId: memory.memoryId });
  expect(purged?.memory).toMatchObject({
    lifecycle: "tombstone",
    body: "",
    lifecycleDetails: {
      archivedAt: "2026-01-15T00:00:00.000Z",
      tombstonedAt: "2026-04-15T00:00:00.000Z"
    }
  });
  const source = await readFile(purged?.path ?? "", "utf8");
  expect(source).not.toContain("An expired archived body");
  await expect(inspectStatus({ runtimeRoot, vaultRoot })).resolves.toMatchObject({
    archive_retention: {
      archive_months: 3,
      archived_count: 0,
      tombstone_count: 1,
      consecutive_failure_count: 0,
      latest_purge: { state: "completed", purged_count: 1 }
    }
  });
});

test("the Worker checks archive retention at most once per six-hour interval", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-archive-retention-schedule-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });

  const first = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "archive-retention-test-worker",
    now: "2026-08-31T00:00:00.000Z",
    workerStartedAt: "2026-08-30T23:00:00.000Z"
  });
  const second = await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "archive-retention-test-worker",
    now: "2026-08-31T05:59:59.000Z",
    workerStartedAt: "2026-08-30T23:00:00.000Z"
  });

  expect(first.state).toBe("idle");
  expect(second.state).toBe("idle");
  const status = await inspectStatus({ runtimeRoot, vaultRoot });
  expect(status.archive_retention?.next_check_at).toBe("2026-08-31T06:00:00Z");
});
