import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";

import { handleCodexHook } from "../../src/adapters/codex/hook.js";
import {
  listOpenCaptureHealthIncidents,
  readCapturedEvent
} from "../../src/capture/index.js";
import {
  importCaptureInboxBatch,
  inspectCaptureInbox
} from "../../src/capture/inbox.js";
import { inspectStatus } from "../../src/operations/status.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

test("an unknown PostToolUse kind is captured through the generic envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-codex-hook-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const result = await handleCodexHook({
    runtimeRoot,
    receivedAt: "2026-08-07T04:00:00.000Z",
    input: {
      hook_event_name: "PostToolUse",
      session_id: "session-hook",
      turn_id: "turn-hook",
      cwd: root,
      tool_name: "future_tool",
      tool_use_id: "call-1",
      tool_input: { resource: "example", cmd: "echo ok" },
      tool_response: { status: "ok", exit_code: 0 }
    }
  });
  expect(result).toMatchObject({
    continue: true,
    captured: true,
    state: "captured"
  });
  if (!result.captured) throw new Error("Expected the official Hook payload to be captured.");
  const eventId = result.eventId;
  const projectId = result.projectId;
  await expect(inspectCaptureInbox(runtimeRoot)).resolves.toMatchObject({
    pendingCount: 1
  });
  await importCaptureInboxBatch({
    runtimeRoot,
    importedAt: "2026-08-07T04:00:00.100Z",
    maximumEntries: 64,
    maximumMilliseconds: 25
  });
  const stored = await readCapturedEvent(runtimeRoot, eventId);

  expect(stored).toMatchObject({
    eventKind: "PostToolUse",
    sessionId: "session-hook",
    turnId: "turn-hook",
    payload: {
      toolName: "future_tool",
      toolCallId: "call-1",
      cwd: root,
      input: { resource: "example", cmd: "echo ok" },
      response: { status: "ok", exit_code: 0 },
      command: "echo ok",
      exitCode: 0,
      resultContentIdentity: createHash("sha256")
        .update(JSON.stringify({ response: { status: "ok", exit_code: 0 } }))
        .digest("hex")
    }
  });
  await expect(handleCodexHook({
    runtimeRoot,
    receivedAt: "2026-08-07T04:00:01.000Z",
    input: {
      hook_event_name: "PostToolUse",
      session_id: "session-hook",
      turn_id: "turn-hook",
      cwd: root,
      tool_name: "future_tool",
      tool_use_id: "call-1",
      tool_input: { resource: "example", cmd: "echo ok" },
      tool_response: { status: "ok", exit_code: 0 }
    }
  })).resolves.toEqual({
    continue: true,
    captured: true,
    state: "captured",
    eventId,
    projectId
  });
});

test("oversized tool input cannot bypass the capture bound through command metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "ms-hook-bound-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const result = await handleCodexHook({
    runtimeRoot, receivedAt: "2026-08-07T04:00:00.000Z",
    input: {
      hook_event_name: "PostToolUse", session_id: "session-large-command",
      turn_id: "turn-large-command", cwd: root, tool_name: "apply_patch", tool_use_id: "large-patch",
      tool_input: { cmd: `apply_patch ${"x".repeat(200_000)}` },
      tool_response: { status: "ok", exit_code: 0 }
    }
  });
  if (!result.captured) throw new Error("Expected capture.");
  await importCaptureInboxBatch({ runtimeRoot, importedAt: "2026-08-07T04:00:00.100Z",
    maximumEntries: 64, maximumMilliseconds: 25 });
  const stored = await readCapturedEvent(runtimeRoot, result.eventId);
  expect(Buffer.byteLength(JSON.stringify(stored?.payload))).toBeLessThan(40_000);
  expect(stored?.payload).toMatchObject({ input: { memstoreTruncated: true } });
  expect(stored?.payload).not.toHaveProperty("command");
});

test("a Hook capture failure fails open with a body-free diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-codex-hook-failure-"));
  temporaryDirectories.push(root);
  const unusableRuntime = join(root, "runtime-file");
  await writeFile(unusableRuntime, "not a directory", "utf8");

  const result = await handleCodexHook({
    runtimeRoot: unusableRuntime,
    receivedAt: "2026-08-07T04:01:00.000Z",
    input: {
      hook_event_name: "Stop",
      session_id: "session-hook",
      turn_id: "turn-hook",
      cwd: root,
      last_assistant_message: "must not appear in the diagnostic"
    }
  });

  expect(result).toMatchObject({
    continue: true,
    captured: false,
    state: "capture_unavailable",
    diagnostic: {
      code: "storage_path_unavailable",
      eventKind: "Stop",
      stage: "inbox_lock",
      persistence: "not_saved"
    }
  });
  expect(JSON.stringify(result)).not.toContain("must not appear");
});

test("a Hook validation failure records a body-free health incident when Runtime is writable", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-codex-hook-health-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");

  const result = await handleCodexHook({
    runtimeRoot,
    input: {
      hook_event_name: "Stop"
    }
  });
  const incidents = await listOpenCaptureHealthIncidents(runtimeRoot);

  expect(result).toMatchObject({
    continue: true,
    captured: false,
    state: "capture_unavailable"
  });
  expect(incidents).toEqual([
    {
      category: "hook_capture",
      occurrenceCount: 1,
      lastErrorCode: "invalid_hook_input",
      bodyRetained: false
    }
  ]);

  const recovered = await handleCodexHook({
    runtimeRoot,
    receivedAt: "2026-08-07T04:01:01.000Z",
    input: {
      hook_event_name: "Stop",
      session_id: "session-hook-recovery",
      turn_id: "turn-hook-recovery",
      cwd: root,
      last_assistant_message: "capture recovered"
    }
  });
  expect(recovered).toMatchObject({
    continue: true,
    captured: true,
    state: "captured"
  });
  await expect(listOpenCaptureHealthIncidents(runtimeRoot)).resolves.toEqual([]);
});

test("a busy Runtime database leaves a normal event durable in the Capture Inbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-codex-hook-busy-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  await handleCodexHook({
    runtimeRoot,
    receivedAt: "2026-08-07T04:02:00.000Z",
    input: {
      hook_event_name: "Stop",
      session_id: "session-hook-busy",
      turn_id: "turn-1",
      cwd: root,
      last_assistant_message: "first"
    }
  });
  const database = new DatabaseSync(join(runtimeRoot, "state", "memstore.sqlite"));
  database.exec("BEGIN IMMEDIATE");

  try {
    const startedAt = performance.now();
    const result = await handleCodexHook({
      runtimeRoot,
      receivedAt: "2026-08-07T04:03:00.000Z",
      input: {
        hook_event_name: "Stop",
        session_id: "session-hook-busy",
        turn_id: "turn-2",
        cwd: root,
        last_assistant_message: "second"
      }
    });
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(result).toMatchObject({
      continue: true,
      captured: true,
      state: "captured"
    });
    expect(elapsedMilliseconds).toBeLessThan(300);
  } finally {
    database.exec("ROLLBACK");
    database.close();
  }
  await expect(inspectCaptureInbox(runtimeRoot)).resolves.toMatchObject({
    pendingCount: 2,
    dispositionCount: 0
  });
  const status = await inspectStatus({ runtimeRoot, vaultRoot: join(root, "vault") });
  expect(status.pipelines.capture).toMatchObject({
    sqlite_busy_count: 0,
    sqlite_busy_recovered_count: 0,
    sqlite_busy_lost_count: 0,
    last_sqlite_busy_outcome: null,
    last_sqlite_busy_at: null,
    last_sqlite_busy_event_kind: null
  });
  expect(JSON.stringify(status.pipelines.capture)).not.toContain("second");
});

// ADR-0161: what the user marked private is never captured.
test("a private span is removed from the captured prompt, and a p: turn is not captured at all", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-codex-hook-private-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const hook = (index: number, input: Record<string, unknown>) => handleCodexHook({
    runtimeRoot, receivedAt: `2026-10-30T04:00:0${String(index)}.000Z`,
    input: { session_id: "session-private", cwd: root, ...input }
  });
  const partial = await hook(0, { hook_event_name: "UserPromptSubmit", turn_id: "t1", prompt: "把 <pv>alice 的住址</pv> 改到配置里" });
  if (!partial.captured) throw new Error("Expected the prompt to be captured.");
  await importCaptureInboxBatch({ runtimeRoot, importedAt: "2026-10-30T04:00:00.500Z", maximumEntries: 64, maximumMilliseconds: 25 });
  expect((await readCapturedEvent(runtimeRoot, partial.eventId))?.payload).toEqual({ prompt: "把  改到配置里" });

  // The whole turn, its tool calls and reply, stays out; the next prompt is captured again.
  await expect(hook(1, { hook_event_name: "UserPromptSubmit", turn_id: "t2", prompt: "p：这一轮都别记" }))
    .resolves.toMatchObject({ captured: false, state: "private_turn" });
  await expect(hook(2, { hook_event_name: "PostToolUse", turn_id: "t2", tool_name: "shell", tool_use_id: "call-p", tool_input: { cmd: "cat ~/notes" }, tool_response: { status: "ok" } }))
    .resolves.toMatchObject({ captured: false, state: "private_turn" });
  await expect(hook(3, { hook_event_name: "Stop", turn_id: "t2", last_assistant_message: "你的笔记写着……" }))
    .resolves.toMatchObject({ captured: false, state: "private_turn" });
  await expect(hook(4, { hook_event_name: "UserPromptSubmit", turn_id: "t3", prompt: "继续正常工作" }))
    .resolves.toMatchObject({ captured: true });
});
