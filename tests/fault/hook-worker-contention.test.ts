import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { handleCodexHook } from "../../src/adapters/codex/hook.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => undefined);
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a long Worker batch scan does not block a foreground Hook capture", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-worker-hook-contention-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const insert = database.prepare(
      `INSERT INTO capture_events(
         event_id, deduplication_key, schema_version, agent, event_kind,
         occurred_at, project_id, session_id, turn_id, whole_content_sha256,
         segment_count, source_bytes, retained_bytes, source_truncated,
         state, created_at, updated_at
       ) VALUES (?, ?, 1, 'codex', 'PostToolUse', ?, NULL, ?, ?, ?,
                 1, 16, 16, 0, 'pending', ?, ?)`
    );
    database.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < 8_000; index += 1) {
      const identity = String(index).padStart(5, "0");
      const occurredAt = "2026-08-18T18:00:00.000Z";
      insert.run(
        `msevent-contention-${identity}`,
        `contention:${identity}`,
        occurredAt,
        `session-contention-${identity}`,
        `turn-contention-${identity}`,
        "a".repeat(64),
        occurredAt,
        occurredAt
      );
    }
    database.exec("COMMIT");
  } finally {
    database.close();
  }

  const childSource = `
    import { prepareNextDistillationBatch } from "./src/worker/distillation.ts";
    process.stdout.write("ready\\n");
    await new Promise((resolve) => setTimeout(resolve, 25));
    await prepareNextDistillationBatch({
      runtimeRoot: ${JSON.stringify(runtimeRoot)},
      maximumEvents: 64,
      preparedAt: "2026-08-18T18:00:10.000Z",
      minimumEventAgeMilliseconds: 30_000
    });
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", childSource],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
  );
  children.push(child);
  await once(child.stdout, "data");
  await new Promise((resolve) => setTimeout(resolve, 75));

  const result = await handleCodexHook({
    runtimeRoot,
    receivedAt: "2026-08-18T18:00:11.000Z",
    input: {
      hook_event_name: "PostToolUse",
      session_id: "foreground-session",
      turn_id: "foreground-turn",
      cwd: root,
      tool_name: "exec_command",
      tool_use_id: "foreground-tool-call",
      tool_input: { cmd: "git status --short" },
      tool_response: { exit_code: 0 }
    }
  });

  expect(result).toMatchObject({
    continue: true,
    captured: true,
    state: "captured"
  });
  const workerExitCode = child.exitCode ?? await Promise.race<number | null | "timeout">([
    new Promise<number | null>((resolve) => {
      child.once("exit", (exitCode) => {
        resolve(exitCode);
      });
    }),
    new Promise<"timeout">((resolve) => setTimeout(() => {
      resolve("timeout");
    }, 1_500))
  ]);
  expect(workerExitCode).toBe(0);
});
