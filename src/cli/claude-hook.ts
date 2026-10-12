import { resolve } from "node:path";
import { text as consumeText } from "node:stream/consumers";
import { z } from "zod";

import { readLastAssistantMessage } from "../adapters/claude/transcript.js";
import { handleCodexHook } from "../adapters/codex/hook.js";
import { CaptureProgress, renderCaptureDiagnostic } from "../capture/deadline.js";
import { MemStoreCommandError } from "../contracts/envelope.js";
import { readDreamingConfiguration } from "../dreaming/config.js";

const claudeHookEventSchema = z.enum(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]);
const hookBudgetMilliseconds = 1_500;

/**
 * Claude Code capture for dreaming. Capture-only: it never writes to stdout,
 * because Claude Code adds UserPromptSubmit/SessionStart stdout to the model
 * context, and it never exits non-zero, because exit code 2 blocks the prompt
 * or the stop. Sessions are captured only while `[dreaming].enabled` is true.
 */
export async function runClaudeHook(eventSource: unknown): Promise<void> {
  const event = claudeHookEventSchema.parse(eventSource);
  const runtimeRoot = process.env.MEMSTORE_RUNTIME_ROOT;
  if (runtimeRoot === undefined) {
    throw new MemStoreCommandError("runtime_required", "MEMSTORE_RUNTIME_ROOT is required for the Claude Hook adapter.");
  }
  const watchdog = setTimeout(() => {
    process.stderr.write(`MemStore (claude ${event}): hook_deadline_exceeded; capture skipped.\n`);
    process.exit(0);
  }, hookBudgetMilliseconds);
  watchdog.unref();
  try {
    const input = z.record(z.string(), z.unknown()).parse(JSON.parse(await consumeText(process.stdin)));
    if (!(await readDreamingConfiguration(resolve(runtimeRoot))).enabled) return;
    let enriched: Record<string, unknown> = { ...input, hook_event_name: event };
    if (event === "Stop" && typeof input.last_assistant_message !== "string" &&
        typeof input.transcript_path === "string" && typeof input.session_id === "string") {
      const reply = await readLastAssistantMessage(input.transcript_path, input.session_id);
      if (reply !== undefined) enriched = { ...enriched, last_assistant_message: reply };
    }
    const result = await handleCodexHook({
      runtimeRoot: resolve(runtimeRoot),
      input: enriched,
      agent: "claude",
      captureEnabled: true,
      progress: new CaptureProgress(hookBudgetMilliseconds - 200)
    });
    if (result.state === "capture_unavailable") process.stderr.write(`${renderCaptureDiagnostic(result.diagnostic)}\n`);
  } catch (error) {
    process.stderr.write(`MemStore (claude ${event}): capture skipped: ${error instanceof Error ? error.name : "error"}\n`);
  } finally {
    clearTimeout(watchdog);
  }
}
