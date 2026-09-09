import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { captureEvent } from "../../../src/capture/index.js";
import { buildRetrievalIndex, type EmbeddingAdapter } from "../../../src/retrieval/index.js";
import {
  startForegroundRetrievalServer
} from "../../../src/retrieval/foreground-ipc.js";
import type { ForegroundAttemptRecord } from "../../../src/retrieval/foreground-attempts.js";
import { requestForegroundRetrieval } from "../../../src/retrieval/foreground-client.js";
import {
  loadRetrievalSnapshot,
  validateRetrievalSnapshot
} from "../../../src/retrieval/snapshot.js";
import { inspectRetrievalReceipt } from "../../../src/retrieval/packs.js";
import {
  inspectShadowEvaluation,
  runNextShadowEvaluation
} from "../../../src/retrieval/shadow-worker.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];
const projectId = "msproj_123e4567-e89b-42d3-a456-426614174801";

const adapter: EmbeddingAdapter = {
  identity: {
    adapterVersion: "fixture-v1",
    modelIdentity: "fixture-embedding",
    artifactSha256: "c".repeat(64),
    dimensions: 2,
    normalization: "l2"
  },
  embed: (texts) => Promise.resolve(texts.map((text) =>
    /sqlite|wal/iu.test(text) ? [1, 0] : [0, 1]
  ))
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp("/tmp/memstore-foreground-ipc-");
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await mkdir(runtimeRoot);
  await writeFile(join(runtimeRoot, "config.toml"), "schema_version = 1\n[adapters]\nsession_start_injection = true\n");
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174811",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174821",
      scope: { kind: "project", projectId },
      body: "Use SQLite WAL for the durable queue.",
      compact: "Use SQLite WAL for the durable queue.",
      startup: "always"
    })
  });
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174812",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174822",
      scope: { kind: "project", projectId },
      body: "SQLite queue recovery requires checking WAL integrity.",
      compact: "Check WAL integrity during SQLite queue recovery.",
      startup: "never"
    })
  });
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter,
    builtAt: "2026-08-25T12:00:00.000Z"
  });
  return { runtimeRoot, vaultRoot };
}

async function saturatedSessionStartSnapshot(runtimeRoot: string) {
  const base = await loadRetrievalSnapshot({ runtimeRoot });
  const template = base.documents[0];
  if (template === undefined) throw new Error("Expected a retrieval document fixture.");
  const documentCount = 2_000;
  const ordinals = Array.from({ length: documentCount }, (_, ordinal) => ordinal);
  const compactText = "constraint ".repeat(96).trim();
  const documents = ordinals.map((ordinal) => ({
    ...template,
    memoryId: `saturated-memory-${String(ordinal).padStart(4, "0")}`,
    memoryRef: ordinal + 1,
    revisionId: `saturated-revision-${String(ordinal).padStart(4, "0")}`,
    scope: { kind: "project" as const, projectId },
    basePriorityTier: "normal" as const,
    sessionOrderKey: `saturated-order-${String(ordinal).padStart(4, "0")}`,
    startup: "auto" as const,
    compactText,
    compactValidated: true,
    compactTokenCount: 96,
    vectorOrdinal: ordinal
  }));
  return validateRetrievalSnapshot({
    schemaVersion: 1,
    workingSetGeneration: base.workingSetGeneration,
    indexRevisionId: base.indexRevisionId,
    directoryPath: base.directoryPath,
    adapterVersion: base.adapterVersion,
    modelIdentity: base.modelIdentity,
    artifactSha256: base.artifactSha256,
    dimensions: base.dimensions,
    documents,
    vectors: new Float32Array(documentCount * base.dimensions),
    automaticEligibleOrdinals: ordinals,
    globalOrdinals: [],
    projectOrdinals: [{ projectId, ordinals }],
    sessionBuckets: [{
      projectId,
      startup: "auto",
      tier: "strong",
      category: template.category,
      ordinals
    }],
    relationships: []
  });
}

async function conversationalHistoryFixture() {
  const root = await mkdtemp("/tmp/memstore-foreground-history-");
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174831",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174841",
      scope: { kind: "project", projectId },
      body: "Automatic Top-N recall keeps only independently relevant memories.",
      compact: "Automatic Top-N recall keeps only independently relevant memories.",
      startup: "never"
    })
  });
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174832",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174842",
      scope: { kind: "project", projectId },
      body: "Deployment rollback uses the verified release checklist.",
      compact: "Deployment rollback uses the verified release checklist.",
      startup: "never"
    })
  });
  const historyAdapter: EmbeddingAdapter = {
    identity: {
      adapterVersion: "history-fixture-v1",
      modelIdentity: "history-fixture-embedding",
      artifactSha256: "d".repeat(64),
      dimensions: 2,
      normalization: "l2"
    },
    embed: (texts) => Promise.resolve(texts.map((text) =>
      /top-n/iu.test(text) ? [1, 0] : [0, 1]
    )),
    embedDocuments: (texts) => Promise.resolve(texts.map((text) =>
      /top-n/iu.test(text) ? [1, 0] : [0, 1]
    )),
    embedQuery: (texts) => Promise.resolve(texts.map((text) =>
      (/memstore/iu.test(text) && /too strict/iu.test(text)) ||
        (/history-anchor/iu.test(text) && /recall-now/iu.test(text)) ||
        (/history-budget-anchor/iu.test(text) && /recall-budget/iu.test(text)) ||
        (/evicted-history-anchor/iu.test(text) && /recall-limit/iu.test(text))
        ? [1, 0]
        : [0, 1]
    ))
  };
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: historyAdapter,
    builtAt: "2026-08-25T12:00:00.000Z"
  });
  return { runtimeRoot, vaultRoot, adapter: historyAdapter };
}

async function corroboratedHistoryFixture() {
  const root = await mkdtemp("/tmp/memstore-foreground-corroborated-history-");
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174851",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174861",
      scope: { kind: "project", projectId },
      body: "检索系统的 Top-N 表示最多返回 N 条；每条记忆必须独立通过准入门槛，弱相关条目不得为填满名额而注入。",
      compact: "检索系统的 Top-N 表示最多返回 N 条；每条记忆必须独立通过准入门槛，弱相关条目不得为填满名额而注入。",
      startup: "never"
    })
  });
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174852",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174862",
      scope: { kind: "project", projectId },
      body: "MemStore 健康诊断中的相关记忆统计只用于性能观测。",
      compact: "MemStore 健康诊断中的相关记忆统计只用于性能观测。",
      startup: "never"
    })
  });
  const contextualAdapter: EmbeddingAdapter = {
    identity: {
      adapterVersion: "corroborated-history-fixture-v1",
      modelIdentity: "corroborated-history-fixture-embedding",
      artifactSha256: "e".repeat(64),
      dimensions: 2,
      normalization: "l2"
    },
    embed: (texts) => Promise.resolve(texts.map((text) =>
      /top-n/iu.test(text) ? [1, 0] : [0.999, 0.045]
    )),
    embedDocuments: (texts) => Promise.resolve(texts.map((text) =>
      /top-n/iu.test(text) ? [1, 0] : [0.999, 0.045]
    )),
    embedQuery: (texts) => Promise.resolve(texts.map((text) =>
      /history-topic/iu.test(text) && /门禁/u.test(text)
        ? [0.999, 0.045]
        : /门禁/u.test(text) ? [1, 0] : [0, 1]
    ))
  };
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: contextualAdapter,
    builtAt: "2026-08-25T12:00:00.000Z"
  });
  return { runtimeRoot, vaultRoot, adapter: contextualAdapter };
}

test("the foreground server returns bounded SessionStart and UserPrompt packs over a private socket", async () => {
  const roots = await fixture();
  const server = await startForegroundRetrievalServer({ ...roots, adapter });
  try {
    expect((await stat(server.socketPath)).mode & 0o777).toBe(0o600);
    const session = await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "SessionStart",
      projectId,
      sessionId: "foreground-session",
      requestedAt: "2026-08-25T12:01:00.000Z"
    });
    expect(session).toMatchObject({ state: "completed", event: "SessionStart" });
    if (session.state !== "completed") throw new Error("Expected a completed SessionStart pack.");
    expect(session.text).toContain("Use SQLite WAL");

    const prompt = await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "UserPromptSubmit",
      projectId,
      sessionId: "foreground-session",
      prompt: "How should the sqlite queue use wal?",
      requestedAt: "2026-08-25T12:02:00.000Z"
    });
    expect(prompt.state).toBe("completed");
  } finally {
    await server.close();
  }
  await expect(stat(server.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a foreground session uses recent user prompts to resolve a contextual follow-up", async () => {
  const roots = await conversationalHistoryFixture();
  const server = await startForegroundRetrievalServer(roots);
  try {
    await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "SessionStart",
      projectId,
      sessionId: "history-session",
      requestedAt: "2026-08-25T12:01:00.000Z"
    });
    await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "UserPromptSubmit",
      projectId,
      sessionId: "history-session",
      prompt: "Check MemStore health.",
      requestedAt: "2026-08-25T12:02:00.000Z"
    });
    const contextual = await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "UserPromptSubmit",
      projectId,
      sessionId: "history-session",
      prompt: "Is it too strict now?",
      requestedAt: "2026-08-25T12:03:00.000Z"
    });
    expect(contextual.state).toBe("completed");
    expect(contextual.state === "completed" ? contextual.text : "").toContain(
      "Automatic Top-N recall"
    );
    expect(contextual.state === "completed" ? contextual.text : "").not.toContain(
      "Check MemStore health"
    );

    await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "SessionStart",
      projectId,
      sessionId: "isolated-history-session",
      requestedAt: "2026-08-25T12:04:00.000Z"
    });
    const isolated = await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "UserPromptSubmit",
      projectId,
      sessionId: "isolated-history-session",
      prompt: "Is it too strict now?",
      requestedAt: "2026-08-25T12:05:00.000Z"
    });
    expect(isolated.state === "completed" ? isolated.text : "").not.toContain(
      "Automatic Top-N recall"
    );
  } finally {
    await server.close();
  }
});

test("context-dependent prompts admit strong history semantics only with current lexical corroboration", async () => {
  const roots = await corroboratedHistoryFixture();
  const server = await startForegroundRetrievalServer(roots);
  try {
    await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "SessionStart",
      projectId,
      sessionId: "corroborated-history-session",
      requestedAt: "2026-08-25T12:06:00.000Z"
    });
    await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "UserPromptSubmit",
      projectId,
      sessionId: "corroborated-history-session",
      prompt: "history-topic",
      requestedAt: "2026-08-25T12:07:00.000Z"
    });
    const contextual = await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "UserPromptSubmit",
      projectId,
      sessionId: "corroborated-history-session",
      prompt: "这个门禁现在会不会太严格，导致相关记忆太少？",
      requestedAt: "2026-08-25T12:08:00.000Z"
    });
    const contextualText = contextual.state === "completed" ? contextual.text : "";
    expect(contextualText).toContain("检索系统的 Top-N");
    expect(contextualText).toContain("健康诊断中的相关记忆统计");
    expect(contextualText.indexOf("检索系统的 Top-N")).toBeLessThan(
      contextualText.indexOf("健康诊断中的相关记忆统计")
    );

    await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "SessionStart",
      projectId,
      sessionId: "uncorroborated-history-session",
      requestedAt: "2026-08-25T12:09:00.000Z"
    });
    const isolated = await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "UserPromptSubmit",
      projectId,
      sessionId: "uncorroborated-history-session",
      prompt: "这个门禁现在会不会太严格，导致相关记忆太少？",
      requestedAt: "2026-08-25T12:10:00.000Z"
    });
    expect(isolated.state === "completed" ? isolated.text : "").not.toContain(
      "检索系统的 Top-N"
    );

    await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "SessionStart",
      projectId,
      sessionId: "non-contextual-history-session",
      requestedAt: "2026-08-25T12:11:00.000Z"
    });
    await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "UserPromptSubmit",
      projectId,
      sessionId: "non-contextual-history-session",
      prompt: "history-topic",
      requestedAt: "2026-08-25T12:12:00.000Z"
    });
    const nonContextual = await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "UserPromptSubmit",
      projectId,
      sessionId: "non-contextual-history-session",
      prompt: "解释严格检索门禁导致相关记忆太少的原因。",
      requestedAt: "2026-08-25T12:13:00.000Z"
    });
    expect(nonContextual.state === "completed" ? nonContextual.text : "").not.toContain(
      "检索系统的 Top-N"
    );
  } finally {
    await server.close();
  }
});

test("short confirmations do not evict meaningful foreground history", async () => {
  const roots = await conversationalHistoryFixture();
  const server = await startForegroundRetrievalServer(roots);
  try {
    const sessionId = "confirmation-history-session";
    await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "SessionStart",
      projectId,
      sessionId,
      requestedAt: "2026-08-25T12:10:00.000Z"
    });
    const prompts = ["history-anchor", "OK", "继续", "同意", "可以"];
    for (const [index, prompt] of prompts.entries()) {
      await requestForegroundRetrieval({
        runtimeRoot: roots.runtimeRoot,
        event: "UserPromptSubmit",
        projectId,
        sessionId,
        prompt,
        requestedAt: `2026-08-25T12:${String(11 + index).padStart(2, "0")}:00.000Z`
      });
    }
    const contextual = await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "UserPromptSubmit",
      projectId,
      sessionId,
      prompt: "recall-now",
      requestedAt: "2026-08-25T12:20:00.000Z"
    });
    expect(contextual.state === "completed" ? contextual.text : "").toContain(
      "Automatic Top-N recall"
    );
  } finally {
    await server.close();
  }
});

test("foreground history is bounded before it influences semantic recall", async () => {
  const roots = await conversationalHistoryFixture();
  const server = await startForegroundRetrievalServer(roots);
  try {
    const sessionId = "bounded-history-session";
    await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "SessionStart",
      projectId,
      sessionId,
      requestedAt: "2026-08-25T12:30:00.000Z"
    });
    await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "UserPromptSubmit",
      projectId,
      sessionId,
      prompt: `${"prefix ".repeat(300)}history-budget-anchor ${"suffix ".repeat(300)}`,
      requestedAt: "2026-08-25T12:31:00.000Z"
    });
    const result = await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "UserPromptSubmit",
      projectId,
      sessionId,
      prompt: "recall-budget",
      requestedAt: "2026-08-25T12:32:00.000Z"
    });
    expect(result.state === "completed" ? result.text : "").not.toContain(
      "Automatic Top-N recall"
    );
  } finally {
    await server.close();
  }
});

test("foreground history retains at most three meaningful user prompts", async () => {
  const roots = await conversationalHistoryFixture();
  const server = await startForegroundRetrievalServer(roots);
  try {
    const sessionId = "history-count-session";
    await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "SessionStart",
      projectId,
      sessionId,
      requestedAt: "2026-08-25T12:40:00.000Z"
    });
    for (const [index, prompt] of [
      "evicted-history-anchor",
      "meaningful-one",
      "meaningful-two",
      "meaningful-three"
    ].entries()) {
      await requestForegroundRetrieval({
        runtimeRoot: roots.runtimeRoot,
        event: "UserPromptSubmit",
        projectId,
        sessionId,
        prompt,
        requestedAt: `2026-08-25T12:${String(41 + index).padStart(2, "0")}:00.000Z`
      });
    }
    const result = await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "UserPromptSubmit",
      projectId,
      sessionId,
      prompt: "recall-limit",
      requestedAt: "2026-08-25T12:50:00.000Z"
    });
    expect(result.state === "completed" ? result.text : "").not.toContain(
      "Automatic Top-N recall"
    );
  } finally {
    await server.close();
  }
});

test("the foreground client fails open when the Worker socket is unavailable", async () => {
  const root = await mkdtemp("/tmp/memstore-foreground-down-");
  roots.push(root);
  const started = performance.now();
  const result = await requestForegroundRetrieval({
    runtimeRoot: join(root, "runtime"),
    event: "SessionStart",
    projectId,
    sessionId: "worker-down",
    requestedAt: "2026-08-25T12:01:00.000Z",
    timeoutMilliseconds: 100
  });
  expect(result).toMatchObject({ state: "unavailable" });
  expect(performance.now() - started).toBeLessThan(250);
});

test("the default foreground deadline accepts a valid response within one second", async () => {
  const root = await mkdtemp("/tmp/memstore-foreground-one-second-");
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const socketPath = join(runtimeRoot, "state", "foreground-retrieval.sock");
  await mkdir(join(runtimeRoot, "state"), { recursive: true });
  const server = createServer((socket) => {
    let source = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      source += chunk;
      if (!source.includes("\n")) return;
      const request = JSON.parse(source.split("\n", 1)[0] ?? "{}") as { requestId?: string };
      setTimeout(() => {
        socket.end(`${JSON.stringify({
          schemaVersion: 2,
          requestId: request.requestId,
          state: "completed",
          event: "SessionStart",
          text: "<memstore-context>response inside one second</memstore-context>",
          receiptId: "msreceipt_one_second",
          renderedTokenCount: 8
        })}\n`);
      }, 600);
    });
  });
  await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
  const started = performance.now();
  try {
    await expect(requestForegroundRetrieval({
      runtimeRoot,
      event: "SessionStart",
      projectId,
      sessionId: "one-second-deadline",
      requestedAt: "2026-08-26T01:00:00.000Z"
    })).resolves.toMatchObject({ state: "completed", receiptId: "msreceipt_one_second" });
    expect(performance.now() - started).toBeGreaterThanOrEqual(500);
    expect(performance.now() - started).toBeLessThan(1_000);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    }));
  }
});

test("a token-saturated SessionStart snapshot stops optional scanning before the foreground deadline", async () => {
  const roots = await fixture();
  const snapshot = await saturatedSessionStartSnapshot(roots.runtimeRoot);
  const attempts: ForegroundAttemptRecord[] = [];
  const server = await startForegroundRetrievalServer({
    ...roots,
    adapter,
    snapshot,
    onAttempt: (attempt) => { attempts.push(attempt); }
  });
  const started = performance.now();
  try {
    const response = await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "SessionStart",
      projectId,
      sessionId: "token-saturated-snapshot-session",
      requestedAt: "2026-08-26T01:01:00.000Z"
    });
    expect(response.state).toBe("completed");
    if (response.state !== "completed") throw new Error("Expected a completed SessionStart.");
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(attempts.at(-1)).toMatchObject({
      outcome: "completed",
      postDeadlineWorkMs: 0
    });
    expect(attempts.at(-1)?.computeMs).toBeLessThan(300);
    await expect(inspectRetrievalReceipt(roots.runtimeRoot, response.receiptId)).resolves.toMatchObject({
      rowsExamined: 2_000,
      terminalStopReason: "candidates_exhausted"
    });
  } finally {
    await server.close();
  }
}, 15_000);

test("the foreground server never returns a different Project's memory", async () => {
  const roots = await fixture();
  const server = await startForegroundRetrievalServer({ ...roots, adapter });
  try {
    const result = await requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "SessionStart",
      projectId: "msproj_123e4567-e89b-42d3-a456-426614174899",
      sessionId: "other-project",
      requestedAt: "2026-08-25T12:01:00.000Z"
    });
    expect(result.state === "completed" ? result.text : "").not.toContain("Use SQLite WAL");
  } finally {
    await server.close();
  }
});

test("an active foreground result consumes its captured event exactly once", async () => {
  const roots = await fixture();
  const eventId = "msevent_foreground_exactly_once";
  await captureEvent({
    runtimeRoot: roots.runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId,
      deduplicationKey: "foreground:exactly-once",
      agent: "codex",
      eventKind: "SessionStart",
      occurredAt: "2026-08-25T12:01:00.000Z",
      sessionId: "foreground-exactly-once",
      projectId,
      payload: { source: "startup" }
    }
  });
  const server = await startForegroundRetrievalServer({ ...roots, adapter });
  try {
    await expect(requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "SessionStart",
      eventId,
      projectId,
      sessionId: "foreground-exactly-once",
      requestedAt: "2026-08-25T12:01:00.000Z"
    })).resolves.toMatchObject({ state: "completed" });
    await expect(inspectShadowEvaluation(roots.runtimeRoot, eventId)).resolves.toMatchObject({
      state: "completed",
      attemptCount: 1
    });
    await expect(runNextShadowEvaluation({
      ...roots,
      adapter,
      now: "2026-08-25T12:02:00.000Z"
    })).resolves.toEqual({ state: "empty" });
  } finally {
    await server.close();
  }
});

test("foreground reservation succeeds before a Capture Inbox event reaches SQLite", async () => {
  const roots = await fixture();
  const eventId = "msevent_foreground_inbox_pending";
  const server = await startForegroundRetrievalServer({ ...roots, adapter });
  try {
    await expect(requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "SessionStart",
      eventId,
      projectId,
      sessionId: "foreground-inbox-pending",
      requestedAt: "2026-08-25T12:03:00.000Z"
    })).resolves.toMatchObject({ state: "completed" });
    await expect(inspectShadowEvaluation(roots.runtimeRoot, eventId)).resolves.toMatchObject({
      state: "completed",
      attemptCount: 1
    });
    await captureEvent({
      runtimeRoot: roots.runtimeRoot,
      event: {
        schemaVersion: 1,
        eventId,
        deduplicationKey: "foreground:inbox-pending",
        agent: "codex",
        eventKind: "SessionStart",
        occurredAt: "2026-08-25T12:03:00.000Z",
        sessionId: "foreground-inbox-pending",
        projectId,
        payload: { source: "startup" }
      }
    });
    await expect(runNextShadowEvaluation({
      ...roots,
      adapter,
      now: "2026-08-25T12:04:00.000Z"
    })).resolves.toEqual({ state: "empty" });
  } finally {
    await server.close();
  }
});

test("Shadow skips a failed foreground event instead of replacing a newer Session epoch", async () => {
  const roots = await fixture();
  const sessionId = "foreground-shadow-recovery";
  const failedEventId = "msevent_foreground_shadow_failed";
  await captureEvent({
    runtimeRoot: roots.runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: failedEventId,
      deduplicationKey: "foreground:shadow-failed",
      agent: "codex",
      eventKind: "SessionStart",
      occurredAt: "2026-08-25T12:00:00.000Z",
      sessionId,
      projectId,
      payload: { source: "startup" }
    }
  });
  const server = await startForegroundRetrievalServer({ ...roots, adapter });
  try {
    await expect(requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "SessionStart",
      eventId: failedEventId,
      projectId,
      sessionId,
      requestedAt: "2026-08-25T12:00:00.000Z",
      timeoutMilliseconds: 10
    })).resolves.toMatchObject({ state: "deadline_exceeded" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "SessionStart",
      eventId: "msevent_foreground_shadow_newer",
      projectId,
      sessionId,
      requestedAt: "2026-08-25T12:10:00.000Z"
    })).resolves.toMatchObject({ state: "completed" });

    await expect(runNextShadowEvaluation({
      ...roots,
      adapter,
      now: "2026-08-25T12:20:00.000Z"
    })).resolves.toEqual({
      state: "skipped",
      eventId: failedEventId,
      reason: "foreground_delivery_failed"
    });
    const database = await openRuntimeDatabase(roots.runtimeRoot);
    try {
      expect(database.prepare(
        `SELECT started_at FROM context_epochs
         WHERE session_id = ? AND state = 'active'`
      ).get(sessionId)?.started_at).toBe("2026-08-25T12:10:00.000Z");
    } finally {
      database.close();
    }
  } finally {
    await server.close();
  }
});

async function rawSocketRequest(socketPath: string, source: string | Buffer): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolveResponse, rejectResponse) => {
    const socket = createConnection(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => { socket.write(source); });
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.once("error", rejectResponse);
    socket.once("end", () => {
      resolveResponse(JSON.parse(response.trim()) as Record<string, unknown>);
    });
  });
}

test("malformed and oversized socket messages are rejected without reaching retrieval", async () => {
  const roots = await fixture();
  const server = await startForegroundRetrievalServer({ ...roots, adapter });
  try {
    await expect(rawSocketRequest(server.socketPath, "not-json\n")).resolves.toMatchObject({
      state: "unavailable",
      code: "malformed_request"
    });
    await expect(rawSocketRequest(server.socketPath, `${"x".repeat(65 * 1024)}\n`)).resolves.toMatchObject({
      state: "unavailable",
      code: "request_too_large"
    });
  } finally {
    await server.close();
  }
});

test("startup removes a dead socket but refuses to replace an active Worker", async () => {
  const roots = await fixture();
  const socketPath = join(roots.runtimeRoot, "state", "foreground-retrieval.sock");
  const stale = spawnSync(process.execPath, [
    "-e",
    `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => process.exit(0))`
  ]);
  expect(stale.status, stale.stderr.toString()).toBe(0);
  expect((await stat(socketPath)).isSocket()).toBe(true);

  const server = await startForegroundRetrievalServer({ ...roots, adapter });
  try {
    await expect(startForegroundRetrievalServer({ ...roots, adapter })).rejects.toThrow(
      /already active/u
    );
  } finally {
    await server.close();
  }
});

test("the client rejects malformed responses and enforces its deadline", async () => {
  for (const behavior of ["malformed", "slow"] as const) {
    const root = await mkdtemp("/tmp/memstore-foreground-client-fault-");
    roots.push(root);
    const runtimeRoot = join(root, "runtime");
    const socketPath = join(runtimeRoot, "state", "foreground-retrieval.sock");
    await mkdir(join(runtimeRoot, "state"), { recursive: true });
    const server = createServer((socket) => {
      socket.on("data", () => {
        if (behavior === "malformed") socket.end("not-json\n");
      });
    });
    await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
    try {
      const response = await requestForegroundRetrieval({
        runtimeRoot,
        event: "SessionStart",
        projectId,
        sessionId: `client-fault-${behavior}`,
        requestedAt: "2026-08-25T12:01:00.000Z",
        timeoutMilliseconds: 50
      });
      expect(response).toMatchObject({
        state: behavior === "malformed" ? "unavailable" : "deadline_exceeded",
        ...(behavior === "malformed" ? { code: "malformed_response" } : {})
      });
      expect(response.requestId).toMatch(/^msforeground_/u);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => server.close((error) => {
        if (error === undefined) resolveClose();
        else rejectClose(error);
      }));
    }
  }
});

test("a SessionStart deadline leaves no Context Epoch or Receipt side effects", async () => {
  const roots = await fixture();
  const eventId = "msevent_foreground_session_deadline";
  const sessionId = "foreground-session-deadline";
  const server = await startForegroundRetrievalServer({ ...roots, adapter });
  try {
    await expect(requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "SessionStart",
      eventId,
      projectId,
      sessionId,
      requestedAt: "2026-08-25T12:09:00.000Z",
      timeoutMilliseconds: 10
    })).resolves.toMatchObject({ state: "deadline_exceeded" });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const database = await openRuntimeDatabase(roots.runtimeRoot);
    try {
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM context_epochs WHERE session_id = ?"
      ).get(sessionId)?.count).toBe(0);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM retrieval_receipts WHERE caller_identity = ?"
      ).get(`session:${sessionId}`)?.count).toBe(0);
    } finally {
      database.close();
    }
    await expect(inspectShadowEvaluation(roots.runtimeRoot, eventId)).resolves.toMatchObject({
      state: "retrying"
    });
  } finally {
    await server.close();
  }
});

test("an abandoned prompt holds one bounded embedding, rejects queued work, and writes no Receipt", async () => {
  const roots = await fixture();
  let releaseEmbedding: (() => void) | undefined;
  let notifyEmbeddingStarted: (() => void) | undefined;
  const embeddingStarted = new Promise<void>((resolve) => { notifyEmbeddingStarted = resolve; });
  const embeddingReleased = new Promise<void>((resolve) => { releaseEmbedding = resolve; });
  let blockNextQuery = true;
  const controlledAdapter: EmbeddingAdapter = {
    ...adapter,
    embedQuery: async (texts) => {
      if (blockNextQuery) {
        blockNextQuery = false;
        notifyEmbeddingStarted?.();
        await embeddingReleased;
      }
      return texts.map(() => [1, 0]);
    }
  };
  const server = await startForegroundRetrievalServer({ ...roots, adapter: controlledAdapter });
  try {
    await expect(requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "SessionStart",
      projectId,
      sessionId: "foreground-cancellation-session",
      requestedAt: "2026-08-25T12:10:00.000Z"
    })).resolves.toMatchObject({ state: "completed" });
    const beforeCancellation = await openRuntimeDatabase(roots.runtimeRoot);
    const epochTokensBefore = beforeCancellation.prepare(
      `SELECT automatic_token_total FROM context_epochs
       WHERE session_id = ? AND state = 'active'`
    ).get("foreground-cancellation-session")?.automatic_token_total;
    beforeCancellation.close();

    const abandoned = requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "UserPromptSubmit",
      projectId,
      sessionId: "foreground-cancellation-session",
      prompt: "How should SQLite WAL recover the durable queue?",
      requestedAt: "2026-08-25T12:11:00.000Z",
      timeoutMilliseconds: 50
    });
    await embeddingStarted;
    await expect(requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "UserPromptSubmit",
      projectId,
      sessionId: "foreground-cancellation-session",
      prompt: "A later caller must not wait behind abandoned work.",
      requestedAt: "2026-08-25T12:11:01.000Z",
      timeoutMilliseconds: 200
    })).resolves.toMatchObject({ state: "busy" });
    await expect(abandoned).resolves.toMatchObject({ state: "deadline_exceeded" });
    releaseEmbedding?.();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const database = await openRuntimeDatabase(roots.runtimeRoot);
    try {
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM retrieval_receipts WHERE caller_kind = 'user_prompt'"
      ).get()?.count).toBe(0);
      expect(database.prepare(
        `SELECT automatic_token_total FROM context_epochs
         WHERE session_id = ? AND state = 'active'`
      ).get("foreground-cancellation-session")?.automatic_token_total).toBe(epochTokensBefore);
    } finally {
      database.close();
    }
    await expect(requestForegroundRetrieval({
      runtimeRoot: roots.runtimeRoot,
      event: "UserPromptSubmit",
      projectId,
      sessionId: "foreground-cancellation-session",
      prompt: "How should SQLite WAL recover the durable queue?",
      requestedAt: "2026-08-25T12:12:00.000Z"
    })).resolves.toMatchObject({ state: "completed" });
  } finally {
    releaseEmbedding?.();
    await server.close();
  }
});
