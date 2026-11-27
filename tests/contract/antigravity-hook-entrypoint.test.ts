import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

import { antigravityCaptureInput, antigravityHookInputSchema } from "../../src/adapters/antigravity/hook.js";
import { executionFollowsUserInput, readLastPlannerReply } from "../../src/adapters/antigravity/transcript.js";
import { importCaptureInboxBatch } from "../../src/capture/inbox.js";
import { readCapturedEvent } from "../../src/capture/index.js";
import { resolveProject } from "../../src/projects/index.js";
import { foregroundRetrievalSocketPath } from "../../src/retrieval/foreground-protocol.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";

const temporaryDirectories: string[] = [];
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const hookEntrypoint = fileURLToPath(new URL("../../src/cli/hook.ts", import.meta.url));

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(config: string, base = join(tmpdir(), "memstore-agy-hook-")) {
  const root = await mkdtemp(base);
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "rt");
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(join(runtimeRoot, "config.toml"), config);
  (await openRuntimeDatabase(runtimeRoot, { applyPendingMigrations: true })).close();
  return { root, runtimeRoot, project };
}

const dreamingConfig = "schema_version = 1\n\n[dreaming]\nenabled = true\n";

function runHook(runtimeRoot: string, event: string, input: unknown, environment: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", hookEntrypoint, "antigravity", event], {
      cwd: repositoryRoot,
      env: { ...process.env, MEMSTORE_INJECTION_MODE: "", MEMSTORE_RUNTIME_ROOT: runtimeRoot, ...environment },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("close", (status) => { resolvePromise({ status, stdout, stderr }); });
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

async function capturedEvents(runtimeRoot: string) {
  await importCaptureInboxBatch({ runtimeRoot, importedAt: new Date().toISOString(), maximumEntries: 64, maximumMilliseconds: 5_000 });
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    return database.prepare("SELECT event_id, agent, event_kind, session_id, project_id FROM capture_events ORDER BY created_at, event_id").all();
  } finally {
    database.close();
  }
}

/** One step per line, as Antigravity writes `transcript_full.jsonl`. */
async function writeTranscript(path: string, steps: readonly { type: string; content?: string }[]): Promise<void> {
  await writeFile(path, `${steps.map((step, index) => JSON.stringify({ step_index: index, status: "DONE", ...step })).join("\n")}\n`);
}

function common(project: string, transcriptPath: string, conversationId = "agy-c1", lastUserInput = "Which package manager?") {
  return { conversationId, workspacePaths: [project], cwd: project, transcriptPath, modelName: "gemini", lastUserInput };
}

test("Antigravity hooks capture a conversation for dreaming and always answer with a JSON object", async () => {
  const { root, runtimeRoot, project } = await fixture(dreamingConfig);
  const transcript = join(root, "transcript_full.jsonl");
  await writeTranscript(transcript, [{ type: "USER_INPUT", content: "<USER_REQUEST>Which package manager?</USER_REQUEST>" }]);
  const base = common(project, transcript);
  const toolCall = { id: "call_1", name: "run_command", args: { CommandLine: "cat package.json", WaitMsBeforeAsync: 5000 } };
  for (const [event, extra] of [
    ["SessionStart", {}],
    ["PreInvocation", { invocationNum: 0, initialNumSteps: 1 }],
    ["PostToolUse", { stepIdx: 2, toolCall, error: "" }],
    ["PreInvocation", { invocationNum: 1, initialNumSteps: 3 }]
  ] as const) {
    const result = await runHook(runtimeRoot, event, { ...base, ...extra, hookEventName: event });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
  }
  await writeTranscript(transcript, [
    { type: "USER_INPUT", content: "<USER_REQUEST>Which package manager?</USER_REQUEST>" },
    { type: "PLANNER_RESPONSE" },
    { type: "GENERIC", content: "Command output: pnpm" },
    { type: "PLANNER_RESPONSE", content: "Use pnpm." },
    { type: "SYSTEM_MESSAGE", content: "notice" }
  ]);
  const stop = await runHook(runtimeRoot, "Stop", { ...base, executionNum: 0, terminationReason: "NO_TOOL_CALL", hookEventName: "Stop" });
  expect(JSON.parse(stop.stdout)).toEqual({});

  const events = await capturedEvents(runtimeRoot);
  expect(events.map((row) => `${String(row.agent)}:${String(row.event_kind)}`)).toEqual([
    "antigravity:SessionStart", "antigravity:UserPromptSubmit", "antigravity:PostToolUse", "antigravity:Stop"
  ]);
  expect((await readCapturedEvent(runtimeRoot, String(events[1]?.event_id)))?.payload).toEqual({ prompt: "Which package manager?" });
  expect((await readCapturedEvent(runtimeRoot, String(events[2]?.event_id)))?.payload).toMatchObject({
    toolName: "run_command", toolCallId: "call_1", command: "cat package.json", input: { command: "cat package.json", WaitMsBeforeAsync: 5000 }
  });
  expect((await readCapturedEvent(runtimeRoot, String(events[3]?.event_id)))?.payload).toEqual({ assistantMessage: "Use pnpm." });
});

test("an execution a subagent's report starts is not a prompt, and subagents stay out unless enabled", async () => {
  const { root, runtimeRoot, project } = await fixture(dreamingConfig);
  const transcript = join(root, "transcript_full.jsonl");
  await writeTranscript(transcript, [
    { type: "USER_INPUT", content: "delegate" },
    { type: "PLANNER_RESPONSE" },
    { type: "GENERIC", content: "subagent started" },
    { type: "PLANNER_RESPONSE", content: "Waiting for the subagent." }
  ]);
  const parent = common(project, transcript, "agy-parent", "delegate");
  await runHook(runtimeRoot, "PreInvocation", { ...parent, invocationNum: 0, initialNumSteps: 4, hookEventName: "PreInvocation" });
  const subagentTranscript = join(root, "sub.jsonl");
  await writeTranscript(subagentTranscript, [{ type: "SYSTEM_MESSAGE", content: "task" }]);
  const subagent = common(project, subagentTranscript, "agy-sub", "");
  const subagentTool = { ...subagent, stepIdx: 2, toolCall: { id: "call_s", name: "run_command", args: { CommandLine: "echo sub" } }, hookEventName: "PostToolUse" };
  await runHook(runtimeRoot, "SessionStart", { ...subagent, hookEventName: "SessionStart" });
  await runHook(runtimeRoot, "PostToolUse", subagentTool);
  expect(await capturedEvents(runtimeRoot)).toEqual([]);

  await writeFile(join(runtimeRoot, "config.toml"), "schema_version = 1\n\n[adapters]\nsubagents_enabled = true\n\n[dreaming]\nenabled = true\n");
  await runHook(runtimeRoot, "PostToolUse", { ...subagentTool, toolCall: { ...subagentTool.toolCall, id: "call_s2" } });
  expect((await capturedEvents(runtimeRoot)).map((row) => `${String(row.session_id)}:${String(row.event_kind)}`)).toEqual(["agy-sub:PostToolUse"]);
});

test("a conversation keeps the Project of its workspace when the agent works elsewhere", async () => {
  const { root, runtimeRoot, project } = await fixture(dreamingConfig);
  const elsewhere = join(root, "elsewhere");
  await mkdir(elsewhere, { recursive: true });
  const transcript = join(root, "transcript_full.jsonl");
  await writeTranscript(transcript, [{ type: "USER_INPUT", content: "look elsewhere" }]);
  const base = { ...common(project, transcript, "agy-cd", "look elsewhere"), cwd: elsewhere };
  await runHook(runtimeRoot, "PreInvocation", { ...base, invocationNum: 0, initialNumSteps: 1, hookEventName: "PreInvocation" });
  await runHook(runtimeRoot, "PostToolUse", { ...base, toolCall: { id: "call_cd", name: "run_command", args: { CommandLine: "ls" } }, error: "exit status 1", hookEventName: "PostToolUse" });
  const launched = await resolveProject({ sessionId: "expected", path: project, runtimeRoot });
  if (launched.status !== "resolved") throw new Error("Project did not resolve.");
  const events = await capturedEvents(runtimeRoot);
  expect(events.map((row) => `${String(row.event_kind)}:${String(row.project_id)}`)).toEqual([
    `UserPromptSubmit:${launched.projectId}`, `PostToolUse:${launched.projectId}`
  ]);
  expect((await readCapturedEvent(runtimeRoot, String(events[1]?.event_id)))?.payload).toMatchObject({ cwd: elsewhere, response: { error: "exit status 1" } });
});

test("without dreaming or injection, and on invalid input or events, the hook captures nothing and still answers {}", async () => {
  const { root, runtimeRoot, project } = await fixture("schema_version = 1\n");
  const transcript = join(root, "transcript_full.jsonl");
  await writeTranscript(transcript, [{ type: "USER_INPUT", content: "hi" }]);
  const quiet = await runHook(runtimeRoot, "PreInvocation", { ...common(project, transcript, "agy-off", "hi"), invocationNum: 0, initialNumSteps: 1 });
  expect(quiet).toMatchObject({ status: 0 });
  expect(JSON.parse(quiet.stdout)).toEqual({});
  for (const [event, input] of [["Stop", "not json"], ["Stop", { cwd: project }], ["NotAnEvent", { conversationId: "x" }]] as const) {
    const result = await runHook(runtimeRoot, event, input);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
  }
  expect(await capturedEvents(runtimeRoot)).toEqual([]);
});

const memoryText = "<memstore-candidates>\n[M:123 S:P A:A R:C] verified dreaming memory\n</memstore-candidates>";

async function foregroundServer(runtimeRoot: string, requests: Record<string, unknown>[]): Promise<Server> {
  await mkdir(join(runtimeRoot, "state"), { recursive: true });
  const server = createServer((socket) => {
    let source = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      source += chunk;
      if (!source.includes("\n")) return;
      const request = JSON.parse(source.split("\n", 1)[0] ?? "{}") as Record<string, unknown>;
      requests.push(request);
      if (request.kind === "context_update") {
        socket.end(`${JSON.stringify({ schemaVersion: 2, requestId: request.requestId, kind: "context_update", state: "applied" })}\n`);
        return;
      }
      socket.end(`${JSON.stringify({ schemaVersion: 2, requestId: request.requestId, state: "completed", event: request.event,
        text: memoryText, receiptId: "msreceipt_agy", renderedTokenCount: 8 })}\n`);
    });
  });
  await new Promise<void>((resolveListen) => server.listen(foregroundRetrievalSocketPath(runtimeRoot), resolveListen));
  return server;
}

for (const display of ["default", "off"] as const) {
  test(`active PreInvocation injects retrieved memory as a system message (${display} display)`, async () => {
    // Unix socket paths are short; keep the runtime under /tmp.
    const { root, runtimeRoot, project } = await fixture(
      `schema_version = 1\n${display === "off" ? "[adapters]\nantigravity_hook_display = \"off\"\n" : ""}\n[dreaming]\nenabled = true\n`, "/tmp/msagy-");
    const transcript = join(root, "t.jsonl");
    await writeTranscript(transcript, [{ type: "USER_INPUT", content: "recall sqlite" }]);
    const requests: Record<string, unknown>[] = [];
    const server = await foregroundServer(runtimeRoot, requests);
    try {
      const base = common(project, transcript, "agy-inject", "recall sqlite");
      const result = await runHook(runtimeRoot, "PreInvocation", { ...base, invocationNum: 0, initialNumSteps: 1 }, { MEMSTORE_INJECTION_MODE: "active" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        injectSteps: [{ systemMessage: {
          systemMessage: memoryText,
          ...(display === "off" ? {} : { renderInfo: { markdown: "MemStore (UserPromptSubmit): 1 memories · 8 tokens" } })
        } }]
      });
      expect(requests.at(-1)).toMatchObject({ event: "UserPromptSubmit", sessionId: "agy-inject", prompt: "recall sqlite" });
      expect(String(requests.at(-1)?.eventId)).toMatch(/^msevent_antigravity_/u);
      // A later model call of the same turn neither captures nor retrieves again.
      const count = requests.length;
      const later = await runHook(runtimeRoot, "PreInvocation", { ...base, invocationNum: 1, initialNumSteps: 3 }, { MEMSTORE_INJECTION_MODE: "active" });
      expect(JSON.parse(later.stdout)).toEqual({});
      expect(requests.length).toBe(count);
      // Stop hands the turn's reply to Jev's conversation context.
      await writeTranscript(transcript, [{ type: "USER_INPUT", content: "recall sqlite" }, { type: "PLANNER_RESPONSE", content: "SQLite runs in WAL mode." }]);
      const stop = await runHook(runtimeRoot, "Stop", base, { MEMSTORE_INJECTION_MODE: "active" });
      expect(JSON.parse(stop.stdout)).toEqual({});
      expect(requests.at(-1)).toMatchObject({ kind: "context_update", action: "assistant", sessionId: "agy-inject", text: "SQLite runs in WAL mode." });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => { resolveClose(); }));
    }
  });
}

test("transcript readers find the step before an execution and the reply that ended it", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-agy-transcript-"));
  temporaryDirectories.push(root);
  const path = join(root, "t.jsonl");
  await writeTranscript(path, [
    { type: "USER_INPUT", content: "first" },
    { type: "PLANNER_RESPONSE", content: "earlier reply" },
    { type: "USER_INPUT", content: "second" },
    { type: "PLANNER_RESPONSE", content: "narration before a tool" },
    { type: "GENERIC", content: "tool output" },
    { type: "PLANNER_RESPONSE", content: "final reply" },
    { type: "PLANNER_RESPONSE" }
  ]);
  expect(await executionFollowsUserInput(path, 3)).toBe(true);
  expect(await executionFollowsUserInput(path, 5)).toBe(false);
  expect(await executionFollowsUserInput(path, 99)).toBeUndefined();
  expect(await readLastPlannerReply(path)).toBe("final reply");
  await writeTranscript(path, [{ type: "PLANNER_RESPONSE", content: "old" }, { type: "USER_INPUT", content: "new" }]);
  expect(await readLastPlannerReply(path)).toBeUndefined();
  expect(await readLastPlannerReply(join(root, "missing.jsonl"))).toBeUndefined();
  expect(await executionFollowsUserInput(join(root, "missing.jsonl"), 1)).toBeUndefined();
});

test("the capture input keeps non-command tool arguments as they are", () => {
  const input = antigravityHookInputSchema.parse({ conversationId: "c", cwd: "/w",
    toolCall: { id: "", name: "view_file", args: { AbsolutePath: "/w/a.ts" } } });
  expect(antigravityCaptureInput("PostToolUse", input)).toEqual({
    hook_event_name: "PostToolUse", session_id: "c", cwd: "/w", tool_name: "view_file", tool_input: { AbsolutePath: "/w/a.ts" }
  });
});
