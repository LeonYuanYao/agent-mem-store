import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

import {
  writeFileAtomically,
  writeFileAtomicallyExclusive
} from "../contracts/atomic-file.js";
import {
  mapLegacyCategory,
  memoryCategorySchema,
  selectPrimaryCategory,
  type LegacyCategoryMapping,
  type MemoryCategory
} from "../memories/categories.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import {
  inspectStandaloneCanonicalFile,
  renderCanonicalCategoryMigration
} from "../vault/index.js";

export interface CategoryMigrationResult {
  readonly state: "preview" | "migrated";
  readonly dryRun: boolean;
  readonly candidateCount: number;
  readonly distinctLegacyCategoryCount: number;
  readonly fallbackCategoryCount: number;
  readonly canonicalMemoryCount: number;
  readonly canonicalRevisionCount: number;
  readonly humanAuthoredSkippedCount: number;
  readonly reportPath?: string;
  readonly mappings: readonly LegacyCategoryMapping[];
}

interface CandidateCategoryRow {
  readonly candidateId: string;
  readonly category: string;
  readonly candidate: Record<string, unknown>;
  readonly importanceTags: readonly string[];
  readonly legacyCategory: string | undefined;
  readonly expected: LegacyCategoryMapping | undefined;
}

interface CanonicalCategoryRow {
  readonly memoryId: string;
  readonly revisionId: string;
  readonly path: string;
  readonly source: string;
  readonly oldContentIdentity: string;
  readonly catalogContentIdentity: string;
  readonly revisionCatalogContentIdentity: string | undefined;
  readonly authority: "human_authored" | "agent_derived";
  readonly isCurrent: boolean;
  readonly importanceTags: readonly string[];
  readonly legacyCategory: string | undefined;
  readonly expected: LegacyCategoryMapping | undefined;
}

interface CategoryAuditMapping {
  readonly kind: "candidate" | "canonical_revision";
  readonly identity: string;
  readonly memoryId?: string;
  readonly legacyCategory: string;
  readonly primaryCategory: MemoryCategory;
  readonly categoryTags: readonly MemoryCategory[];
  readonly matchedSignals: readonly string[];
  readonly usedFallback: boolean;
}

function equalCategories(left: unknown, right: readonly string[]): boolean {
  const parsed = z.array(z.string()).safeParse(left);
  return parsed.success &&
    parsed.data.length === right.length &&
    parsed.data.every((category, index) => category === right[index]);
}

function candidateCategoryRows(rows: readonly Record<string, unknown>[]): CandidateCategoryRow[] {
  return rows.map((row) => {
    const candidate = z.record(z.string(), z.unknown()).parse(
      JSON.parse(z.string().parse(row.candidate_json))
    );
    const category = z.string().parse(row.category);
    const legacyCategory = z.array(z.string()).catch([]).parse(candidate.categoryAliases)[0] ??
      z.string().optional().parse(candidate.category);
    const importanceTags = z.array(z.string()).catch([]).parse(candidate.importanceTags);
    return {
      candidateId: z.string().parse(row.candidate_id),
      category,
      candidate,
      importanceTags,
      legacyCategory,
      expected: legacyCategory === undefined
        ? undefined
        : mapLegacyCategory(legacyCategory, importanceTags)
    };
  });
}

function memstoreFrontmatter(source: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(source);
  if (match?.[1] === undefined) throw new Error("Canonical Memory has invalid frontmatter.");
  const topLevel = z.record(z.string(), z.unknown()).parse(parse(match[1]));
  return z.record(z.string(), z.unknown()).parse(topLevel.memstore);
}

function canonicalLegacyCategory(source: string): string | undefined {
  const memstore = memstoreFrontmatter(source);
  return z.array(z.string()).catch([]).parse(memstore.category_aliases)[0] ??
    z.string().optional().parse(memstore.category);
}

function hasCanonicalLegacyShape(source: string): boolean {
  const memstore = memstoreFrontmatter(source);
  return Object.hasOwn(memstore, "category") || Object.hasOwn(memstore, "category_aliases");
}

async function listMarkdownFiles(directory: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listMarkdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  }))).flat();
}

function sourceSha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function controlledMapping(
  primaryCategory: MemoryCategory,
  categoryTags: readonly MemoryCategory[]
): LegacyCategoryMapping {
  const tags = categoryTags.length === 0 ? [primaryCategory] : [...categoryTags];
  const normalized = [...new Set(tags)];
  return {
    legacyCategory: primaryCategory,
    primaryCategory: selectPrimaryCategory(normalized),
    categoryTags: normalized,
    matchedSignals: [`controlled:${primaryCategory}`],
    usedFallback: false
  };
}

async function canonicalCategoryRows(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
}): Promise<CanonicalCategoryRow[]> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let catalogRows: readonly Record<string, unknown>[];
  let revisionRows: readonly Record<string, unknown>[];
  try {
    catalogRows = database.prepare(
      `SELECT memory_id, current_revision_id, canonical_path, content_identity, authority
       FROM memory_catalog WHERE lifecycle != 'tombstone' ORDER BY memory_id`
    ).all();
    revisionRows = database.prepare(
      `SELECT revision.memory_id, revision.revision_id, revision.revision_path,
              revision.content_identity,
              catalog.current_revision_id, catalog.authority
       FROM memory_revisions AS revision
       JOIN memory_catalog AS catalog ON catalog.memory_id = revision.memory_id
       WHERE catalog.lifecycle != 'tombstone'
       ORDER BY revision.memory_id, revision.created_at, revision.revision_id`
    ).all();
  } finally {
    database.close();
  }
  const byPath = new Map<string, {
    readonly memoryId: string;
    readonly revisionId: string;
    readonly authority: "human_authored" | "agent_derived";
    readonly isCurrent: boolean;
    readonly catalogContentIdentity: string;
    readonly revisionCatalogContentIdentity: string | undefined;
  }>();
  for (const row of revisionRows) {
    const path = resolve(z.string().parse(row.revision_path));
    byPath.set(path, {
      memoryId: z.string().parse(row.memory_id),
      revisionId: z.string().parse(row.revision_id),
      authority: z.enum(["human_authored", "agent_derived"]).parse(row.authority),
      isCurrent: false,
      catalogContentIdentity: "",
      revisionCatalogContentIdentity: z.string().parse(row.content_identity)
    });
  }
  for (const row of catalogRows) {
    const path = resolve(z.string().parse(row.canonical_path));
    byPath.set(path, {
      memoryId: z.string().parse(row.memory_id),
      revisionId: z.string().parse(row.current_revision_id),
      authority: z.enum(["human_authored", "agent_derived"]).parse(row.authority),
      isCurrent: true,
      catalogContentIdentity: z.string().parse(row.content_identity),
      revisionCatalogContentIdentity: byPath.get(path)?.revisionCatalogContentIdentity
    });
  }
  const revisionRoot = resolve(request.vaultRoot, "_MemStore", "Revisions");
  for (const path of await listMarkdownFiles(revisionRoot)) {
    const inspected = await inspectStandaloneCanonicalFile(path);
    const existing = byPath.get(resolve(path));
    byPath.set(resolve(path), existing ?? {
      memoryId: inspected.memory.memoryId,
      revisionId: inspected.memory.revisionId,
      authority: inspected.memory.authority,
      isCurrent: false,
      catalogContentIdentity: "",
      revisionCatalogContentIdentity: undefined
    });
  }
  return Promise.all([...byPath.entries()].map(async ([path, metadata]) => {
    const source = await readFile(path, "utf8");
    const inspected = await inspectStandaloneCanonicalFile(path);
    if (
      inspected.memory.memoryId !== metadata.memoryId ||
      inspected.memory.revisionId !== metadata.revisionId
    ) {
      throw new Error("Canonical category migration path has inconsistent identity metadata.");
    }
    const legacyCategory = canonicalLegacyCategory(source);
    const expected = legacyCategory === undefined || legacyCategory === "tombstone"
      ? controlledMapping(
          memoryCategorySchema.parse(inspected.memory.primaryCategory),
          inspected.memory.categoryTags
        )
      : mapLegacyCategory(legacyCategory, inspected.memory.importanceTags);
    return {
      ...metadata,
      path,
      source,
      oldContentIdentity: inspected.contentIdentity,
      importanceTags: inspected.memory.importanceTags,
      legacyCategory,
      expected
    };
  }));
}

export async function migrateMemoryCategories(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly preview: boolean;
  readonly migratedAt: string;
}): Promise<CategoryMigrationResult> {
  z.iso.datetime().parse(request.migratedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let candidates: CandidateCategoryRow[];
  try {
    candidates = candidateCategoryRows(database.prepare(
      `SELECT candidate_id, category, candidate_json FROM memory_candidates
       WHERE candidate_json IS NOT NULL ORDER BY category, candidate_id`
    ).all());
  } finally {
    database.close();
  }
  const candidateNeedsMigration = (candidate: CandidateCategoryRow): boolean => {
    const hasLegacyShape = Object.hasOwn(candidate.candidate, "category");
    const hasMigrationAlias = Object.hasOwn(candidate.candidate, "categoryAliases");
    if (!hasLegacyShape && !hasMigrationAlias) return false;
    if (candidate.expected === undefined) return true;
    return candidate.category !== candidate.expected.primaryCategory ||
      candidate.candidate.primaryCategory !== candidate.expected.primaryCategory ||
      !equalCategories(candidate.candidate.categoryTags, candidate.expected.categoryTags) ||
      hasLegacyShape || hasMigrationAlias;
  };
  const candidateTargets = candidates.filter(candidateNeedsMigration);
  const canonicalTargets = (await canonicalCategoryRows(request)).filter((row) =>
    hasCanonicalLegacyShape(row.source)
  );
  const currentLegacyMemoryIds = new Set(canonicalTargets.filter((row) => row.isCurrent)
    .map((row) => row.memoryId));
  const legacyCategories = [...new Set([
    ...candidateTargets.flatMap((candidate) => candidate.legacyCategory === undefined
      ? [] : [candidate.legacyCategory]),
    ...canonicalTargets.flatMap((row) => row.legacyCategory === undefined
      ? [] : [row.legacyCategory])
  ])].sort((left, right) => left.localeCompare(right, "en-US"));
  const actualMappings: CategoryAuditMapping[] = [
    ...candidateTargets.flatMap((row) => row.legacyCategory === undefined || row.expected === undefined
      ? []
      : [{
          kind: "candidate" as const,
          identity: row.candidateId,
          legacyCategory: row.legacyCategory,
          primaryCategory: row.expected.primaryCategory,
          categoryTags: row.expected.categoryTags,
          matchedSignals: row.expected.matchedSignals,
          usedFallback: row.expected.usedFallback
        }]),
    ...canonicalTargets.flatMap((row) => row.legacyCategory === undefined || row.expected === undefined
      ? []
      : [{
          kind: "canonical_revision" as const,
          identity: row.revisionId,
          memoryId: row.memoryId,
          legacyCategory: row.legacyCategory,
          primaryCategory: row.expected.primaryCategory,
          categoryTags: row.expected.categoryTags,
          matchedSignals: row.expected.matchedSignals,
          usedFallback: row.expected.usedFallback
        }])
  ];
  const mappings = legacyCategories.map((legacyCategory) => {
    const actual = actualMappings.find((mapping) =>
      mapping.legacyCategory === legacyCategory
    );
    return actual === undefined
      ? mapLegacyCategory(legacyCategory)
      : {
          legacyCategory,
          primaryCategory: actual.primaryCategory,
          categoryTags: actual.categoryTags,
          matchedSignals: actual.matchedSignals,
          usedFallback: actual.usedFallback
        };
  });
  const humanAuthoredSkippedCount = canonicalTargets.filter((row) =>
    row.authority === "human_authored"
  ).length;
  const fallbackCategoryCount = actualMappings.filter((mapping) => mapping.usedFallback).length +
    candidateTargets.filter((row) => row.expected === undefined).length +
    canonicalTargets.filter((row) => row.expected === undefined).length;
  const canonicalMemoryCount = new Set(canonicalTargets.map((row) => row.memoryId)).size;

  if (request.preview) {
    return {
      state: "preview",
      dryRun: true,
      candidateCount: candidateTargets.length,
      distinctLegacyCategoryCount: legacyCategories.length,
      fallbackCategoryCount,
      canonicalMemoryCount,
      canonicalRevisionCount: canonicalTargets.length,
      humanAuthoredSkippedCount,
      mappings
    };
  }
  if (fallbackCategoryCount > 0) {
    throw new Error(
      "Category migration contains unsupported legacy categories; review the preview mapping before execution."
    );
  }
  if (humanAuthoredSkippedCount > 0) {
    throw new Error(
      "Human-authored legacy categories require explicit human review before migration."
    );
  }

  const renderedCanonical = canonicalTargets.map((row) => {
    if (row.expected === undefined) throw new Error("Canonical category mapping is unavailable.");
    return {
      ...row,
      rendered: renderCanonicalCategoryMigration({
        source: row.source,
        primaryCategory: row.expected.primaryCategory,
        categoryTags: row.expected.categoryTags,
        policyVersion: "controlled-categories-v3-no-alias"
      })
    };
  });
  for (const memoryId of currentLegacyMemoryIds) {
    if (!renderedCanonical.some((row) => row.memoryId === memoryId && row.isCurrent)) {
      throw new Error("Canonical category migration is missing the current Memory file.");
    }
  }
  const preparedCandidates = candidateTargets.map((row) => {
    if (row.expected === undefined) throw new Error("Candidate category mapping is unavailable.");
    const candidate = { ...row.candidate };
    delete candidate.category;
    delete candidate.categoryAliases;
    candidate.primaryCategory = row.expected.primaryCategory;
    candidate.categoryTags = [...row.expected.categoryTags];
    return { ...row, candidate };
  });

  const writtenCanonical: typeof renderedCanonical = [];
  try {
    for (const row of renderedCanonical) {
      await writeFileAtomically(
        row.path,
        row.rendered.source,
        0o600,
        sourceSha256(row.source)
      );
      writtenCanonical.push(row);
    }
    const updateDatabase = await openRuntimeDatabase(request.runtimeRoot);
    try {
      updateDatabase.exec("BEGIN IMMEDIATE");
      const updateCandidate = updateDatabase.prepare(
        `UPDATE memory_candidates SET category = ?, candidate_json = ?, updated_at = ?
         WHERE candidate_id = ? AND category = ? AND candidate_json IS NOT NULL`
      );
      for (const row of preparedCandidates) {
        const result = updateCandidate.run(
          row.expected?.primaryCategory ?? row.category,
          JSON.stringify(row.candidate),
          request.migratedAt,
          row.candidateId,
          row.category
        );
        if (result.changes !== 1) {
          throw new Error("Candidate category migration precondition failed.");
        }
      }
      const updateRevision = updateDatabase.prepare(
        "UPDATE memory_revisions SET content_identity = ? WHERE revision_id = ? AND content_identity = ?"
      );
      const updateCatalog = updateDatabase.prepare(
        `UPDATE memory_catalog SET content_identity = ?, catalog_updated_at = ?
         WHERE memory_id = ? AND current_revision_id = ? AND content_identity = ?`
      );
      const updatedRevisionIds = new Set<string>();
      for (const row of renderedCanonical) {
        if (!updatedRevisionIds.has(row.revisionId) &&
            row.revisionCatalogContentIdentity !== undefined) {
          const revisionUpdate = updateRevision.run(
            row.rendered.contentIdentity,
            row.revisionId,
            row.revisionCatalogContentIdentity
          );
          if (revisionUpdate.changes !== 1) {
            throw new Error("Canonical revision category migration precondition failed.");
          }
          updatedRevisionIds.add(row.revisionId);
        }
        if (row.isCurrent) {
          const catalogUpdate = updateCatalog.run(
            row.rendered.contentIdentity,
            request.migratedAt,
            row.memoryId,
            row.revisionId,
            row.catalogContentIdentity
          );
          if (catalogUpdate.changes !== 1) {
            throw new Error("Canonical catalog category migration precondition failed.");
          }
        }
      }
      updateDatabase.exec("COMMIT");
    } catch (error) {
      updateDatabase.exec("ROLLBACK");
      throw error;
    } finally {
      updateDatabase.close();
    }
  } catch (error) {
    const rollbackFailures: unknown[] = [];
    for (const row of [...writtenCanonical].reverse()) {
      try {
        await writeFileAtomically(
          row.path,
          row.source,
          0o600,
          sourceSha256(row.rendered.source)
        );
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        "Category migration failed and its Vault rollback was incomplete."
      );
    }
    throw error;
  }

  const reportPath = join(
    request.runtimeRoot,
    "migrations",
    `controlled-categories-v3-no-alias-${request.migratedAt.replace(/[:.]/gu, "-")}.json`
  );
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFileAtomicallyExclusive(reportPath, `${JSON.stringify({
    schemaVersion: 2,
    migratedAt: request.migratedAt,
    candidateCount: candidateTargets.length,
    canonicalMemoryCount,
    canonicalRevisionCount: canonicalTargets.length,
    humanAuthoredSkippedCount,
    mappings,
    actualMappings
  }, null, 2)}\n`, 0o600);
  return {
    state: "migrated",
    dryRun: false,
    candidateCount: candidateTargets.length,
    distinctLegacyCategoryCount: legacyCategories.length,
    fallbackCategoryCount,
    canonicalMemoryCount,
    canonicalRevisionCount: canonicalTargets.length,
    humanAuthoredSkippedCount,
    reportPath,
    mappings
  };
}
