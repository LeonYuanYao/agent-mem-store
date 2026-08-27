import { expect, test } from "vitest";

import { startForegroundRuntime } from "../../src/retrieval/foreground-runtime.js";

const identity = {
  adapterVersion: "thread-fixture-v1",
  modelIdentity: "thread-fixture",
  artifactSha256: "d".repeat(64),
  dimensions: 2,
  normalization: "l2"
};

function fixtureWorkerUrl(): URL {
  const source = `
    import { parentPort } from "node:worker_threads";
    const identity = ${JSON.stringify(identity)};
    parentPort.on("message", (message) => {
      if (message.state === "embed") {
        if (message.texts.includes("crash")) process.exit(23);
        parentPort.postMessage({
          state: "embedding_completed",
          requestId: message.requestId,
          vectors: message.texts.map(() => [1, 0])
        });
      } else if (message.state === "publish_snapshot") {
        parentPort.postMessage({ state: "snapshot_published", requestId: message.requestId });
      } else if (message.state === "close") {
        parentPort.postMessage({ state: "closed" });
        parentPort.close();
      }
    });
    parentPort.postMessage({ state: "ready", identity });
  `;
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

test("the Foreground Runtime exposes one thread-owned embedding Adapter and closes cleanly", async () => {
  const runtime = await startForegroundRuntime({
    runtimeRoot: "/isolated/runtime",
    vaultRoot: "/isolated/vault",
    workerUrl: fixtureWorkerUrl(),
    startupTimeoutMilliseconds: 1_000
  });
  expect(runtime.threadId).toBeGreaterThan(0);
  expect(runtime.embedding.identity).toEqual(identity);
  await expect(runtime.embedding.embedDocuments?.(["one", "two"]))
    .resolves.toEqual([[1, 0], [1, 0]]);
  await runtime.close();
  await expect(runtime.embedding.embed(["after close"]))
    .rejects.toThrow("Foreground Runtime is closed");
});

test("a Foreground Runtime startup crash is surfaced without hanging", async () => {
  const crashUrl = new URL(
    `data:text/javascript,${encodeURIComponent("throw new Error('fixture crash')")}`
  );
  await expect(startForegroundRuntime({
    runtimeRoot: "/isolated/runtime",
    vaultRoot: "/isolated/vault",
    workerUrl: crashUrl,
    startupTimeoutMilliseconds: 1_000
  })).rejects.toThrow();
});

test("an unexpected thread exit restarts after the bounded first backoff", async () => {
  const runtime = await startForegroundRuntime({
    runtimeRoot: "/isolated/runtime-restart",
    vaultRoot: "/isolated/vault-restart",
    workerUrl: fixtureWorkerUrl(),
    startupTimeoutMilliseconds: 1_000
  });
  await expect(runtime.embedding.embed(["crash"])).rejects.toThrow(/exited/u);
  await expect(runtime.embedding.embed(["during restart"]))
    .rejects.toThrow("restarting");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await expect(runtime.embedding.embed(["after restart"]))
    .resolves.toEqual([[1, 0]]);
  await runtime.close();
});
