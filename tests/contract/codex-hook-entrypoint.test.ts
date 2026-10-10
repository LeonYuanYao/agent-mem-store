import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

import { foregroundRetrievalSocketPath } from "../../src/retrieval/foreground-client.js";
import { foregroundContextUpdateSchema, foregroundRequestSchema } from "../../src/retrieval/foreground-protocol.js";
import { adapterDisplaySchema, readSessionStartInjection, renderHookDisplay } from "../../src/configuration/hook-display.js";
import { codexPrimaryInput } from "../helpers/codex-primary-input.js";

const temporaryDirectories: string[] = [];
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const hookEntrypoint = fileURLToPath(new URL("../../src/cli/hook.ts", import.meta.url));
const legacyEntrypoint = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

test("display omits summary IDs, preserves body ordering, stays silent without memories, and validates modes", () => {
  const body = "<memstore-candidates>\n[M:92 S:P] first\n[M:3 S:G] second\n</memstore-candidates>";
  expect(renderHookDisplay("summary", "UserPromptSubmit", body, 42))
    .toBe("MemStore (UserPromptSubmit): 2 memories · 42 tokens");
  expect(renderHookDisplay("full", "UserPromptSubmit", body, 42))
    .toBe(`MemStore (UserPromptSubmit): 2 memories · 42 tokens\n${body}`);
  expect(renderHookDisplay("full", "UserPromptSubmit", "", 0)).toBeUndefined();
  expect(renderHookDisplay("full", "UserPromptSubmit", "<memstore-context>legend only</memstore-context>", 10)).toBeUndefined();
  expect(adapterDisplaySchema.safeParse({ hook_display: "invalid" }).success).toBe(false);
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function runHook(request: {
  readonly runtimeRoot: string;
  readonly event: "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop" | "SessionEnd";
  readonly input: Record<string, unknown>;
  readonly environment?: Record<string, string>;
}): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  const input = await codexPrimaryInput(join(request.runtimeRoot, ".."), request.input);
  const child = spawn(
    process.execPath,
    ["--import", "tsx", hookEntrypoint, "codex", request.event],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CODEX_HOME: join(request.runtimeRoot, "absent-codex"),
        MEMSTORE_RUNTIME_ROOT: request.runtimeRoot,
        ...request.environment
      },
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(input));
  const status = await new Promise<number | null>((resolveExit) => child.once("close", resolveExit));
  return { status, stdout, stderr };
}

test.each(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"] as const)(
  "human-only mode skips new %s capture while retaining foreground injection and reversible capture", async (event) => {
    const root = await mkdtemp(join(tmpdir(), "memstore-human-only-hook-"));
    temporaryDirectories.push(root);
    const runtimeRoot = join(root, "runtime");
    await mkdir(join(runtimeRoot, "state"), { recursive: true });
    const configure = (enabled: boolean) => writeFile(join(runtimeRoot, "config.toml"),
      `schema_version = 1\n[adapters]\nsession_start_injection = true\nhook_display = "off"\nhuman_authored_only_injection = ${String(enabled)}\n`);
    await configure(true);
    let calls = 0;
    const eventIdsPresent: boolean[] = [];
    const memoryText = "<memstore-candidates>\n[M:1 S:P A:H R:C] Human SQLite guidance\n</memstore-candidates>";
    const server = createServer(socket => {
      let source = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        source += chunk;
        if (!source.includes("\n")) return;
        const document: unknown = JSON.parse(source.split("\n", 1)[0] ?? "{}");
        const context = foregroundContextUpdateSchema.safeParse(document);
        if (context.success) {
          socket.end(`${JSON.stringify({ schemaVersion: 2, requestId: context.data.requestId, accepted: true })}\n`);
          return;
        }
        const request = foregroundRequestSchema.parse(document);
        calls++;
        eventIdsPresent.push(request.eventId !== undefined);
        socket.end(`${JSON.stringify({ schemaVersion: 2, requestId: request.requestId,
          state: "completed", event, text: memoryText, receiptId: "msreceipt_human_only", renderedTokenCount: 8 })}\n`);
      });
    });
    await new Promise<void>(resolveListen => server.listen(foregroundRetrievalSocketPath(runtimeRoot), resolveListen));
    const invoke = (prompt = "SQLite WAL") => runHook({ runtimeRoot, event,
      environment: { MEMSTORE_INJECTION_MODE: "active" },
      input: { session_id: "human-only-hook", turn_id: `turn-${event}`, cwd: root,
        source: "startup", reason: "finished", prompt, last_assistant_message: "Existing work completed.",
        tool_name: "exec_command", tool_use_id: "call-1", tool_input: { cmd: "git status" }, tool_response: { exit_code: 0 } }
    });
    try {
      const result = await invoke();
      expect(result.status, result.stderr).toBe(0);
      const automaticInjection = event === "SessionStart" || event === "UserPromptSubmit";
      expect(calls).toBe(automaticInjection ? 1 : 0);
      expect(eventIdsPresent).toEqual(automaticInjection ? [false] : []);
      expect(JSON.parse(result.stdout)).toEqual(automaticInjection
        ? { continue: true, hookSpecificOutput: { hookEventName: event, additionalContext: memoryText } }
        : { continue: true });
      await expect(access(join(runtimeRoot, "spool", "capture"))).rejects.toThrow();
      if (event === "UserPromptSubmit") {
        const secret = await invoke(`OPENAI_API_KEY=sk-${"a".repeat(48)}`);
        expect(JSON.parse(secret.stdout)).toEqual({ continue: true });
        expect(calls).toBe(1);
        await expect(access(join(runtimeRoot, "spool", "capture"))).rejects.toThrow();
      }
      await configure(false);
      expect((await invoke()).status).toBe(0);
      expect((await readdir(join(runtimeRoot, "spool", "capture"))).length).toBeGreaterThan(0);
      expect(calls).toBe(automaticInjection ? 2 : 0);
      expect(eventIdsPresent).toEqual(automaticInjection ? [false, true] : []);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => server.close(error => {
        if (error === undefined) resolveClose(); else rejectClose(error);
      }));
    }
  }
);

for (const setting of ["missing", "false", "invalid"] as const) {
 test(`startup injection ${setting} stays silent and honors configuration availability for capture`, async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-startup-switch-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  await mkdir(runtimeRoot);
  if (setting !== "missing") {
    await writeFile(join(runtimeRoot, "config.toml"), `schema_version = 1\n[adapters]\nsession_start_injection = ${setting === "false" ? "false" : '"invalid"'}\n`);
  }
  expect(await readSessionStartInjection(runtimeRoot)).toBe(false);
  const result = await runHook({ runtimeRoot, event: "SessionStart",
    environment: { MEMSTORE_INJECTION_MODE: "active" },
    input: { session_id: "disabled-startup", cwd: root, source: "startup" }
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ continue: true });
  if (setting === "missing") {
    await expect(access(join(runtimeRoot, "spool", "capture"))).rejects.toThrow();
  } else {
    expect((await readdir(join(runtimeRoot, "spool", "capture"))).length).toBeGreaterThan(0);
  }
 });
}

for (const event of ["SessionStart", "UserPromptSubmit"] as const) {
 for (const mode of ["off", "summary", "full", "default", "invalid"] as const) {
  test(`active ${event} preserves injection with ${mode} display`, async () => {
    const root = await mkdtemp("/tmp/memstore-active-hook-");
    temporaryDirectories.push(root);
    const runtimeRoot = join(root, "runtime");
    const socketPath = foregroundRetrievalSocketPath(runtimeRoot);
    await mkdir(join(runtimeRoot, "state"), { recursive: true });
    await writeFile(join(runtimeRoot, "config.toml"), `schema_version = 1\n[adapters]\nsession_start_injection = ${String(event === "SessionStart")}\n${mode === "default" ? "" : `hook_display = "${mode}"\n`}`);
    const memoryText = "<memstore-candidates>\n[M:123 S:P A:A R:C] verified foreground memory\n</memstore-candidates>";
    const server = createServer((socket) => {
      let source = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        source += chunk;
        if (!source.includes("\n")) return;
        const request = JSON.parse(source.split("\n", 1)[0] ?? "{}") as { requestId?: string };
        socket.end(`${JSON.stringify({
          schemaVersion: 2,
          requestId: request.requestId,
          state: "completed",
          event,
          text: memoryText,
          receiptId: "msreceipt_contract",
          renderedTokenCount: 8
        })}\n`);
      });
    });
    await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
    try {
      const result = await runHook({
        runtimeRoot,
        event,
        environment: { MEMSTORE_INJECTION_MODE: "active" },
        input: {
          session_id: `active-${event}`,
          turn_id: `turn-${event}`,
          cwd: root,
          ...(event === "SessionStart" ? { source: "startup" } : { prompt: "recall sqlite" })
        }
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        continue: true,
        ...(mode === "off" ? {} : {
          systemMessage: `MemStore (${event}): 1 memories · 8 tokens${mode === "full" ? `\n${memoryText}` : ""}`
        }),
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: memoryText
        }
      });
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => server.close((error) => {
        if (error === undefined) resolveClose();
        else rejectClose(error);
      }));
    }
  });
 }
}

test("active injection fails open when the persistent Worker socket is unavailable", async () => {
  const root = await mkdtemp("/tmp/memstore-active-hook-down-");
  temporaryDirectories.push(root);
  const started = performance.now();
  const result = await runHook({
    runtimeRoot: join(root, "runtime"),
    event: "SessionStart",
    environment: { MEMSTORE_INJECTION_MODE: "active" },
    input: {
      session_id: "active-worker-down",
      cwd: root,
      source: "startup"
    }
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ continue: true });
  expect(performance.now() - started).toBeLessThan(1_000);
});

test("the external Codex Hook entrypoint captures PostToolUse within its one-second host deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-hook-entrypoint-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  await mkdir(runtimeRoot);
  await writeFile(join(runtimeRoot, "config.toml"), "schema_version = 1\n");
  const input = JSON.stringify(await codexPrimaryInput(root, {
    hook_event_name: "PostToolUse",
    session_id: "session-entrypoint",
    turn_id: "turn-entrypoint",
    cwd: root,
    tool_name: "exec_command",
    tool_use_id: "call-entrypoint",
    tool_input: { cmd: "git status --short" },
    tool_response: { status: "ok", exit_code: 0 }
  }));

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", hookEntrypoint, "codex", "PostToolUse"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: join(root, "absent-codex"), MEMSTORE_RUNTIME_ROOT: runtimeRoot },
      input,
      timeout: 1_000
    }
  );

  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ continue: true });
});

test("the installed legacy CLI Hook route also returns within its one-second host deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-legacy-hook-entrypoint-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "runtime"));
  await writeFile(join(root, "runtime", "config.toml"), "schema_version = 1\n");
  const input = JSON.stringify(await codexPrimaryInput(root, {
    hook_event_name: "PostToolUse",
    session_id: "legacy-session-entrypoint",
    turn_id: "legacy-turn-entrypoint",
    cwd: root,
    tool_name: "exec_command",
    tool_use_id: "legacy-call-entrypoint",
    tool_input: { cmd: "git status --short" },
    tool_response: { status: "ok", exit_code: 0 }
  }));

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", legacyEntrypoint, "hook", "codex", "PostToolUse"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: join(root, "absent-codex"),
        MEMSTORE_RUNTIME_ROOT: join(root, "runtime")
      },
      input,
      timeout: 1_000
    }
  );

  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ continue: true });
});

test("the external Stop Hook spools within its host deadline while Runtime SQLite is busy", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-busy-hook-entrypoint-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  await mkdir(runtimeRoot);
  await writeFile(join(runtimeRoot, "config.toml"), "schema_version = 1\n");
  const environment = { ...process.env, CODEX_HOME: join(root, "absent-codex"), MEMSTORE_RUNTIME_ROOT: runtimeRoot };
  const initialInput = JSON.stringify(await codexPrimaryInput(root, {
    session_id: "busy-entrypoint-session",
    turn_id: "turn-1",
    cwd: root,
    last_assistant_message: "initial capture"
  }));
  const initialized = spawnSync(
    process.execPath,
    ["--import", "tsx", hookEntrypoint, "codex", "Stop"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: environment,
      input: initialInput,
      timeout: 1_000
    }
  );
  expect(initialized.error).toBeUndefined();
  expect(initialized.status, initialized.stderr).toBe(0);

  const database = new DatabaseSync(join(runtimeRoot, "state", "memstore.sqlite"));
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", hookEntrypoint, "codex", "Stop"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: environment,
        input: JSON.stringify({
          transcript_path: join(root, "primary-transcript.jsonl"),
          session_id: "busy-entrypoint-session",
          turn_id: "turn-2",
          cwd: root,
          last_assistant_message: "must not appear in the diagnostic"
        }),
        timeout: 1_000
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
    expect(result.stdout).not.toContain("must not appear");
  } finally {
    database.exec("ROLLBACK");
    database.close();
  }
});


test("human-only Stop sends bounded ephemeral context, clears sensitive replies, and never captures", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-context-hook-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  await mkdir(join(runtimeRoot, "state"), { recursive: true });
  await writeFile(join(runtimeRoot, "config.toml"), "schema_version = 1\n[adapters]\nhuman_authored_only_injection = true\n");
  const updates: unknown[] = [];
  const server = createServer(socket => {
    let source = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      source += chunk;
      if (!source.includes("\n")) return;
      const update = foregroundContextUpdateSchema.parse(JSON.parse(source.split("\n", 1)[0] ?? "{}"));
      updates.push(update);
      socket.end(`${JSON.stringify({ schemaVersion: 2, requestId: update.requestId, accepted: true })}\n`);
    });
  });
  await new Promise<void>(resolveListen => server.listen(foregroundRetrievalSocketPath(runtimeRoot), resolveListen));
  try {
    const invoke = (text: string, turnId: string | undefined) => runHook({ runtimeRoot, event: "Stop",
      environment: { MEMSTORE_INJECTION_MODE: "active" },
      input: { session_id: "context-session", turn_id: turnId, cwd: root, last_assistant_message: text } });
    expect((await invoke("Propose checking WAL; do not delete it.", "turn-1")).status).toBe(0);
    expect(updates[0]).toMatchObject({ action: "assistant", sessionId: "context-session", turnId: "turn-1", text: "Propose checking WAL; do not delete it.", truncated: false });
    await invoke("Unbound reply", undefined);
    expect(updates).toHaveLength(1);
    await invoke(`${"Safe text. ".repeat(3000)}OPENAI_API_KEY=sk-${"a".repeat(48)}${" Safe ending.".repeat(3000)}`, "turn-2");
    expect(updates[1]).toMatchObject({ action: "clear" });
    expect(JSON.stringify(updates)).not.toContain("OPENAI_API_KEY");
    await expect(access(join(runtimeRoot, "spool", "capture"))).rejects.toThrow();
  } finally { await new Promise<void>(resolveClose => server.close(() => { resolveClose(); })); }
});
