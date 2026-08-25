import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { captureEvent } from "../../../src/capture/index.js";
import { buildRetrievalIndex, type EmbeddingAdapter } from "../../../src/retrieval/index.js";
import {
  startForegroundRetrievalServer
} from "../../../src/retrieval/foreground-ipc.js";
import { requestForegroundRetrieval } from "../../../src/retrieval/foreground-client.js";
import {
  inspectShadowEvaluation,
  runNextShadowEvaluation
} from "../../../src/retrieval/shadow-worker.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
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
      state: "error",
      code: "malformed_request"
    });
    await expect(rawSocketRequest(server.socketPath, `${"x".repeat(65 * 1024)}\n`)).resolves.toMatchObject({
      state: "error",
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
      await expect(requestForegroundRetrieval({
        runtimeRoot,
        event: "SessionStart",
        projectId,
        sessionId: `client-fault-${behavior}`,
        requestedAt: "2026-08-25T12:01:00.000Z",
        timeoutMilliseconds: 50
      })).resolves.toEqual({
        state: "unavailable",
        code: behavior === "malformed" ? "malformed_response" : "deadline_exceeded"
      });
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => server.close((error) => {
        if (error === undefined) resolveClose();
        else rejectClose(error);
      }));
    }
  }
});
