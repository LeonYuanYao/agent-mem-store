#!/usr/bin/env node

import { MemStoreCommandError } from "../contracts/envelope.js";
import { runCodexHook } from "./codex-hook.js";

try {
  const [agent, event] = process.argv.slice(2);
  if (agent !== "codex") {
    throw new MemStoreCommandError(
      "unknown_agent",
      "The lightweight Hook entrypoint supports only Codex."
    );
  }
  await runCodexHook(event);
} catch (error) {
  const code = error instanceof MemStoreCommandError ? `${error.code}: ` : "";
  const message = error instanceof Error ? error.message : "Unknown MemStore Hook error.";
  process.stderr.write(`memstore-hook: ${code}${message}\n`);
  process.exitCode = 2;
}
