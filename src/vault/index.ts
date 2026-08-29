import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parse, stringify } from "yaml";
import { z } from "zod";

import {
  writeFileAtomically,
  writeFileAtomicallyExclusive
} from "../contracts/atomic-file.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import { classifyLocalSensitivity } from "../contracts/sensitivity.js";
import {
  memoryCategorySchema,
  mapLegacyCategory,
  selectPrimaryCategory,
  type MemoryCategory
} from "../memories/categories.js";

const uuidV4Suffix =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const memoryIdSchema = z.string().regex(new RegExp(`^msmem_${uuidV4Suffix}$`, "u"));
const revisionIdSchema = z.string().regex(new RegExp(`^msrev_${uuidV4Suffix}$`, "u"));
const projectIdSchema = z.string().regex(new RegExp(`^msproj_${uuidV4Suffix}$`, "u"));
const memoryRefSchema = z.number().int().positive();

export interface CanonicalMemory {
  readonly schemaVersion: 1;
  readonly memoryId: string;
  readonly memoryRef?: number;
  readonly revisionId: string;
  readonly scope:
    | { readonly kind: "project"; readonly projectId: string }
    | { readonly kind: "global" };
  readonly authority: "human_authored" | "agent_derived";
  readonly originKind: "direct_human_assertion" | "model_extraction" | "manual_edit";
  readonly sensitivity: "normal" | "private";
  readonly lifecycle: "active" | "archived" | "tombstone";
  readonly lifecycleDetails: {
    readonly archivedAt?: string;
    readonly tombstonedAt?: string;
    readonly reason?: string;
    readonly purgeAfter?: string;
    readonly retainForever?: boolean;
    readonly pinned?: boolean;
    readonly purgedContentIdentity?: string;
    readonly purgedRevisionIds?: readonly string[];
  };
  readonly primaryCategory: MemoryCategory | "tombstone";
  readonly categoryTags: readonly MemoryCategory[];
  readonly importanceTags: readonly string[];
  readonly startup: "auto" | "always" | "never";
  readonly applicability: {
    readonly summary: string;
    readonly conditions: readonly string[];
  };
  readonly validity: {
    readonly state: "valid" | "review_due" | "invalid";
    readonly validFrom?: string;
    readonly validUntil?: string;
  };
  readonly createdAt: string;
  readonly revisedAt: string;
  readonly semanticContract: {
    readonly schemaVersion: 1;
    readonly claims: readonly string[];
    readonly conditions: readonly string[];
    readonly exclusions: readonly string[];
    readonly preservedNegations: readonly string[];
  };
  readonly representations: {
    readonly identity?: {
      readonly label: string;
      readonly validated: boolean;
      readonly generatorIdentity: string;
      readonly sourceRevisionId: string;
      readonly renderedTokenCount: number;
    };
    readonly compact: {
      readonly text: string;
      readonly validated: boolean;
      readonly generatorIdentity: string;
      readonly sourceRevisionId: string;
      readonly renderedTokenCount: number;
    };
    readonly standard: {
      readonly text: string;
      readonly validated: boolean;
      readonly generatorIdentity: string;
      readonly sourceRevisionId: string;
      readonly renderedTokenCount: number;
    };
  };
  readonly provenance: readonly string[];
  readonly injectionReceiptIds: readonly string[];
  readonly relationships: readonly {
    readonly type: string;
    readonly targetMemoryId: string;
  }[];
  readonly predecessorMemoryId?: string;
  readonly successorMemoryId?: string;
  readonly predecessorRevisionId?: string;
  readonly contentIdentity: string;
  readonly policyVersion: string;
  readonly body: string;
}

const frontmatterSchema = z.object({
  memstore: z.object({
    schema_version: z.literal(1),
    memory_id: memoryIdSchema,
    memory_ref: memoryRefSchema.optional(),
    revision_id: revisionIdSchema,
    scope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("project"), project_id: projectIdSchema }),
      z.object({ kind: z.literal("global") })
    ]),
    authority: z.enum(["human_authored", "agent_derived"]),
    origin_kind: z.enum(["direct_human_assertion", "model_extraction", "manual_edit"]),
    sensitivity: z.enum(["normal", "private"]),
    lifecycle: z.enum(["active", "archived", "tombstone"]),
    lifecycle_details: z.object({
      archived_at: z.iso.datetime().optional(),
      tombstoned_at: z.iso.datetime().optional(),
      reason: z.string().min(1).optional(),
      purge_after: z.iso.datetime().optional(),
      retain_forever: z.boolean().optional(),
      pinned: z.boolean().optional(),
      purged_content_identity: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
      purged_revision_ids: z.array(revisionIdSchema).optional()
    }),
    primary_category: memoryCategorySchema.or(z.literal("tombstone")).optional(),
    category_tags: z.array(memoryCategorySchema).optional(),
    category_aliases: z.array(z.string().min(1).max(256)).max(16).optional(),
    category: z.string().min(1).optional(),
    importance_tags: z.array(z.string().min(1)),
    startup: z.enum(["auto", "always", "never"]),
    applicability: z.object({
      summary: z.string(),
      conditions: z.array(z.string())
    }),
    validity: z.object({
      state: z.enum(["valid", "review_due", "invalid"]),
      valid_from: z.iso.datetime().optional(),
      valid_until: z.iso.datetime().optional()
    }),
    created_at: z.iso.datetime(),
    revised_at: z.iso.datetime(),
    semantic_contract: z.object({
      schema_version: z.literal(1),
      claims: z.array(z.string()),
      conditions: z.array(z.string()),
      exclusions: z.array(z.string()),
      preserved_negations: z.array(z.string())
    }),
    representations: z.object({
      identity: z.object({
        label: z.string(),
        validated: z.boolean(),
        generator_identity: z.string().min(1),
        source_revision_id: revisionIdSchema,
        rendered_token_count: z.number().int().nonnegative()
      }).optional(),
      compact: z.object({
        text: z.string(),
        validated: z.boolean(),
        generator_identity: z.string().min(1),
        source_revision_id: revisionIdSchema,
        rendered_token_count: z.number().int().nonnegative()
      }),
      standard: z.object({
        text: z.string(),
        validated: z.boolean(),
        generator_identity: z.string().min(1),
        source_revision_id: revisionIdSchema,
        rendered_token_count: z.number().int().nonnegative()
      })
    }),
    provenance: z.array(z.string()),
    injection_receipt_ids: z.array(z.string().min(1)),
    relationships: z.array(
      z.object({ type: z.string().min(1), target_memory_id: memoryIdSchema })
    ),
    predecessor_memory_id: memoryIdSchema.optional(),
    successor_memory_id: memoryIdSchema.optional(),
    predecessor_revision_id: revisionIdSchema.optional(),
    content_identity: z.string().regex(/^[0-9a-f]{64}$/u),
    policy_version: z.string().min(1)
  })
});

export interface WriteCanonicalMemoryRequest {
  readonly vaultRoot: string;
  readonly runtimeRoot: string;
  readonly actor: "human" | "agent";
  readonly memory: CanonicalMemory;
  readonly expectedContentIdentity?: string;
}

export interface CanonicalWriteResult {
  readonly state: "created" | "revised";
  readonly memoryId: string;
  readonly memoryRef: number;
  readonly revisionId: string;
  readonly path: string;
  readonly contentIdentity: string;
}

export class VaultRevisionConflictError extends Error {
  public readonly expectedContentIdentity: string | undefined;
  public readonly observedContentIdentity: string;

  public constructor(
    expectedContentIdentity: string | undefined,
    observedContentIdentity: string
  ) {
    super("Canonical Memory changed after it was read.");
    this.name = "VaultRevisionConflictError";
    this.expectedContentIdentity = expectedContentIdentity;
    this.observedContentIdentity = observedContentIdentity;
  }
}

export class SecretContentError extends Error {
  public readonly category: string;

  public constructor(category: string) {
    super("Secret Content cannot be written to Canonical Memory.");
    this.name = "SecretContentError";
    this.category = category;
  }
}

function validateCanonicalIdentity(memory: CanonicalMemory): void {
  memoryIdSchema.parse(memory.memoryId);
  if (memory.memoryRef !== undefined) memoryRefSchema.parse(memory.memoryRef);
  revisionIdSchema.parse(memory.revisionId);
  z.string().regex(/^[0-9a-f]{64}$/u).parse(memory.contentIdentity);
  z.string().min(1).parse(memory.policyVersion);
  z.iso.datetime().parse(memory.createdAt);
  z.iso.datetime().parse(memory.revisedAt);
  if (memory.scope.kind === "project") {
    projectIdSchema.parse(memory.scope.projectId);
  }
  for (const relationship of memory.relationships) {
    memoryIdSchema.parse(relationship.targetMemoryId);
  }
  if (memory.predecessorMemoryId !== undefined) {
    memoryIdSchema.parse(memory.predecessorMemoryId);
  }
  if (memory.successorMemoryId !== undefined) {
    memoryIdSchema.parse(memory.successorMemoryId);
  }
  if (memory.predecessorRevisionId !== undefined) {
    revisionIdSchema.parse(memory.predecessorRevisionId);
  }
  if (
    memory.lifecycle === "archived" &&
    (memory.lifecycleDetails.archivedAt === undefined ||
      memory.lifecycleDetails.reason === undefined)
  ) {
    throw new Error("Archived Canonical Memory requires time and reason.");
  }
  if (
    memory.lifecycle === "tombstone" &&
    (memory.lifecycleDetails.tombstonedAt === undefined ||
      memory.lifecycleDetails.reason === undefined)
  ) {
    throw new Error("Tombstone Canonical Memory requires time and reason.");
  }
  if (
    memory.lifecycleDetails.retainForever === true &&
    memory.lifecycleDetails.purgeAfter !== undefined
  ) {
    throw new Error("Canonical retention cannot combine retain_forever and purge_after.");
  }
  if (
    memory.lifecycle === "tombstone" &&
    (memory.body.trim().length > 0 ||
      memory.primaryCategory !== "tombstone" ||
      memory.categoryTags.length > 0 ||
      memory.importanceTags.length > 0 ||
      memory.startup !== "never" ||
      memory.applicability.summary.length > 0 ||
      memory.applicability.conditions.length > 0 ||
      memory.validity.state !== "invalid" ||
      memory.representations.identity !== undefined ||
      memory.representations.compact.text.length > 0 ||
      memory.representations.standard.text.length > 0 ||
      memory.semanticContract.claims.length > 0 ||
      memory.semanticContract.conditions.length > 0 ||
      memory.semanticContract.exclusions.length > 0 ||
      memory.semanticContract.preservedNegations.length > 0 ||
      memory.relationships.length > 0)
  ) {
    throw new Error("Tombstone Canonical Memory must be knowledge-free.");
  }
  if (
    memory.lifecycle !== "tombstone" &&
    (memory.primaryCategory === "tombstone" ||
      memory.categoryTags.length === 0 ||
      new Set(memory.categoryTags).size !== memory.categoryTags.length ||
      selectPrimaryCategory(memory.categoryTags) !== memory.primaryCategory)
  ) {
    throw new Error("Canonical Memory contains invalid controlled categories.");
  }
}

function canonicalPath(vaultRoot: string, memory: CanonicalMemory): string {
  return memory.scope.kind === "global"
    ? join(vaultRoot, "Memories", "Global", `${memory.memoryId}.md`)
    : join(
        vaultRoot,
        "Memories",
        "Projects",
        memory.scope.projectId,
        `${memory.memoryId}.md`
      );
}

async function reserveMemoryRef(
  runtimeRoot: string,
  selectedMemoryId: string,
  requestedRef?: number
): Promise<number> {
  memoryIdSchema.parse(selectedMemoryId);
  if (requestedRef !== undefined) memoryRefSchema.parse(requestedRef);
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = database.prepare(
        "SELECT memory_ref FROM memory_ref_reservations WHERE memory_id = ?"
      ).get(selectedMemoryId);
      if (existing !== undefined) {
        const memoryRef = memoryRefSchema.parse(existing.memory_ref);
        if (requestedRef !== undefined && requestedRef !== memoryRef) {
          throw new Error("Canonical Memory cannot change its portable reference.");
        }
        database.exec("COMMIT");
        return memoryRef;
      }
      const allocator = database.prepare(
        "SELECT next_ref FROM memory_ref_allocator WHERE singleton = 1"
      ).get();
      const allocatedRef = requestedRef ?? memoryRefSchema.parse(allocator?.next_ref);
      database.prepare(
        `INSERT INTO memory_ref_reservations(memory_id, memory_ref, reserved_at)
         VALUES (?, ?, ?)`
      ).run(selectedMemoryId, allocatedRef, new Date().toISOString());
      database.prepare(
        `UPDATE memory_ref_allocator
         SET next_ref = MAX(next_ref, ?)
         WHERE singleton = 1`
      ).run(allocatedRef + 1);
      database.exec("COMMIT");
      return allocatedRef;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function sameScope(left: CanonicalMemory["scope"], right: CanonicalMemory["scope"]): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "global" ||
      (right.kind === "project" && left.projectId === right.projectId))
  );
}

function replaceCatalogRelationships(
  database: DatabaseSync,
  memory: CanonicalMemory
): void {
  database
    .prepare("DELETE FROM memory_relationships WHERE source_memory_id = ?")
    .run(memory.memoryId);
  const insertRelationship = database.prepare(
    `INSERT INTO memory_relationships(
       source_memory_id, target_memory_id, relationship_type,
       source_revision_id
     ) VALUES (?, ?, ?, ?)`
  );
  for (const relationship of memory.relationships) {
    insertRelationship.run(
      memory.memoryId,
      relationship.targetMemoryId,
      relationship.type,
      memory.revisionId
    );
  }
}

function canonicalPathFromCatalogScope(
  vaultRoot: string,
  selectedMemoryId: string,
  scopeKind: unknown,
  selectedProjectId: unknown
): string {
  memoryIdSchema.parse(selectedMemoryId);
  if (scopeKind === "global" && selectedProjectId === null) {
    return join(resolve(vaultRoot), "Memories", "Global", `${selectedMemoryId}.md`);
  }
  if (scopeKind === "project" && typeof selectedProjectId === "string") {
    projectIdSchema.parse(selectedProjectId);
    return join(
      resolve(vaultRoot),
      "Memories",
      "Projects",
      selectedProjectId,
      `${selectedMemoryId}.md`
    );
  }
  throw new Error("Canonical catalog contains an invalid scope.");
}

function canonicalRevisionPath(
  vaultRoot: string,
  memoryId: string,
  revisionId: string
): string {
  return join(
    vaultRoot,
    "_MemStore",
    "Revisions",
    memoryId,
    `${revisionId}.md`
  );
}

async function ensurePortableProjectCatalog(
  vaultRoot: string,
  runtimeRoot: string,
  selectedProjectId: string
): Promise<void> {
  projectIdSchema.parse(selectedProjectId);
  const path = join(vaultRoot, "_MemStore", "Projects", `${selectedProjectId}.md`);
  if (await exists(path)) return;
  const database = await openRuntimeDatabase(runtimeRoot);
  let displayName = selectedProjectId;
  try {
    const row = database
      .prepare("SELECT display_name FROM projects WHERE project_id = ?")
      .get(selectedProjectId);
    if (typeof row?.display_name === "string") displayName = row.display_name;
  } finally {
    database.close();
  }
  const source = `---\n${stringify({
    memstore_project: {
      schema_version: 1,
      project_id: selectedProjectId,
      display_name: displayName,
      aliases: []
    }
  }).trimEnd()}\n---\n# ${displayName}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFileAtomicallyExclusive(path, source, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

const unknownPropertiesSchema = z.record(z.string(), z.unknown());

function mergeOwnedValues(
  previous: unknown,
  current: unknown
): unknown {
  const previousRecord = unknownPropertiesSchema.safeParse(previous);
  const currentRecord = unknownPropertiesSchema.safeParse(current);
  if (!previousRecord.success || !currentRecord.success) return current;
  const merged: Record<string, unknown> = { ...previousRecord.data };
  for (const [key, value] of Object.entries(currentRecord.data)) {
    merged[key] = mergeOwnedValues(previousRecord.data[key], value);
  }
  return merged;
}

function replaceOwnedFrontmatterBlock(
  previousFrontmatter: string,
  ownedBlock: string
): string {
  const lines = previousFrontmatter.split("\n");
  const start = lines.findIndex((line) => /^memstore\s*:/u.test(line));
  if (start < 0) {
    throw new Error("Existing Canonical Memory has no replaceable memstore block.");
  }
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line !== undefined && line.length > 0 && !/^[ \t]/u.test(line)) {
      break;
    }
    end += 1;
  }
  return [...lines.slice(0, start), ownedBlock, ...lines.slice(end)].join("\n");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  const record = unknownPropertiesSchema.safeParse(value);
  if (!record.success) return value;
  return Object.fromEntries(
    Object.keys(record.data)
      .sort()
      .map((key) => [key, canonicalize(record.data[key])])
  );
}

function identityFromOwnedContent(
  ownedMetadata: Record<string, unknown>,
  body: string
): string {
  const withoutIdentity = { ...ownedMetadata };
  delete withoutIdentity.content_identity;
  delete withoutIdentity.memory_ref;
  return createHash("sha256")
    .update(
      JSON.stringify({
        memstore: canonicalize(withoutIdentity),
        body: body.trimEnd()
      })
    )
    .digest("hex");
}

function render(memory: CanonicalMemory, previousSource?: string): string {
  const metadata = {
    schema_version: memory.schemaVersion,
    memory_id: memory.memoryId,
    ...(memory.memoryRef === undefined ? {} : { memory_ref: memory.memoryRef }),
    revision_id: memory.revisionId,
    scope:
      memory.scope.kind === "global"
        ? { kind: "global" }
        : { kind: "project", project_id: memory.scope.projectId },
    authority: memory.authority,
    origin_kind: memory.originKind,
    sensitivity: memory.sensitivity,
    lifecycle: memory.lifecycle,
    lifecycle_details: {
      ...(memory.lifecycleDetails.archivedAt === undefined
        ? {}
        : { archived_at: memory.lifecycleDetails.archivedAt }),
      ...(memory.lifecycleDetails.tombstonedAt === undefined
        ? {}
        : { tombstoned_at: memory.lifecycleDetails.tombstonedAt }),
      ...(memory.lifecycleDetails.reason === undefined
        ? {}
        : { reason: memory.lifecycleDetails.reason }),
      ...(memory.lifecycleDetails.purgeAfter === undefined
        ? {}
        : { purge_after: memory.lifecycleDetails.purgeAfter }),
      ...(memory.lifecycleDetails.retainForever === undefined
        ? {}
        : { retain_forever: memory.lifecycleDetails.retainForever }),
      ...(memory.lifecycleDetails.pinned === undefined
        ? {}
        : { pinned: memory.lifecycleDetails.pinned }),
      ...(memory.lifecycleDetails.purgedContentIdentity === undefined
        ? {}
        : { purged_content_identity: memory.lifecycleDetails.purgedContentIdentity }),
      ...(memory.lifecycleDetails.purgedRevisionIds === undefined
        ? {}
        : { purged_revision_ids: [...memory.lifecycleDetails.purgedRevisionIds] })
    },
    primary_category: memory.primaryCategory,
    category_tags: [...memory.categoryTags],
    importance_tags: [...memory.importanceTags],
    startup: memory.startup,
    applicability: {
      summary: memory.applicability.summary,
      conditions: [...memory.applicability.conditions]
    },
    validity: {
      state: memory.validity.state,
      ...(memory.validity.validFrom === undefined
        ? {}
        : { valid_from: memory.validity.validFrom }),
      ...(memory.validity.validUntil === undefined
        ? {}
        : { valid_until: memory.validity.validUntil })
    },
    created_at: memory.createdAt,
    revised_at: memory.revisedAt,
    semantic_contract: {
      schema_version: memory.semanticContract.schemaVersion,
      claims: [...memory.semanticContract.claims],
      conditions: [...memory.semanticContract.conditions],
      exclusions: [...memory.semanticContract.exclusions],
      preserved_negations: [...memory.semanticContract.preservedNegations]
    },
    representations: {
      ...(memory.representations.identity === undefined
        ? {}
        : {
            identity: {
              label: memory.representations.identity.label,
              validated: memory.representations.identity.validated,
              generator_identity: memory.representations.identity.generatorIdentity,
              source_revision_id: memory.representations.identity.sourceRevisionId,
              rendered_token_count: memory.representations.identity.renderedTokenCount
            }
          }),
      compact: {
        text: memory.representations.compact.text,
        validated: memory.representations.compact.validated,
        generator_identity: memory.representations.compact.generatorIdentity,
        source_revision_id: memory.representations.compact.sourceRevisionId,
        rendered_token_count: memory.representations.compact.renderedTokenCount
      },
      standard: {
        text: memory.representations.standard.text,
        validated: memory.representations.standard.validated,
        generator_identity: memory.representations.standard.generatorIdentity,
        source_revision_id: memory.representations.standard.sourceRevisionId,
        rendered_token_count: memory.representations.standard.renderedTokenCount
      }
    },
    provenance: [...memory.provenance],
    injection_receipt_ids: [...memory.injectionReceiptIds],
    relationships: memory.relationships.map((relationship) => ({
      type: relationship.type,
      target_memory_id: relationship.targetMemoryId
    })),
    ...(memory.predecessorMemoryId === undefined
      ? {}
      : { predecessor_memory_id: memory.predecessorMemoryId }),
    ...(memory.successorMemoryId === undefined
      ? {}
      : { successor_memory_id: memory.successorMemoryId }),
    ...(memory.predecessorRevisionId === undefined
      ? {}
      : { predecessor_revision_id: memory.predecessorRevisionId }),
    policy_version: memory.policyVersion
  };
  let previousMemstore: Record<string, unknown> = {};
  let previousFrontmatter: string | undefined;
  if (previousSource !== undefined) {
    const match = /^---\n([\s\S]*?)\n---\n/u.exec(previousSource);
    if (match?.[1] === undefined) {
      throw new Error("Existing Canonical Memory has invalid frontmatter.");
    }
    previousFrontmatter = match[1];
    const topLevel = unknownPropertiesSchema.parse(parse(previousFrontmatter));
    previousMemstore = unknownPropertiesSchema.safeParse(topLevel.memstore).success
      ? unknownPropertiesSchema.parse(topLevel.memstore)
      : {};
  }
  const mergedMetadata = unknownPropertiesSchema.parse(
    memory.lifecycle === "tombstone"
      ? metadata
      : mergeOwnedValues(previousMemstore, metadata)
  );
  delete mergedMetadata.category;
  delete mergedMetadata.category_aliases;
  mergedMetadata.content_identity = identityFromOwnedContent(
    mergedMetadata,
    memory.body
  );
  const ownedBlock = stringify({ memstore: mergedMetadata }, { lineWidth: 0 }).trimEnd();
  const frontmatter =
    previousFrontmatter === undefined
      ? ownedBlock
      : replaceOwnedFrontmatterBlock(previousFrontmatter, ownedBlock);
  return `---\n${frontmatter}\n---\n${memory.body.trimEnd()}\n`;
}

function contentIdentity(source: string): string {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(source);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error("Canonical Memory must contain YAML frontmatter.");
  }
  const topLevel = unknownPropertiesSchema.parse(parse(match[1]));
  const ownedMetadata = unknownPropertiesSchema.parse(topLevel.memstore);
  return identityFromOwnedContent(ownedMetadata, match[2]);
}

function fileIdentity(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function parseCanonical(source: string): CanonicalMemory {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(source);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error("Canonical Memory must contain YAML frontmatter.");
  }
  const frontmatter = frontmatterSchema.parse(parse(match[1])).memstore;
  const scope =
    frontmatter.scope.kind === "global"
      ? ({ kind: "global" } as const)
      : ({ kind: "project", projectId: frontmatter.scope.project_id } as const);
  const legacyCategory = frontmatter.primary_category === undefined
    ? z.string().parse(frontmatter.category)
    : undefined;
  const legacyMapping = legacyCategory === undefined || legacyCategory === "tombstone"
    ? undefined
    : mapLegacyCategory(legacyCategory, frontmatter.importance_tags);
  const parsedPrimaryCategory: MemoryCategory | "tombstone" =
    frontmatter.primary_category ??
    (legacyCategory === "tombstone"
      ? "tombstone"
      : legacyMapping?.primaryCategory ?? "durable_reference");
  const parsedCategoryTags = frontmatter.category_tags ??
    (parsedPrimaryCategory === "tombstone"
      ? []
      : legacyMapping?.categoryTags ?? [parsedPrimaryCategory]);
  const memory: CanonicalMemory = {
    schemaVersion: 1,
    memoryId: frontmatter.memory_id,
    ...(frontmatter.memory_ref === undefined ? {} : { memoryRef: frontmatter.memory_ref }),
    revisionId: frontmatter.revision_id,
    scope,
    authority: frontmatter.authority,
    originKind: frontmatter.origin_kind,
    sensitivity: frontmatter.sensitivity,
    lifecycle: frontmatter.lifecycle,
    lifecycleDetails: {
      ...(frontmatter.lifecycle_details.archived_at === undefined
        ? {}
        : { archivedAt: frontmatter.lifecycle_details.archived_at }),
      ...(frontmatter.lifecycle_details.tombstoned_at === undefined
        ? {}
        : { tombstonedAt: frontmatter.lifecycle_details.tombstoned_at }),
      ...(frontmatter.lifecycle_details.reason === undefined
        ? {}
        : { reason: frontmatter.lifecycle_details.reason }),
      ...(frontmatter.lifecycle_details.purge_after === undefined
        ? {}
        : { purgeAfter: frontmatter.lifecycle_details.purge_after }),
      ...(frontmatter.lifecycle_details.retain_forever === undefined
        ? {}
        : { retainForever: frontmatter.lifecycle_details.retain_forever }),
      ...(frontmatter.lifecycle_details.pinned === undefined
        ? {}
        : { pinned: frontmatter.lifecycle_details.pinned }),
      ...(frontmatter.lifecycle_details.purged_content_identity === undefined
        ? {}
        : { purgedContentIdentity: frontmatter.lifecycle_details.purged_content_identity }),
      ...(frontmatter.lifecycle_details.purged_revision_ids === undefined
        ? {}
        : { purgedRevisionIds: frontmatter.lifecycle_details.purged_revision_ids })
    },
    primaryCategory: parsedPrimaryCategory,
    categoryTags: parsedCategoryTags,
    importanceTags: frontmatter.importance_tags,
    startup: frontmatter.startup,
    applicability: {
      summary: frontmatter.applicability.summary,
      conditions: frontmatter.applicability.conditions
    },
    validity: {
      state: frontmatter.validity.state,
      ...(frontmatter.validity.valid_from === undefined
        ? {}
        : { validFrom: frontmatter.validity.valid_from }),
      ...(frontmatter.validity.valid_until === undefined
        ? {}
        : { validUntil: frontmatter.validity.valid_until })
    },
    createdAt: frontmatter.created_at,
    revisedAt: frontmatter.revised_at,
    semanticContract: {
      schemaVersion: 1,
      claims: frontmatter.semantic_contract.claims,
      conditions: frontmatter.semantic_contract.conditions,
      exclusions: frontmatter.semantic_contract.exclusions,
      preservedNegations: frontmatter.semantic_contract.preserved_negations
    },
    representations: {
      ...(frontmatter.representations.identity === undefined
        ? {}
        : {
            identity: {
              label: frontmatter.representations.identity.label,
              validated: frontmatter.representations.identity.validated,
              generatorIdentity: frontmatter.representations.identity.generator_identity,
              sourceRevisionId: frontmatter.representations.identity.source_revision_id,
              renderedTokenCount: frontmatter.representations.identity.rendered_token_count
            }
          }),
      compact: {
        text: frontmatter.representations.compact.text,
        validated: frontmatter.representations.compact.validated,
        generatorIdentity: frontmatter.representations.compact.generator_identity,
        sourceRevisionId: frontmatter.representations.compact.source_revision_id,
        renderedTokenCount: frontmatter.representations.compact.rendered_token_count
      },
      standard: {
        text: frontmatter.representations.standard.text,
        validated: frontmatter.representations.standard.validated,
        generatorIdentity: frontmatter.representations.standard.generator_identity,
        sourceRevisionId: frontmatter.representations.standard.source_revision_id,
        renderedTokenCount: frontmatter.representations.standard.rendered_token_count
      }
    },
    provenance: frontmatter.provenance,
    injectionReceiptIds: frontmatter.injection_receipt_ids,
    relationships: frontmatter.relationships.map((relationship) => ({
      type: relationship.type,
      targetMemoryId: relationship.target_memory_id
    })),
    ...(frontmatter.predecessor_memory_id === undefined
      ? {}
      : { predecessorMemoryId: frontmatter.predecessor_memory_id }),
    ...(frontmatter.successor_memory_id === undefined
      ? {}
      : { successorMemoryId: frontmatter.successor_memory_id }),
    ...(frontmatter.predecessor_revision_id === undefined
      ? {}
      : { predecessorRevisionId: frontmatter.predecessor_revision_id }),
    contentIdentity: frontmatter.content_identity,
    policyVersion: frontmatter.policy_version,
    body: match[2].trimEnd()
  };
  validateCanonicalIdentity(memory);
  return memory;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function requireReconciledCatalog(
  runtimeRoot: string,
  memoryId: string,
  revisionId: string,
  observedContentIdentity: string
): Promise<void> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const row = database
      .prepare(
        `SELECT current_revision_id, content_identity
         FROM memory_catalog WHERE memory_id = ?`
      )
      .get(memoryId);
    if (
      row === undefined ||
      row.current_revision_id !== revisionId ||
      row.content_identity !== observedContentIdentity
    ) {
      throw new Error(
        "Canonical Memory requires reconciliation before an Agent revision."
      );
    }
  } finally {
    database.close();
  }
}

export async function writeCanonicalMemory(
  request: WriteCanonicalMemoryRequest
): Promise<CanonicalWriteResult> {
  validateCanonicalIdentity(request.memory);
  if (
    (request.actor === "human" && request.memory.authority !== "human_authored") ||
    (request.actor === "agent" && request.memory.authority !== "agent_derived")
  ) {
    throw new Error("Canonical authority must match the write actor.");
  }
  const sensitivity = classifyLocalSensitivity(JSON.stringify(request.memory));
  if (sensitivity.state === "secret") {
    throw new SecretContentError(sensitivity.category);
  }
  if (sensitivity.state === "uncertain") {
    throw new Error("Uncertain sensitive content requires explicit review.");
  }
  const memoryRef = await reserveMemoryRef(
    request.runtimeRoot,
    request.memory.memoryId,
    request.memory.memoryRef
  );
  request = {
    ...request,
    memory: { ...request.memory, memoryRef }
  };
  const vaultRoot = resolve(request.vaultRoot);
  const path = canonicalPath(vaultRoot, request.memory);
  const alreadyExists = await exists(path);
  if (alreadyExists) {
    const previousSource = await readFile(path, "utf8");
    const observedIdentity = contentIdentity(previousSource);
    const observedFileIdentity = fileIdentity(previousSource);
    if (request.expectedContentIdentity !== observedIdentity) {
      const database = await openRuntimeDatabase(request.runtimeRoot);
      try {
        database
          .prepare(
            `INSERT INTO vault_conflicts(
               conflict_id, memory_id, expected_content_identity,
               observed_content_identity, detected_at, state
             ) VALUES (?, ?, ?, ?, ?, 'open')`
          )
          .run(
            `msvaultconflict_${randomUUID()}`,
            request.memory.memoryId,
            request.expectedContentIdentity ?? null,
            observedIdentity,
            new Date().toISOString()
          );
      } finally {
        database.close();
      }
      throw new VaultRevisionConflictError(
        request.expectedContentIdentity,
        observedIdentity
      );
    }

    const previousMemory = parseCanonical(previousSource);
    if (previousMemory.memoryId !== request.memory.memoryId) {
      throw new Error("Canonical path belongs to another Memory identity.");
    }
    if (!sameScope(previousMemory.scope, request.memory.scope)) {
      throw new Error("A Canonical revision cannot change Memory scope.");
    }
    if (previousMemory.revisionId === request.memory.revisionId) {
      throw new Error("A revision must use a new revision identity.");
    }
    await requireReconciledCatalog(
      request.runtimeRoot,
      request.memory.memoryId,
      previousMemory.revisionId,
      observedIdentity
    );
    if (request.actor === "agent" && previousMemory.authority === "human_authored") {
      throw new Error("An Agent cannot replace Human-authored Canonical Memory.");
    }
    if (request.memory.predecessorRevisionId !== previousMemory.revisionId) {
      throw new Error("A Canonical revision must identify its predecessor revision.");
    }
    const revisedSource = render(request.memory, previousSource);
    const renderedSensitivity = classifyLocalSensitivity(revisedSource);
    if (renderedSensitivity.state === "secret") {
      throw new SecretContentError(renderedSensitivity.category);
    }
    if (renderedSensitivity.state === "uncertain") {
      throw new Error("Rendered Canonical Memory requires explicit review.");
    }
    const revisedIdentity = contentIdentity(revisedSource);
    if (request.memory.scope.kind === "project") {
      await ensurePortableProjectCatalog(
        vaultRoot,
        request.runtimeRoot,
        request.memory.scope.projectId
      );
    }
    const revisionPath = canonicalRevisionPath(
      vaultRoot,
      request.memory.memoryId,
      previousMemory.revisionId
    );
    await mkdir(dirname(revisionPath), { recursive: true, mode: 0o700 });
    if (!(await exists(revisionPath))) {
      await writeFileAtomicallyExclusive(revisionPath, previousSource, 0o600);
    }

    await writeFileAtomically(path, revisedSource, 0o600, observedFileIdentity);
    const revisedRevisionPath = canonicalRevisionPath(
      vaultRoot,
      request.memory.memoryId,
      request.memory.revisionId
    );
    await mkdir(dirname(revisedRevisionPath), { recursive: true, mode: 0o700 });
    await writeFileAtomicallyExclusive(revisedRevisionPath, revisedSource, 0o600);
    const verifiedSource = await readFile(path, "utf8");
    const verified = parseCanonical(verifiedSource);
    if (
      verified.memoryId !== request.memory.memoryId ||
      verified.revisionId !== request.memory.revisionId ||
      contentIdentity(verifiedSource) !== revisedIdentity
    ) {
      throw new Error("Canonical Memory revision read-back verification failed.");
    }

    const database = await openRuntimeDatabase(request.runtimeRoot);
    try {
      database.exec("BEGIN IMMEDIATE");
      try {
        database
          .prepare(
            `INSERT OR IGNORE INTO memory_revisions(
               revision_id, memory_id, predecessor_revision_id,
               revision_path, content_identity, created_at
             ) VALUES (?, ?, NULL, ?, ?, ?)`
          )
          .run(
            previousMemory.revisionId,
            previousMemory.memoryId,
            revisionPath,
            observedIdentity,
            previousMemory.revisedAt
          );
        database
          .prepare(
            `INSERT INTO memory_revisions(
               revision_id, memory_id, predecessor_revision_id,
               revision_path, content_identity, created_at
             ) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            request.memory.revisionId,
            request.memory.memoryId,
            previousMemory.revisionId,
            revisedRevisionPath,
            revisedIdentity,
            request.memory.revisedAt
          );
        const catalogUpdate = database
          .prepare(
            `UPDATE memory_catalog
             SET current_revision_id = ?, authority = ?, sensitivity = ?,
                 lifecycle = ?, content_identity = ?, revised_at = ?,
                 catalog_updated_at = ?
             WHERE memory_id = ? AND content_identity = ?`
          )
          .run(
            request.memory.revisionId,
            request.memory.authority,
            request.memory.sensitivity,
            request.memory.lifecycle,
            revisedIdentity,
            request.memory.revisedAt,
            new Date().toISOString(),
            request.memory.memoryId,
            observedIdentity
          );
        if (catalogUpdate.changes !== 1) {
          throw new Error("Canonical catalog revision precondition failed.");
        }
        replaceCatalogRelationships(database, request.memory);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }

    return {
      state: "revised",
      memoryId: request.memory.memoryId,
      memoryRef,
      revisionId: request.memory.revisionId,
      path,
      contentIdentity: revisedIdentity
    };
  }
  if (request.expectedContentIdentity !== undefined) {
    throw new Error("A create operation cannot specify expectedContentIdentity.");
  }
  if (request.memory.predecessorRevisionId !== undefined) {
    throw new Error("An initial Canonical revision cannot have a predecessor.");
  }
  const existingDatabase = await openRuntimeDatabase(request.runtimeRoot);
  try {
    if (
      existingDatabase
        .prepare("SELECT 1 FROM memory_catalog WHERE memory_id = ?")
        .get(request.memory.memoryId) !== undefined
    ) {
      throw new Error(
        "Canonical catalog already owns this Memory identity at another path."
      );
    }
  } finally {
    existingDatabase.close();
  }
  if (request.memory.scope.kind === "project") {
    await ensurePortableProjectCatalog(
      vaultRoot,
      request.runtimeRoot,
      request.memory.scope.projectId
    );
  }

  const source = render(request.memory);
  const renderedSensitivity = classifyLocalSensitivity(source);
  if (renderedSensitivity.state === "secret") {
    throw new SecretContentError(renderedSensitivity.category);
  }
  if (renderedSensitivity.state === "uncertain") {
    throw new Error("Rendered Canonical Memory requires explicit review.");
  }
  const identity = contentIdentity(source);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomicallyExclusive(path, source, 0o600);
  const revisionPath = canonicalRevisionPath(
    vaultRoot,
    request.memory.memoryId,
    request.memory.revisionId
  );
  await mkdir(dirname(revisionPath), { recursive: true, mode: 0o700 });
  await writeFileAtomicallyExclusive(revisionPath, source, 0o600);
  const verifiedSource = await readFile(path, "utf8");
  const verified = parseCanonical(verifiedSource);
  if (
    verified.memoryId !== request.memory.memoryId ||
    verified.revisionId !== request.memory.revisionId ||
    contentIdentity(verifiedSource) !== identity
  ) {
    throw new Error("Canonical Memory read-back verification failed.");
  }

  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          `INSERT INTO memory_catalog(
             memory_id, memory_ref, current_revision_id, canonical_path, scope_kind,
             project_id, authority, sensitivity, lifecycle, content_identity,
             revised_at, catalog_updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          request.memory.memoryId,
          memoryRef,
          request.memory.revisionId,
          path,
          request.memory.scope.kind,
          request.memory.scope.kind === "project"
            ? request.memory.scope.projectId
            : null,
          request.memory.authority,
          request.memory.sensitivity,
          request.memory.lifecycle,
          identity,
          request.memory.revisedAt,
          now
        );
      database
        .prepare(
          `INSERT INTO memory_revisions(
             revision_id, memory_id, predecessor_revision_id,
             revision_path, content_identity, created_at
           ) VALUES (?, ?, NULL, ?, ?, ?)`
        )
        .run(
          request.memory.revisionId,
          request.memory.memoryId,
          revisionPath,
          identity,
          request.memory.revisedAt
        );
      replaceCatalogRelationships(database, request.memory);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }

  return {
    state: "created",
    memoryId: request.memory.memoryId,
    memoryRef,
    revisionId: request.memory.revisionId,
    path,
    contentIdentity: identity
  };
}

export interface ReconcileCanonicalMemoryRequest {
  readonly vaultRoot: string;
  readonly runtimeRoot: string;
  readonly memoryId: string;
  readonly observedAt: string;
}

async function listMarkdownFiles(directory: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return listMarkdownFiles(path);
      return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
    })
  );
  return nested.flat();
}

export interface RebuildCanonicalCatalogRequest {
  readonly vaultRoot: string;
  readonly runtimeRoot: string;
}

export interface BackfillPortableMemoryRefsResult {
  readonly scanned: number;
  readonly updated: number;
}

export async function backfillPortableMemoryRefs(request: {
  readonly vaultRoot: string;
  readonly runtimeRoot: string;
}): Promise<BackfillPortableMemoryRefsResult> {
  const vaultRoot = resolve(request.vaultRoot);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let rows: readonly Record<string, unknown>[];
  try {
    rows = database.prepare(
      `SELECT memory_id, memory_ref, canonical_path, scope_kind, project_id
       FROM memory_catalog
       ORDER BY memory_ref`
    ).all();
  } finally {
    database.close();
  }

  let updated = 0;
  for (const row of rows) {
    const memoryId = memoryIdSchema.parse(row.memory_id);
    const memoryRef = memoryRefSchema.parse(row.memory_ref);
    const path = canonicalPathFromCatalogScope(
      vaultRoot,
      memoryId,
      row.scope_kind,
      row.project_id
    );
    if (resolve(z.string().parse(row.canonical_path)) !== path) {
      throw new Error("Canonical catalog path is outside its derived Vault location.");
    }
    const source = await readFile(path, "utf8");
    const memory = parseCanonical(source);
    if (memory.memoryId !== memoryId) {
      throw new Error("Canonical Memory path does not match its identity.");
    }
    if (memory.memoryRef !== undefined && memory.memoryRef !== memoryRef) {
      throw new Error("Canonical Memory cannot change its portable reference.");
    }
    if (memory.memoryRef === memoryRef) continue;
    const upgraded = render({ ...memory, memoryRef }, source);
    if (contentIdentity(upgraded) !== contentIdentity(source)) {
      throw new Error("Portable Memory reference changed Canonical content identity.");
    }
    await writeFileAtomically(path, upgraded, 0o600, fileIdentity(source));
    updated += 1;
  }
  return { scanned: rows.length, updated };
}

export interface RebuildCanonicalCatalogResult {
  readonly state: "rebuilt";
  readonly memoryCount: number;
  readonly revisionCount: number;
}

export async function rebuildCanonicalCatalog(
  request: RebuildCanonicalCatalogRequest
): Promise<RebuildCanonicalCatalogResult> {
  const vaultRoot = resolve(request.vaultRoot);
  const currentPaths = await listMarkdownFiles(join(vaultRoot, "Memories"));
  const discovered = await Promise.all(
    currentPaths.map(async (path) => {
      const source = await readFile(path, "utf8");
      if (classifyLocalSensitivity(source).state !== "normal") {
        throw new Error("Canonical catalog rebuild encountered sensitive content.");
      }
      const memory = parseCanonical(source);
      if (canonicalPath(vaultRoot, memory) !== resolve(path)) {
        throw new Error("Canonical Memory path does not match its identity.");
      }
      return {
        path,
        source,
        memory,
        identity: contentIdentity(source),
        fileIdentity: fileIdentity(source)
      };
    })
  );
  const current = await Promise.all(discovered.map(async (item) => {
    const memoryRef = await reserveMemoryRef(
      request.runtimeRoot,
      item.memory.memoryId,
      item.memory.memoryRef
    );
    if (item.memory.memoryRef === memoryRef) return item;
    const memory = { ...item.memory, memoryRef };
    const source = render(memory, item.source);
    const identity = contentIdentity(source);
    if (identity !== item.identity) {
      throw new Error("Portable Memory reference changed Canonical content identity.");
    }
    await writeFileAtomically(item.path, source, 0o600, item.fileIdentity);
    return {
      ...item,
      source,
      memory,
      identity,
      fileIdentity: fileIdentity(source)
    };
  }));
  const knownMemoryIds = new Set<string>();
  for (const item of current) {
    if (knownMemoryIds.has(item.memory.memoryId)) {
      throw new Error("Canonical Vault contains a duplicate Memory identity.");
    }
    knownMemoryIds.add(item.memory.memoryId);
  }

  const catalogSnapshot = await Promise.all(
    current.map(async (item) => {
      const revisionFiles = await listMarkdownFiles(
        join(vaultRoot, "_MemStore", "Revisions", item.memory.memoryId)
      );
      const revisions = await Promise.all(
        revisionFiles.map(async (revisionPath) => {
          const revisionSource = await readFile(revisionPath, "utf8");
          if (classifyLocalSensitivity(revisionSource).state !== "normal") {
            throw new Error("Canonical revision rebuild encountered sensitive content.");
          }
          const revision = parseCanonical(revisionSource);
          if (revision.memoryId !== item.memory.memoryId) {
            throw new Error("Revision path belongs to another Memory identity.");
          }
          if (
            canonicalRevisionPath(
              vaultRoot,
              revision.memoryId,
              revision.revisionId
            ) !== resolve(revisionPath)
          ) {
            throw new Error("Canonical revision path does not match its identity.");
          }
          return {
            path: revisionPath,
            memory: revision,
            identity: contentIdentity(revisionSource),
            fileIdentity: fileIdentity(revisionSource)
          };
        })
      );
      if (item.memory.lifecycle === "tombstone") {
        if (revisions.some((revision) =>
          revision.memory.lifecycle !== "tombstone" ||
          revision.memory.body.length > 0
        )) {
          throw new Error("Tombstone catalog rebuild found a retained knowledge revision.");
        }
        return { ...item, revisions: [] };
      }
      const matchingCurrentRevision = revisions.find(
        (revision) => revision.memory.revisionId === item.memory.revisionId
      );
      let currentItem = item;
      if (
        matchingCurrentRevision !== undefined &&
        matchingCurrentRevision.identity !== item.identity
      ) {
        const manualRevision: CanonicalMemory = {
          ...item.memory,
          revisionId: `msrev_${randomUUID()}`,
          authority: "human_authored",
          originKind: "manual_edit",
          predecessorRevisionId: item.memory.revisionId,
          revisedAt: new Date().toISOString(),
          representations: {
            ...(item.memory.representations.identity === undefined
              ? {}
              : {
                  identity: {
                    ...item.memory.representations.identity,
                    validated: false
                  }
                }),
            compact: { ...item.memory.representations.compact, validated: false },
            standard: { ...item.memory.representations.standard, validated: false }
          }
        };
        const manualSource = render(manualRevision, item.source);
        const manualIdentity = contentIdentity(manualSource);
        const manualFileIdentity = fileIdentity(manualSource);
        const manualRevisionPath = canonicalRevisionPath(
          vaultRoot,
          manualRevision.memoryId,
          manualRevision.revisionId
        );
        await writeFileAtomically(
          item.path,
          manualSource,
          0o600,
          item.fileIdentity
        );
        await mkdir(dirname(manualRevisionPath), { recursive: true, mode: 0o700 });
        await writeFileAtomicallyExclusive(
          manualRevisionPath,
          manualSource,
          0o600
        );
        revisions.push({
          path: manualRevisionPath,
          memory: manualRevision,
          identity: manualIdentity,
          fileIdentity: manualFileIdentity
        });
        currentItem = {
          path: item.path,
          source: manualSource,
          memory: manualRevision,
          identity: manualIdentity,
          fileIdentity: manualFileIdentity
        };
      } else if (matchingCurrentRevision === undefined) {
        const recoveredRevisionPath = canonicalRevisionPath(
          vaultRoot,
          item.memory.memoryId,
          item.memory.revisionId
        );
        await mkdir(dirname(recoveredRevisionPath), { recursive: true, mode: 0o700 });
        await writeFileAtomicallyExclusive(
          recoveredRevisionPath,
          item.source,
          0o600
        );
        revisions.push({
          path: recoveredRevisionPath,
          memory: item.memory,
          identity: item.identity,
          fileIdentity: item.fileIdentity
        });
      }
      return { ...currentItem, revisions };
    })
  );

  const database = await openRuntimeDatabase(request.runtimeRoot);
  const revisionCount = catalogSnapshot.reduce(
    (count, item) => count + item.revisions.length,
    0
  );
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(
        "DELETE FROM memory_relationships; DELETE FROM memory_revisions; DELETE FROM memory_catalog"
      );
      for (const item of catalogSnapshot) {
        database
          .prepare(
            `INSERT INTO memory_catalog(
               memory_id, memory_ref, current_revision_id, canonical_path, scope_kind,
               project_id, authority, sensitivity, lifecycle, content_identity,
               revised_at, catalog_updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            item.memory.memoryId,
            memoryRefSchema.parse(item.memory.memoryRef),
            item.memory.revisionId,
            item.path,
            item.memory.scope.kind,
            item.memory.scope.kind === "project" ? item.memory.scope.projectId : null,
            item.memory.authority,
            item.memory.sensitivity,
            item.memory.lifecycle,
            item.identity,
            item.memory.revisedAt,
            new Date().toISOString()
          );
        for (const revision of item.revisions) {
          database
            .prepare(
              `INSERT INTO memory_revisions(
                 revision_id, memory_id, predecessor_revision_id,
                 revision_path, content_identity, created_at
               ) VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(
              revision.memory.revisionId,
              revision.memory.memoryId,
              revision.memory.predecessorRevisionId ?? null,
              revision.path,
              revision.identity,
              revision.memory.revisedAt
            );
        }
        for (const relationship of item.memory.relationships) {
          database
            .prepare(
              `INSERT INTO memory_relationships(
                 source_memory_id, target_memory_id, relationship_type,
                 source_revision_id
               ) VALUES (?, ?, ?, ?)`
            )
            .run(
              item.memory.memoryId,
              relationship.targetMemoryId,
              relationship.type,
              item.memory.revisionId
            );
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
  return { state: "rebuilt", memoryCount: current.length, revisionCount };
}

export type ReconcileCanonicalMemoryResult =
  | { readonly state: "unchanged"; readonly memoryId: string }
  | {
      readonly state: "manual_revision";
      readonly memoryId: string;
      readonly previousRevisionId: string;
      readonly revisionId: string;
      readonly contentIdentity: string;
    }
  | {
      readonly state: "excluded_secret";
      readonly memoryId: string;
      readonly category: string;
    };

export async function reconcileCanonicalMemory(
  request: ReconcileCanonicalMemoryRequest
): Promise<ReconcileCanonicalMemoryResult> {
  const observedAt = z.iso.datetime().parse(request.observedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let path: string;
  let catalogIdentity: string;
  let catalogRevisionId: string;
  let catalogMemoryRef: number;
  try {
    const row = database
      .prepare(
        `SELECT canonical_path, scope_kind, project_id, content_identity,
                current_revision_id, memory_ref
         FROM memory_catalog WHERE memory_id = ?`
      )
      .get(request.memoryId);
    if (
      row === undefined ||
      typeof row.canonical_path !== "string" ||
      typeof row.content_identity !== "string" ||
      typeof row.current_revision_id !== "string"
    ) {
      throw new Error("Canonical Memory is not present in the Runtime catalog.");
    }
    path = canonicalPathFromCatalogScope(
      request.vaultRoot,
      request.memoryId,
      row.scope_kind,
      row.project_id
    );
    if (resolve(row.canonical_path) !== path) {
      throw new Error("Canonical catalog path is outside its derived Vault location.");
    }
    catalogIdentity = row.content_identity;
    catalogRevisionId = row.current_revision_id;
    catalogMemoryRef = memoryRefSchema.parse(row.memory_ref);
  } finally {
    database.close();
  }

  const editedSource = await readFile(path, "utf8");
  const editedIdentity = contentIdentity(editedSource);
  const editedFileIdentity = fileIdentity(editedSource);
  if (editedIdentity === catalogIdentity) {
    const editedMemory = parseCanonical(editedSource);
    if (
      editedMemory.memoryRef !== undefined &&
      editedMemory.memoryRef !== catalogMemoryRef
    ) {
      throw new Error("Manual edit changed the portable Memory reference.");
    }
    return { state: "unchanged", memoryId: request.memoryId };
  }
  const sensitivity = classifyLocalSensitivity(editedSource);
  if (sensitivity.state === "secret") {
    return {
      state: "excluded_secret",
      memoryId: request.memoryId,
      category: sensitivity.category
    };
  }
  if (sensitivity.state === "uncertain") {
    return {
      state: "excluded_secret",
      memoryId: request.memoryId,
      category: sensitivity.category
    };
  }

  const editedMemory = parseCanonical(editedSource);
  if (
    editedMemory.memoryId !== request.memoryId ||
    editedMemory.revisionId !== catalogRevisionId
  ) {
    throw new Error("Manual edit changed Canonical identity metadata.");
  }
  if (
    editedMemory.memoryRef !== undefined &&
    editedMemory.memoryRef !== catalogMemoryRef
  ) {
    throw new Error("Manual edit changed the portable Memory reference.");
  }
  if (canonicalPath(resolve(request.vaultRoot), editedMemory) !== path) {
    throw new Error("Manual edit cannot change Canonical Memory scope.");
  }
  const revisionId = `msrev_${randomUUID()}`;
  const manualRevision: CanonicalMemory = {
    ...editedMemory,
    revisionId,
    authority: "human_authored",
    originKind: "manual_edit",
    predecessorRevisionId: catalogRevisionId,
    revisedAt: observedAt,
    representations: {
      ...(editedMemory.representations.identity === undefined
        ? {}
        : {
            identity: {
              ...editedMemory.representations.identity,
              validated: false
            }
          }),
      compact: { ...editedMemory.representations.compact, validated: false },
      standard: { ...editedMemory.representations.standard, validated: false }
    }
  };
  const source = render(manualRevision, editedSource);
  const identity = contentIdentity(source);
  const revisionPath = canonicalRevisionPath(
    resolve(request.vaultRoot),
    request.memoryId,
    revisionId
  );
  await writeFileAtomically(path, source, 0o600, editedFileIdentity);
  await mkdir(dirname(revisionPath), { recursive: true, mode: 0o700 });
  await writeFileAtomicallyExclusive(revisionPath, source, 0o600);
  const verifiedSource = await readFile(path, "utf8");
  const verified = parseCanonical(verifiedSource);
  if (
    verified.memoryId !== request.memoryId ||
    verified.revisionId !== revisionId ||
    contentIdentity(verifiedSource) !== identity
  ) {
    throw new Error("Manual Canonical revision read-back verification failed.");
  }

  const updateDatabase = await openRuntimeDatabase(request.runtimeRoot);
  try {
    updateDatabase.exec("BEGIN IMMEDIATE");
    try {
      updateDatabase
        .prepare(
          `INSERT INTO memory_revisions(
             revision_id, memory_id, predecessor_revision_id,
             revision_path, content_identity, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          revisionId,
          request.memoryId,
          catalogRevisionId,
          revisionPath,
          identity,
          observedAt
        );
      const catalogUpdate = updateDatabase
        .prepare(
          `UPDATE memory_catalog
           SET current_revision_id = ?, authority = 'human_authored',
               sensitivity = ?, lifecycle = ?, content_identity = ?,
               revised_at = ?, catalog_updated_at = ?
           WHERE memory_id = ? AND content_identity = ?`
        )
        .run(
          revisionId,
          manualRevision.sensitivity,
          manualRevision.lifecycle,
          identity,
          observedAt,
          new Date().toISOString(),
          request.memoryId,
          catalogIdentity
        );
      if (catalogUpdate.changes !== 1) {
        throw new Error("Manual revision catalog precondition failed.");
      }
      replaceCatalogRelationships(updateDatabase, manualRevision);
      updateDatabase.exec("COMMIT");
    } catch (error) {
      updateDatabase.exec("ROLLBACK");
      throw error;
    }
  } finally {
    updateDatabase.close();
  }

  return {
    state: "manual_revision",
    memoryId: request.memoryId,
    previousRevisionId: catalogRevisionId,
    revisionId,
    contentIdentity: identity
  };
}

export interface ReadCanonicalRevisionRequest {
  readonly vaultRoot: string;
  readonly runtimeRoot: string;
  readonly memoryId: string;
  readonly revisionId: string;
}

export async function readCanonicalRevision(
  request: ReadCanonicalRevisionRequest
): Promise<CanonicalReadResult | undefined> {
  memoryIdSchema.parse(request.memoryId);
  revisionIdSchema.parse(request.revisionId);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  const path = canonicalRevisionPath(
    resolve(request.vaultRoot),
    request.memoryId,
    request.revisionId
  );
  try {
    const row = database
      .prepare(
        `SELECT revision_path FROM memory_revisions
         WHERE memory_id = ? AND revision_id = ?`
      )
      .get(request.memoryId, request.revisionId);
    if (row === undefined) {
      return undefined;
    }
    if (
      typeof row.revision_path !== "string" ||
      resolve(row.revision_path) !== path
    ) {
      throw new Error("Canonical revision catalog contains an invalid path.");
    }
  } finally {
    database.close();
  }
  const source = await readFile(path, "utf8");
  const parsedMemory = parseCanonical(source);
  const identity = contentIdentity(source);
  const memory = { ...parsedMemory, contentIdentity: identity };
  if (
    memory.memoryId !== request.memoryId ||
    memory.revisionId !== request.revisionId
  ) {
    throw new Error("Canonical revision path points to a different identity.");
  }
  return { memory, path, contentIdentity: identity };
}

export interface ReadCanonicalMemoryRequest {
  readonly vaultRoot: string;
  readonly runtimeRoot: string;
  readonly memoryId: string;
}

export interface CanonicalReadResult {
  readonly memory: CanonicalMemory;
  readonly path: string;
  readonly contentIdentity: string;
}

export async function readCanonicalMemory(
  request: ReadCanonicalMemoryRequest
): Promise<CanonicalReadResult | undefined> {
  memoryIdSchema.parse(request.memoryId);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let path: string | undefined;
  try {
    const row = database
      .prepare(
        `SELECT canonical_path, scope_kind, project_id
         FROM memory_catalog WHERE memory_id = ?`
      )
      .get(request.memoryId);
    if (row === undefined) {
      return undefined;
    }
    if (typeof row.canonical_path !== "string") {
      throw new Error("Canonical catalog contains an invalid path.");
    }
    path = canonicalPathFromCatalogScope(
      request.vaultRoot,
      request.memoryId,
      row.scope_kind,
      row.project_id
    );
    if (resolve(row.canonical_path) !== path) {
      throw new Error("Canonical catalog path is outside its derived Vault location.");
    }
  } finally {
    database.close();
  }
  const source = await readFile(path, "utf8");
  const parsedMemory = parseCanonical(source);
  const identity = contentIdentity(source);
  const memory = { ...parsedMemory, contentIdentity: identity };
  if (memory.memoryId !== request.memoryId) {
    throw new Error("Canonical path points to a different Memory identity.");
  }
  return { memory, path, contentIdentity: identity };
}

export async function inspectStandaloneCanonicalFile(
  path: string
): Promise<CanonicalReadResult> {
  const resolvedPath = resolve(path);
  const source = await readFile(resolvedPath, "utf8");
  const parsedMemory = parseCanonical(source);
  const identity = contentIdentity(source);
  return {
    memory: { ...parsedMemory, contentIdentity: identity },
    path: resolvedPath,
    contentIdentity: identity
  };
}

export function renderCanonicalCategoryMigration(request: {
  readonly source: string;
  readonly primaryCategory: MemoryCategory;
  readonly categoryTags: readonly MemoryCategory[];
  readonly policyVersion: string;
}): {
  readonly source: string;
  readonly contentIdentity: string;
} {
  const memory = parseCanonical(request.source);
  if (memory.lifecycle === "tombstone") {
    throw new Error("Tombstone revisions cannot carry migrated knowledge categories.");
  }
  const migrated: CanonicalMemory = {
    ...memory,
    primaryCategory: request.primaryCategory,
    categoryTags: [...request.categoryTags],
    policyVersion: request.policyVersion
  };
  const source = render(migrated, request.source);
  return { source, contentIdentity: contentIdentity(source) };
}

export type CanonicalPurgeCheckpoint =
  | "tombstone_written"
  | "revision_bodies_removed"
  | "catalog_committed"
  | "derived_indexes_removed";

export async function purgeArchivedCanonicalBody(request: {
  readonly vaultRoot: string;
  readonly runtimeRoot: string;
  readonly memoryId: string;
  readonly expectedContentIdentity: string;
  readonly purgedAt: string;
  readonly reason: string;
  readonly onCheckpoint?: (
    checkpoint: CanonicalPurgeCheckpoint,
    result: { readonly tombstoneContentIdentity: string }
  ) => Promise<void>;
}): Promise<{
  readonly state: "purged";
  readonly memoryId: string;
  readonly tombstoneContentIdentity: string;
  readonly purgedRevisionIds: readonly string[];
}> {
  memoryIdSchema.parse(request.memoryId);
  z.string().regex(/^[0-9a-f]{64}$/u).parse(request.expectedContentIdentity);
  const purgedAt = z.iso.datetime().parse(request.purgedAt);
  const vaultRoot = resolve(request.vaultRoot);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let path: string;
  let revisionIds: string[];
  let affectedIndexes: { readonly indexRevisionId: string; readonly directoryPath: string }[];
  try {
    const row = database.prepare(
      `SELECT canonical_path, scope_kind, project_id
       FROM memory_catalog WHERE memory_id = ?`
    ).get(request.memoryId);
    if (row === undefined || typeof row.canonical_path !== "string") {
      throw new Error("Purge target is missing from the Canonical catalog.");
    }
    path = canonicalPathFromCatalogScope(
      vaultRoot,
      request.memoryId,
      row.scope_kind,
      row.project_id
    );
    if (resolve(row.canonical_path) !== path) {
      throw new Error("Purge target path is outside its derived Vault location.");
    }
    revisionIds = database.prepare(
      `SELECT revision_id FROM memory_revisions
       WHERE memory_id = ? ORDER BY created_at, revision_id`
    ).all(request.memoryId).map((revision) => revisionIdSchema.parse(revision.revision_id));
    affectedIndexes = database.prepare(
      `SELECT DISTINCT revision.index_revision_id, revision.directory_path
       FROM retrieval_index_revisions AS revision
       LEFT JOIN retrieval_documents AS document
         ON revision.index_revision_id = document.index_revision_id
       WHERE document.memory_id = ? OR revision.state = 'failed'`
    ).all(request.memoryId).map((index) => ({
      indexRevisionId: z.string().parse(index.index_revision_id),
      directoryPath: z.string().parse(index.directory_path)
    }));
  } finally {
    database.close();
  }

  const previousSource = await readFile(path, "utf8");
  const previous = parseCanonical(previousSource);
  const observedIdentity = contentIdentity(previousSource);
  let tombstone: CanonicalMemory;
  let tombstoneSource: string;
  let tombstoneIdentity: string;
  if (previous.lifecycle === "tombstone") {
    if (previous.lifecycleDetails.purgedContentIdentity !== request.expectedContentIdentity) {
      throw new VaultRevisionConflictError(
        request.expectedContentIdentity,
        previous.lifecycleDetails.purgedContentIdentity ?? observedIdentity
      );
    }
    tombstone = previous;
    tombstoneSource = previousSource;
    tombstoneIdentity = observedIdentity;
    revisionIds = [...(previous.lifecycleDetails.purgedRevisionIds ?? revisionIds)];
  } else {
    if (previous.lifecycle !== "archived") {
      throw new Error("Purge target is no longer archived.");
    }
    if (observedIdentity !== request.expectedContentIdentity) {
      throw new VaultRevisionConflictError(
        request.expectedContentIdentity,
        observedIdentity
      );
    }
    if (!revisionIds.includes(previous.revisionId)) revisionIds.push(previous.revisionId);
    tombstone = {
      ...previous,
      lifecycle: "tombstone",
      lifecycleDetails: {
        archivedAt: z.iso.datetime().parse(previous.lifecycleDetails.archivedAt),
        tombstonedAt: purgedAt,
        reason: z.string().min(1).parse(request.reason),
        purgedContentIdentity: observedIdentity,
        purgedRevisionIds: [...revisionIds]
      },
      primaryCategory: "tombstone",
      categoryTags: [],
      importanceTags: [],
      startup: "never",
      applicability: { summary: "", conditions: [] },
      validity: { state: "invalid" },
      revisedAt: purgedAt,
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
          sourceRevisionId: previous.revisionId,
          renderedTokenCount: 0
        },
        standard: {
          text: "",
          validated: false,
          generatorIdentity: "purge-v1",
          sourceRevisionId: previous.revisionId,
          renderedTokenCount: 0
        }
      },
      provenance: [],
      injectionReceiptIds: [],
      relationships: [],
      contentIdentity: "0".repeat(64),
      body: ""
    };
    tombstoneSource = render(tombstone);
    tombstoneIdentity = contentIdentity(tombstoneSource);
    await writeFileAtomically(path, tombstoneSource, 0o600, fileIdentity(previousSource));
  }
  await request.onCheckpoint?.("tombstone_written", {
    tombstoneContentIdentity: tombstoneIdentity
  });

  const revisionDirectory = join(vaultRoot, "_MemStore", "Revisions", request.memoryId);
  if (!revisionDirectory.startsWith(`${join(vaultRoot, "_MemStore", "Revisions")}/`)) {
    throw new Error("Purge revision path escaped the Vault control directory.");
  }
  await rm(revisionDirectory, { recursive: true, force: true });
  await request.onCheckpoint?.("revision_bodies_removed", {
    tombstoneContentIdentity: tombstoneIdentity
  });

  const commitDatabase = await openRuntimeDatabase(request.runtimeRoot);
  try {
    commitDatabase.exec("BEGIN IMMEDIATE");
    try {
      commitDatabase.prepare(
        "DELETE FROM memory_relationships WHERE source_memory_id = ? OR target_memory_id = ?"
      ).run(request.memoryId, request.memoryId);
      commitDatabase.prepare("DELETE FROM memory_revisions WHERE memory_id = ?")
        .run(request.memoryId);
      commitDatabase.prepare("DELETE FROM retrieval_documents WHERE memory_id = ?")
        .run(request.memoryId);
      for (const index of affectedIndexes) {
        commitDatabase.prepare(
          "DELETE FROM active_retrieval_index WHERE index_revision_id = ?"
        ).run(index.indexRevisionId);
        commitDatabase.prepare(
          "UPDATE retrieval_index_revisions SET state = 'failed' WHERE index_revision_id = ?"
        ).run(index.indexRevisionId);
      }
      const updated = commitDatabase.prepare(
        `UPDATE memory_catalog
         SET lifecycle = 'tombstone', content_identity = ?, revised_at = ?,
             catalog_updated_at = ?
         WHERE memory_id = ? AND content_identity IN (?, ?)`
      ).run(
        tombstoneIdentity,
        purgedAt,
        purgedAt,
        request.memoryId,
        request.expectedContentIdentity,
        tombstoneIdentity
      );
      if (updated.changes !== 1) {
        throw new Error("Canonical catalog purge precondition failed.");
      }
      commitDatabase.prepare(
        `UPDATE future_purge_obligations
         SET state = 'completed'
         WHERE memory_id = ? AND state = 'pending'`
      ).run(request.memoryId);
      commitDatabase.exec("COMMIT");
    } catch (error) {
      commitDatabase.exec("ROLLBACK");
      throw error;
    }
  } finally {
    commitDatabase.close();
  }
  await request.onCheckpoint?.("catalog_committed", {
    tombstoneContentIdentity: tombstoneIdentity
  });

  await Promise.all(affectedIndexes.map(async (index) => {
    const indexesRoot = resolve(request.runtimeRoot, "indexes");
    const directory = resolve(index.directoryPath);
    if (!directory.startsWith(`${indexesRoot}/`)) {
      throw new Error("Retrieval index path escaped the Runtime index directory.");
    }
    await rm(directory, { recursive: true, force: true });
  }));
  await request.onCheckpoint?.("derived_indexes_removed", {
    tombstoneContentIdentity: tombstoneIdentity
  });
  return {
    state: "purged",
    memoryId: request.memoryId,
    tombstoneContentIdentity: tombstoneIdentity,
    purgedRevisionIds: revisionIds
  };
}
