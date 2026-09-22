import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export type CodexSessionKind = "primary" | "subagent" | "unknown";

function classifySource(source: unknown): CodexSessionKind {
  if (source === "subagent") return "subagent";
  if (source === "cli" || source === "exec" || source === "vscode" || source === "appServer") return "primary";
  const structured = z.object({ subagent: z.unknown() }).safeParse(source);
  return structured.success && structured.data.subagent !== undefined ? "subagent" : "unknown";
}

/** Read only the exact host thread's source; never read prompts or create a DB. */
async function databaseSessionKind(sessionId: string): Promise<CodexSessionKind> {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  try {
    const files = (await readdir(codexHome)).flatMap(name => {
      const version = /^state_(\d+)\.sqlite$/.exec(name)?.[1];
      return version === undefined ? [] : [{ name, version: Number(version) }];
    }).sort((a, b) => b.version - a.version);
    const latest = files[0];
    if (latest === undefined) return "unknown";
    const db = new DatabaseSync(join(codexHome, latest.name), { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 0; PRAGMA query_only = ON");
      const row = db.prepare("SELECT source FROM threads WHERE id = ?").get(sessionId);
      if (typeof row?.source !== "string") return "unknown";
      return classifySource(row.source.startsWith("{") ? JSON.parse(row.source) : row.source);
    } finally {
      db.close();
    }
  } catch {
    return "unknown";
  }
}

/** The transcript format is a fallback, not a stable host API. Bound all reads. */
async function transcriptSessionKind(path: string, sessionId: string): Promise<CodexSessionKind> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) return "unknown";
      const buffer = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const prefix = buffer.subarray(0, bytesRead);
      const newline = prefix.indexOf(10);
      if (newline < 0) return "unknown";
      const metadata = z.object({ type: z.literal("session_meta"), payload: z.object({
        id: z.string(), source: z.unknown()
      }) }).safeParse(JSON.parse(prefix.subarray(0, newline).toString("utf8")));
      if (!metadata.success || metadata.data.payload.id !== sessionId) return "unknown";
      return classifySource(metadata.data.payload.source);
    } finally {
      await file.close();
    }
  } catch {
    return "unknown";
  }
}

export async function inspectCodexSessionKind(input: unknown): Promise<CodexSessionKind> {
  const parsed = z.object({ session_id: z.string().min(1), transcript_path: z.string().nullable().optional() }).safeParse(input);
  if (!parsed.success) return "unknown";
  const kind = await databaseSessionKind(parsed.data.session_id);
  if (kind !== "unknown") return kind;
  return parsed.data.transcript_path ? transcriptSessionKind(parsed.data.transcript_path, parsed.data.session_id) : "unknown";
}
