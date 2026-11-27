import { open } from "node:fs/promises";

const tailBytes = 1024 * 1024;
const maximumMessageCharacters = 64 * 1024;

interface TranscriptStep {
  readonly index: number | undefined;
  readonly type: string | undefined;
  readonly content: string | undefined;
}

/**
 * Steps from the end of an Antigravity `transcript_full.jsonl`, newest first. Each line is one
 * trajectory step (`step_index`, `type` such as USER_INPUT, PLANNER_RESPONSE, GENERIC or
 * SYSTEM_MESSAGE, and `content`). Bounded to the last 1 MiB; an unreadable file yields undefined.
 */
async function readStepsNewestFirst(transcriptPath: string): Promise<TranscriptStep[] | undefined> {
  let handle;
  try {
    handle = await open(transcriptPath, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (size > length) lines.shift(); // first line may be cut
    const steps: TranscriptStep[] = [];
    for (const line of lines.reverse()) {
      if (line.trim() === "") continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof record !== "object" || record === null) continue;
      const entry = record as { step_index?: unknown; type?: unknown; content?: unknown };
      steps.push({
        index: typeof entry.step_index === "number" ? entry.step_index : undefined,
        type: typeof entry.type === "string" ? entry.type : undefined,
        content: typeof entry.content === "string" ? entry.content : undefined
      });
    }
    return steps;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Whether the execution that starts with `initialNumSteps` steps answers a user message: its last
 * step before the execution is USER_INPUT. Antigravity also starts executions without one, for
 * example when a subagent's report arrives. Undefined when the transcript does not show that step.
 */
export async function executionFollowsUserInput(transcriptPath: string, initialNumSteps: number): Promise<boolean | undefined> {
  const steps = await readStepsNewestFirst(transcriptPath);
  const step = steps?.find((candidate) => candidate.index === initialNumSteps - 1);
  return step?.type === undefined ? undefined : step.type === "USER_INPUT";
}

/**
 * The reply that ended the latest execution: the content of the last PLANNER_RESPONSE after the
 * last USER_INPUT. Steps that only call tools carry no content and are skipped.
 */
export async function readLastPlannerReply(transcriptPath: string): Promise<string | undefined> {
  const steps = await readStepsNewestFirst(transcriptPath);
  if (steps === undefined) return undefined;
  for (const step of steps) {
    if (step.type === "USER_INPUT") return undefined;
    if (step.type !== "PLANNER_RESPONSE") continue;
    const text = step.content?.trim() ?? "";
    if (text !== "") return text.slice(0, maximumMessageCharacters);
  }
  return undefined;
}
