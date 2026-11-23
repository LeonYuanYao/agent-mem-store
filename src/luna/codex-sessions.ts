import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Session-file flag for MemStore's `codex exec` calls (ADR-0189). In the user's own Codex home
 * (`~/.codex`) the calls stay ephemeral so they do not fill its session list. A home kept for such
 * calls keeps their session files, the only record of their token usage that usage reporters read.
 */
export function codexSessionArguments(codexHome: string, userHome: string = homedir()): string[] {
  return realDirectory(codexHome) === realDirectory(join(userHome, ".codex")) ? ["--ephemeral"] : [];
}

function realDirectory(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
