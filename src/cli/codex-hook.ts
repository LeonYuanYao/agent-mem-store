import { resolve } from "node:path";
import { text as consumeText } from "node:stream/consumers";
import { z } from "zod";

import { handleCodexHook } from "../adapters/codex/hook.js";
import { MemStoreCommandError } from "../contracts/envelope.js";
import { requestForegroundRetrieval } from "../retrieval/foreground-client.js";
import { readHookDisplay, readSessionStartInjection, renderHookDisplay } from "../configuration/hook-display.js";

const codexHookEventSchema = z.enum([
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
  "SessionEnd"
]);

const activeHookInputSchema = z.object({
  session_id: z.string().min(1),
  prompt: z.string().optional()
});

export async function runCodexHook(eventSource: unknown): Promise<void> {
  const event = codexHookEventSchema.parse(eventSource);
  const runtimeRoot = process.env.MEMSTORE_RUNTIME_ROOT;
  if (runtimeRoot === undefined) {
    throw new MemStoreCommandError(
      "runtime_required",
      "MEMSTORE_RUNTIME_ROOT is required for the Codex Hook adapter."
    );
  }
  const input = z.record(z.string(), z.unknown()).parse(
    JSON.parse(await consumeText(process.stdin))
  );
  const result = await handleCodexHook({
    runtimeRoot: resolve(runtimeRoot),
    input: { ...input, hook_event_name: event }
  });
  let output: Record<string, unknown> = result.state === "capture_unavailable"
    ? {
        continue: true,
        systemMessage: `MemStore could not capture ${result.diagnostic.eventKind}; the session will continue without persisting this event.`
      }
    : { continue: true };
  const injectionMode = process.env.MEMSTORE_INJECTION_MODE === "active" ? "active" : "shadow";
  if (injectionMode === "active" &&
      (event === "SessionStart" || event === "UserPromptSubmit") &&
      (event !== "SessionStart" || await readSessionStartInjection(resolve(runtimeRoot))) &&
      result.captured && result.projectId !== undefined) {
    const activeInput = activeHookInputSchema.parse(input);
    const foreground = await requestForegroundRetrieval({
      runtimeRoot: resolve(runtimeRoot),
      event,
      projectId: result.projectId,
      sessionId: activeInput.session_id,
      eventId: result.eventId,
      ...(event === "UserPromptSubmit" ? { prompt: activeInput.prompt ?? "" } : {}),
      requestedAt: new Date().toISOString()
    });
    if (foreground.state === "completed") {
      const systemMessage = renderHookDisplay(
        await readHookDisplay(resolve(runtimeRoot)), event, foreground.text,
        foreground.renderedTokenCount
      );
      output = {
        continue: true,
        ...(systemMessage === undefined ? {} : { systemMessage }),
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: foreground.text
        }
      };
    }
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
