import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";

import type { EmbeddingAdapter } from "./index.js";
import {
  createForegroundRetrievalLane,
  type ForegroundExecutionControl
} from "./foreground-lane.js";
import type { ForegroundAttemptRecord } from "./foreground-attempts.js";
import {
  prepareSessionStartShadowPack,
  prepareUserPromptShadowPack
} from "./packs.js";
import {
  finishForegroundEvaluation,
  reserveForegroundEvaluation
} from "./shadow-worker.js";
import {
  foregroundProtocolVersion,
  foregroundRequestSchema,
  foregroundRetrievalSocketPath,
  maximumForegroundRequestBytes,
  type ForegroundRequest,
  type ForegroundWireResponse
} from "./foreground-protocol.js";
import { loadRetrievalSnapshot, type RetrievalSnapshot } from "./snapshot.js";
import { validateRetrievalSnapshot } from "./snapshot.js";

function writeResponse(socket: Socket, response: ForegroundWireResponse): void {
  if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
}

async function prepareResponse(request: ForegroundRequest, options: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly adapter: EmbeddingAdapter;
  readonly snapshot: RetrievalSnapshot;
  readonly control: ForegroundExecutionControl;
  readonly onReceiptCommitted: (receiptCommitMs: number) => void;
}): Promise<ForegroundWireResponse> {
  await options.control.checkpoint("before_reservation");
  const reserved = request.eventId === undefined || await reserveForegroundEvaluation({
    runtimeRoot: options.runtimeRoot,
    eventId: request.eventId,
    eventKind: request.event,
    reservedAt: request.requestedAt
  });
  if (!reserved) {
    return {
      schemaVersion: foregroundProtocolVersion,
      requestId: request.requestId,
      state: "empty",
      event: request.event,
      reason: "event_already_evaluated"
    };
  }
  try {
    await options.control.checkpoint("after_reservation");
    const pack = request.event === "SessionStart"
      ? await prepareSessionStartShadowPack({
          runtimeRoot: options.runtimeRoot,
          vaultRoot: options.vaultRoot,
          projectId: request.projectId,
          sessionId: request.sessionId,
          requestedAt: request.requestedAt,
          snapshot: options.snapshot,
          foregroundControl: options.control
        })
      : await prepareUserPromptShadowPack({
          runtimeRoot: options.runtimeRoot,
          vaultRoot: options.vaultRoot,
          projectId: request.projectId,
          sessionId: request.sessionId,
          prompt: request.prompt,
          signals: request.signals,
          adapter: options.adapter,
          requestedAt: request.requestedAt,
          snapshot: options.snapshot,
          foregroundControl: options.control
        });
    options.onReceiptCommitted(pack.receiptCommitMs);
    await options.control.checkpoint("after_pack");
    if (pack.receiptId.startsWith("msreceipt_unrecorded_")) {
      throw new Error("Foreground retrieval receipt was not recorded.");
    }
    if (request.eventId !== undefined) {
      await finishForegroundEvaluation({
        runtimeRoot: options.runtimeRoot,
        eventId: request.eventId,
        state: "completed",
        receiptId: pack.receiptId,
        updatedAt: request.requestedAt
      });
    }
    if (pack.text.length === 0) {
      return {
        schemaVersion: foregroundProtocolVersion,
        requestId: request.requestId,
        state: "empty",
        event: request.event,
        reason: pack.emptyReason ?? "no_eligible_memory"
      };
    }
    return {
      schemaVersion: foregroundProtocolVersion,
      requestId: request.requestId,
      state: "completed",
      event: request.event,
      text: pack.text,
      receiptId: pack.receiptId,
      renderedTokenCount: pack.renderedTokenCount
    };
  } catch (error) {
    if (request.eventId !== undefined) {
      await finishForegroundEvaluation({
        runtimeRoot: options.runtimeRoot,
        eventId: request.eventId,
        state: "retrying",
        errorCode: "foreground_retrieval_failed",
        updatedAt: request.requestedAt
      });
    }
    throw error;
  }
}

function serveConnection(socket: Socket, options: {
  readonly lane: ReturnType<typeof createForegroundRetrievalLane<
    ForegroundRequest,
    ForegroundWireResponse
  >>;
  readonly onPressure?: () => void;
}): void {
  let source = Buffer.alloc(0);
  let handled = false;
  const disconnect = new AbortController();
  socket.on("data", (chunk: Buffer) => {
    if (handled) return;
    source = Buffer.concat([source, chunk]);
    if (source.byteLength > maximumForegroundRequestBytes) {
      handled = true;
      writeResponse(socket, {
        schemaVersion: foregroundProtocolVersion,
        requestId: "oversized",
        state: "unavailable",
        code: "request_too_large"
      });
      return;
    }
    const newline = source.indexOf(0x0a);
    if (newline < 0) return;
    handled = true;
    let document: unknown;
    try {
      document = JSON.parse(source.subarray(0, newline).toString("utf8"));
    } catch {
      writeResponse(socket, {
        schemaVersion: foregroundProtocolVersion,
        requestId: "malformed",
        state: "unavailable",
        code: "malformed_request"
      });
      return;
    }
    const parsed = foregroundRequestSchema.safeParse(document);
    if (!parsed.success) {
      writeResponse(socket, {
        schemaVersion: foregroundProtocolVersion,
        requestId: "malformed",
        state: "unavailable",
        code: "malformed_request"
      });
      return;
    }
    options.onPressure?.();
    void options.lane.run(parsed.data, { signal: disconnect.signal }).then((response) => {
      if (response.state === "cancelled") return;
      if (response.state === "busy" || response.state === "deadline_exceeded") {
        writeResponse(socket, {
          schemaVersion: foregroundProtocolVersion,
          requestId: response.requestId,
          state: response.state
        });
        return;
      }
      if (response.state === "unavailable") {
        writeResponse(socket, {
          schemaVersion: foregroundProtocolVersion,
          requestId: response.requestId,
          state: "unavailable",
          code: "retrieval_unavailable"
        });
        return;
      }
      writeResponse(socket, response);
    });
  });
  socket.on("error", () => { disconnect.abort(); });
  socket.on("close", () => { disconnect.abort(); });
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    const socket = createConnection(socketPath);
    const finish = (active: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(active);
    };
    const timer = setTimeout(() => { finish(false); }, 100);
    socket.once("connect", () => { finish(true); });
    socket.once("error", () => { finish(false); });
  });
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const metadata = await lstat(socketPath);
    if (!metadata.isSocket()) throw new Error(`Foreground retrieval path is not a socket: ${socketPath}`);
    if (await socketAcceptsConnections(socketPath)) {
      throw new Error(`Foreground retrieval socket is already active: ${socketPath}`);
    }
    await rm(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function startForegroundRetrievalServer(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly adapter: EmbeddingAdapter;
  readonly snapshot?: RetrievalSnapshot;
  readonly allowUnavailableSnapshot?: boolean;
  readonly onAttempt?: (attempt: ForegroundAttemptRecord) => void;
  readonly onPressure?: () => void;
}): Promise<{
  readonly socketPath: string;
  publishSnapshot(snapshot: RetrievalSnapshot): void;
  close(): Promise<void>;
}> {
  const socketPath = foregroundRetrievalSocketPath(request.runtimeRoot);
  await mkdir(resolve(request.runtimeRoot, "state"), { recursive: true, mode: 0o700 });
  await removeStaleSocket(socketPath);
  let activeSnapshot = request.snapshot;
  if (activeSnapshot === undefined) {
    try {
      activeSnapshot = await loadRetrievalSnapshot({ runtimeRoot: request.runtimeRoot });
    } catch (error) {
      if (request.allowUnavailableSnapshot !== true) throw error;
    }
  }
  const requestSnapshotIds = new Map<string, string>();
  const requestReceiptCommitMs = new Map<string, number>();
  const lane = createForegroundRetrievalLane<ForegroundRequest, ForegroundWireResponse>({
    execute: (foregroundRequest, control) => {
      const snapshot = activeSnapshot;
      if (snapshot !== undefined) {
        requestSnapshotIds.set(foregroundRequest.requestId, snapshot.indexRevisionId);
      }
      return snapshot === undefined
      ? Promise.resolve({
          schemaVersion: foregroundProtocolVersion,
          requestId: foregroundRequest.requestId,
          state: "unavailable" as const,
          code: "snapshot_unavailable"
        })
      : prepareResponse(foregroundRequest, {
          ...request,
          snapshot,
          control,
          onReceiptCommitted: (receiptCommitMs) => {
            requestReceiptCommitMs.set(foregroundRequest.requestId, receiptCommitMs);
          }
        });
    },
    onAttempt: (attempt, foregroundRequest, result) => {
      const indexRevisionId = requestSnapshotIds.get(foregroundRequest.requestId);
      const receiptCommitMs = requestReceiptCommitMs.get(foregroundRequest.requestId) ?? 0;
      requestSnapshotIds.delete(foregroundRequest.requestId);
      requestReceiptCommitMs.delete(foregroundRequest.requestId);
      request.onAttempt?.({
        requestId: foregroundRequest.requestId,
        eventKind: foregroundRequest.event,
        ...(foregroundRequest.eventId === undefined
          ? {}
          : { eventId: foregroundRequest.eventId }),
        projectId: foregroundRequest.projectId,
        ...(result.state === "completed" ? { receiptId: result.receiptId } : {}),
        ...(indexRevisionId === undefined ? {} : { indexRevisionId }),
        outcome: attempt.outcome,
        admissionDelayMs: attempt.admissionDelayMs,
        computeMs: attempt.computeMs,
        receiptCommitMs,
        observedClientElapsedMs: attempt.computeMs,
        ...(attempt.outcome === "cancelled"
          ? { cancellationObservedMs: attempt.computeMs }
          : {}),
        postDeadlineWorkMs: attempt.postDeadlineWorkMs,
        createdAt: attempt.createdAt,
        completedAt: attempt.completedAt
      });
    }
  });
  const server = createServer((socket) => {
    serveConnection(socket, {
      lane,
      ...(request.onPressure === undefined ? {} : { onPressure: request.onPressure })
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => { rejectListen(error); };
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
  await chmod(socketPath, 0o600);
  let closed = false;
  return {
    socketPath,
    publishSnapshot: (snapshot) => {
      activeSnapshot = validateRetrievalSnapshot(snapshot);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(server);
      await rm(socketPath, { force: true });
    }
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    });
  });
}
