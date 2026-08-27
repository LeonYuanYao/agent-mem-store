import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";

import { loadConfiguredEmbeddingAdapter } from "./embeddings/configured.js";
import { startForegroundRetrievalServer } from "./foreground-ipc.js";
import type { EmbeddingAdapter } from "./index.js";
import { validateRetrievalSnapshot } from "./snapshot.js";

const port = z.custom<NonNullable<typeof parentPort>>((value) => value !== null).parse(parentPort);
const configuration = z.object({
  runtimeRoot: z.string().min(1),
  vaultRoot: z.string().min(1)
}).parse(workerData);

const commandSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("embed"),
    requestId: z.string().min(1),
    kind: z.enum(["documents", "query"]),
    texts: z.array(z.string())
  }),
  z.object({
    state: z.literal("publish_snapshot"),
    requestId: z.string().min(1),
    snapshot: z.unknown()
  }),
  z.object({ state: z.literal("close") })
]);

let startupStage = "load_adapter";
void (async () => {
  const loaded = await loadConfiguredEmbeddingAdapter(configuration.runtimeRoot);
  if (loaded === undefined) throw new Error("embedding_adapter_unavailable");
  type ScheduledEmbedding = {
    readonly kind: "documents" | "query";
    readonly texts: readonly string[];
    readonly resolve: (vectors: readonly (readonly number[])[]) => void;
    readonly reject: (error: Error) => void;
  };
  const queryQueue: ScheduledEmbedding[] = [];
  const documentQueue: ScheduledEmbedding[] = [];
  let embeddingActive = false;
  let closing = false;
  const idleResolvers: Array<() => void> = [];
  const resolveIdle = (): void => {
    if (embeddingActive || queryQueue.length > 0 || documentQueue.length > 0) return;
    for (const resolveIdleWaiter of idleResolvers.splice(0)) resolveIdleWaiter();
  };
  const pump = (): void => {
    if (embeddingActive) return;
    const operation = queryQueue.shift() ?? documentQueue.shift();
    if (operation === undefined) return;
    embeddingActive = true;
    const embedded = operation.kind === "query"
      ? loaded.adapter.embedQuery?.(operation.texts) ?? loaded.adapter.embed(operation.texts)
      : loaded.adapter.embedDocuments?.(operation.texts) ?? loaded.adapter.embed(operation.texts);
    void embedded.then(operation.resolve, operation.reject).finally(() => {
      embeddingActive = false;
      pump();
      resolveIdle();
    });
  };
  const scheduleEmbedding = (
    kind: "documents" | "query",
    texts: readonly string[]
  ): Promise<readonly (readonly number[])[]> => new Promise((resolve, reject) => {
    if (closing) {
      reject(new Error("Foreground embedding scheduler is closing."));
      return;
    }
    const operation = { kind, texts, resolve, reject };
    if (kind === "query") queryQueue.push(operation);
    else documentQueue.push(operation);
    pump();
  });
  const scheduledAdapter: EmbeddingAdapter = {
    identity: loaded.adapter.identity,
    embed: (texts) => scheduleEmbedding("documents", texts),
    embedDocuments: (texts) => scheduleEmbedding("documents", texts),
    embedQuery: (texts) => scheduleEmbedding("query", texts)
  };
  startupStage = "start_server";
  const server = await startForegroundRetrievalServer({
    ...configuration,
    adapter: scheduledAdapter,
    allowUnavailableSnapshot: true,
    onPressure: () => { port.postMessage({ state: "foreground_pressure" }); },
    onAttempt: (attempt) => { port.postMessage({ state: "foreground_attempt", attempt }); }
  });
  port.on("message", (message: unknown) => {
    const parsed = commandSchema.safeParse(message);
    if (!parsed.success) return;
    if (parsed.data.state === "close") {
      closing = true;
      void Promise.resolve().then(async () => {
        await server.close();
        if (embeddingActive || queryQueue.length > 0 || documentQueue.length > 0) {
          await new Promise<void>((resolveIdleWaiter) => {
            idleResolvers.push(resolveIdleWaiter);
          });
        }
        await loaded.dispose();
        port.postMessage({ state: "closed" });
        port.close();
      });
      return;
    }
    if (parsed.data.state === "publish_snapshot") {
      try {
        server.publishSnapshot(validateRetrievalSnapshot(parsed.data.snapshot));
        port.postMessage({ state: "snapshot_published", requestId: parsed.data.requestId });
      } catch {
        port.postMessage({
          state: "snapshot_failed",
          requestId: parsed.data.requestId,
          code: "snapshot_invalid"
        });
      }
      return;
    }
    const operation = parsed.data;
    void scheduleEmbedding(operation.kind, operation.texts).then(
      (vectors) => {
        port.postMessage({
          state: "embedding_completed",
          requestId: operation.requestId,
          vectors
        });
      },
      () => {
        port.postMessage({
          state: "embedding_failed",
          requestId: operation.requestId,
          code: "embedding_failed"
        });
      }
    );
  });
  port.postMessage({ state: "ready", identity: loaded.adapter.identity });
})().catch((error: unknown) => {
  const rawCode = typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string"
    ? error.code
    : error instanceof Error
      ? error.name
      : "unknown";
  const compactCode = rawCode.toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
  port.postMessage({
    state: "failed",
    code: `foreground_thread_${startupStage}_${compactCode || "failed"}`
  });
});
