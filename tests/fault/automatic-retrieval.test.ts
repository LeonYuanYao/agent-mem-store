import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";

import { buildRetrievalIndex, type EmbeddingAdapter } from "../../src/retrieval/index.js";
import {
  prepareSessionStartShadowPack,
  prepareUserPromptShadowPack
} from "../../src/retrieval/packs.js";
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
