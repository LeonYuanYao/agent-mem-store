import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

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

test("the external Stop Hook fails open within its host deadline while Runtime SQLite is busy", async () => {
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
    expect(JSON.parse(result.stdout)).toEqual({
      continue: true,
      systemMessage:
        "MemStore could not capture Stop; the session will continue without persisting this event."
    });
    expect(result.stdout).not.toContain("must not appear");
  } finally {
    database.exec("ROLLBACK");
    database.close();
  }
});
