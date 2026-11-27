import { isAbsolute } from "node:path";
import { z } from "zod";

/** The Antigravity hook events MemStore handles; PreInvocation stands in for a submitted prompt. */
export const antigravityHookEventSchema = z.enum(["SessionStart", "PreInvocation", "PostToolUse", "Stop"]);
export type AntigravityHookEvent = z.infer<typeof antigravityHookEventSchema>;

/** Antigravity hook stdin (camelCase protojson); fields MemStore does not read pass through. */
export const antigravityHookInputSchema = z.object({
  conversationId: z.string().min(1),
  workspacePaths: z.array(z.string()).optional(),
  transcriptPath: z.string().optional(),
  modelName: z.string().optional(),
  lastUserInput: z.string().optional(),
  cwd: z.string().optional(),
  invocationNum: z.number().int().optional(),
  initialNumSteps: z.number().int().optional(),
  toolCall: z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    args: z.unknown().optional()
  }).loose().optional(),
  error: z.string().optional(),
  continuationActive: z.boolean().optional()
}).loose();
export type AntigravityHookInput = z.infer<typeof antigravityHookInputSchema>;

/** The captured event kind each Antigravity event becomes. */
export function capturedEventKind(event: AntigravityHookEvent): "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop" {
  return event === "PreInvocation" ? "UserPromptSubmit" : event;
}

/**
 * The directory that decides the Project: the first workspace the conversation was opened on,
 * not the agent's current directory, so a `cd` during the conversation does not change it.
 */
export function antigravityProjectPath(input: AntigravityHookInput): string | undefined {
  const workspace = input.workspacePaths?.find((path) => isAbsolute(path));
  return workspace ?? (input.cwd !== undefined && isAbsolute(input.cwd) ? input.cwd : undefined);
}

/**
 * Subagent conversations (`invoke_subagent`) run under their own conversation id, are started by
 * the parent agent rather than a user message, and so carry an empty `lastUserInput`.
 */
export function isAntigravitySubagent(input: AntigravityHookInput): boolean {
  return (input.lastUserInput ?? "").trim() === "";
}

/**
 * PreInvocation runs before every model call. Only the first call of an execution with a user
 * message can be a submitted prompt; the transcript then tells whether a user message started it.
 */
export function mayStartUserTurn(input: { readonly invocationNum?: unknown; readonly lastUserInput?: unknown }): boolean {
  const invocation = input.invocationNum ?? 0;
  return invocation === 0 && typeof input.lastUserInput === "string" && input.lastUserInput.trim() !== "";
}

/** `run_command` names its command `CommandLine`; capture reads a command from `command`. */
function toolInput(args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  const { CommandLine: commandLine, ...rest } = args as Record<string, unknown>;
  return typeof commandLine === "string" ? { command: commandLine, ...rest } : args;
}

/**
 * The Codex/Claude Code shaped hook input that shared capture reads. Antigravity's PostToolUse
 * carries the tool call and its error but not its output, which the transcript records only later.
 */
export function antigravityCaptureInput(
  event: AntigravityHookEvent,
  input: AntigravityHookInput,
  extras: { readonly reply?: string } = {}
): Record<string, unknown> {
  const common = {
    hook_event_name: capturedEventKind(event),
    session_id: input.conversationId,
    cwd: input.cwd !== undefined && input.cwd !== "" ? input.cwd : antigravityProjectPath(input) ?? "",
    ...(input.transcriptPath === undefined ? {} : { transcript_path: input.transcriptPath }),
    ...(input.modelName === undefined ? {} : { model: input.modelName })
  };
  if (event === "SessionStart") return { ...common, source: "startup" };
  if (event === "PreInvocation") return { ...common, prompt: input.lastUserInput ?? "" };
  if (event === "PostToolUse") {
    const call = input.toolCall;
    return {
      ...common,
      ...(call === undefined ? {} : { tool_name: call.name, tool_input: toolInput(call.args) }),
      ...(call?.id === undefined || call.id === "" ? {} : { tool_use_id: call.id }),
      ...(input.error === undefined || input.error === "" ? {} : { tool_response: { error: input.error } })
    };
  }
  return {
    ...common,
    ...(extras.reply === undefined ? {} : { last_assistant_message: extras.reply }),
    ...(input.continuationActive === undefined ? {} : { stop_hook_active: input.continuationActive })
  };
}

/**
 * Hook stdout that adds context before the model call. The model reads `systemMessage`; the user
 * sees `renderInfo.markdown` instead of a collapsed system message row. Antigravity 1.5.x rejects
 * the whole output when `metadata` holds a string (its own guide still suggests
 * `metadata.user_markdown`), so the display goes only to `renderInfo`.
 */
export function antigravityInjection(context: string, display: string | undefined): Record<string, unknown> {
  return {
    injectSteps: [{
      systemMessage: {
        systemMessage: context,
        ...(display === undefined || display === "" ? {} : { renderInfo: { markdown: display } })
      }
    }]
  };
}
