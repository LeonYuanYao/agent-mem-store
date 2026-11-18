#!/usr/bin/env node

import { silenceSqliteExperimentalWarning } from "./sqlite-warning.js";

// Everything below loads by dynamic import so this runs before node:sqlite does.
silenceSqliteExperimentalWarning();

const arguments_ = process.argv.slice(2);

if (arguments_[0] === "hook" && arguments_[1] === "codex") {
  try {
    const { runCodexHook } = await import("./codex-hook.js");
    await runCodexHook(arguments_[2]);
  } catch (error) {
    const { MemStoreCommandError } = await import("../contracts/envelope.js");
    const code = error instanceof MemStoreCommandError ? `${error.code}: ` : "";
    const message = error instanceof Error ? error.message : "Unknown MemStore error.";
    process.stderr.write(`memstore: ${code}${message}\n`);
    process.exitCode = 2;
  }
} else {
  await import("./command.js");
}
