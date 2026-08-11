import { resolve } from "node:path";
import { text as consumeText } from "node:stream/consumers";
import { z } from "zod";

import { handleCodexHook } from "../adapters/codex/hook.js";
import { MemStoreCommandError } from "../contracts/envelope.js";

const codexHookEventSchema = z.enum([
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
  "SessionEnd"
]);

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
  const output = result.state === "capture_unavailable"
    ? {
        continue: true,
        systemMessage: `MemStore could not capture ${result.diagnostic.eventKind}; the session will continue without persisting this event.`
      }
    : { continue: true };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
