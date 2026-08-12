import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { getEncoding } from "js-tiktoken";

import { openRuntimeDatabase } from "../runtime/database.js";
import { readCanonicalMemory, type CanonicalMemory } from "../vault/index.js";

const embeddingIdentitySchema = z.object({
  adapterVersion: z.string().min(1),
  modelIdentity: z.string().min(1),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  dimensions: z.number().int().positive(),
  normalization: z.literal("l2")
});
const tokenizer = getEncoding("o200k_base");

function catalogSha256(rows: readonly Record<string, unknown>[]): string {
  const source = rows.map((row) => [
    z.string().parse(row.memory_id),
    z.string().parse(row.current_revision_id),
    z.string().parse(row.content_identity),
    z.string().parse(row.lifecycle),
    z.string().parse(row.sensitivity)
  ]);
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

export interface EmbeddingAdapter {
  readonly identity: z.infer<typeof embeddingIdentitySchema>;
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
  embedDocuments?(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
  embedQuery?(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface ActiveRetrievalIndex {
  readonly indexRevisionId: string;
  readonly documentCount: number;
  readonly semanticReady: true;
  readonly adapterIdentity: EmbeddingAdapter["identity"];
}

function searchableText(memory: CanonicalMemory): string {
  return [
    memory.body,
    memory.representations.compact.text,
    memory.representations.standard.text,
    memory.representations.identity?.label ?? "",
    memory.primaryCategory,
    ...memory.categoryTags,
    ...memory.importanceTags,
    memory.applicability.summary,
    ...memory.applicability.conditions,
    ...memory.semanticContract.claims,
    ...memory.semanticContract.conditions,
    ...memory.semanticContract.exclusions,
    ...memory.semanticContract.preservedNegations
  ].filter((item) => item.length > 0).join("\n");
}

function basePriorityTier(memory: CanonicalMemory): "critical" | "strong" | "normal" {
  if (
    memory.primaryCategory === "safety_data_integrity" ||
    (memory.authority === "human_authored" &&
      ["preference_constraint", "architecture_contract"].includes(memory.primaryCategory)) ||
    memory.importanceTags.some((tag) => ["safety", "architecture", "decision"].includes(tag))
  ) return "critical";
  if (
    ["failure_recovery_hazard", "workflow_environment_toolchain"].includes(memory.primaryCategory) ||
    memory.importanceTags.includes("constraint")
  ) return "strong";
  return "normal";
}

function sessionOrderKey(memory: CanonicalMemory): string {
  const authorityRank = memory.authority === "human_authored" ? "0" : "1";
  const specificityRank = String(999_999 - memory.applicability.conditions.length).padStart(6, "0");
  return `${authorityRank}:${specificityRank}:${memory.memoryId}`;
}

function normalizeVector(vector: readonly number[], dimensions: number): readonly number[] {
  if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding adapter returned an invalid vector.");
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) throw new Error("Embedding adapter returned a zero vector.");
  return vector.map((value) => value / magnitude);
}

function encodeVectors(vectors: readonly (readonly number[])[]): Uint8Array {
  const values = new Float32Array(vectors.flat());
  return new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
}

async function buildRetrievalIndexImpl(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly adapter: EmbeddingAdapter;
  readonly builtAt: string;
}): Promise<{
  readonly state: "published";
  readonly indexRevisionId: string;
  readonly documentCount: number;
  readonly semanticReady: true;
}> {
  const builtAt = z.iso.datetime().parse(request.builtAt);
  const adapterIdentity = embeddingIdentitySchema.parse(request.adapter.identity);
  const snapshotDatabase = await openRuntimeDatabase(request.runtimeRoot);
  let catalogRows: readonly Record<string, unknown>[];
  try {
    catalogRows = snapshotDatabase.prepare(
      `SELECT memory_id, current_revision_id, content_identity, lifecycle, sensitivity
       FROM memory_catalog
       WHERE lifecycle = 'active' AND sensitivity IN ('normal', 'private')
       ORDER BY memory_id`
    ).all();
  } finally {
    snapshotDatabase.close();
  }
  const sourceCatalogSha256 = catalogSha256(catalogRows);
  const memories = (await Promise.all(catalogRows.map(async (row) => {
    const memoryId = z.string().parse(row.memory_id);
    const current = await readCanonicalMemory({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      memoryId
    });
    if (
      current === undefined ||
      current.memory.lifecycle !== "active" ||
      current.memory.revisionId !== row.current_revision_id ||
      current.contentIdentity !== row.content_identity
    ) {
      throw new Error("Canonical catalog changed while the retrieval index was building.");
    }
    return current.memory;
  }))).filter((memory) => memory.validity.state !== "invalid");
  const texts = memories.map((memory) => searchableText(memory));
  const rawVectors = texts.length === 0
    ? []
    : await (request.adapter.embedDocuments ?? request.adapter.embed)(texts);
  if (rawVectors.length !== memories.length) {
    throw new Error("Embedding adapter returned the wrong vector count.");
  }
  const vectors = rawVectors.map((vector) =>
    normalizeVector(vector, adapterIdentity.dimensions)
  );
  const indexRevisionId = `msindex_${randomUUID()}`;
  const indexesRoot = join(request.runtimeRoot, "indexes");
  const stagingDirectory = join(indexesRoot, `.staging-${indexRevisionId}`);
  const finalDirectory = join(indexesRoot, indexRevisionId);
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  try {
    const vectorBytes = encodeVectors(vectors);
    const vectorSha256 = createHash("sha256").update(vectorBytes).digest("hex");
    const manifest = {
      schemaVersion: 1,
      indexRevisionId,
      builtAt,
      adapterIdentity,
      documentCount: memories.length,
      vectorSha256,
      rows: memories.map((memory, ordinal) => ({
        ordinal,
        memoryId: memory.memoryId,
        revisionId: memory.revisionId,
        contentIdentity: memory.contentIdentity
      }))
    };
    const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestSha256 = createHash("sha256").update(manifestSource).digest("hex");
    await Promise.all([
      writeFile(join(stagingDirectory, "vectors.f32"), vectorBytes, { mode: 0o600 }),
      writeFile(join(stagingDirectory, "manifest.json"), manifestSource, { mode: 0o600 })
    ]);
    const verifiedVectorBytes = await readFile(join(stagingDirectory, "vectors.f32"));
    if (createHash("sha256").update(verifiedVectorBytes).digest("hex") !== vectorSha256) {
      throw new Error("Vector sidecar verification failed.");
    }
    await rename(stagingDirectory, finalDirectory);

    const database = await openRuntimeDatabase(request.runtimeRoot);
    try {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(
          `INSERT INTO retrieval_index_revisions(
             index_revision_id, state, built_at, selected_at, directory_path,
             manifest_sha256, adapter_version, model_identity, artifact_sha256,
             dimensions, normalization, document_count
           ) VALUES (?, 'complete', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          indexRevisionId,
          builtAt,
          builtAt,
          finalDirectory,
          manifestSha256,
          adapterIdentity.adapterVersion,
          adapterIdentity.modelIdentity,
          adapterIdentity.artifactSha256,
          adapterIdentity.dimensions,
          adapterIdentity.normalization,
          memories.length
        );
        database.prepare(
          `INSERT INTO retrieval_index_sources(index_revision_id, catalog_sha256)
           VALUES (?, ?)`
        ).run(indexRevisionId, sourceCatalogSha256);
        const insertDocument = database.prepare(
          `INSERT INTO retrieval_documents(
             index_revision_id, vector_ordinal, memory_id, revision_id,
             content_identity, scope_kind, project_id, authority, sensitivity,
             lifecycle, category, base_priority_tier, session_order_key,
             importance_tags_json, startup,
             applicability_summary, applicability_conditions_json,
             validity_state, valid_from, valid_until, identity_label,
             identity_validated, identity_token_count, compact_text,
             compact_validated, compact_token_count, standard_text,
             standard_validated, standard_token_count, searchable_text, revised_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const insertFts = database.prepare(
          "INSERT INTO fts_memories(index_revision_id, memory_id, searchable_text) VALUES (?, ?, ?)"
        );
        for (const [ordinal, memory] of memories.entries()) {
          const text = texts[ordinal];
          if (text === undefined) throw new Error("Retrieval text is missing.");
          insertDocument.run(
            indexRevisionId,
            ordinal,
            memory.memoryId,
            memory.revisionId,
            memory.contentIdentity,
            memory.scope.kind,
            memory.scope.kind === "project" ? memory.scope.projectId : null,
            memory.authority,
            memory.sensitivity,
            memory.primaryCategory,
            basePriorityTier(memory),
            sessionOrderKey(memory),
            JSON.stringify(memory.importanceTags),
            memory.startup,
            memory.applicability.summary,
            JSON.stringify(memory.applicability.conditions),
            memory.validity.state,
            memory.validity.validFrom ?? null,
            memory.validity.validUntil ?? null,
            memory.representations.identity?.label ?? null,
            memory.representations.identity?.validated === true &&
              memory.representations.identity.sourceRevisionId === memory.revisionId &&
              memory.representations.identity.label.trim().length > 0 &&
              tokenizer.encode(memory.representations.identity.label).length <= 48 ? 1 : 0,
            memory.representations.identity === undefined
              ? 0
              : tokenizer.encode(memory.representations.identity.label).length,
            memory.representations.compact.text,
            memory.representations.compact.validated &&
              memory.representations.compact.sourceRevisionId === memory.revisionId &&
              memory.representations.compact.text.trim().length > 0 &&
              tokenizer.encode(memory.representations.compact.text).length <= 96 ? 1 : 0,
            tokenizer.encode(memory.representations.compact.text).length,
            memory.representations.standard.text,
            memory.representations.standard.validated &&
              memory.representations.standard.sourceRevisionId === memory.revisionId &&
              memory.representations.standard.text.trim().length > 0 &&
              tokenizer.encode(memory.representations.standard.text).length <= 192 ? 1 : 0,
            tokenizer.encode(memory.representations.standard.text).length,
            text,
            memory.revisedAt
          );
          insertFts.run(indexRevisionId, memory.memoryId, text);
        }
        database.prepare(
          `INSERT INTO active_retrieval_index(singleton, index_revision_id)
           VALUES (1, ?)
           ON CONFLICT(singleton) DO UPDATE SET index_revision_id = excluded.index_revision_id`
        ).run(indexRevisionId);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }
  } catch (error) {
    await Promise.all([
      rm(stagingDirectory, { recursive: true, force: true }),
      rm(finalDirectory, { recursive: true, force: true })
    ]);
    throw error;
  }
  return {
    state: "published",
    indexRevisionId,
    documentCount: memories.length,
    semanticReady: true
  };
}

export async function retrievalIndexNeedsRebuild(request: {
  readonly runtimeRoot: string;
  readonly adapter: EmbeddingAdapter;
}): Promise<boolean> {
  const identity = embeddingIdentitySchema.parse(request.adapter.identity);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const active = database.prepare(
      `SELECT revision.adapter_version, revision.model_identity,
              revision.artifact_sha256, revision.dimensions, revision.normalization,
              source.catalog_sha256
       FROM active_retrieval_index AS active
       JOIN retrieval_index_revisions AS revision
         ON revision.index_revision_id = active.index_revision_id
       JOIN retrieval_index_sources AS source
         ON source.index_revision_id = active.index_revision_id
       WHERE active.singleton = 1 AND revision.state = 'complete'`
    ).get();
    if (active === undefined) return true;
    if (
      active.adapter_version !== identity.adapterVersion ||
      active.model_identity !== identity.modelIdentity ||
      active.artifact_sha256 !== identity.artifactSha256 ||
      active.dimensions !== identity.dimensions ||
      active.normalization !== identity.normalization
    ) return true;
    const catalogRows = database.prepare(
      `SELECT memory_id, current_revision_id, content_identity, lifecycle, sensitivity
       FROM memory_catalog
       WHERE lifecycle = 'active' AND sensitivity IN ('normal', 'private')
       ORDER BY memory_id`
    ).all();
    return active.catalog_sha256 !== catalogSha256(catalogRows);
  } finally {
    database.close();
  }
}

export async function buildRetrievalIndex(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly adapter: EmbeddingAdapter;
  readonly builtAt: string;
}): Promise<{
  readonly state: "published";
  readonly indexRevisionId: string;
  readonly documentCount: number;
  readonly semanticReady: true;
}> {
  const activityStartedAt = new Date().toISOString();
  const activityLeaseUntil = new Date(Date.parse(activityStartedAt) + 6 * 60 * 60 * 1000).toISOString();
  const buildId = `msindexbuild_${randomUUID()}`;
  const activityDatabase = await openRuntimeDatabase(request.runtimeRoot);
  try {
    activityDatabase.prepare(
      `INSERT INTO retrieval_index_build_activity(
         singleton, build_id, state, started_at, lease_until, completed_at
       ) VALUES (1, ?, 'building', ?, ?, NULL)
       ON CONFLICT(singleton) DO UPDATE SET
         build_id = excluded.build_id, state = 'building',
         started_at = excluded.started_at, lease_until = excluded.lease_until,
         completed_at = NULL`
    ).run(buildId, activityStartedAt, activityLeaseUntil);
  } finally {
    activityDatabase.close();
  }
  try {
    const result = await buildRetrievalIndexImpl(request);
    const completedAt = new Date().toISOString();
    const completionDatabase = await openRuntimeDatabase(request.runtimeRoot);
    try {
      completionDatabase.prepare(
        `UPDATE retrieval_index_build_activity
         SET state = 'complete', completed_at = ?, lease_until = ?
         WHERE singleton = 1 AND build_id = ?`
      ).run(completedAt, completedAt, buildId);
    } finally {
      completionDatabase.close();
    }
    return result;
  } catch (error) {
    const failedAt = new Date().toISOString();
    const failureDatabase = await openRuntimeDatabase(request.runtimeRoot);
    try {
      failureDatabase.prepare(
        `UPDATE retrieval_index_build_activity
         SET state = 'failed', completed_at = ?, lease_until = ?
         WHERE singleton = 1 AND build_id = ?`
      ).run(failedAt, failedAt, buildId);
    } finally {
      failureDatabase.close();
    }
    throw error;
  }
}

export async function inspectActiveRetrievalIndex(
  runtimeRoot: string
): Promise<ActiveRetrievalIndex | undefined> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const row = database.prepare(
      `SELECT revision.* FROM active_retrieval_index AS active
       JOIN retrieval_index_revisions AS revision
         ON revision.index_revision_id = active.index_revision_id
       WHERE active.singleton = 1 AND revision.state = 'complete'`
    ).get();
    if (row === undefined) return undefined;
    return {
      indexRevisionId: z.string().parse(row.index_revision_id),
      documentCount: z.number().int().nonnegative().parse(row.document_count),
      semanticReady: true,
      adapterIdentity: {
        adapterVersion: z.string().parse(row.adapter_version),
        modelIdentity: z.string().parse(row.model_identity),
        artifactSha256: z.string().parse(row.artifact_sha256),
        dimensions: z.number().int().positive().parse(row.dimensions),
        normalization: z.literal("l2").parse(row.normalization)
      }
    };
  } finally {
    database.close();
  }
}
