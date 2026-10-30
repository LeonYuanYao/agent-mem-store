import { createHash } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withoutPrivateText } from "../contracts/prompt-text.js";

/**
 * A turn the user opened with `p：` stays out of capture until it ends (ADR-0161):
 * its prompt, tool calls and reply. Hooks run as separate processes, so the open
 * turn is a marker file per Session; the next prompt or Session boundary clears it.
 */
function markerPath(runtimeRoot: string, sessionId: string): string {
  return join(runtimeRoot, "state", "private-turns", createHash("sha256").update(sessionId).digest("hex"));
}

async function marked(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** Whether this hook event belongs to a private turn; updates the marker as turns begin and end. */
export async function inPrivateTurn(request: {
  readonly runtimeRoot: string;
  readonly sessionId: string;
  readonly eventKind: string;
  readonly prompt?: string;
}): Promise<boolean> {
  const path = markerPath(request.runtimeRoot, request.sessionId);
  if (request.eventKind === "UserPromptSubmit") {
    if (withoutPrivateText(request.prompt ?? "").whole) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, "", { mode: 0o600 });
      return true;
    }
    await rm(path, { force: true });
    return false;
  }
  if (request.eventKind === "SessionStart" || request.eventKind === "SessionEnd") {
    await rm(path, { force: true });
    return false;
  }
  if (!await marked(path)) return false;
  if (request.eventKind === "Stop") await rm(path, { force: true });
  return true;
}
