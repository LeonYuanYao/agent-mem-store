import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Synthetic host metadata for CLI tests; never consult installed Codex state. */
export async function codexPrimaryInput(root: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const transcript = join(root, "primary-transcript.jsonl");
  await writeFile(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: input.session_id, source: "cli" } })}\n`);
  return { ...input, transcript_path: transcript };
}
