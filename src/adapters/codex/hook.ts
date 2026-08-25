import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";

import {
  captureEvent,
  type CaptureEvent,
  recordHookSqliteBusyDiagnostic,
  recordCaptureHealthIncident
} from "../../capture/index.js";
import { spoolCaptureEvent } from "../../capture/emergency-spool.js";
import { classifyLocalSensitivity } from "../../contracts/sensitivity.js";
import { resolveProject } from "../../projects/index.js";

const hookInputSchema = z.object({
  hook_event_name: z.enum([
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "Stop",
    "SessionEnd"
  ]),
  session_id: z.string().min(1),
  transcript_path: z.string().nullable().optional(),
  turn_id: z.string().min(1).optional(),
  cwd: z.string().min(1),
  model: z.string().nullable().optional(),
  permission_mode: z.string().nullable().optional(),
  source: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  tool_name: z.string().min(1).optional(),
  tool_use_id: z.string().min(1).optional(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  prompt: z.string().optional(),
  last_assistant_message: z.string().optional(),
  stop_hook_active: z.boolean().optional()
});

export interface CodexHookRequest {
  readonly runtimeRoot: string;
  readonly input: unknown;
  readonly receivedAt?: string;
}

export type CodexHookResult =
  | {
      readonly continue: true;
      readonly captured: true;
      readonly state: "captured" | "duplicate" | "spooled";
      readonly eventId: string;
      readonly projectId?: string;
    }
  | {
      readonly continue: true;
      readonly captured: false;
      readonly state: "blocked_secret" | "quarantined";
      readonly findingId: string;
    }
  | {
      readonly continue: true;
      readonly captured: false;
      readonly state: "capture_unavailable";
      readonly diagnostic: {
        readonly code: "capture_unavailable";
        readonly eventKind: string;
      };
    };

const maximumToolFieldBytes = 16 * 1024;
const hookSqliteBusyTimeoutMilliseconds = 100;

function boundedStructuredValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  try {
    const source = JSON.stringify(value);
    const bytes = Buffer.from(source, "utf8");
    if (bytes.byteLength <= maximumToolFieldBytes) {
      return value;
    }
    return {
      memstoreTruncated: true,
      originalBytes: bytes.byteLength,
      retainedJsonPrefix: new TextDecoder().decode(
        bytes.subarray(0, maximumToolFieldBytes - 128)
      )
    };
  } catch {
    return { memstoreUnserializable: true };
  }
}

function hookPayload(input: z.infer<typeof hookInputSchema>): unknown {
  if (input.hook_event_name === "PostToolUse") {
    const originalToolData = JSON.stringify({
      input: input.tool_input,
      response: input.tool_response
    });
    const sensitivity = classifyLocalSensitivity(originalToolData);
    if (sensitivity.state !== "normal") {
      return {
        toolName: input.tool_name,
        toolCallId: input.tool_use_id,
        input: input.tool_input,
        response: input.tool_response
      };
    }
    const boundedInput = boundedStructuredValue(input.tool_input);
    const boundedResponse = boundedStructuredValue(input.tool_response);
    const inputRecord = z.record(z.string(), z.unknown()).safeParse(input.tool_input);
    const responseRecord = z.record(z.string(), z.unknown()).safeParse(input.tool_response);
    const command = inputRecord.success
      ? typeof inputRecord.data.command === "string"
        ? inputRecord.data.command
        : typeof inputRecord.data.cmd === "string"
          ? inputRecord.data.cmd
          : undefined
      : undefined;
    const exitCode = responseRecord.success
      ? typeof responseRecord.data.exitCode === "number"
        ? responseRecord.data.exitCode
        : typeof responseRecord.data.exit_code === "number"
          ? responseRecord.data.exit_code
          : undefined
      : undefined;
    const responseWasTruncated =
      z.record(z.string(), z.unknown()).safeParse(boundedResponse).data
        ?.memstoreTruncated === true;
    return {
      toolName: input.tool_name,
      toolCallId: input.tool_use_id,
      cwd: input.cwd,
      input: boundedInput,
      response: boundedResponse,
      ...(command === undefined ? {} : { command }),
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(responseWasTruncated
        ? {}
        : {
            resultContentIdentity: createHash("sha256")
              .update(JSON.stringify({ response: boundedResponse }))
              .digest("hex")
          })
    };
  }
  if (input.hook_event_name === "Stop") {
    return { assistantMessage: input.last_assistant_message ?? "" };
  }
  if (input.hook_event_name === "UserPromptSubmit") {
    return { prompt: input.prompt ?? "" };
  }
  if (input.hook_event_name === "SessionStart") {
    return { source: input.source ?? "unknown" };
  }
  return { reason: input.reason ?? "other" };
}

function hookIdentity(input: z.infer<typeof hookInputSchema>): {
  readonly eventId: string;
  readonly deduplicationKey: string;
} {
  const stableOccurrenceId = input.tool_use_id ?? input.turn_id;
  if (stableOccurrenceId === undefined) {
    const eventId = `msevent_codex_${randomUUID()}`;
    return { eventId, deduplicationKey: `codex:${eventId}` };
  }
  const digest = createHash("sha256")
    .update(input.session_id)
    .update("\0")
    .update(input.hook_event_name)
    .update("\0")
    .update(stableOccurrenceId)
    .digest("hex");
  const eventId = `msevent_codex_${digest.slice(0, 32)}`;
  return {
    eventId,
    deduplicationKey: `codex:${input.session_id}:${input.hook_event_name}:${stableOccurrenceId}`
  };
}

export async function handleCodexHook(
  request: CodexHookRequest
): Promise<CodexHookResult> {
  let eventKind = "unknown";
  let occurredAt = new Date().toISOString();
  let emergencyEvent: CaptureEvent | undefined;
  let emergencyProjectPath: string | undefined;
  let resolvedProjectId: string | undefined;
  try {
    const input = hookInputSchema.parse(request.input);
    eventKind = input.hook_event_name;
    occurredAt = z.iso.datetime().parse(request.receivedAt ?? occurredAt);
    const identity = hookIdentity(input);
    emergencyProjectPath = input.cwd;
    emergencyEvent = {
      schemaVersion: 1,
      eventId: identity.eventId,
      deduplicationKey: identity.deduplicationKey,
      agent: "codex",
      eventKind: input.hook_event_name,
      occurredAt,
      sessionId: input.session_id,
      ...(input.turn_id === undefined ? {} : { turnId: input.turn_id }),
      payload: hookPayload(input)
    };
    const project = await resolveProject({
      path: input.cwd,
      runtimeRoot: request.runtimeRoot,
      busyTimeoutMilliseconds: hookSqliteBusyTimeoutMilliseconds
    });
    resolvedProjectId = project.status === "resolved" ? project.projectId : undefined;
    emergencyEvent = {
      ...emergencyEvent,
      ...(resolvedProjectId === undefined ? {} : { projectId: resolvedProjectId })
    };
    const captured = await captureEvent({
      runtimeRoot: request.runtimeRoot,
      recoverHealthCategory: "hook_capture",
      busyTimeoutMilliseconds: hookSqliteBusyTimeoutMilliseconds,
      event: emergencyEvent
    });
    if (captured.state === "blocked_secret" || captured.state === "quarantined") {
      return {
        continue: true,
        captured: false,
        state: captured.state,
        findingId: captured.findingId
      };
    }
    return {
      continue: true,
      captured: true,
      state: captured.state,
      eventId: captured.eventId,
      ...(resolvedProjectId === undefined ? {} : { projectId: resolvedProjectId })
    };
  } catch (error) {
    const systemCode = (error as NodeJS.ErrnoException).code;
    const message = error instanceof Error ? error.message : "";
    const runtimeIsBusy =
      systemCode === "SQLITE_BUSY" || /database is locked|SQLITE_BUSY/iu.test(message);
    if (runtimeIsBusy) {
      if (emergencyEvent !== undefined && emergencyProjectPath !== undefined) {
        try {
          const spooled = await spoolCaptureEvent({
            runtimeRoot: request.runtimeRoot,
            projectPath: emergencyProjectPath,
            spooledAt: new Date().toISOString(),
            event: emergencyEvent
          });
          await recordHookSqliteBusyDiagnostic({
            runtimeRoot: request.runtimeRoot,
            occurredAt,
            eventKind,
            outcome: "spooled"
          }).catch(() => undefined);
          return {
            continue: true,
            captured: true,
            state: spooled.state,
            eventId: spooled.eventId,
            ...(resolvedProjectId === undefined ? {} : { projectId: resolvedProjectId })
          };
        } catch {
          // The active Agent session remains fail-open when both durable paths fail.
        }
      }
      await recordHookSqliteBusyDiagnostic({
        runtimeRoot: request.runtimeRoot,
        occurredAt,
        eventKind,
        outcome: "lost"
      }).catch(() => undefined);
    } else {
      const errorCode = error instanceof z.ZodError
        ? "invalid_hook_input"
        : "capture_unavailable";
      await recordCaptureHealthIncident({
        runtimeRoot: request.runtimeRoot,
        category: "hook_capture",
        errorCode,
        occurredAt: new Date().toISOString()
      }).catch(() => undefined);
    }
    return {
      continue: true,
      captured: false,
      state: "capture_unavailable",
      diagnostic: { code: "capture_unavailable", eventKind }
    };
  }
}
