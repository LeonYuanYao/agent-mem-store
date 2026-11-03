import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { captureEvent } from "../../../src/capture/index.js";
import { capturedConversationTurns } from "../../../src/retrieval/conversation-history.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

// ADR-0167: after a Worker restart, Jev's conversation context comes from capture.
test("captured prompts and replies rebuild the recent turns, without notifications, private text or the current prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-conversation-history-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  let sequence = 0;
  const capture = (eventKind: "UserPromptSubmit" | "Stop", payload: Record<string, unknown>) => captureEvent({ runtimeRoot, event: {
    schemaVersion: 1, eventId: `msevent_history_${String(sequence)}`, deduplicationKey: `history:${String(sequence++)}`, agent: "claude",
    eventKind, occurredAt: new Date().toISOString(), sessionId: "history-session", payload } });
  await capture("UserPromptSubmit", { prompt: "把预览重载改成按需加载，<pv>机器密码 hunter2</pv>" });
  await capture("Stop", { assistantMessage: "方案：只在切换特效时重载。要我实现吗？" });
  await capture("UserPromptSubmit", { prompt: "<task-notification>子任务完成</task-notification>" });
  await capture("UserPromptSubmit", { prompt: "同意你的方案" });
  const turns = await capturedConversationTurns({ runtimeRoot, sessionId: "history-session", currentPrompt: "同意你的方案" });
  expect(turns).toEqual([{ user: "把预览重载改成按需加载，", assistant: "方案：只在切换特效时重载。要我实现吗？" }]);
});
