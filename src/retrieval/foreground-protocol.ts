import { resolve } from "node:path";
import { z } from "zod";

export const foregroundProtocolVersion = 2;
export const maximumForegroundRequestBytes = 64 * 1024;
export const maximumForegroundResponseBytes = 64 * 1024;

const commonRequestSchema = z.object({
  schemaVersion: z.literal(foregroundProtocolVersion),
  requestId: z.string().min(1),
  projectId: z.string().min(1),
  sessionId: z.string().min(1),
  requestedAt: z.iso.datetime(),
  deadlineAt: z.iso.datetime(),
  eventId: z.string().min(1).optional()
});

export const foregroundRequestSchema = z.discriminatedUnion("event", [
  commonRequestSchema.extend({ event: z.literal("SessionStart") }),
  commonRequestSchema.extend({
    event: z.literal("UserPromptSubmit"),
    prompt: z.string(),
    signals: z.object({
      files: z.array(z.string()),
      symbols: z.array(z.string()),
      errors: z.array(z.string()),
      commands: z.array(z.string())
    })
  })
]);

export const foregroundResponseSchema = z.discriminatedUnion("state", [
  z.object({
    schemaVersion: z.literal(foregroundProtocolVersion),
    requestId: z.string().min(1),
    state: z.literal("completed"),
    event: z.enum(["SessionStart", "UserPromptSubmit"]),
    text: z.string().min(1),
    receiptId: z.string().min(1),
    renderedTokenCount: z.number().int().nonnegative()
  }),
  z.object({
    schemaVersion: z.literal(foregroundProtocolVersion),
    requestId: z.string().min(1),
    state: z.literal("empty"),
    event: z.enum(["SessionStart", "UserPromptSubmit"]),
    reason: z.string().min(1)
  }),
  z.object({
    schemaVersion: z.literal(foregroundProtocolVersion),
    requestId: z.string().min(1),
    state: z.literal("busy")
  }),
  z.object({
    schemaVersion: z.literal(foregroundProtocolVersion),
    requestId: z.string().min(1),
    state: z.literal("deadline_exceeded")
  }),
  z.object({
    schemaVersion: z.literal(foregroundProtocolVersion),
    requestId: z.string().min(1),
    state: z.literal("unavailable"),
    code: z.string().min(1)
  })
]);

export type ForegroundRequest = z.infer<typeof foregroundRequestSchema>;
export type ForegroundWireResponse = z.infer<typeof foregroundResponseSchema>;

export type ForegroundRetrievalResult = ForegroundWireResponse | {
  readonly state: "unavailable";
  readonly requestId: string;
  readonly code: "socket_unavailable" | "malformed_response";
} | {
  readonly state: "deadline_exceeded";
  readonly requestId: string;
};

export function foregroundRetrievalSocketPath(runtimeRoot: string): string {
  return resolve(runtimeRoot, "state", "foreground-retrieval.sock");
}
