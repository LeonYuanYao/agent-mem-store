import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

import { readLastAssistantMessage } from "../../src/adapters/claude/transcript.js";
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

async function fixture(dreaming: boolean) {
  const root = await mkdtemp(join(tmpdir(), "memstore-claude-hook-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(join(runtimeRoot, "config.toml"), `schema_version = 1\n${dreaming ? "\n[dreaming]\nenabled = true\n" : ""}`);
  (await openRuntimeDatabase(runtimeRoot, { applyPendingMigrations: true })).close();
  return { root, runtimeRoot, project };
}

function runHook(runtimeRoot: string, event: string, input: Record<string, unknown>, environment: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", hookEntrypoint, "claude", event], {
      cwd: repositoryRoot,
      env: { ...process.env, MEMSTORE_INJECTION_MODE: "", MEMSTORE_RUNTIME_ROOT: runtimeRoot, ...environment },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("close", (status) => { resolvePromise({ status, stdout, stderr }); });
    child.stdin.end(JSON.stringify(input));
  });
}

async function capturedEvents(runtimeRoot: string) {
  // Hooks append to the durable Inbox; the Worker imports it into the runtime database.
  await importCaptureInboxBatch({ runtimeRoot, importedAt: new Date().toISOString(), maximumEntries: 64, maximumMilliseconds: 5_000 });
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    return database.prepare("SELECT agent, event_kind, session_id FROM capture_events ORDER BY created_at, event_id").all();
  } finally {
    database.close();
  }
}

test("Claude Code hooks capture a Session for dreaming without writing to stdout or blocking", async () => {
  const { root, runtimeRoot, project } = await fixture(true);
  const transcript = join(root, "transcript.jsonl");
  await writeFile(transcript, [
    { type: "user", sessionId: "claude-s1", message: { role: "user", content: "Which package manager?" } },
    { type: "assistant", sessionId: "claude-s1", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", name: "Bash" }] } },
    { type: "assistant", sessionId: "claude-s1", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Use pnpm." }] } }
  ].map((record) => JSON.stringify(record)).join("\n"));
  const common = { session_id: "claude-s1", transcript_path: transcript, cwd: project };
  for (const [event, extra] of [
    ["SessionStart", { source: "startup" }],
    ["UserPromptSubmit", { prompt: "Which package manager?" }],
    ["PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "cat package.json" }, tool_response: { stdout: "pnpm" } }],
    ["Stop", { stop_hook_active: false }],
    ["SessionEnd", { reason: "exit" }]
  ] as const) {
    const result = await runHook(runtimeRoot, event, { ...common, ...extra, hook_event_name: event });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  }
  const events = await capturedEvents(runtimeRoot);
  expect(events.map((row) => `${String(row.agent)}:${String(row.event_kind)}`)).toEqual([
    "claude:SessionStart", "claude:UserPromptSubmit", "claude:PostToolUse", "claude:Stop", "claude:SessionEnd"
  ]);
});

test("without dreaming, and on invalid input, Claude hooks capture nothing and still exit 0", async () => {
  const { runtimeRoot, project } = await fixture(false);
  const result = await runHook(runtimeRoot, "UserPromptSubmit", { session_id: "s", cwd: project, prompt: "hi" });
  expect(result).toMatchObject({ status: 0, stdout: "" });
  expect(await capturedEvents(runtimeRoot)).toEqual([]);
  const invalid = await runHook(runtimeRoot, "NotAnEvent", { session_id: "s", cwd: project });
  expect(invalid).toMatchObject({ status: 0, stdout: "" });
});

test("the last assistant reply is read from the transcript tail, scoped to the Session", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-claude-transcript-"));
  temporaryDirectories.push(root);
  const path = join(root, "t.jsonl");
  await writeFile(path, [
    { type: "assistant", sessionId: "s", message: { id: "old", role: "assistant", content: [{ type: "text", text: "earlier" }] } },
    { type: "user", sessionId: "s", message: { role: "user", content: "next" } },
    { type: "assistant", sessionId: "s", message: { id: "new", role: "assistant", content: [{ type: "text", text: "part one" }] } },
    { type: "assistant", sessionId: "s", message: { id: "new", role: "assistant", content: [{ type: "text", text: "part two" }] } },
    { type: "assistant", sessionId: "other", message: { id: "x", role: "assistant", content: [{ type: "text", text: "foreign" }] } }
  ].map((record) => JSON.stringify(record)).join("\n"));
  expect(await readLastAssistantMessage(path, "s")).toBe("part one\npart two");
  expect(await readLastAssistantMessage(join(root, "missing.jsonl"), "s")).toBeUndefined();
});

const memoryText = "<memstore-candidates>\n[M:123 S:P A:A R:C] verified dreaming memory\n</memstore-candidates>";

/** A stand-in for the Worker's foreground retrieval lane that answers every request with one memory. */
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
        text: memoryText, receiptId: "msreceipt_claude", renderedTokenCount: 8 })}\n`);
    });
  });
  await new Promise<void>((resolveListen) => server.listen(foregroundRetrievalSocketPath(runtimeRoot), resolveListen));
  return server;
}

async function shortFixture(config: string) {
  // Unix socket paths are short; keep the runtime under /tmp.
  const root = await mkdtemp("/tmp/msclaude-");
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "rt");
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(join(runtimeRoot, "config.toml"), config);
  (await openRuntimeDatabase(runtimeRoot, { applyPendingMigrations: true })).close();
  return { runtimeRoot, project };
}

for (const display of ["default", "off"] as const) {
  test(`active Claude UserPromptSubmit injects retrieved memory as additional context (${display} display)`, async () => {
    const { runtimeRoot, project } = await shortFixture(
      `schema_version = 1\n${display === "off" ? "[adapters]\nclaude_hook_display = \"off\"\n" : ""}\n[dreaming]\nenabled = true\n`);
    const requests: Record<string, unknown>[] = [];
    const server = await foregroundServer(runtimeRoot, requests);
    try {
      const result = await runHook(runtimeRoot, "UserPromptSubmit",
        { session_id: "claude-inject", cwd: project, prompt: "recall sqlite", hook_event_name: "UserPromptSubmit" },
        { MEMSTORE_INJECTION_MODE: "active" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        ...(display === "off" ? {} : { systemMessage: "MemStore (UserPromptSubmit): 1 memories · 8 tokens" }),
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: memoryText }
      });
      // The request carries the prompt and the captured event, so the Worker does not evaluate it again later.
      expect(requests.at(-1)).toMatchObject({ event: "UserPromptSubmit", sessionId: "claude-inject", prompt: "recall sqlite" });
      expect(String(requests.at(-1)?.eventId)).toMatch(/^msevent_claude_/u);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => { resolveClose(); }));
    }
  });
}

test("Claude injection works without dreaming and fails open when the Worker is unavailable", async () => {
  const { runtimeRoot, project } = await shortFixture("schema_version = 1\n");
  const input = { session_id: "claude-no-dreaming", cwd: project, prompt: "recall sqlite", hook_event_name: "UserPromptSubmit" };
  const requests: Record<string, unknown>[] = [];
  const server = await foregroundServer(runtimeRoot, requests);
  try {
    const injected = await runHook(runtimeRoot, "UserPromptSubmit", input, { MEMSTORE_INJECTION_MODE: "active" });
    expect(JSON.parse(injected.stdout)).toMatchObject({ hookSpecificOutput: { additionalContext: memoryText } });
    expect(requests.at(-1)?.eventId).toBeUndefined();
    expect(await capturedEvents(runtimeRoot)).toEqual([]);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => { resolveClose(); }));
  }
  const started = performance.now();
  const unavailable = await runHook(runtimeRoot, "UserPromptSubmit", input, { MEMSTORE_INJECTION_MODE: "active" });
  expect(unavailable).toMatchObject({ status: 0, stdout: "" });
  expect(performance.now() - started).toBeLessThan(2_500);
});

test("a Claude Code Session keeps the Project of its launch directory after a cd", async () => {
  const { root, runtimeRoot, project } = await fixture(true);
  const elsewhere = join(root, "elsewhere");
  await mkdir(elsewhere, { recursive: true });
  const launch = { CLAUDE_PROJECT_DIR: project };
  for (const [event, extra] of [
    ["UserPromptSubmit", { prompt: "看看 MemStore" }],
    ["PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_cd", tool_input: { command: "cd elsewhere && ls" }, tool_response: { stdout: "ok" } }]
  ] as const) {
    const result = await runHook(runtimeRoot, event, { session_id: "claude-cd", cwd: elsewhere, ...extra, hook_event_name: event }, launch);
    expect(result.status, result.stderr).toBe(0);
  }
  await importCaptureInboxBatch({ runtimeRoot, importedAt: new Date().toISOString(), maximumEntries: 64, maximumMilliseconds: 5_000 });
  const launched = await resolveProject({ sessionId: "expected", path: project, runtimeRoot });
  if (launched.status !== "resolved") throw new Error("Project did not resolve.");
  const database = await openRuntimeDatabase(runtimeRoot);
  let rows: Record<string, unknown>[];
  try {
    rows = database.prepare("SELECT event_id, event_kind, project_id FROM capture_events WHERE session_id = 'claude-cd' ORDER BY created_at").all();
  } finally {
    database.close();
  }
  expect(rows.map((row) => `${String(row.event_kind)}:${String(row.project_id)}`)).toEqual([
    `UserPromptSubmit:${launched.projectId}`, `PostToolUse:${launched.projectId}`
  ]);
  // The tool payload still records where the command actually ran.
  const tool = await readCapturedEvent(runtimeRoot, String(rows[1]?.event_id));
  expect(tool?.payload).toMatchObject({ cwd: elsewhere });
});
