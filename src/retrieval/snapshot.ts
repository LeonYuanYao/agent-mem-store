import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { openRuntimeDatabase } from "../runtime/database.js";

const indexedMemoryRowSchema = z.object({
  index_revision_id: z.string(),
  memory_id: z.string(),
  memory_ref: z.number().int().positive(),
  revision_id: z.string(),
  scope_kind: z.enum(["global", "project"]),
  project_id: z.string().nullable(),
  authority: z.enum(["human_authored", "agent_derived"]),
  category: z.string(),
  base_priority_tier: z.enum(["critical", "strong", "normal"]),
  session_order_key: z.string().min(1),
  importance_tags_json: z.string(),
  startup: z.enum(["auto", "always", "never"]),
  applicability_summary: z.string(),
  applicability_conditions_json: z.string(),
  valid_from: z.string().nullable(),
  valid_until: z.string().nullable(),
  validity_state: z.enum(["valid", "review_due"]),
  identity_label: z.string().nullable(),
  identity_validated: z.union([z.literal(0), z.literal(1)]),
  identity_token_count: z.number().int().nonnegative(),
  compact_text: z.string(),
  compact_validated: z.union([z.literal(0), z.literal(1)]),
  compact_token_count: z.number().int().nonnegative(),
  standard_text: z.string(),
  standard_validated: z.union([z.literal(0), z.literal(1)]),
  standard_token_count: z.number().int().nonnegative(),
  searchable_text: z.string(),
  vector_ordinal: z.number().int().nonnegative()
});

export interface IndexedMemory {
  readonly indexRevisionId: string;
  readonly memoryId: string;
  readonly memoryRef: number;
  readonly revisionId: string;
  readonly scope: { readonly kind: "global" } | { readonly kind: "project"; readonly projectId: string };
  readonly authority: "human_authored" | "agent_derived";
  readonly category: string;
  readonly basePriorityTier: "critical" | "strong" | "normal";
  readonly sessionOrderKey: string;
  readonly importanceTags: string[];
  readonly startup: "auto" | "always" | "never";
  readonly applicabilitySummary: string;
  readonly applicabilityConditions: string[];
  readonly validFrom?: string | undefined;
  readonly validUntil?: string | undefined;
  readonly validityState: "valid" | "review_due";
  readonly identityLabel?: string | undefined;
  readonly identityValidated: boolean;
  readonly identityTokenCount: number;
  readonly compactText: string;
  readonly compactValidated: boolean;
  readonly compactTokenCount: number;
  readonly standardText: string;
  readonly standardValidated: boolean;
  readonly standardTokenCount: number;
  readonly searchableText: string;
  readonly vectorOrdinal: number;
}

export interface RetrievalSearchDocument {
  readonly memoryId: string;
  readonly memoryRef: number;
  readonly normalizedSearchableText: string;
  readonly normalizedApplicabilityText: string;
  readonly searchableTerms: ReadonlySet<string>;
  readonly applicabilityTerms: ReadonlySet<string>;
}

export interface RetrievalSearchIndex {
  readonly documentsByMemoryId: ReadonlyMap<string, RetrievalSearchDocument>;
  readonly memoryIdByRef: ReadonlyMap<number, string>;
  readonly postingsByTerm: ReadonlyMap<string, readonly string[]>;
}

function normalizeSearchText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("en-US");
}

function tokenizeSearchText(text: string): ReadonlySet<string> {
  return new Set(
    normalizeSearchText(text).match(/[\p{L}\p{N}_./:-]+/gu)?.filter((term) => term.length > 1) ?? []
  );
}

export function buildRetrievalSearchIndex(
  documents: readonly IndexedMemory[]
): RetrievalSearchIndex {
  const documentsByMemoryId = new Map<string, RetrievalSearchDocument>();
  const memoryIdByRef = new Map<number, string>();
  const mutablePostings = new Map<string, string[]>();
  for (const document of documents) {
    const normalizedSearchableText = normalizeSearchText(document.searchableText);
    const normalizedApplicabilityText = normalizeSearchText([
      document.applicabilitySummary,
      ...document.applicabilityConditions
    ].join("\n"));
    const searchableTerms = tokenizeSearchText(normalizedSearchableText);
    const applicabilityTerms = tokenizeSearchText(normalizedApplicabilityText);
    documentsByMemoryId.set(document.memoryId, {
      memoryId: document.memoryId,
      memoryRef: document.memoryRef,
      normalizedSearchableText,
      normalizedApplicabilityText,
      searchableTerms,
      applicabilityTerms
    });
    memoryIdByRef.set(document.memoryRef, document.memoryId);
    for (const term of searchableTerms) {
      const postings = mutablePostings.get(term) ?? [];
      postings.push(document.memoryId);
      mutablePostings.set(term, postings);
    }
  }
  return {
    documentsByMemoryId,
    memoryIdByRef,
    postingsByTerm: new Map(
      [...mutablePostings.entries()].map(([term, memoryIds]) => [term, memoryIds] as const)
    )
  };
}

const indexedMemorySnapshotSchema = z.object({
  indexRevisionId: z.string().min(1),
  memoryId: z.string().min(1),
  memoryRef: z.number().int().positive(),
  revisionId: z.string().min(1),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("global") }),
    z.object({ kind: z.literal("project"), projectId: z.string().min(1) })
  ]),
  authority: z.enum(["human_authored", "agent_derived"]),
  category: z.string(),
  basePriorityTier: z.enum(["critical", "strong", "normal"]),
  sessionOrderKey: z.string().min(1),
  importanceTags: z.array(z.string()),
  startup: z.enum(["auto", "always", "never"]),
  applicabilitySummary: z.string(),
  applicabilityConditions: z.array(z.string()),
  validFrom: z.string().optional(),
  validUntil: z.string().optional(),
  validityState: z.enum(["valid", "review_due"]),
  identityLabel: z.string().optional(),
  identityValidated: z.boolean(),
  identityTokenCount: z.number().int().nonnegative(),
  compactText: z.string(),
  compactValidated: z.boolean(),
  compactTokenCount: z.number().int().nonnegative(),
  standardText: z.string(),
  standardValidated: z.boolean(),
  standardTokenCount: z.number().int().nonnegative(),
  searchableText: z.string(),
  vectorOrdinal: z.number().int().nonnegative()
});

export function rowToIndexedMemory(row: Record<string, unknown>): IndexedMemory {
  const parsed = indexedMemoryRowSchema.parse(row);
  return {
    indexRevisionId: parsed.index_revision_id,
    memoryId: parsed.memory_id,
    memoryRef: parsed.memory_ref,
    revisionId: parsed.revision_id,
    scope: parsed.scope_kind === "global"
      ? { kind: "global" }
      : { kind: "project", projectId: z.string().parse(parsed.project_id) },
    authority: parsed.authority,
    category: parsed.category,
    basePriorityTier: parsed.base_priority_tier,
    sessionOrderKey: parsed.session_order_key,
    importanceTags: z.array(z.string()).parse(JSON.parse(parsed.importance_tags_json)),
    startup: parsed.startup,
    applicabilitySummary: parsed.applicability_summary,
    applicabilityConditions: z.array(z.string()).parse(
      JSON.parse(parsed.applicability_conditions_json)
    ),
    ...(parsed.valid_from === null ? {} : { validFrom: parsed.valid_from }),
    ...(parsed.valid_until === null ? {} : { validUntil: parsed.valid_until }),
    validityState: parsed.validity_state,
    ...(parsed.identity_label === null ? {} : { identityLabel: parsed.identity_label }),
    identityValidated: parsed.identity_validated === 1,
    identityTokenCount: parsed.identity_token_count,
    compactText: parsed.compact_text,
    compactValidated: parsed.compact_validated === 1,
    compactTokenCount: parsed.compact_token_count,
    standardText: parsed.standard_text,
    standardValidated: parsed.standard_validated === 1,
    standardTokenCount: parsed.standard_token_count,
    searchableText: parsed.searchable_text,
    vectorOrdinal: parsed.vector_ordinal
  };
}

const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  workingSetGeneration: z.number().int().nonnegative(),
  indexRevisionId: z.string().min(1),
  directoryPath: z.string().min(1),
  adapterVersion: z.string().min(1),
  modelIdentity: z.string().min(1),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  dimensions: z.number().int().positive(),
  documents: z.array(indexedMemorySnapshotSchema),
  vectors: z.instanceof(Float32Array),
  automaticEligibleOrdinals: z.array(z.number().int().nonnegative()),
  globalOrdinals: z.array(z.number().int().nonnegative()),
  projectOrdinals: z.array(z.object({
    projectId: z.string().min(1),
    ordinals: z.array(z.number().int().nonnegative())
  })),
  sessionBuckets: z.array(z.object({
    projectId: z.string().min(1).nullable(),
    startup: z.enum(["always", "auto"]),
    tier: z.enum(["critical", "strong", "normal"]),
    category: z.string(),
    ordinals: z.array(z.number().int().nonnegative())
  })),
  relationships: z.array(z.object({
    sourceMemoryId: z.string().min(1),
    targetMemoryId: z.string().min(1)
  }))
});

export type RetrievalSnapshot = z.infer<typeof snapshotSchema> & {
  readonly searchIndex: RetrievalSearchIndex;
};

export function validateRetrievalSnapshot(snapshot: unknown): RetrievalSnapshot {
  const parsed = snapshotSchema.parse(snapshot);
  if (parsed.vectors.length !== parsed.documents.length * parsed.dimensions) {
    throw new Error("Retrieval Snapshot vector dimensions do not match its documents.");
  }
  for (const [ordinal, document] of parsed.documents.entries()) {
    if (document.vectorOrdinal !== ordinal || document.indexRevisionId !== parsed.indexRevisionId) {
      throw new Error("Retrieval Snapshot document ordinals are inconsistent.");
    }
  }
  if (parsed.sessionBuckets.some((bucket) =>
    bucket.ordinals.some((ordinal) => ordinal >= parsed.documents.length)
  )) {
    throw new Error("Retrieval Snapshot session bucket contains an invalid ordinal.");
  }
  const validated = { ...parsed } as RetrievalSnapshot;
  if (parsed.automaticEligibleOrdinals.some((ordinal) => ordinal >= parsed.documents.length)) {
    throw new Error("Retrieval Snapshot working-set ordinal is invalid.");
  }
  Object.defineProperty(validated, "searchIndex", {
    value: buildRetrievalSearchIndex(
      parsed.automaticEligibleOrdinals.flatMap((ordinal) => {
        const document = parsed.documents[ordinal];
        return document === undefined ? [] : [document];
      })
    ),
    enumerable: false,
    writable: false,
    configurable: false
  });
  return validated;
}

export async function loadRetrievalSnapshot(request: {
  readonly runtimeRoot: string;
}): Promise<RetrievalSnapshot> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let active: Record<string, unknown> | undefined;
  let documentRows: readonly Record<string, unknown>[] = [];
  let relationshipRows: readonly Record<string, unknown>[] = [];
  let exclusionRows: readonly Record<string, unknown>[] = [];
  let workingSetGeneration = 0;
  try {
    database.exec("BEGIN");
    active = database.prepare(
      `SELECT revision.* FROM active_retrieval_index AS active
       JOIN retrieval_index_revisions AS revision
         ON revision.index_revision_id = active.index_revision_id
       WHERE active.singleton = 1 AND revision.state = 'complete'`
    ).get();
    if (active !== undefined) {
      documentRows = database.prepare(
        `SELECT * FROM retrieval_documents
         WHERE index_revision_id = ? ORDER BY vector_ordinal`
      ).all(z.string().parse(active.index_revision_id));
      relationshipRows = database.prepare(
        "SELECT source_memory_id, target_memory_id FROM memory_relationships"
      ).all();
      exclusionRows = database.prepare(
        "SELECT memory_id, revision_id, space_key FROM memory_ranking_exclusions"
      ).all();
      workingSetGeneration = z.number().int().nonnegative().parse(database.prepare(
        "SELECT dirty_generation FROM memory_working_set_generations WHERE singleton = 1"
      ).get()?.dirty_generation);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  if (active === undefined) throw new Error("No completed retrieval index is active.");

  const indexRevisionId = z.string().parse(active.index_revision_id);
  const directoryPath = z.string().parse(active.directory_path);
  const [manifestBytes, vectorBytes] = await Promise.all([
    readFile(join(directoryPath, "manifest.json")),
    readFile(join(directoryPath, "vectors.f32"))
  ]);
  if (createHash("sha256").update(manifestBytes).digest("hex") !== active.manifest_sha256) {
    throw new Error("Retrieval Snapshot manifest identity does not match the active index.");
  }
  const manifest = z.object({
    vectorSha256: z.string().regex(/^[0-9a-f]{64}$/u)
  }).loose().parse(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  if (createHash("sha256").update(vectorBytes).digest("hex") !== manifest.vectorSha256) {
    throw new Error("Retrieval Snapshot vectors do not match the active manifest.");
  }
  const dimensions = z.number().int().positive().parse(active.dimensions);
  const documents = documentRows.map(rowToIndexedMemory);
  if (vectorBytes.byteLength !== documents.length * dimensions * 4) {
    throw new Error("Retrieval Snapshot vector file has an invalid size.");
  }
  const sourceVectors = new Float32Array(
    vectorBytes.buffer,
    vectorBytes.byteOffset,
    vectorBytes.byteLength / 4
  );
  const vectors = new Float32Array(sourceVectors);
  const excludedRevisions = new Set(exclusionRows.flatMap((row) =>
    typeof row.memory_id === "string" && typeof row.revision_id === "string" &&
      typeof row.space_key === "string"
      ? [`${row.memory_id}:${row.revision_id}:${row.space_key}`]
      : []
  ));
  const automaticEligibleOrdinals = documents.flatMap((document, ordinal) => {
    const spaceKey = document.scope.kind === "global"
      ? "global"
      : `project:${document.scope.projectId}`;
    return excludedRevisions.has(`${document.memoryId}:${document.revisionId}:${spaceKey}`)
      ? []
      : [ordinal];
  });
  const automaticEligibleOrdinalSet = new Set(automaticEligibleOrdinals);
  const globalOrdinals: number[] = [];
  const projects = new Map<string, number[]>();
  documents.forEach((document, ordinal) => {
    if (!automaticEligibleOrdinalSet.has(ordinal)) return;
    if (document.scope.kind === "global") globalOrdinals.push(ordinal);
    else {
      const ordinals = projects.get(document.scope.projectId) ?? [];
      ordinals.push(ordinal);
      projects.set(document.scope.projectId, ordinals);
    }
  });
  const documentIds = new Set(documents.map((document) => document.memoryId));
  const bucketMap = new Map<string, {
    readonly projectId: string | null;
    readonly startup: "always" | "auto";
    readonly tier: "critical" | "strong" | "normal";
    readonly category: string;
    readonly ordinals: number[];
  }>();
  const effectiveProjectTier = (
    tier: "critical" | "strong" | "normal"
  ): "critical" | "strong" | "normal" => tier === "normal"
    ? "strong"
    : "critical";
  documents.forEach((document, ordinal) => {
    if (!automaticEligibleOrdinalSet.has(ordinal)) return;
    if (document.startup === "never") return;
    const projectId = document.scope.kind === "project" ? document.scope.projectId : null;
    const tier = projectId === null
      ? document.basePriorityTier
      : effectiveProjectTier(document.basePriorityTier);
    const key = `${projectId ?? "global"}\0${document.startup}\0${tier}\0${document.category}`;
    const bucket = bucketMap.get(key) ?? {
      projectId,
      startup: document.startup,
      tier,
      category: document.category,
      ordinals: []
    };
    bucket.ordinals.push(ordinal);
    bucketMap.set(key, bucket);
  });
  const tierRank = { critical: 0, strong: 1, normal: 2 } as const;
  const sessionBuckets = [...bucketMap.values()].map((bucket) => ({
    ...bucket,
    ordinals: bucket.ordinals.sort((left, right) =>
      (documents[left]?.sessionOrderKey ?? "").localeCompare(
        documents[right]?.sessionOrderKey ?? ""
      )
    )
  })).sort((left, right) =>
    (left.projectId ?? "").localeCompare(right.projectId ?? "") ||
    left.startup.localeCompare(right.startup) ||
    tierRank[left.tier] - tierRank[right.tier] ||
    left.category.localeCompare(right.category)
  );
  return validateRetrievalSnapshot({
    schemaVersion: 1,
    workingSetGeneration,
    indexRevisionId,
    directoryPath,
    adapterVersion: z.string().parse(active.adapter_version),
    modelIdentity: z.string().parse(active.model_identity),
    artifactSha256: z.string().parse(active.artifact_sha256),
    dimensions,
    documents,
    vectors,
    automaticEligibleOrdinals,
    globalOrdinals,
    projectOrdinals: [...projects.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([projectId, ordinals]) => ({ projectId, ordinals })),
    sessionBuckets,
    relationships: relationshipRows.flatMap((row) => {
      const sourceMemoryId = z.string().parse(row.source_memory_id);
      const targetMemoryId = z.string().parse(row.target_memory_id);
      return documentIds.has(sourceMemoryId) && documentIds.has(targetMemoryId)
        ? [{ sourceMemoryId, targetMemoryId }]
        : [];
    })
  });
}

export function snapshotMemoriesForProject(request: {
  readonly snapshot: RetrievalSnapshot;
  readonly projectId: string;
  readonly requestedAt: string;
}): readonly IndexedMemory[] {
  const project = request.snapshot.projectOrdinals.find(
    (entry) => entry.projectId === request.projectId
  );
  return [...request.snapshot.globalOrdinals, ...(project?.ordinals ?? [])]
    .map((ordinal) => request.snapshot.documents[ordinal])
    .filter((memory): memory is IndexedMemory => memory !== undefined)
    .filter((memory) =>
      !(memory.authority === "agent_derived" && memory.validityState === "review_due") &&
      (memory.validFrom === undefined || memory.validFrom <= request.requestedAt) &&
      (memory.validUntil === undefined || memory.validUntil >= request.requestedAt)
    );
}
