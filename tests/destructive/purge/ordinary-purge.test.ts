import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  previewArchivePurge,
  runArchivePurgeBatch
} from "../../../src/purge/index.js";
import {
  buildRetrievalIndex,
  inspectActiveRetrievalIndex,
  type EmbeddingAdapter
} from "../../../src/retrieval/index.js";
import {
  readCanonicalMemory,
  readCanonicalRevision,
  rebuildCanonicalCatalog,
  writeCanonicalMemory
} from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];
const memoryId = "msmem_123e4567-e89b-42d3-a456-426614174701";
const activeRevisionId = "msrev_123e4567-e89b-42d3-a456-426614174702";
const archivedRevisionId = "msrev_123e4567-e89b-42d3-a456-426614174703";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function treeDigest(root: string): Promise<string> {
  const entries: string[] = [];
  async function visit(path: string): Promise<void> {
    const metadata = await lstat(path);
    const name = relative(root, path);
    if (metadata.isDirectory()) {
      entries.push(`D:${name}`);
      for (const child of (await readdir(path)).sort()) await visit(join(path, child));
      return;
    }
    if (
      path.endsWith("memstore.sqlite-shm") ||
      (path.endsWith("memstore.sqlite-wal") && metadata.size === 0)
    ) return;
    const source = await readFile(path);
    entries.push(`F:${name}:${createHash("sha256").update(source).digest("hex")}`);
  }
  await visit(root);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

const adapter: EmbeddingAdapter = {
  identity: {
    adapterVersion: "purge-fixture-v1",
    modelIdentity: "purge-fixture",
    artifactSha256: "d".repeat(64),
    dimensions: 2,
    normalization: "l2"
  },
  embed: (texts) => Promise.resolve(texts.map(() => [1, 0]))
};

test("an expired Agent archive is previewed without writes then purged to one body-free Tombstone", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-destructive-purge-"));
  roots.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const backupRoot = join(root, "verified-backup");
  const active = makeCanonicalMemory({
    memoryId,
    revisionId: activeRevisionId,
    body: "Use the obsolete deployment switch.",
    authority: "agent_derived"
  });
  const created = await writeCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    actor: "agent",
    memory: active
  });
  await buildRetrievalIndex({
    vaultRoot,
    runtimeRoot,
    adapter,
    builtAt: "2026-08-01T00:00:00.000Z"
  });
  const archived = {
    ...makeCanonicalMemory({
      memoryId,
      revisionId: archivedRevisionId,
      body: "Use the obsolete deployment switch.",
      authority: "agent_derived",
      lifecycle: "archived"
    }),
    predecessorRevisionId: activeRevisionId,
    lifecycleDetails: {
      archivedAt: "2026-01-01T00:00:00.000Z",
      reason: "superseded",
      purgeAfter: "2026-01-02T00:00:00.000Z"
    }
  } as const;
  const archivedWrite = await writeCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    actor: "agent",
    memory: archived,
    expectedContentIdentity: created.contentIdentity
  });
  await cp(vaultRoot, backupRoot, { recursive: true });

  const beforePreview = await treeDigest(root);
  const preview = await previewArchivePurge({
    vaultRoot,
    runtimeRoot,
    backupRoot,
    now: "2026-01-03T00:00:00.000Z"
  });
  expect(await treeDigest(root)).toBe(beforePreview);
  expect(preview).toMatchObject({
    schemaVersion: 1,
    dryRun: true,
    state: "preview",
    eligibleCount: 1,
    items: [{ memoryId, expectedContentIdentity: archivedWrite.contentIdentity }]
  });

  const completed = await runArchivePurgeBatch({
    vaultRoot,
    runtimeRoot,
    backupRoot,
    now: "2026-01-03T00:00:00.000Z"
  });
  const tombstone = await readCanonicalMemory({ vaultRoot, runtimeRoot, memoryId });
  const repeated = await runArchivePurgeBatch({
    vaultRoot,
    runtimeRoot,
    backupRoot,
    now: "2026-01-03T00:01:00.000Z"
  });

  expect(completed).toMatchObject({
    state: "completed",
    purgedMemoryIds: [memoryId],
    skipped: []
  });
  expect(tombstone?.memory).toMatchObject({
    memoryId,
    lifecycle: "tombstone",
    lifecycleDetails: {
      archivedAt: "2026-01-01T00:00:00.000Z",
      tombstonedAt: "2026-01-03T00:00:00.000Z",
      purgedContentIdentity: archivedWrite.contentIdentity,
      purgedRevisionIds: [activeRevisionId, archivedRevisionId]
    },
    body: "",
    category: "tombstone",
    importanceTags: [],
    relationships: [],
    provenance: []
  });
  expect(await readCanonicalRevision({
    vaultRoot,
    runtimeRoot,
    memoryId,
    revisionId: activeRevisionId
  })).toBeUndefined();
  expect(await readCanonicalRevision({
    vaultRoot,
    runtimeRoot,
    memoryId,
    revisionId: archivedRevisionId
  })).toBeUndefined();
  expect(await inspectActiveRetrievalIndex(runtimeRoot)).toBeUndefined();
  expect(repeated).toMatchObject({ state: "completed", purgedMemoryIds: [], skipped: [] });
  await rebuildCanonicalCatalog({ vaultRoot, runtimeRoot });
  expect(await readCanonicalRevision({
    vaultRoot,
    runtimeRoot,
    memoryId,
    revisionId: archivedRevisionId
  })).toBeUndefined();

  const vaultText = (await Promise.all(
    (await readdir(join(vaultRoot, "Memories", "Projects"), { recursive: true }))
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => readFile(join(vaultRoot, "Memories", "Projects", entry), "utf8"))
  )).join("\n");
  expect(vaultText).not.toContain("obsolete deployment switch");
  expect(await readFile(
    join(backupRoot, "Memories", "Projects", active.scope.kind === "project"
      ? active.scope.projectId
      : "", `${memoryId}.md`),
    "utf8"
  )).toContain("obsolete deployment switch");
});
