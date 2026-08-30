import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";

import { buildRetrievalIndex, type EmbeddingAdapter } from "../../src/retrieval/index.js";
import {
  prepareSessionStartShadowPack,
  prepareUserPromptShadowPack
} from "../../src/retrieval/packs.js";
import {
  loadRetrievalSnapshot,
  validateRetrievalSnapshot
} from "../../src/retrieval/snapshot.js";
import { writeCanonicalMemory } from "../../src/vault/index.js";
import { makeCanonicalMemory } from "../helpers/canonical-memory.js";

const roots: string[] = [];
const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const identity = {
  adapterVersion: "fixture-v1",
  modelIdentity: "fixture-embedding",
  artifactSha256: "b".repeat(64),
  dimensions: 2,
  normalization: "l2" as const
};

test("automatic pack preparation fails open when no completed index exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-pack-no-index-"));
  roots.push(root);
  const started = performance.now();
  const result = await prepareSessionStartShadowPack({
    runtimeRoot: join(root, "runtime"),
    vaultRoot: join(root, "vault"),
    projectId,
    sessionId: "no-index",
    requestedAt: "2026-08-07T13:10:00.000Z"
  });

  expect(performance.now() - started).toBeLessThan(500);
  expect(result).toMatchObject({
    mode: "shadow",
    injected: false,
    items: [],
    text: "",
    emptyReason: "index_unavailable"
  });
});

test("a slow semantic query degrades to lexical-only before the automatic deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-pack-slow-semantic-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174521",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174531",
      scope: { kind: "project", projectId },
      body: "Use SQLite WAL for durable state.",
      compact: "Use SQLite WAL.",
      startup: "never"
    })
  });
  const fast: EmbeddingAdapter = {
    identity,
    embed: (texts) => Promise.resolve(texts.map(() => [1, 0]))
  };
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: fast,
    builtAt: "2026-08-07T13:11:00.000Z"
  });
  await prepareSessionStartShadowPack({
    runtimeRoot,
    vaultRoot,
    projectId,
    sessionId: "slow-semantic",
    requestedAt: "2026-08-07T13:11:01.000Z"
  });
  const slow: EmbeddingAdapter = {
    identity,
    embed: () => new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve([[1, 0]]);
      }, 1000);
      timer.unref();
    })
  };

  const started = performance.now();
  const result = await prepareUserPromptShadowPack({
    runtimeRoot,
    vaultRoot,
    projectId,
    sessionId: "slow-semantic",
    prompt: "SQLite WAL",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter: slow,
    requestedAt: "2026-08-07T13:11:02.000Z"
  });

  expect(performance.now() - started).toBeLessThan(500);
  expect(result.semanticStage).toBe("lexical_only");
  expect(result.items).toHaveLength(1);
});

test("large historical receipt volume does not consume the semantic deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-pack-receipt-history-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174541",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174551",
      scope: { kind: "project", projectId },
      body: "Use SQLite WAL for durable state.",
      compact: "Use SQLite WAL.",
      startup: "never"
    })
  });
  const fast: EmbeddingAdapter = {
    identity,
    embed: (texts) => Promise.resolve(texts.map(() => [1, 0]))
  };
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: fast,
    builtAt: "2026-08-07T13:11:00.000Z"
  });
  const historical = await prepareSessionStartShadowPack({
    runtimeRoot,
    vaultRoot,
    projectId,
    sessionId: "historical-receipts",
    requestedAt: "2026-08-07T13:11:01.000Z"
  });
  const database = new DatabaseSync(join(runtimeRoot, "state", "memstore.sqlite"));
  database.exec("BEGIN IMMEDIATE");
  try {
    const insert = database.prepare(
      `INSERT INTO retrieval_receipt_items(
         receipt_id, memory_id, revision_id, rank_ordinal, relevance_band,
         representation_kind, rendered_token_count, score, reasons_json,
         outcome, omission_reason
       ) VALUES (?, ?, ?, ?, 'weak', 'identity', 0, 0, '[]', 'omitted', 'weak_relevance')`
    );
    for (let ordinal = 0; ordinal < 150_000; ordinal += 1) {
      insert.run(
        historical.receiptId,
        `historical-memory-${String(ordinal)}`,
        "historical-revision",
        ordinal + 1
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  await prepareSessionStartShadowPack({
    runtimeRoot,
    vaultRoot,
    projectId,
    sessionId: "current-receipts",
    requestedAt: "2026-08-07T13:11:02.000Z"
  });
  const bounded: EmbeddingAdapter = {
    identity,
    embed: () => new Promise((resolve) => {
      setTimeout(() => {
        resolve([[1, 0]]);
      }, 100);
    })
  };

  const result = await prepareUserPromptShadowPack({
    runtimeRoot,
    vaultRoot,
    projectId,
    sessionId: "current-receipts",
    prompt: "How should SQLite WAL be configured?",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter: bounded,
    requestedAt: "2026-08-07T13:11:03.000Z"
  });

  expect(result.semanticStage).toBe("complete");
}, 15_000);

test("large Project scope is parsed before the semantic deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-pack-large-scope-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const baseMemoryId = "msmem_123e4567-e89b-42d3-a456-426614174561";
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: baseMemoryId,
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174571",
      scope: { kind: "project", projectId },
      body: "Use SQLite WAL for durable state.",
      compact: "Use SQLite WAL.",
      startup: "never"
    })
  });
  const fast: EmbeddingAdapter = {
    identity,
    embed: (texts) => Promise.resolve(texts.map(() => [1, 0]))
  };
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: fast,
    builtAt: "2026-08-07T13:11:00.000Z"
  });
  const database = new DatabaseSync(join(runtimeRoot, "state", "memstore.sqlite"));
  const active = database.prepare(
    `SELECT revision.index_revision_id, revision.directory_path, revision.dimensions
     FROM active_retrieval_index AS active
     JOIN retrieval_index_revisions AS revision
       ON revision.index_revision_id = active.index_revision_id
     WHERE active.singleton = 1`
  ).get();
  if (
    typeof active?.index_revision_id !== "string" ||
    typeof active.directory_path !== "string" ||
    typeof active.dimensions !== "number"
  ) throw new Error("Expected an active retrieval index fixture.");
  const insert = database.prepare(
    `INSERT INTO retrieval_documents(
       index_revision_id, vector_ordinal, memory_id, memory_ref, revision_id, content_identity,
       scope_kind, project_id, authority, sensitivity, lifecycle, category,
       base_priority_tier, session_order_key, importance_tags_json, startup,
       applicability_summary, applicability_conditions_json, validity_state,
       valid_from, valid_until, identity_label, identity_validated,
       identity_token_count, compact_text, compact_validated, compact_token_count,
       standard_text, standard_validated, standard_token_count, searchable_text,
       revised_at
     )
     SELECT index_revision_id, ?, ?, ?, ?, ?, scope_kind, project_id, authority,
            sensitivity, lifecycle, category, base_priority_tier, ?,
            importance_tags_json, startup, applicability_summary,
            applicability_conditions_json, validity_state, valid_from, valid_until,
            identity_label, identity_validated, identity_token_count, compact_text,
            compact_validated, compact_token_count, standard_text,
            standard_validated, standard_token_count, searchable_text, revised_at
     FROM retrieval_documents WHERE index_revision_id = ? AND memory_id = ?`
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    for (let ordinal = 1; ordinal <= 2_000; ordinal += 1) {
      insert.run(
        ordinal,
        `large-scope-memory-${String(ordinal)}`,
        ordinal + 1,
        `large-scope-revision-${String(ordinal)}`,
        `large-scope-content-${String(ordinal)}`,
        `large-scope-order-${String(ordinal).padStart(4, "0")}`,
        active.index_revision_id,
        baseMemoryId
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  const vectors = new Float32Array(2_001 * active.dimensions);
  for (let ordinal = 0; ordinal <= 2_000; ordinal += 1) {
    vectors[ordinal * active.dimensions] = 1;
  }
  await writeFile(join(active.directory_path, "vectors.f32"), Buffer.from(vectors.buffer));
  await prepareSessionStartShadowPack({
    runtimeRoot,
    vaultRoot,
    projectId,
    sessionId: "large-scope",
    requestedAt: "2026-08-07T13:11:01.000Z"
  });
  const bounded: EmbeddingAdapter = {
    identity,
    embed: () => new Promise((resolve) => {
      setTimeout(() => {
        resolve([[1, 0]]);
      }, 100);
    })
  };

  const result = await prepareUserPromptShadowPack({
    runtimeRoot,
    vaultRoot,
    projectId,
    sessionId: "large-scope",
    prompt: "How should SQLite WAL be configured?",
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter: bounded,
    requestedAt: "2026-08-07T13:11:02.000Z"
  });

  expect(result.semanticStage).toBe("complete");
});

test("a long prompt over a production-sized snapshot stays inside the warm-path budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-pack-large-prompt-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const targetMemoryId = "msmem_123e4567-e89b-42d3-a456-426614174581";
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: targetMemoryId,
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174591",
      scope: { kind: "project", projectId },
      body: "Use SQLite WAL for durable state.",
      compact: "Use SQLite WAL.",
      startup: "never"
    })
  });
  const fast: EmbeddingAdapter = {
    identity,
    embed: (texts) => Promise.resolve(texts.map(() => [1, 0]))
  };
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: fast,
    builtAt: "2026-08-07T13:11:00.000Z"
  });
  const baseSnapshot = await loadRetrievalSnapshot({ runtimeRoot });
  const baseMemory = baseSnapshot.documents[0];
  if (baseMemory === undefined) throw new Error("Expected an indexed Memory fixture.");
  const documents = Array.from({ length: 2_700 }, (_, ordinal) => ordinal === 0
    ? baseMemory
    : {
        ...baseMemory,
        memoryId: `large-prompt-memory-${String(ordinal)}`,
        memoryRef: ordinal + 1,
        revisionId: `large-prompt-revision-${String(ordinal)}`,
        sessionOrderKey: `large-prompt-order-${String(ordinal).padStart(4, "0")}`,
        applicabilitySummary: `Archived deployment procedure ${String(ordinal)}`,
        applicabilityConditions: [
          `Only for archived deployment environment ${String(ordinal)}`,
          `Requires unrelated release train ${String(ordinal)}`,
          `Excludes the durable database queue ${String(ordinal)}`
        ],
        compactText: `Archived deployment procedure ${String(ordinal)}.`,
        standardText: `Archived deployment procedure ${String(ordinal)} for an unrelated release train.`,
        searchableText: `archived deployment procedure release train ${String(ordinal)}`,
        vectorOrdinal: ordinal
      });
  const vectors = new Float32Array(documents.length * baseSnapshot.dimensions);
  vectors[0] = 1;
  for (let ordinal = 1; ordinal < documents.length; ordinal += 1) {
    vectors[ordinal * baseSnapshot.dimensions + 1] = 1;
  }
  const snapshot = validateRetrievalSnapshot({
    ...baseSnapshot,
    documents,
    vectors,
    globalOrdinals: [],
    projectOrdinals: [{
      projectId,
      ordinals: documents.map((_, ordinal) => ordinal)
    }],
    sessionBuckets: [],
    relationships: []
  });
  await prepareSessionStartShadowPack({
    runtimeRoot,
    vaultRoot,
    projectId,
    sessionId: "large-prompt",
    requestedAt: "2026-08-07T13:11:01.000Z",
    snapshot
  });
  const noise = Array.from(
    { length: 350 },
    (_, ordinal) => `querytoken${String(ordinal).padStart(4, "0")}`
  ).join(" ");
  const prompt = `${noise} How should SQLite WAL be configured? ${noise}`;

  const started = performance.now();
  const result = await prepareUserPromptShadowPack({
    runtimeRoot,
    vaultRoot,
    projectId,
    sessionId: "large-prompt",
    prompt,
    signals: { files: [], symbols: [], errors: [], commands: [] },
    adapter: fast,
    requestedAt: "2026-08-07T13:11:02.000Z",
    snapshot
  });
  const elapsedMilliseconds = performance.now() - started;

  expect(result.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ memoryId: targetMemoryId })
  ]));
  expect(elapsedMilliseconds).toBeLessThan(500);
}, 15_000);

test("automatic SessionStart fails open when Runtime SQLite is temporarily busy", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-pack-busy-runtime-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await prepareSessionStartShadowPack({
    runtimeRoot,
    vaultRoot,
    projectId,
    sessionId: "prepare-schema",
    requestedAt: "2026-08-07T13:12:00.000Z"
  });
  const writer = new DatabaseSync(join(runtimeRoot, "state", "memstore.sqlite"));
  writer.exec("BEGIN IMMEDIATE");
  try {
    const started = performance.now();
    const result = await prepareSessionStartShadowPack({
      runtimeRoot,
      vaultRoot,
      projectId,
      sessionId: "busy-runtime",
      requestedAt: "2026-08-07T13:12:01.000Z"
    });
    expect(performance.now() - started).toBeLessThan(500);
    expect(result).toMatchObject({
      mode: "shadow",
      injected: false,
      items: [],
      text: "",
      emptyReason: "runtime_unavailable"
    });
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
});
