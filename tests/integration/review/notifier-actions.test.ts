import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import { openRuntimeDatabase } from "../../../src/runtime/database.js";

const exec = promisify(execFile);
const roots: string[] = [];
const nativeExecutable = process.env.MEMSTORE_NATIVE_TEST_EXECUTABLE;
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test.skipIf(nativeExecutable === undefined)("cold launch keeps the application alive to receive notification responses", async () => {
  if (nativeExecutable === undefined) throw new Error("Native executable required.");
  const child = spawn(nativeExecutable, [], { stdio: "ignore" });
  try {
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(child.exitCode).toBeNull();
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("close", resolve));
  }
});

// Opt-in cross-process tests: the real Swift callback invokes the real Review CLI.
test.skipIf(nativeExecutable === undefined)("native snooze callback reaches the Review ledger without opening or changing knowledge", async () => {
  if (nativeExecutable === undefined) throw new Error("Native executable required.");
  const root = await mkdtemp(join(tmpdir(), "memstore-native-action-"));
  roots.push(root);
  const runtime = join(root, "runtime");
  const vault = join(root, "vault");
  const database = await openRuntimeDatabase(runtime);
  database.prepare(`INSERT INTO reminder_obligations(
    reminder_id,digest_key,state,counts_json,issue_categories_json,inbox_path,due_at,created_at,updated_at
  ) VALUES ('msreminder_test','test','delivered','{}','[]',?,'2026-09-01T00:00:00.000Z',
    '2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`).run(join(vault, "_MemStore", "Review Inbox.md"));
  database.close();
  const launcher = join(root, "memstore");
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve("dist/cli/main.js"))} "$@" --vault ${quote(vault)}\n`, { mode: 0o700 });
  await mkdir(join(runtime, "install"), { recursive: true });
  await writeFile(join(runtime, "install", "ownership-manifest.json"), JSON.stringify({
    schemaVersion: 1, state: "installed", targets: [{ label: "memstore_cli", path: launcher }]
  }), { mode: 0o600 });
  const result = await exec(nativeExecutable, ["action", "snooze", "msreminder_test", "--runtime", runtime, "--days", "3"], { timeout: 15_000 });
  expect(JSON.parse(result.stdout)).toMatchObject({ state: "completed", action: "snooze" });
  const inspected = await openRuntimeDatabase(runtime);
  const row = inspected.prepare("SELECT state,snoozed_until FROM reminder_obligations WHERE reminder_id='msreminder_test'").get();
  expect(row?.state).toBe("snoozed");
  expect(Date.parse(String(row?.snoozed_until)) - Date.now()).toBeGreaterThan(2.99 * 86400000);
  inspected.close();
  expect(JSON.parse(await readFile(join(runtime, "state", "notifier-last-action.json"), "utf8")))
    .toMatchObject({ state: "completed", action: "snooze" });
}, 20_000);

test.skipIf(nativeExecutable === undefined)("native callback rejects unknown actions and non-Obsidian links without dispatching", async () => {
  if (nativeExecutable === undefined) throw new Error("Native executable required.");
  for (const args of [
    ["action", "delete", "msreminder_test"],
    ["action", "open_inbox", "msreminder_test", "--uri", "https://example.com"]
  ]) {
    const result = await exec(nativeExecutable, args).catch((error: unknown) => {
      if (typeof error !== "object" || error === null || !("stdout" in error)) throw error;
      return { stdout: String(error.stdout) };
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ state: "failed", errorCode: "invalid_action" });
  }
});
