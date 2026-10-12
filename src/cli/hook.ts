#!/usr/bin/env node

import { MemStoreCommandError } from "../contracts/envelope.js";
import { runClaudeHook } from "./claude-hook.js";
import { runCodexHook } from "./codex-hook.js";

const [agent, event] = process.argv.slice(2);
try {
  if (agent === "claude") {
    await runClaudeHook(event);
  } else if (agent === "codex") {
    await runCodexHook(event);
  } else {
    throw new MemStoreCommandError(
      "unknown_agent",
      "The lightweight Hook entrypoint supports Codex and Claude Code."
    );
  }
} catch (error) {
  const code = error instanceof MemStoreCommandError ? `${error.code}: ` : "";
  const message = error instanceof Error ? error.message : "Unknown MemStore Hook error.";
  process.stderr.write(`memstore-hook: ${code}${message}\n`);
  // Claude Code treats exit code 2 as a blocking error; capture must never block a session.
  process.exitCode = agent === "claude" ? 0 : 2;
}
