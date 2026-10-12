import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

import { readLastAssistantMessage } from "../../src/adapters/claude/transcript.js";
import { importCaptureInboxBatch } from "../../src/capture/inbox.js";
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

function runHook(runtimeRoot: string, event: string, input: Record<string, unknown>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", hookEntrypoint, "claude", event], {
      cwd: repositoryRoot,
      env: { ...process.env, MEMSTORE_RUNTIME_ROOT: runtimeRoot },
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
