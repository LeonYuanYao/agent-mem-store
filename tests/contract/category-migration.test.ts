import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import { migrateMemoryCategories } from "../../src/operations/category-migration.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";
import {
  readCanonicalMemory,
  inspectStandaloneCanonicalFile,
  writeCanonicalMemory
} from "../../src/vault/index.js";
import { makeCanonicalMemory } from "../helpers/canonical-memory.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

function allowLegacyCategoryFixtures(database: Awaited<ReturnType<typeof openRuntimeDatabase>>): void {
  database.exec("DROP TRIGGER memory_candidates_no_legacy_category_insert");
  database.exec("DROP TRIGGER memory_candidates_no_legacy_category_update");
  database.exec("DROP TRIGGER memory_candidates_controlled_category_insert");
  database.exec("DROP TRIGGER memory_candidates_controlled_category_update");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

test("category migration preview maps legacy Candidate categories without mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-category-preview-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    allowLegacyCategoryFixtures(database);
    const insert = database.prepare(
      `INSERT INTO memory_candidates(
         candidate_id, fingerprint, scope_kind, project_id, statement,
         candidate_json, category, certainty, state, high_value, sensitivity,
         created_at, last_evidence_at, updated_at, startup
       ) VALUES (?, ?, 'global', NULL, ?, ?, ?, 'asserted', 'waiting', 0,
                 'normal', ?, ?, ?, 'auto')`
    );
    const now = "2026-08-12T00:00:00.000Z";
    insert.run(
      "mscand_legacy_api_limit",
      "a".repeat(64),
      "The API is unavailable in this runtime.",
      JSON.stringify({
        statement: "The API is unavailable in this runtime.",
        category: "api_limitation",
        applicabilitySummary: "This runtime only",
        conditions: [],
        exclusions: [],
        preservedNegations: [],
        certainty: "asserted",
        importanceTags: ["limitation", "api_contract"],
        importanceReasons: [],
        sensitivity: "normal"
      }),
      "api_limitation",
      now,
      now,
      now
    );
    insert.run(
      "mscand_legacy_architecture",
      "b".repeat(64),
      "Program and data are separate.",
      JSON.stringify({
        statement: "Program and data are separate.",
        category: "architecture_invariant",
        applicabilitySummary: "MemStore",
        conditions: [],
        exclusions: [],
        preservedNegations: [],
        certainty: "asserted",
        importanceTags: ["architecture_invariant"],
        importanceReasons: [],
        sensitivity: "normal"
      }),
      "architecture_invariant",
      now,
      now,
      now
    );
  } finally {
    database.close();
  }

  await expect(migrateMemoryCategories({
    runtimeRoot,
    vaultRoot: join(root, "vault"),
    preview: true,
    migratedAt: "2026-08-12T00:01:00.000Z"
  })).resolves.toMatchObject({
    state: "preview",
    dryRun: true,
    candidateCount: 2,
    distinctLegacyCategoryCount: 2,
    mappings: [
      {
        legacyCategory: "api_limitation",
        primaryCategory: "applicability_limitation",
        categoryTags: ["applicability_limitation", "architecture_contract"]
      },
      {
        legacyCategory: "architecture_invariant",
        primaryCategory: "architecture_contract",
        categoryTags: ["architecture_contract"]
      }
    ]
  });

  const unchanged = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(unchanged.prepare(
      "SELECT COUNT(*) AS count FROM memory_candidates WHERE category IN ('api_limitation', 'architecture_invariant')"
    ).get()?.count).toBe(2);
  } finally {
    unchanged.close();
  }
});

test("category migration is available as an explicit dry-run CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-category-cli-"));
  roots.push(root);
  const result = await execFileAsync(
    "pnpm",
    [
      "exec", "tsx", "src/cli/main.ts", "category", "migrate",
      "--runtime", join(root, "runtime"),
      "--vault", join(root, "vault"),
      "--preview", "--json"
    ],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  expect(JSON.parse(result.stdout)).toMatchObject({
    schema_version: 1,
    ok: true,
    command: "category.migrate",
    result: { state: "preview", dryRun: true }
  });
});

test("new Candidate writes reject a free-form category after schema migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-category-guard-"));
  roots.push(root);
  const database = await openRuntimeDatabase(join(root, "runtime"));
  try {
    const now = "2026-08-12T00:00:00.000Z";
    expect(() => database.prepare(
      `INSERT INTO memory_candidates(
         candidate_id, fingerprint, scope_kind, project_id, statement,
         candidate_json, category, certainty, state, high_value, sensitivity,
         created_at, last_evidence_at, updated_at, startup
       ) VALUES (?, ?, 'global', NULL, ?, ?, ?, 'asserted', 'waiting', 0,
                 'normal', ?, ?, ?, 'auto')`
    ).run(
      "mscand_uncontrolled",
      "d".repeat(64),
      "Uncontrolled category.",
      JSON.stringify({
        statement: "Uncontrolled category.",
        primaryCategory: "decision",
        categoryTags: ["architecture_contract"]
      }),
      "decision",
      now,
      now,
      now
    )).toThrow("controlled category invariants");
  } finally {
    database.close();
  }
});

test.each([
  {
    id: "missing",
    name: "missing primary category",
    category: "architecture_contract",
    candidate: { categoryTags: ["architecture_contract"] }
  },
  {
    id: "unknown",
    name: "unknown secondary tag",
    category: "architecture_contract",
    candidate: {
      primaryCategory: "architecture_contract",
      categoryTags: ["architecture_contract", "invented_category"]
    }
  },
  {
    id: "duplicate",
    name: "duplicate tags",
    category: "architecture_contract",
    candidate: {
      primaryCategory: "architecture_contract",
      categoryTags: ["architecture_contract", "architecture_contract"]
    }
  },
  {
    id: "precedence",
    name: "primary category that violates precedence",
    category: "architecture_contract",
    candidate: {
      primaryCategory: "architecture_contract",
      categoryTags: ["safety_data_integrity", "architecture_contract"]
    }
  }
])("database rejects $name", async ({ id, category, candidate }) => {
  const root = await mkdtemp(join(tmpdir(), "memstore-category-invariants-"));
  roots.push(root);
  const database = await openRuntimeDatabase(join(root, "runtime"));
  try {
    const now = "2026-08-12T00:00:00.000Z";
    expect(() => database.prepare(
      `INSERT INTO memory_candidates(
         candidate_id, fingerprint, scope_kind, project_id, statement,
         candidate_json, category, certainty, state, high_value, sensitivity,
         created_at, last_evidence_at, updated_at, startup
       ) VALUES (?, ?, 'global', NULL, ?, ?, ?, 'asserted', 'waiting', 0,
                 'normal', ?, ?, ?, 'auto')`
    ).run(
      `mscand_invalid_${id}`,
      "7".repeat(64),
      "Invalid controlled categories.",
      JSON.stringify({ statement: "Invalid controlled categories.", ...candidate }),
      category,
      now,
      now,
      now
    )).toThrow("controlled category invariants");
  } finally {
    database.close();
  }
});

test("same legacy label is remapped from each Candidate's own importance tags", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-category-per-item-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    allowLegacyCategoryFixtures(database);
    const insert = database.prepare(
      `INSERT INTO memory_candidates(
         candidate_id, fingerprint, scope_kind, project_id, statement,
         candidate_json, category, certainty, state, high_value, sensitivity,
         created_at, last_evidence_at, updated_at, startup
       ) VALUES (?, ?, 'global', NULL, ?, ?, 'architecture_invariant',
                 'asserted', 'waiting', 0, 'normal', ?, ?, ?, 'auto')`
    );
    const now = "2026-08-12T00:00:00.000Z";
    const candidate = (statement: string, importanceTags: readonly string[]) => JSON.stringify({
      statement,
      category: "architecture_invariant",
      applicabilitySummary: "test",
      conditions: [],
      exclusions: [],
      preservedNegations: [],
      certainty: "asserted",
      importanceTags,
      importanceReasons: [],
      sensitivity: "normal"
    });
    insert.run("mscand_arch_only", "e".repeat(64), "Architecture only.", candidate(
      "Architecture only.", ["architecture_invariant"]
    ), now, now, now);
    insert.run("mscand_arch_safety", "f".repeat(64), "Architecture safety.", candidate(
      "Architecture safety.", ["architecture_invariant", "data_loss_risk"]
    ), now, now, now);
  } finally {
    database.close();
  }

  await migrateMemoryCategories({
    runtimeRoot,
    vaultRoot: join(root, "vault"),
    preview: false,
    migratedAt: "2026-08-12T00:01:00.000Z"
  });
  const migrated = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(migrated.prepare(
      "SELECT category FROM memory_candidates WHERE candidate_id = 'mscand_arch_only'"
    ).get()?.category).toBe("architecture_contract");
    expect(migrated.prepare(
      "SELECT category FROM memory_candidates WHERE candidate_id = 'mscand_arch_safety'"
    ).get()?.category).toBe("safety_data_integrity");
  } finally {
    migrated.close();
  }
});

test("category migration removes stale secondary tags even when the primary category is correct", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-category-stale-tags-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    allowLegacyCategoryFixtures(database);
    const now = "2026-08-12T00:00:00.000Z";
    database.prepare(
      `INSERT INTO memory_candidates(
         candidate_id, fingerprint, scope_kind, project_id, statement,
         candidate_json, category, certainty, state, high_value, sensitivity,
         created_at, last_evidence_at, updated_at, startup
       ) VALUES (?, ?, 'global', NULL, ?, ?, 'architecture_contract',
                 'asserted', 'waiting', 0, 'normal', ?, ?, ?, 'auto')`
    ).run(
      "mscand_stale_tags",
      "1".repeat(64),
      "Program and data are separate.",
      JSON.stringify({
        statement: "Program and data are separate.",
        primaryCategory: "architecture_contract",
        categoryTags: ["safety_data_integrity", "architecture_contract"],
        categoryAliases: ["architecture_invariant"],
        applicabilitySummary: "MemStore",
        conditions: [],
        exclusions: [],
        preservedNegations: [],
        certainty: "asserted",
        importanceTags: ["architecture_invariant"],
        importanceReasons: [],
        sensitivity: "normal"
      }),
      now,
      now,
      now
    );
  } finally {
    database.close();
  }

  await expect(migrateMemoryCategories({
    runtimeRoot,
    vaultRoot: join(root, "vault"),
    preview: true,
    migratedAt: "2026-08-12T00:01:00.000Z"
  })).resolves.toMatchObject({ candidateCount: 1 });
  await migrateMemoryCategories({
    runtimeRoot,
    vaultRoot: join(root, "vault"),
    preview: false,
    migratedAt: "2026-08-12T00:02:00.000Z"
  });

  const migrated = await openRuntimeDatabase(runtimeRoot);
  try {
    const row = migrated.prepare(
      "SELECT category, candidate_json FROM memory_candidates WHERE candidate_id = 'mscand_stale_tags'"
    ).get();
    expect(row?.category).toBe("architecture_contract");
    expect(JSON.parse(String(row?.candidate_json))).toMatchObject({
      primaryCategory: "architecture_contract",
      categoryTags: ["architecture_contract"]
    });
    expect(JSON.parse(String(row?.candidate_json))).not.toHaveProperty("categoryAliases");
  } finally {
    migrated.close();
  }
});

test("category migration rewrites Candidate and Agent-derived Canonical Memory consistently", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-category-run-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memory = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174801",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174802",
    body: "The API is unavailable in this runtime.",
    authority: "agent_derived",
    primaryCategory: "durable_reference",
    importanceTags: ["limitation", "api_contract"]
  });
  const written = await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory
  });
  const source = await readFile(written.path, "utf8");
  await writeFile(
    written.path,
    source
      .replace(/ {2}primary_category: durable_reference\n/u, "  category: api_limitation\n")
      .replace(/ {2}category_tags:\n {4}- durable_reference\n/u, "")
      .replace(/ {2}category_aliases:\n {4}- api_limitation\n/u, "")
  );
  const legacy = await inspectStandaloneCanonicalFile(written.path);
  const catalogDatabase = await openRuntimeDatabase(runtimeRoot);
  try {
    catalogDatabase.prepare(
      "UPDATE memory_catalog SET content_identity = ? WHERE memory_id = ?"
    ).run(legacy.contentIdentity, memory.memoryId);
  } finally {
    catalogDatabase.close();
  }
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    allowLegacyCategoryFixtures(database);
    const now = "2026-08-12T00:00:00.000Z";
    database.prepare(
      `INSERT INTO memory_candidates(
         candidate_id, fingerprint, scope_kind, project_id, statement,
         candidate_json, category, certainty, state, high_value, sensitivity,
         created_at, last_evidence_at, updated_at, startup,
         promoted_memory_id, promotion_revision_id, promotion_generation
       ) VALUES (?, ?, 'global', NULL, ?, ?, ?, 'asserted', 'promoted', 0,
                 'normal', ?, ?, ?, 'auto', ?, ?, 1)`
    ).run(
      "mscand_legacy_promoted",
      "c".repeat(64),
      memory.body,
      JSON.stringify({
        statement: memory.body,
        category: "api_limitation",
        applicabilitySummary: "This runtime only",
        conditions: [],
        exclusions: [],
        preservedNegations: [],
        certainty: "asserted",
        importanceTags: ["limitation", "api_contract"],
        importanceReasons: [],
        sensitivity: "normal"
      }),
      "api_limitation",
      now,
      now,
      now,
      memory.memoryId,
      memory.revisionId
    );
  } finally {
    database.close();
  }

  await expect(migrateMemoryCategories({
    runtimeRoot,
    vaultRoot,
    preview: false,
    migratedAt: "2026-08-12T00:02:00.000Z"
  })).resolves.toMatchObject({
    state: "migrated",
    dryRun: false,
    candidateCount: 1,
    canonicalMemoryCount: 1
  });

  const migrated = await openRuntimeDatabase(runtimeRoot);
  try {
    const row = migrated.prepare(
      "SELECT category, candidate_json FROM memory_candidates WHERE candidate_id = 'mscand_legacy_promoted'"
    ).get();
    expect(row?.category).toBe("applicability_limitation");
    expect(JSON.parse(String(row?.candidate_json))).toMatchObject({
      primaryCategory: "applicability_limitation",
      categoryTags: ["applicability_limitation", "architecture_contract"]
    });
    expect(JSON.parse(String(row?.candidate_json))).not.toHaveProperty("categoryAliases");
  } finally {
    migrated.close();
  }
  await expect(readCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    memoryId: memory.memoryId
  })).resolves.toMatchObject({
    memory: {
      primaryCategory: "applicability_limitation",
      categoryTags: ["applicability_limitation", "architecture_contract"]
    }
  });
  expect((await readCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    memoryId: memory.memoryId
  }))?.memory).not.toHaveProperty("categoryAliases");
  expect(await readFile(written.path, "utf8")).not.toContain("category_aliases:");
  const revisionDirectory = join(vaultRoot, "_MemStore", "Revisions", memory.memoryId);
  const revisionSources = await Promise.all((await readdir(revisionDirectory, {
    withFileTypes: true
  }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => readFile(join(revisionDirectory, entry.name), "utf8")));
  expect(revisionSources).not.toHaveLength(0);
  for (const revisionSource of revisionSources) {
    expect(revisionSource).not.toContain("category_aliases:");
    expect(revisionSource).not.toMatch(/^ {2}category:/mu);
  }
  expect(written.contentIdentity).not.toBe((await readCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    memoryId: memory.memoryId
  }))?.contentIdentity);
});

test("new Candidate writes reject category aliases at the Runtime boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-category-alias-guard-"));
  roots.push(root);
  const database = await openRuntimeDatabase(join(root, "runtime"));
  try {
    const now = "2026-08-12T00:00:00.000Z";
    expect(() => database.prepare(
      `INSERT INTO memory_candidates(
         candidate_id, fingerprint, scope_kind, project_id, statement,
         candidate_json, category, certainty, state, high_value, sensitivity,
         created_at, last_evidence_at, updated_at, startup
       ) VALUES (?, ?, 'global', NULL, ?, ?, 'architecture_contract',
                 'asserted', 'waiting', 0, 'normal', ?, ?, ?, 'auto')`
    ).run(
      "mscand_alias_rejected",
      "2".repeat(64),
      "Aliases are not online knowledge.",
      JSON.stringify({
        statement: "Aliases are not online knowledge.",
        primaryCategory: "architecture_contract",
        categoryTags: ["architecture_contract"],
        categoryAliases: ["legacy_architecture"]
      }),
      now,
      now,
      now
    )).toThrow("category aliases");
  } finally {
    database.close();
  }
});

test("category migration preflights every target before changing the Vault", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-category-preflight-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const memory = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174811",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174812",
    body: "Legacy category migration must be all-preflighted.",
    authority: "agent_derived",
    primaryCategory: "durable_reference"
  });
  const written = await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory
  });
  const original = await readFile(written.path, "utf8");
  const legacy = original
    .replace(/ {2}primary_category: durable_reference\n/u, "  category: architecture_invariant\n")
    .replace(/ {2}category_tags:\n {4}- durable_reference\n/u, "");
  await writeFile(written.path, legacy);
  const inspected = await inspectStandaloneCanonicalFile(written.path);
  const catalog = await openRuntimeDatabase(runtimeRoot);
  try {
    catalog.prepare("UPDATE memory_catalog SET content_identity = ? WHERE memory_id = ?")
      .run(inspected.contentIdentity, memory.memoryId);
    allowLegacyCategoryFixtures(catalog);
    const now = "2026-08-12T00:00:00.000Z";
    catalog.prepare(
      `INSERT INTO memory_candidates(
         candidate_id, fingerprint, scope_kind, project_id, statement,
         candidate_json, category, certainty, state, high_value, sensitivity,
         created_at, last_evidence_at, updated_at, startup
       ) VALUES (?, ?, 'global', NULL, ?, ?, ?, 'asserted', 'waiting', 0,
                 'normal', ?, ?, ?, 'auto')`
    ).run(
      "mscand_unmapped_preflight",
      "9".repeat(64),
      "Unmapped category.",
      JSON.stringify({
        statement: "Unmapped category.",
        category: "zz_unmapped_category",
        importanceTags: []
      }),
      "zz_unmapped_category",
      now,
      now,
      now
    );
  } finally {
    catalog.close();
  }

  await expect(migrateMemoryCategories({
    runtimeRoot,
    vaultRoot,
    preview: false,
    migratedAt: "2026-08-12T00:01:00.000Z"
  })).rejects.toThrow("unsupported legacy categories");
  expect(await readFile(written.path, "utf8")).toBe(legacy);
});
