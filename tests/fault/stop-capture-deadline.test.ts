import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { inspectCaptureInbox, importCaptureInboxBatch } from "../../src/capture/inbox.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";
import { readCapturedEvent } from "../../src/capture/index.js";
import { resolveProject } from "../../src/projects/index.js";
import { setSessionProjectRoute } from "../../src/projects/session-route.js";
import { codexPrimaryInput } from "../helpers/codex-primary-input.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test("Stop persists before a slow Git lookup and deferred import honors the exact session route", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-stop-deadline-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  (await openRuntimeDatabase(runtimeRoot)).close();
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!${process.execPath}\nsetTimeout(() => process.exit(1), 5000);\n`, { mode: 0o700 });
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/hook.ts", "codex", "Stop"], {
    env: { ...process.env, CODEX_HOME: join(root, "absent-codex"), PATH: `${bin}:${process.env.PATH ?? ""}`, MEMSTORE_RUNTIME_ROOT: runtimeRoot },
    encoding: "utf8", timeout: 1800, killSignal: "SIGKILL",
    input: JSON.stringify(await codexPrimaryInput(root, { session_id: "deferred-stop", turn_id: "slow-git", cwd: root, last_assistant_message: "Durable fixture." }))
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ continue: true });
  expect(await inspectCaptureInbox(runtimeRoot)).toMatchObject({ pendingCount: 1 });

  const targetPath = join(root, "target");
  await mkdir(targetPath);
  const target = await resolveProject({ runtimeRoot, path: targetPath });
  if (target.status !== "resolved") throw new Error("Expected fixture Project.");
  await setSessionProjectRoute({ runtimeRoot, sessionId: "deferred-stop", projectId: target.projectId });
  expect(await importCaptureInboxBatch({ runtimeRoot, importedAt: new Date().toISOString(), maximumEntries: 8, maximumMilliseconds: 1000 })).toMatchObject({ importedCount: 1 });
  const { createHash } = await import("node:crypto");
  const eventId = `msevent_codex_${createHash("sha256").update("deferred-stop\0Stop\0slow-git").digest("hex").slice(0, 32)}`;
  expect(await readCapturedEvent(runtimeRoot, eventId)).toMatchObject({ projectId: target.projectId });
});

test("Stop reports a body-free lock failure before the host deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-stop-lock-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  (await openRuntimeDatabase(runtimeRoot)).close();
  await mkdir(join(runtimeRoot, "spool/capture/.capacity-lock"), { recursive: true });
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/hook.ts", "codex", "Stop"], {
    env: { ...process.env, CODEX_HOME: join(root, "absent-codex"), MEMSTORE_RUNTIME_ROOT: runtimeRoot }, encoding: "utf8", timeout: 1800,
    input: JSON.stringify(await codexPrimaryInput(root, { session_id: "lock-stop", turn_id: "locked", cwd: root, last_assistant_message: "private diagnostic fixture must not be printed" }))
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("code=inbox_lock_timeout");
  expect(result.stdout).toContain("stage=inbox_lock");
  expect(result.stdout).toContain("persistence=not_saved");
  expect(result.stderr).toContain("inbox_lock_timeout");
  expect(result.stdout + result.stderr).not.toContain("private diagnostic fixture");
  expect(result.stdout + result.stderr).not.toContain(root);
});

test("Stop recovers a transient Inbox lock within its shared budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-stop-transient-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  (await openRuntimeDatabase(runtimeRoot)).close();
  const lock = join(runtimeRoot, "spool/capture/.capacity-lock");
  await mkdir(lock, { recursive: true });
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli/hook.ts", "codex", "Stop"], {
    env: { ...process.env, CODEX_HOME: join(root, "absent-codex"), MEMSTORE_RUNTIME_ROOT: runtimeRoot }, stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.resume();
  child.stdin.end(JSON.stringify(await codexPrimaryInput(root, { session_id: "transient", turn_id: "transient", cwd: root, last_assistant_message: "Fixture." })));
  const guard = setTimeout(() => child.kill("SIGKILL"), 1800);
  const release = setTimeout(() => { void rm(lock, { recursive: true, force: true }); }, 1000);
  const code = await new Promise<number | null>(resolve => child.on("close", resolve));
  clearTimeout(guard);
  clearTimeout(release);
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ continue: true });
  expect(await inspectCaptureInbox(runtimeRoot)).toMatchObject({ pendingCount: 1 });
});

test("the Stop watchdog reports stalled persistence without claiming capture succeeded", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-stop-watchdog-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  (await openRuntimeDatabase(runtimeRoot)).close();
  const preload = join(root, "stall.mjs");
  await writeFile(preload, `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.open;
fs.open = async (...args) => {
  if (String(args[0]).includes('/pending/')) await new Promise(resolve => setTimeout(resolve, 5000));
  return original(...args);
};
syncBuiltinESMExports();\n`);
  const result = spawnSync(process.execPath, ["--import", preload, "--import", "tsx", "src/cli/hook.ts", "codex", "Stop"], {
    env: { ...process.env, CODEX_HOME: join(root, "absent-codex"), MEMSTORE_RUNTIME_ROOT: runtimeRoot }, encoding: "utf8", timeout: 1950, killSignal: "SIGKILL",
    input: JSON.stringify(await codexPrimaryInput(root, { session_id: "watchdog", turn_id: "watchdog", cwd: root, last_assistant_message: "Fixture." }))
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("code=capture_deadline_exceeded");
  expect(result.stdout).toContain("stage=inbox_write");
  expect(result.stdout).toContain("persistence=unconfirmed");
  expect(await inspectCaptureInbox(runtimeRoot)).toMatchObject({ pendingCount: 0 });
});
