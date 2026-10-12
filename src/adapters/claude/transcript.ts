import { open } from "node:fs/promises";

const tailBytes = 1024 * 1024;
const maximumMessageCharacters = 64 * 1024;

/**
 * Claude Code's Stop hook may not carry the final reply. Read it from the end of
 * the host-provided transcript: the text blocks of the last assistant message
 * (one message can span several JSONL records sharing its id). Bounded to the
 * last 1 MiB; anything unreadable yields undefined instead of failing capture.
 */
export async function readLastAssistantMessage(transcriptPath: string, sessionId: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(transcriptPath, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (size > length) lines.shift(); // first line may be cut
    let messageId: string | undefined;
    const parts: string[] = [];
    for (const line of lines.reverse()) {
      if (line.trim() === "") continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof record !== "object" || record === null) continue;
      const entry = record as { type?: unknown; sessionId?: unknown; message?: { id?: unknown; role?: unknown; content?: unknown } };
      if (entry.sessionId !== undefined && entry.sessionId !== sessionId) continue;
      if (entry.type === "user" && messageId !== undefined) break;
      if (entry.type !== "assistant" || entry.message?.role !== "assistant") continue;
      const id = typeof entry.message.id === "string" ? entry.message.id : undefined;
      if (messageId === undefined) messageId = id ?? "";
      else if (id !== messageId) break;
      const content = entry.message.content;
      const texts = typeof content === "string" ? [content]
        : Array.isArray(content)
          ? content.flatMap((block: unknown) =>
            typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" &&
            typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text] : [])
          : [];
      parts.unshift(...texts);
    }
    const text = parts.join("\n").trim();
    return text === "" ? undefined : text.slice(0, maximumMessageCharacters);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
