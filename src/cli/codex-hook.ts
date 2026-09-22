import { resolve } from "node:path";
import { text as consumeText } from "node:stream/consumers";
import { z } from "zod";

import { handleCodexHook } from "../adapters/codex/hook.js";
import { MemStoreCommandError } from "../contracts/envelope.js";
import { requestForegroundRetrieval } from "../retrieval/foreground-client.js";
import { readHookDisplay, readSessionStartInjection, renderHookDisplay } from "../configuration/hook-display.js";
import { CaptureProgress, captureErrorCode, renderCaptureDiagnostic } from "../capture/deadline.js";

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
  const progress = new CaptureProgress(event === "Stop" ? 1300 : Infinity);
  const watchdogState = { expired: false };
  // Leave startup/output headroom inside the two-second host limit. A hard
  // host kill cannot print diagnostics; this watchdog handles async stalls first.
  const watchdog = event === "Stop" ? setTimeout(() => {
    watchdogState.expired = true;
    const message = renderCaptureDiagnostic(progress.diagnostic(event, "capture_deadline_exceeded"));
    process.stderr.write(`${message}\n`);
    process.stdout.write(`${JSON.stringify({ continue: true, systemMessage: message })}\n`, () => process.exit(0));
  }, 1450) : undefined;
  watchdog?.unref();
  try {
    const input = z.record(z.string(), z.unknown()).parse(
      JSON.parse(await consumeText(process.stdin))
    );
    const result = await handleCodexHook({
      runtimeRoot: resolve(runtimeRoot),
      input: { ...input, hook_event_name: event },
      progress
    });
    if (watchdogState.expired) return;
    if (result.state === "capture_unavailable") {
      process.stderr.write(`${renderCaptureDiagnostic(result.diagnostic)}\n`);
    }
    let output: Record<string, unknown> = result.state === "capture_unavailable"
      ? {
          continue: true,
          systemMessage: renderCaptureDiagnostic(result.diagnostic)
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
  } catch (error) {
    if (watchdogState.expired) return;
    const code = error instanceof z.ZodError || error instanceof SyntaxError
      ? "invalid_hook_input" : captureErrorCode(error);
    const message = renderCaptureDiagnostic(progress.diagnostic(event, code));
    process.stderr.write(`${message}\n`);
    process.stdout.write(`${JSON.stringify({ continue: true, systemMessage: message })}\n`);
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
}
