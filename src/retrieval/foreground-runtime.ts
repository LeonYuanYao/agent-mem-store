import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { z } from "zod";

import type { EmbeddingAdapter } from "./index.js";
import type { RetrievalSnapshot } from "./snapshot.js";
import {
  foregroundAttemptRecordSchema,
  recordForegroundAttempt,
  recordForegroundAttemptOverflow,
  type ForegroundAttemptRecord
} from "./foreground-attempts.js";

const embeddingIdentitySchema = z.object({
  adapterVersion: z.string().min(1),
  modelIdentity: z.string().min(1),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  dimensions: z.number().int().positive(),
  normalization: z.literal("l2")
});

const threadMessageSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), identity: embeddingIdentitySchema }),
  z.object({
    state: z.literal("embedding_completed"),
    requestId: z.string(),
    vectors: z.array(z.array(z.number()))
  }),
  z.object({
    state: z.literal("embedding_failed"),
    requestId: z.string(),
    code: z.string()
  }),
  z.object({ state: z.literal("snapshot_published"), requestId: z.string() }),
  z.object({ state: z.literal("snapshot_failed"), requestId: z.string(), code: z.string() }),
  z.object({ state: z.literal("foreground_attempt"), attempt: foregroundAttemptRecordSchema }),
  z.object({ state: z.literal("foreground_pressure") }),
  z.object({ state: z.literal("closed") }),
  z.object({ state: z.literal("failed"), code: z.string() })
]);

interface PendingRequest {
  readonly resolve: (value: readonly (readonly number[])[]) => void;
  readonly reject: (error: Error) => void;
}

export interface ForegroundRuntime {
  readonly embedding: EmbeddingAdapter;
  readonly threadId: number;
  hasRecentPressure(): boolean;
  publishSnapshot(snapshot: RetrievalSnapshot): Promise<void>;
  close(): Promise<void>;
}

export async function startForegroundRuntime(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly startupTimeoutMilliseconds?: number;
  readonly workerUrl?: URL;
}): Promise<ForegroundRuntime> {
  const worker = new Worker(
    request.workerUrl ?? new URL("./foreground-thread.js", import.meta.url), {
    workerData: {
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot
    }
  });
  const pending = new Map<string, PendingRequest>();
  const snapshotPending = new Map<string, { resolve(): void; reject(error: Error): void }>();
  let closed = false;
  let exited = false;
  let startupResolved = false;
  let replacement: ForegroundRuntime | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let closeResolve: (() => void) | undefined;
  let attemptPersistence = Promise.resolve();
  let queuedAttemptCount = 0;
  const overflowAttempts = new Map<string, {
    readonly bucketAt: string;
    readonly outcome: ForegroundAttemptRecord["outcome"];
    count: number;
  }>();
  let overflowTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPressureAt = Number.NEGATIVE_INFINITY;
  const closedPromise = new Promise<void>((resolve) => { closeResolve = resolve; });
  const ready = new Promise<EmbeddingAdapter["identity"]>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error("Foreground Runtime startup timed out."));
      void worker.terminate();
    }, request.startupTimeoutMilliseconds ?? 120_000);
    worker.on("message", (message: unknown) => {
      const parsed = threadMessageSchema.safeParse(message);
      if (!parsed.success) return;
      if (parsed.data.state === "ready") {
        clearTimeout(timeout);
        resolveReady(parsed.data.identity);
        return;
      }
      if (parsed.data.state === "embedding_completed") {
        const operation = pending.get(parsed.data.requestId);
        pending.delete(parsed.data.requestId);
        operation?.resolve(parsed.data.vectors);
        return;
      }
      if (parsed.data.state === "embedding_failed") {
        const operation = pending.get(parsed.data.requestId);
        pending.delete(parsed.data.requestId);
        operation?.reject(new Error(parsed.data.code));
        return;
      }
      if (parsed.data.state === "snapshot_published") {
        const publication = snapshotPending.get(parsed.data.requestId);
        snapshotPending.delete(parsed.data.requestId);
        publication?.resolve();
        return;
      }
      if (parsed.data.state === "snapshot_failed") {
        const publication = snapshotPending.get(parsed.data.requestId);
        snapshotPending.delete(parsed.data.requestId);
        publication?.reject(new Error(parsed.data.code));
        return;
      }
      if (parsed.data.state === "foreground_attempt") {
        const attempt = parsed.data.attempt;
        if (queuedAttemptCount >= 1_024) {
          const bucketAt = `${attempt.completedAt.slice(0, 16)}:00.000Z`;
          const key = `${bucketAt}\0${attempt.outcome}`;
          const overflow = overflowAttempts.get(key) ?? {
            bucketAt,
            outcome: attempt.outcome,
            count: 0
          };
          overflow.count += 1;
          overflowAttempts.set(key, overflow);
          overflowTimer ??= setTimeout(() => { flushAttemptOverflow(); }, 1_000);
          return;
        }
        queuedAttemptCount += 1;
        attemptPersistence = attemptPersistence.then(() => recordForegroundAttempt({
          runtimeRoot: request.runtimeRoot,
          attempt
        })).catch(() => undefined).finally(() => { queuedAttemptCount -= 1; });
        return;
      }
      if (parsed.data.state === "foreground_pressure") {
        lastPressureAt = performance.now();
        return;
      }
      if (parsed.data.state === "failed") {
        clearTimeout(timeout);
        rejectReady(new Error(parsed.data.code));
        return;
      }
      closeResolve?.();
    });
    worker.once("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
  });
  worker.once("exit", (code) => {
    exited = true;
    const error = new Error(`Foreground Runtime thread exited with code ${String(code)}.`);
    for (const operation of pending.values()) operation.reject(error);
    pending.clear();
    for (const publication of snapshotPending.values()) publication.reject(error);
    snapshotPending.clear();
    closeResolve?.();
    if (startupResolved && !closed) scheduleRestart();
  });
  const identity = await ready;
  startupResolved = true;
  let restartAttempt = 0;
  function scheduleRestart(): void {
    if (closed || replacement !== undefined || restartTimer !== undefined) return;
    const delayMilliseconds = [1_000, 5_000, 30_000][Math.min(restartAttempt, 2)] ?? 30_000;
    restartAttempt += 1;
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      void startForegroundRuntime(request).then(
        (started) => {
          if (closed) {
            void started.close();
            return;
          }
          if (JSON.stringify(started.embedding.identity) !== JSON.stringify(identity)) {
            void started.close();
            scheduleRestart();
            return;
          }
          replacement = started;
        },
        () => { scheduleRestart(); }
      );
    }, delayMilliseconds);
  }

  function flushAttemptOverflow(): void {
    if (overflowTimer !== undefined) clearTimeout(overflowTimer);
    overflowTimer = undefined;
    const pendingOverflow = [...overflowAttempts.values()];
    overflowAttempts.clear();
    for (const overflow of pendingOverflow) {
      attemptPersistence = attemptPersistence.then(() => recordForegroundAttemptOverflow({
        runtimeRoot: request.runtimeRoot,
        bucketAt: overflow.bucketAt,
        outcome: overflow.outcome,
        occurrenceCount: overflow.count
      })).catch(() => undefined);
    }
  }

  const embed = (kind: "documents" | "query", texts: readonly string[]) =>
    new Promise<readonly (readonly number[])[]>((resolveEmbedding, rejectEmbedding) => {
      if (closed) {
        rejectEmbedding(new Error("Foreground Runtime is closed."));
        return;
      }
      if (replacement !== undefined) {
        const operation = kind === "query"
          ? replacement.embedding.embedQuery?.(texts) ?? replacement.embedding.embed(texts)
          : replacement.embedding.embedDocuments?.(texts) ?? replacement.embedding.embed(texts);
        void operation.then(resolveEmbedding, rejectEmbedding);
        return;
      }
      if (exited) {
        rejectEmbedding(new Error("Foreground Runtime is restarting."));
        return;
      }
      const requestId = `msembedding_${randomUUID()}`;
      pending.set(requestId, { resolve: resolveEmbedding, reject: rejectEmbedding });
      worker.postMessage({ state: "embed", requestId, kind, texts: [...texts] });
    });
  return {
    embedding: {
      identity,
      embed: (texts) => embed("documents", texts),
      embedDocuments: (texts) => embed("documents", texts),
      embedQuery: (texts) => embed("query", texts)
    },
    get threadId() { return replacement?.threadId ?? worker.threadId; },
    hasRecentPressure: () => replacement?.hasRecentPressure() ??
      performance.now() - lastPressureAt <= 250,
    publishSnapshot: (snapshot) => new Promise<void>((resolvePublication, rejectPublication) => {
      if (closed) {
        rejectPublication(new Error("Foreground Runtime is closed."));
        return;
      }
      if (replacement !== undefined) {
        void replacement.publishSnapshot(snapshot).then(resolvePublication, rejectPublication);
        return;
      }
      if (exited) {
        rejectPublication(new Error("Foreground Runtime is restarting."));
        return;
      }
      const requestId = `mssnapshot_${randomUUID()}`;
      snapshotPending.set(requestId, { resolve: resolvePublication, reject: rejectPublication });
      const transfer = snapshot.vectors.buffer instanceof ArrayBuffer
        ? [snapshot.vectors.buffer]
        : [];
      worker.postMessage({ state: "publish_snapshot", requestId, snapshot }, transfer);
    }),
    close: async () => {
      if (closed) return;
      closed = true;
      flushAttemptOverflow();
      if (restartTimer !== undefined) clearTimeout(restartTimer);
      if (replacement !== undefined) {
        await replacement.close();
        await attemptPersistence;
        return;
      }
      if (exited) {
        await attemptPersistence;
        return;
      }
      worker.postMessage({ state: "close" });
      const timeout = setTimeout(() => { void worker.terminate(); }, 5_000);
      await closedPromise;
      await attemptPersistence;
      clearTimeout(timeout);
    }
  };
}
