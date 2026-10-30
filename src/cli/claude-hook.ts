import { isAbsolute, resolve } from "node:path";
import { text as consumeText } from "node:stream/consumers";
import { z } from "zod";

import { readLastAssistantMessage } from "../adapters/claude/transcript.js";
import { handleCodexHook } from "../adapters/codex/hook.js";
import { CaptureProgress, renderCaptureDiagnostic } from "../capture/deadline.js";
import { readClaudeHookDisplay, readSessionStartInjection, renderHookDisplay } from "../configuration/hook-display.js";
import { MemStoreCommandError } from "../contracts/envelope.js";
import { classifyLocalSensitivity } from "../contracts/sensitivity.js";
import { readDreamingConfiguration } from "../dreaming/config.js";
import { firstPromptRecentWork, recentWorkDisplay } from "../dreaming/recent-work.js";
import { requestForegroundRetrieval, sendForegroundContextUpdate } from "../retrieval/foreground-client.js";

const claudeHookEventSchema = z.enum(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]);
const hookBudgetMilliseconds = 1_700;

/**
 * Claude Code Hooks: capture for dreaming and, with `MEMSTORE_INJECTION_MODE=active`,
 * automatic injection through the same foreground retrieval as Codex (ADR-0149).
 * Claude Code adds UserPromptSubmit and SessionStart stdout to the model context and
 * blocks on exit code 2, so stdout carries only a completed injection, every failure
 * goes to stderr, and the exit code is always 0. Capture needs `[dreaming].enabled`.
 */
export async function runClaudeHook(eventSource: unknown): Promise<void> {
  const event = claudeHookEventSchema.parse(eventSource);
  const runtimeRoot = process.env.MEMSTORE_RUNTIME_ROOT;
  if (runtimeRoot === undefined) {
    throw new MemStoreCommandError("runtime_required", "MEMSTORE_RUNTIME_ROOT is required for the Claude Hook adapter.");
  }
  const root = resolve(runtimeRoot);
  const deadlineAt = performance.now() + hookBudgetMilliseconds;
  const watchdog = setTimeout(() => {
    process.stderr.write(`MemStore (claude ${event}): hook_deadline_exceeded; the session continues without it.\n`);
    process.exit(0);
  }, hookBudgetMilliseconds);
  watchdog.unref();
  try {
    const input = z.record(z.string(), z.unknown()).parse(JSON.parse(await consumeText(process.stdin)));
    const injecting = process.env.MEMSTORE_INJECTION_MODE === "active";
    const dreaming = await readDreamingConfiguration(root);
    const capturing = dreaming.enabled;
    if (!capturing && !injecting) return;
    let enriched: Record<string, unknown> = { ...input, hook_event_name: event };
    if (capturing && event === "Stop" && typeof input.last_assistant_message !== "string" &&
        typeof input.transcript_path === "string" && typeof input.session_id === "string") {
      const reply = await readLastAssistantMessage(input.transcript_path, input.session_id);
      if (reply !== undefined) enriched = { ...enriched, last_assistant_message: reply };
    }
    // Claude Code passes the directory it was started in; a `cd` during the Session must not change its Project.
    const launchDirectory = process.env.CLAUDE_PROJECT_DIR;
    const result = await handleCodexHook({
      runtimeRoot: root,
      input: enriched,
      agent: "claude",
      ...(launchDirectory !== undefined && isAbsolute(launchDirectory) ? { projectPath: launchDirectory } : {}),
      captureEnabled: capturing,
      progress: new CaptureProgress(hookBudgetMilliseconds - 200)
    });
    if (result.state === "capture_unavailable") process.stderr.write(`${renderCaptureDiagnostic(result.diagnostic)}\n`);
    if (!injecting || typeof input.session_id !== "string") return;
    const sessionId = input.session_id;
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    // A new or ended Session, or a sensitive prompt, must not leave conversation context behind.
    if (event === "SessionStart" || event === "SessionEnd" ||
        (event === "UserPromptSubmit" && classifyLocalSensitivity(prompt).state !== "normal")) {
      await sendForegroundContextUpdate({ runtimeRoot: root, sessionId, update: { action: "clear" } });
    }
    const injectable = event === "UserPromptSubmit" || (event === "SessionStart" && await readSessionStartInjection(root));
    if (!injectable || !(result.captured || result.state === "capture_disabled") || result.projectId === undefined) return;
    const foreground = await requestForegroundRetrieval({
      runtimeRoot: root,
      event,
      projectId: result.projectId,
      sessionId,
      ...(result.captured ? { eventId: result.eventId } : {}),
      ...(event === "UserPromptSubmit" ? { prompt } : {}),
      requestedAt: new Date().toISOString(),
      timeoutMilliseconds: Math.max(1, Math.min(1_500, Math.floor(deadlineAt - performance.now() - 75)))
    });
    // The first prompt of a Session also gets where the Project's recent Sessions left off (ADR-0164).
    const recent = event === "UserPromptSubmit"
      ? await firstPromptRecentWork({ runtimeRoot: root, projectId: result.projectId, sessionId, now: new Date().toISOString(), configuration: dreaming })
        .catch(() => undefined)
      : undefined;
    const retrieved = foreground.state === "completed" ? foreground.text.trim() : "";
    if (retrieved === "" && recent === undefined) return;
    const display = await readClaudeHookDisplay(root);
    const systemMessage = [
      foreground.state === "completed" ? renderHookDisplay(display, event, foreground.text, foreground.renderedTokenCount) : undefined,
      recent !== undefined && display !== "off" ? recentWorkDisplay(recent.count) : undefined
    ].filter((line) => line !== undefined).join("\n");
    process.stdout.write(`${JSON.stringify({
      ...(systemMessage === "" ? {} : { systemMessage }),
      hookSpecificOutput: { hookEventName: event, additionalContext: [retrieved, recent?.text ?? ""].filter((part) => part !== "").join("\n\n") }
    })}\n`);
  } catch (error) {
    process.stderr.write(`MemStore (claude ${event}): skipped: ${error instanceof Error ? error.name : "error"}\n`);
  } finally {
    clearTimeout(watchdog);
  }
}
