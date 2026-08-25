import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

import { foregroundRetrievalSocketPath } from "../../src/retrieval/foreground-client.js";

const temporaryDirectories: string[] = [];
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const hookEntrypoint = fileURLToPath(new URL("../../src/cli/hook.ts", import.meta.url));
const legacyEntrypoint = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function runHook(request: {
  readonly runtimeRoot: string;
  readonly event: "SessionStart" | "UserPromptSubmit";
  readonly input: Record<string, unknown>;
  readonly environment?: Record<string, string>;
}): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", hookEntrypoint, "codex", request.event],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
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
  child.stdin.end(JSON.stringify(request.input));
  const status = await new Promise<number | null>((resolveExit) => child.once("close", resolveExit));
  return { status, stdout, stderr };
}

for (const event of ["SessionStart", "UserPromptSubmit"] as const) {
  test(`active ${event} returns the official event-specific additionalContext payload`, async () => {
    const root = await mkdtemp("/tmp/memstore-active-hook-");
    temporaryDirectories.push(root);
    const runtimeRoot = join(root, "runtime");
    const socketPath = foregroundRetrievalSocketPath(runtimeRoot);
    await mkdir(join(runtimeRoot, "state"), { recursive: true });
    const server = createServer((socket) => {
      let source = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        source += chunk;
        if (!source.includes("\n")) return;
        const request = JSON.parse(source.split("\n", 1)[0] ?? "{}") as { requestId?: string };
        socket.end(`${JSON.stringify({
          schemaVersion: 1,
          requestId: request.requestId,
          state: "completed",
          event,
          text: "<memstore-context>verified foreground memory</memstore-context>",
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
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: "<memstore-context>verified foreground memory</memstore-context>"
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
  const input = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "session-entrypoint",
    turn_id: "turn-entrypoint",
    cwd: root,
    tool_name: "exec_command",
    tool_use_id: "call-entrypoint",
    tool_input: { cmd: "git status --short" },
    tool_response: { status: "ok", exit_code: 0 }
  });

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", hookEntrypoint, "codex", "PostToolUse"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, MEMSTORE_RUNTIME_ROOT: runtimeRoot },
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
  const input = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "legacy-session-entrypoint",
    turn_id: "legacy-turn-entrypoint",
    cwd: root,
    tool_name: "exec_command",
    tool_use_id: "legacy-call-entrypoint",
    tool_input: { cmd: "git status --short" },
    tool_response: { status: "ok", exit_code: 0 }
  });

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", legacyEntrypoint, "hook", "codex", "PostToolUse"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
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
  const environment = { ...process.env, MEMSTORE_RUNTIME_ROOT: runtimeRoot };
  const initialInput = JSON.stringify({
    session_id: "busy-entrypoint-session",
    turn_id: "turn-1",
    cwd: root,
    last_assistant_message: "initial capture"
  });
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
