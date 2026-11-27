#!/usr/bin/env node

import { MemStoreCommandError } from "../contracts/envelope.js";

const [agent, event] = process.argv.slice(2);
try {
  // Each host loads only its own adapter: Antigravity runs a hook before every model call.
  if (agent === "claude") {
    await (await import("./claude-hook.js")).runClaudeHook(event);
  } else if (agent === "codex") {
    await (await import("./codex-hook.js")).runCodexHook(event);
  } else if (agent === "antigravity") {
    await (await import("./antigravity-hook.js")).runAntigravityHook(event);
  } else {
    throw new MemStoreCommandError(
      "unknown_agent",
      "The lightweight Hook entrypoint supports Codex, Claude Code and Antigravity."
    );
  }
} catch (error) {
  const code = error instanceof MemStoreCommandError ? `${error.code}: ` : "";
  const message = error instanceof Error ? error.message : "Unknown MemStore Hook error.";
  process.stderr.write(`memstore-hook: ${code}${message}\n`);
  // Claude Code treats exit code 2 as a blocking error and Antigravity hooks block the agent loop;
  // capture must never block a session.
  process.exitCode = agent === "codex" ? 2 : 0;
}
