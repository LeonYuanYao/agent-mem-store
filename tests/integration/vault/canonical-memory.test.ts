import {
  access,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";

import {
  readCanonicalMemory,
  readCanonicalRevision,
  rebuildCanonicalCatalog,
  reconcileCanonicalMemory,
  SecretContentError,
  writeCanonicalMemory as writeCanonicalMemoryCore,
  VaultRevisionConflictError,
  type CanonicalMemory,
  type WriteCanonicalMemoryRequest
} from "../../../src/vault/index.js";

const temporaryDirectories: string[] = [];
const projectId = "msproj_123e4567-e89b-42d3-a456-426614174000";

function writeCanonicalMemory(
  request: Omit<WriteCanonicalMemoryRequest, "actor">
) {
  return writeCanonicalMemoryCore({ ...request, actor: "human" });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

const memory: CanonicalMemory = {
  schemaVersion: 1,
  memoryId: "msmem_123e4567-e89b-42d3-a456-426614174020",
  revisionId: "msrev_123e4567-e89b-42d3-a456-426614174021",
  scope: {
    kind: "project",
    projectId
  },
  authority: "human_authored",
  originKind: "direct_human_assertion",
  sensitivity: "normal",
  lifecycle: "active",
  lifecycleDetails: {},
  primaryCategory: "architecture_contract",
  categoryTags: ["architecture_contract"],
  importanceTags: ["architecture"],
  startup: "auto",
  applicability: {
    summary: "Applies when resolving Project Memory identity.",
    conditions: ["A project boundary is required."]
  },
  validity: { state: "valid", validFrom: "2026-08-07T03:00:00.000Z" },
  createdAt: "2026-08-07T03:00:00.000Z",
  revisedAt: "2026-08-07T03:00:00.000Z",
  semanticContract: {
    schemaVersion: 1,
    claims: ["Project memory is isolated by stable project identity."],
    conditions: ["The project can be resolved safely."],
    exclusions: ["Global memory is not implied."],
    preservedNegations: ["Do not merge unrelated same-name projects."]
  },
  representations: {
    compact: {
      text: "Project memory uses a stable project identity.",
      validated: true,
      generatorIdentity: "human-direct",
      sourceRevisionId: "msrev_123e4567-e89b-42d3-a456-426614174021",
      renderedTokenCount: 8
    },
    standard: {
      text: "Use a stable project identity to isolate Project Memory.",
      validated: true,
      generatorIdentity: "human-direct",
      sourceRevisionId: "msrev_123e4567-e89b-42d3-a456-426614174021",
      renderedTokenCount: 10
    }
  },
  provenance: [],
  injectionReceiptIds: [],
  relationships: [],
  contentIdentity: "a".repeat(64),
  policyVersion: "1",
  body: "# Stable Project identity\n\nProject memory is isolated by stable project identity."
};

test("Canonical Memory is written to its identity-stable Vault path and read back", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-write-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");

  const written = await writeCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memory
  });
  const read = await readCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memoryId: memory.memoryId
  });

  expect(written.contentIdentity).toMatch(/^[0-9a-f]{64}$/u);
  expect(written).toEqual({
    state: "created",
    memoryId: memory.memoryId,
    revisionId: memory.revisionId,
    path: join(
      vaultRoot,
      "Memories",
      "Projects",
      projectId,
      `${memory.memoryId}.md`
    ),
    contentIdentity: written.contentIdentity
  });
  expect(read).toEqual({
    memory: { ...memory, contentIdentity: written.contentIdentity },
    path: written.path,
    contentIdentity: written.contentIdentity
  });
  expect(await readFile(written.path, "utf8")).toContain(
    `content_identity: ${written.contentIdentity}`
  );
  expect(
    await readFile(join(vaultRoot, "_MemStore", "Projects", `${projectId}.md`), "utf8")
  ).toContain(`project_id: ${projectId}`);
});

test("legacy free-form category frontmatter is read through the controlled taxonomy", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-legacy-category-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const legacy = {
    ...memory,
    authority: "agent_derived" as const,
    originKind: "model_extraction" as const
  };
  const written = await writeCanonicalMemoryCore({
    vaultRoot,
    runtimeRoot,
    actor: "agent",
    memory: legacy
  });
  const source = await readFile(written.path, "utf8");
  const legacySource = source
    .replace(/ {2}primary_category: architecture_contract\n/u, "  category: api_limitation\n")
    .replace(/ {2}category_tags:\n {4}- architecture_contract\n/u, "");
  await writeFile(written.path, legacySource);
  await rebuildCanonicalCatalog({ vaultRoot, runtimeRoot });

  await expect(readCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memoryId: memory.memoryId
  })).resolves.toMatchObject({
    memory: {
      primaryCategory: "applicability_limitation",
      categoryTags: ["applicability_limitation", "architecture_contract"]
    }
  });
  expect((await readCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memoryId: memory.memoryId
  }))?.memory).not.toHaveProperty("categoryAliases");
});

test("ordinary writes keep the relationship catalog synchronized", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-relationships-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const firstTarget = "msmem_123e4567-e89b-42d3-a456-426614174036";
  const secondTarget = "msmem_123e4567-e89b-42d3-a456-426614174037";
  const relatedMemory: CanonicalMemory = {
    ...memory,
    relationships: [{ type: "supports", targetMemoryId: firstTarget }]
  };
  const created = await writeCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memory: relatedMemory
  });
  await writeCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    expectedContentIdentity: created.contentIdentity,
    memory: {
      ...relatedMemory,
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174038",
      predecessorRevisionId: relatedMemory.revisionId,
      revisedAt: "2026-08-07T03:00:30.000Z",
      relationships: [{ type: "supersedes", targetMemoryId: secondTarget }]
    }
  });

  const database = new DatabaseSync(join(runtimeRoot, "state", "memstore.sqlite"));
  const rows = database
    .prepare(
      `SELECT target_memory_id, relationship_type
       FROM memory_relationships WHERE source_memory_id = ?`
    )
    .all(memory.memoryId);
  database.close();
  expect(rows).toEqual([
    {
      target_memory_id: secondTarget,
      relationship_type: "supersedes"
    }
  ]);
});

test("the Runtime catalog can be rebuilt from Canonical Vault files", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-rebuild-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const created = await writeCanonicalMemory({ vaultRoot, runtimeRoot, memory });
  const revisionPath = join(
    vaultRoot,
    "_MemStore",
    "Revisions",
    memory.memoryId,
    `${memory.revisionId}.md`
  );
  await unlink(revisionPath);
  const database = new DatabaseSync(join(runtimeRoot, "state", "memstore.sqlite"));
  database.exec("DELETE FROM memory_relationships; DELETE FROM memory_revisions; DELETE FROM memory_catalog");
  database.close();

  const result = await rebuildCanonicalCatalog({ vaultRoot, runtimeRoot });
  const read = await readCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memoryId: memory.memoryId
  });

  expect(result).toEqual({ state: "rebuilt", memoryCount: 1, revisionCount: 1 });
  expect(read?.memory).toEqual({
    ...memory,
    contentIdentity: created.contentIdentity
  });
  expect(await readFile(revisionPath, "utf8")).toContain(memory.body);
});

test("catalog rebuild preserves an unreconciled edit as a Human-authored revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-rebuild-human-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const created = await writeCanonicalMemory({ vaultRoot, runtimeRoot, memory });
  const editedSource = (await readFile(created.path, "utf8")).replace(
    "# Stable Project identity\n\nProject memory is isolated by stable project identity.",
    "# Stable Project identity\n\nHuman edited this before the Runtime catalog was rebuilt."
  );
  await writeFile(created.path, editedSource, "utf8");
  const database = new DatabaseSync(join(runtimeRoot, "state", "memstore.sqlite"));
  database.exec("DELETE FROM memory_relationships; DELETE FROM memory_revisions; DELETE FROM memory_catalog");
  database.close();

  await rebuildCanonicalCatalog({ vaultRoot, runtimeRoot });
  const current = await readCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memoryId: memory.memoryId
  });
  const original = await readCanonicalRevision({
    vaultRoot,
    runtimeRoot,
    memoryId: memory.memoryId,
    revisionId: memory.revisionId
  });

  expect(current?.memory).toMatchObject({
    authority: "human_authored",
    originKind: "manual_edit"
  });
  expect(current?.memory.body).toContain("Human edited");
  expect(current?.memory.revisionId).not.toBe(memory.revisionId);
  expect(original?.memory).toEqual({
    ...memory,
    contentIdentity: created.contentIdentity
  });
});

test("a corrupted Runtime catalog cannot redirect Vault reads or reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-catalog-containment-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  await writeCanonicalMemory({ vaultRoot, runtimeRoot, memory });
  const outsidePath = join(root, "outside.md");
  await writeFile(outsidePath, "do not touch\n", "utf8");
  const database = new DatabaseSync(join(runtimeRoot, "state", "memstore.sqlite"));
  database
    .prepare("UPDATE memory_catalog SET canonical_path = ? WHERE memory_id = ?")
    .run(outsidePath, memory.memoryId);
  database.close();

  await expect(
    readCanonicalMemory({ vaultRoot, runtimeRoot, memoryId: memory.memoryId })
  ).rejects.toThrow("outside");
  await expect(
    reconcileCanonicalMemory({
      vaultRoot,
      runtimeRoot,
      memoryId: memory.memoryId,
      observedAt: "2026-08-07T03:00:01.000Z"
    })
  ).rejects.toThrow("outside");
  expect(await readFile(outsidePath, "utf8")).toBe("do not touch\n");
});

test("a revision archives the prior body and rejects a stale content identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-revision-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const created = await writeCanonicalMemory({ vaultRoot, runtimeRoot, memory });
  const revisedMemory: CanonicalMemory = {
    ...memory,
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174022",
    predecessorRevisionId: memory.revisionId,
    revisedAt: "2026-08-07T03:01:00.000Z",
    body: "# Stable Project identity\n\nProject memory uses the reviewed stable identity."
  };

  const revised = await writeCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memory: revisedMemory,
    expectedContentIdentity: created.contentIdentity
  });
  const prior = await readCanonicalRevision({
    vaultRoot,
    runtimeRoot,
    memoryId: memory.memoryId,
    revisionId: memory.revisionId
  });
  if (prior === undefined) throw new Error("Expected prior Canonical revision.");

  expect(revised).toMatchObject({
    state: "revised",
    path: created.path,
    revisionId: revisedMemory.revisionId
  });
  expect(prior.memory).toEqual({
    ...memory,
    contentIdentity: created.contentIdentity
  });

  const staleAttempt = writeCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memory: {
      ...revisedMemory,
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174023",
      revisedAt: "2026-08-07T03:02:00.000Z",
      body: "stale overwrite"
    },
    expectedContentIdentity: created.contentIdentity
  });
  await expect(staleAttempt).rejects.toBeInstanceOf(VaultRevisionConflictError);
  expect(
    (await readCanonicalMemory({ vaultRoot, runtimeRoot, memoryId: memory.memoryId }))
      ?.memory
  ).toEqual({ ...revisedMemory, contentIdentity: revised.contentIdentity });

  const reorderedHistoricalSource = (await readFile(prior.path, "utf8")).replace(
    "  revised_at: 2026-08-07T03:00:00.000Z\n",
    "  revised_at: 2030-08-07T03:00:00.000Z\n"
  );
  await writeFile(prior.path, reorderedHistoricalSource, "utf8");
  const database = new DatabaseSync(join(runtimeRoot, "state", "memstore.sqlite"));
  database.exec(
    "DELETE FROM memory_relationships; DELETE FROM memory_revisions; DELETE FROM memory_catalog"
  );
  database.close();
  await rebuildCanonicalCatalog({ vaultRoot, runtimeRoot });
  const rebuiltDatabase = new DatabaseSync(
    join(runtimeRoot, "state", "memstore.sqlite")
  );
  const rebuiltRevision = rebuiltDatabase
    .prepare(
      "SELECT predecessor_revision_id FROM memory_revisions WHERE revision_id = ?"
    )
    .get(revisedMemory.revisionId);
  rebuiltDatabase.close();
  expect(rebuiltRevision).toEqual({
    predecessor_revision_id: memory.revisionId
  });
});

test("a revision preserves user-owned top-level frontmatter", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-frontmatter-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const created = await writeCanonicalMemory({ vaultRoot, runtimeRoot, memory });
  const userOwnedFrontmatter =
    "# human formatting must remain byte-for-byte\naliases: [\"human-label\"]\ncssclasses:\n  - wide-page\n";
  const userEditedSource = (await readFile(created.path, "utf8"))
    .replace("---\n", `---\n${userOwnedFrontmatter}`)
    .replace(
      "  semantic_contract:\n",
      "  semantic_contract:\n    future_contract_rule: preserve-me\n"
    )
    .replace(
      "    compact:\n",
      "    compact:\n      future_renderer_hint: preserve-me-too\n"
    );
  await writeFile(created.path, userEditedSource, "utf8");
  await reconcileCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memoryId: memory.memoryId,
    observedAt: "2026-08-07T03:02:30.000Z"
  });
  const observed = await readCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memoryId: memory.memoryId
  });
  if (observed === undefined) {
    throw new Error("Expected Canonical Memory to exist.");
  }

  await writeCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    expectedContentIdentity: observed.contentIdentity,
    memory: {
      ...observed.memory,
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174024",
      predecessorRevisionId: observed.memory.revisionId,
      revisedAt: "2026-08-07T03:03:00.000Z",
      body: "# Stable Project identity\n\nReviewed without removing human properties."
    }
  });

  const rewrittenSource = await readFile(created.path, "utf8");
  expect(rewrittenSource).toContain(
    `---\n${userOwnedFrontmatter}memstore:\n`
  );
  expect(rewrittenSource).toContain("future_contract_rule: preserve-me");
  expect(rewrittenSource).toContain("future_renderer_hint: preserve-me-too");
});

test("unowned frontmatter does not change Canonical content identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-content-identity-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const created = await writeCanonicalMemory({ vaultRoot, runtimeRoot, memory });
  const withAlias = (await readFile(created.path, "utf8")).replace(
    "---\n",
    "---\naliases: [human-only]\n"
  );
  await writeFile(created.path, withAlias, "utf8");

  const observed = await readCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memoryId: memory.memoryId
  });

  expect(observed?.contentIdentity).toBe(created.contentIdentity);
  expect(observed?.memory.contentIdentity).toBe(created.contentIdentity);
});

test("a Tombstone removes unknown owned excerpts but preserves unowned frontmatter", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-tombstone-unknown-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const created = await writeCanonicalMemory({ vaultRoot, runtimeRoot, memory });
  const edited = (await readFile(created.path, "utf8"))
    .replace("---\n", "---\naliases: [human-only]\n")
    .replace(
      "  semantic_contract:\n",
      "  source_excerpt: old bounded source excerpt\n  semantic_contract:\n"
    );
  await writeFile(created.path, edited, "utf8");
  await reconcileCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memoryId: memory.memoryId,
    observedAt: "2026-08-07T03:03:05.000Z"
  });
  const observed = await readCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memoryId: memory.memoryId
  });
  if (observed === undefined) throw new Error("Expected reconciled Memory.");

  await writeCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    expectedContentIdentity: observed.contentIdentity,
    memory: {
      ...observed.memory,
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174033",
      predecessorRevisionId: observed.memory.revisionId,
      lifecycle: "tombstone",
      lifecycleDetails: {
        tombstonedAt: "2026-08-07T03:03:10.000Z",
        reason: "test purge"
      },
      primaryCategory: "tombstone",
      categoryTags: [],
      importanceTags: [],
      startup: "never",
      applicability: { summary: "", conditions: [] },
      validity: { state: "invalid" },
      revisedAt: "2026-08-07T03:03:10.000Z",
      semanticContract: {
        schemaVersion: 1,
        claims: [],
        conditions: [],
        exclusions: [],
        preservedNegations: []
      },
      representations: {
        compact: {
          ...observed.memory.representations.compact,
          text: "",
          validated: false
        },
        standard: {
          ...observed.memory.representations.standard,
          text: "",
          validated: false
        }
      },
      relationships: [],
      body: ""
    }
  });

  const tombstoneSource = await readFile(created.path, "utf8");
  expect(tombstoneSource).toContain("aliases: [human-only]");
  expect(tombstoneSource).not.toContain("source_excerpt");
  expect(tombstoneSource).not.toContain("old bounded source excerpt");
});

test("final rendered Canonical content is sensitivity-screened", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-render-secret-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const created = await writeCanonicalMemory({ vaultRoot, runtimeRoot, memory });
  const secretSource = (await readFile(created.path, "utf8")).replace(
    "---\n",
    "---\nhuman_secret: 'Authorization: Bearer sk-live-0123456789abcdefghijklmnopqrstuvwxyz'\n"
  );
  await writeFile(created.path, secretSource, "utf8");
  const revisionPath = join(
    vaultRoot,
    "_MemStore",
    "Revisions",
    memory.memoryId,
    `${memory.revisionId}.md`
  );
  await unlink(revisionPath);

  await expect(
    writeCanonicalMemory({
      vaultRoot,
      runtimeRoot,
      expectedContentIdentity: created.contentIdentity,
      memory: {
        ...memory,
        revisionId: "msrev_123e4567-e89b-42d3-a456-426614174034",
        predecessorRevisionId: memory.revisionId,
        revisedAt: "2026-08-07T03:03:15.000Z"
      }
    })
  ).rejects.toBeInstanceOf(SecretContentError);
  expect(await readFile(created.path, "utf8")).toBe(secretSource);
  await expect(access(revisionPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("an unreconciled human edit blocks an Agent revision without changing the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-unreconciled-human-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const created = await writeCanonicalMemory({ vaultRoot, runtimeRoot, memory });
  const humanSource = (await readFile(created.path, "utf8")).replace(
    "Project memory is isolated by stable project identity.",
    "Human changed this before Runtime reconciliation."
  );
  await writeFile(created.path, humanSource, "utf8");
  const projectCatalogPath = join(
    vaultRoot,
    "_MemStore",
    "Projects",
    `${projectId}.md`
  );
  await unlink(projectCatalogPath);
  const observed = await readCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memoryId: memory.memoryId
  });
  if (observed === undefined) throw new Error("Expected Canonical Memory.");

  await expect(
    writeCanonicalMemory({
      vaultRoot,
      runtimeRoot,
      expectedContentIdentity: observed.contentIdentity,
      memory: {
        ...memory,
        revisionId: "msrev_123e4567-e89b-42d3-a456-426614174029",
        revisedAt: "2026-08-07T03:03:30.000Z",
        body: "Agent revision must not replace the unreconciled human edit."
      }
    })
  ).rejects.toThrow("reconciliation");
  expect(await readFile(created.path, "utf8")).toBe(humanSource);
  await expect(access(projectCatalogPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("Memory scope cannot change through an ordinary or manual revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-scope-invariant-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const created = await writeCanonicalMemory({ vaultRoot, runtimeRoot, memory });
  const globalPath = join(
    vaultRoot,
    "Memories",
    "Global",
    `${memory.memoryId}.md`
  );

  await expect(
    writeCanonicalMemory({
      vaultRoot,
      runtimeRoot,
      memory: {
        ...memory,
        revisionId: "msrev_123e4567-e89b-42d3-a456-426614174039",
        scope: { kind: "global" }
      }
    })
  ).rejects.toThrow("already owns");
  await expect(access(globalPath)).rejects.toMatchObject({ code: "ENOENT" });

  const scopeEditedSource = (await readFile(created.path, "utf8")).replace(
    `  scope:\n    kind: project\n    project_id: ${projectId}\n`,
    "  scope:\n    kind: global\n"
  );
  await writeFile(created.path, scopeEditedSource, "utf8");
  await expect(
    reconcileCanonicalMemory({
      vaultRoot,
      runtimeRoot,
      memoryId: memory.memoryId,
      observedAt: "2026-08-07T03:03:35.000Z"
    })
  ).rejects.toThrow("scope");
  expect(await readFile(created.path, "utf8")).toBe(scopeEditedSource);
});

test("an Agent operation cannot replace Human-authored Canonical Memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-human-authority-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const created = await writeCanonicalMemory({ vaultRoot, runtimeRoot, memory });

  await expect(
    writeCanonicalMemoryCore({
      vaultRoot,
      runtimeRoot,
      actor: "agent",
      expectedContentIdentity: created.contentIdentity,
      memory: {
        ...memory,
        revisionId: "msrev_123e4567-e89b-42d3-a456-426614174030",
        predecessorRevisionId: memory.revisionId,
        authority: "agent_derived",
        originKind: "model_extraction",
        revisedAt: "2026-08-07T03:03:45.000Z",
        body: "Agent replacement"
      }
    })
  ).rejects.toThrow("Human-authored");
  expect(
    (await readCanonicalMemory({ vaultRoot, runtimeRoot, memoryId: memory.memoryId }))
      ?.memory.body
  ).toBe(memory.body);
});

test("a Secret body is rejected before Canonical or Runtime persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-secret-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const secretMemory: CanonicalMemory = {
    ...memory,
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174025",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174026",
    body: "Authorization: Bearer sk-live-0123456789abcdefghijklmnopqrstuvwxyz"
  };
  const path = join(
    vaultRoot,
    "Memories",
    "Projects",
    secretMemory.scope.kind === "project" ? secretMemory.scope.projectId : "invalid",
    `${secretMemory.memoryId}.md`
  );

  await expect(
    writeCanonicalMemory({ vaultRoot, runtimeRoot, memory: secretMemory })
  ).rejects.toBeInstanceOf(SecretContentError);
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

test("invalid Canonical identities are rejected before path construction", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-invalid-id-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const invalidMemory: CanonicalMemory = {
    ...memory,
    memoryId: "../../outside",
    revisionId: "not-a-revision",
    scope: { kind: "project", projectId: "../Global" }
  };

  await expect(
    writeCanonicalMemory({ vaultRoot, runtimeRoot, memory: invalidMemory })
  ).rejects.toThrow();
  await expect(access(vaultRoot)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a tombstone is representable only without memory-bearing text", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-tombstone-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const invalidTombstone: CanonicalMemory = { ...memory, lifecycle: "tombstone" };
  await expect(
    writeCanonicalMemory({ vaultRoot, runtimeRoot, memory: invalidTombstone })
  ).rejects.toThrow("Tombstone");

  const tombstone: CanonicalMemory = {
    ...memory,
    lifecycle: "tombstone",
    lifecycleDetails: {
      tombstonedAt: "2026-08-07T03:05:00.000Z",
      reason: "test purge"
    },
    primaryCategory: "tombstone",
    categoryTags: [],
    importanceTags: [],
    startup: "never",
    applicability: { summary: "", conditions: [] },
    validity: { state: "invalid" },
    body: "",
    semanticContract: {
      schemaVersion: 1,
      claims: [],
      conditions: [],
      exclusions: [],
      preservedNegations: []
    },
    representations: {
      compact: { ...memory.representations.compact, text: "", validated: false },
      standard: { ...memory.representations.standard, text: "", validated: false }
    }
  };
  const written = await writeCanonicalMemory({ vaultRoot, runtimeRoot, memory: tombstone });
  const read = await readCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memoryId: tombstone.memoryId
  });

  expect(written.state).toBe("created");
  expect(read?.memory).toEqual({
    ...tombstone,
    contentIdentity: written.contentIdentity
  });

  await expect(
    writeCanonicalMemory({
      vaultRoot,
      runtimeRoot,
      memory: {
        ...tombstone,
        memoryId: "msmem_123e4567-e89b-42d3-a456-426614174031",
        revisionId: "msrev_123e4567-e89b-42d3-a456-426614174032",
        applicability: { summary: "Still applies to a hidden fact.", conditions: [] }
      }
    })
  ).rejects.toThrow("knowledge-free");

  await expect(
    writeCanonicalMemory({
      vaultRoot,
      runtimeRoot,
      memory: {
        ...tombstone,
        memoryId: "msmem_123e4567-e89b-42d3-a456-426614174041",
        revisionId: "msrev_123e4567-e89b-42d3-a456-426614174042",
        representations: {
          identity: {
            label: "Hidden knowledge label",
            validated: true,
            generatorIdentity: "fixture",
            sourceRevisionId: "msrev_123e4567-e89b-42d3-a456-426614174042",
            renderedTokenCount: 3
          },
          ...tombstone.representations
        }
      }
    })
  ).rejects.toThrow("knowledge-free");
});

test("a direct Obsidian body edit becomes a Human-authored revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-reconcile-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const memoryWithIdentity: CanonicalMemory = {
    ...memory,
    representations: {
      identity: {
        label: "Stable Project identity",
        validated: true,
        generatorIdentity: "fixture",
        sourceRevisionId: memory.revisionId,
        renderedTokenCount: 3
      },
      ...memory.representations
    }
  };
  const created = await writeCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memory: memoryWithIdentity
  });
  const originalSource = await readFile(created.path, "utf8");
  const bodyBoundary = originalSource.indexOf("\n---\n", 4);
  const editedSource =
    originalSource.slice(0, bodyBoundary + 5) +
    originalSource
      .slice(bodyBoundary + 5)
      .replace(
        "Project memory is isolated by stable project identity.",
        "Human clarified that Project memory follows the reviewed stable identity."
      );
  await writeFile(created.path, editedSource, "utf8");

  const reconciled = await reconcileCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memoryId: memory.memoryId,
    observedAt: "2026-08-07T03:04:00.000Z"
  });
  const current = await readCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memoryId: memory.memoryId
  });
  const original = await readCanonicalRevision({
    vaultRoot,
    runtimeRoot,
    memoryId: memory.memoryId,
    revisionId: memory.revisionId
  });

  expect(reconciled.state).toBe("manual_revision");
  if (reconciled.state === "manual_revision") {
    expect(reconciled.revisionId).toMatch(/^msrev_/u);
  }
  expect(reconciled).toMatchObject({
    state: "manual_revision",
    memoryId: memory.memoryId,
    previousRevisionId: memory.revisionId
  });
  expect(current?.memory).toMatchObject({
    authority: "human_authored",
    originKind: "manual_edit",
    revisedAt: "2026-08-07T03:04:00.000Z",
    predecessorRevisionId: memory.revisionId,
    representations: {
      identity: { validated: false },
      compact: { validated: false },
      standard: { validated: false }
    }
  });
  expect(current?.memory.body).toContain("Human clarified");
  expect(original?.memory).toEqual({
    ...memoryWithIdentity,
    contentIdentity: created.contentIdentity
  });
});

test("manual metadata reconciliation refreshes Runtime lifecycle and relationships", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-metadata-reconcile-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const created = await writeCanonicalMemory({ vaultRoot, runtimeRoot, memory });
  const targetMemoryId = "msmem_123e4567-e89b-42d3-a456-426614174035";
  const editedSource = (await readFile(created.path, "utf8"))
    .replace("  lifecycle: active\n", "  lifecycle: archived\n")
    .replace(
      "  lifecycle_details: {}\n",
      "  lifecycle_details:\n    archived_at: 2026-08-07T03:05:00.000Z\n    reason: manual archive\n"
    )
    .replace(
      "  relationships: []\n",
      `  relationships:\n    - type: clarifies\n      target_memory_id: ${targetMemoryId}\n`
    );
  await writeFile(created.path, editedSource, "utf8");

  await reconcileCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memoryId: memory.memoryId,
    observedAt: "2026-08-07T03:05:01.000Z"
  });

  const database = new DatabaseSync(join(runtimeRoot, "state", "memstore.sqlite"));
  const catalog = database
    .prepare("SELECT lifecycle, authority FROM memory_catalog WHERE memory_id = ?")
    .get(memory.memoryId);
  const relationships = database
    .prepare(
      `SELECT target_memory_id, relationship_type, source_revision_id
       FROM memory_relationships WHERE source_memory_id = ?`
    )
    .all(memory.memoryId);
  database.close();

  expect(catalog).toEqual({
    lifecycle: "archived",
    authority: "human_authored"
  });
  expect(relationships).toHaveLength(1);
  const relationship = relationships[0];
  expect(relationship).toMatchObject({
    target_memory_id: targetMemoryId,
    relationship_type: "clarifies"
  });
  if (typeof relationship?.source_revision_id !== "string") {
    throw new Error("Expected relationship revision identity.");
  }
  expect(relationship.source_revision_id).toMatch(/^msrev_/u);
});
