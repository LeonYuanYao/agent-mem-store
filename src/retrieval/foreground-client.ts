import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

import {
  foregroundProtocolVersion,
  foregroundRequestSchema,
  foregroundResponseSchema,
  foregroundRetrievalSocketPath,
  maximumForegroundRequestBytes,
  maximumForegroundResponseBytes,
  type ForegroundRequest,
  type ForegroundRetrievalResult
} from "./foreground-protocol.js";

const defaultClientTimeoutMilliseconds = 1_000;
const emptySignals = { files: [], symbols: [], errors: [], commands: [] } as const;

export { foregroundRetrievalSocketPath } from "./foreground-protocol.js";
export type { ForegroundRetrievalResult } from "./foreground-protocol.js";

export async function requestForegroundRetrieval(request: {
  readonly runtimeRoot: string;
  readonly event: "SessionStart" | "UserPromptSubmit";
  readonly projectId: string;
  readonly sessionId: string;
  readonly eventId?: string;
  readonly prompt?: string;
  readonly signals?: {
    readonly files: readonly string[];
    readonly symbols: readonly string[];
    readonly errors: readonly string[];
    readonly commands: readonly string[];
  };
  readonly requestedAt: string;
  readonly timeoutMilliseconds?: number;
}): Promise<ForegroundRetrievalResult> {
  const requestId = `msforeground_${randomUUID()}`;
  const timeoutMilliseconds = request.timeoutMilliseconds ?? defaultClientTimeoutMilliseconds;
  const deadlineAt = new Date(Date.now() + timeoutMilliseconds).toISOString();
  const payload: ForegroundRequest = request.event === "SessionStart"
    ? {
        schemaVersion: foregroundProtocolVersion,
        requestId,
        event: request.event,
        projectId: request.projectId,
        sessionId: request.sessionId,
        requestedAt: request.requestedAt,
        deadlineAt,
        ...(request.eventId === undefined ? {} : { eventId: request.eventId })
      }
    : {
        schemaVersion: foregroundProtocolVersion,
        requestId,
        event: request.event,
        projectId: request.projectId,
        sessionId: request.sessionId,
        ...(request.eventId === undefined ? {} : { eventId: request.eventId }),
        prompt: request.prompt ?? "",
        signals: {
          files: [...(request.signals?.files ?? emptySignals.files)],
          symbols: [...(request.signals?.symbols ?? emptySignals.symbols)],
          errors: [...(request.signals?.errors ?? emptySignals.errors)],
          commands: [...(request.signals?.commands ?? emptySignals.commands)]
        },
        requestedAt: request.requestedAt,
        deadlineAt
      };
  foregroundRequestSchema.parse(payload);
  const source = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  if (source.byteLength > maximumForegroundRequestBytes) {
    return { state: "unavailable", requestId, code: "malformed_response" };
  }
  return new Promise<ForegroundRetrievalResult>((resolveResult) => {
    const socket = createConnection(foregroundRetrievalSocketPath(request.runtimeRoot));
    let response = Buffer.alloc(0);
    let settled = false;
    const finish = (result: ForegroundRetrievalResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveResult(result);
    };
    const timer = setTimeout(
      () => { finish({ state: "deadline_exceeded", requestId }); },
      Math.max(1, Date.parse(deadlineAt) - Date.now())
    );
    socket.once("connect", () => { socket.write(source); });
    socket.on("data", (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      if (response.byteLength > maximumForegroundResponseBytes) {
        finish({ state: "unavailable", requestId, code: "malformed_response" });
        return;
      }
      const newline = response.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const parsed = foregroundResponseSchema.safeParse(
          JSON.parse(response.subarray(0, newline).toString("utf8"))
        );
        if (!parsed.success || parsed.data.requestId !== requestId) {
          finish({ state: "unavailable", requestId, code: "malformed_response" });
          return;
        }
        finish(parsed.data);
      } catch {
        finish({ state: "unavailable", requestId, code: "malformed_response" });
      }
    });
    socket.once("error", () => {
      finish({ state: "unavailable", requestId, code: "socket_unavailable" });
    });
    socket.once("end", () => {
      if (!settled) finish({ state: "unavailable", requestId, code: "malformed_response" });
    });
  });
}
