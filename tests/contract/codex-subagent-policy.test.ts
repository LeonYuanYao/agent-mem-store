import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";
import { z } from "zod";
import { afterEach, expect, test } from "vitest";
import { inspectCaptureInbox } from "../../src/capture/inbox.js";
import { foregroundRetrievalSocketPath } from "../../src/retrieval/foreground-client.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

for (const source of ["cli", "exec", "vscode"]) {
test(`a database-identified primary ${source} session still captures with the switch off`, async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-primary-db-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  await mkdir(codexHome);
  const db = new DatabaseSync(join(codexHome, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT NOT NULL)");
  db.prepare("INSERT INTO threads VALUES (?, ?)").run("primary", source);
  db.close();
  const runtimeRoot = join(root, "runtime");
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/hook.ts", "codex", "Stop"], {
    env: { ...process.env, CODEX_HOME: codexHome, MEMSTORE_RUNTIME_ROOT: runtimeRoot },
    input: JSON.stringify({ session_id: "primary", cwd: root, last_assistant_message: "Primary fixture." }),
    encoding: "utf8", timeout: 1500
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ continue: true });
  expect(await inspectCaptureInbox(runtimeRoot)).toMatchObject({ pendingCount: 1 });
});
}

test("a locked host database falls back without waiting, including through the legacy CLI route", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-host-locked-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  await mkdir(codexHome);
  const db = new DatabaseSync(join(codexHome, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT NOT NULL); BEGIN EXCLUSIVE");
  const transcript = join(root, "rollout.jsonl");
  await writeFile(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: "child", source: { subagent: { other: "guardian" } } } })}\n`);
  const runtimeRoot = join(root, "runtime");
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/main.ts", "hook", "codex", "PostToolUse"], {
      env: { ...process.env, CODEX_HOME: codexHome, MEMSTORE_RUNTIME_ROOT: runtimeRoot },
      input: JSON.stringify({ session_id: "child", cwd: root, transcript_path: transcript }),
      encoding: "utf8", timeout: 1500
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
    expect(await readdir(runtimeRoot).catch(() => [])).toEqual([]);
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
});

test("a primary session can capture using matching transcript metadata without a host database", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-primary-source-"));
  roots.push(root);
  const transcript = join(root, "rollout.jsonl");
  await writeFile(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: "primary", source: "cli" } })}\n`);
  const runtimeRoot = join(root, "runtime");
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/hook.ts", "codex", "UserPromptSubmit"], {
    env: { ...process.env, CODEX_HOME: join(root, "absent-codex"), MEMSTORE_RUNTIME_ROOT: runtimeRoot, MEMSTORE_INJECTION_MODE: "active" },
    input: JSON.stringify({ session_id: "primary", cwd: root, transcript_path: transcript, prompt: "Primary fixture." }),
    encoding: "utf8", timeout: 1500
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ continue: true });
  expect(await inspectCaptureInbox(runtimeRoot)).toMatchObject({ pendingCount: 1 });
});

for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]) {
test(`a subagent ${event} is neither captured nor injected by default`, async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-subagent-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  const runtimeRoot = join(root, "runtime");
  await mkdir(codexHome);
  const db = new DatabaseSync(join(codexHome, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT NOT NULL)");
  db.prepare("INSERT INTO threads VALUES (?, ?)").run("child", JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1 } } }));
  db.close();
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/hook.ts", "codex", event], {
    env: { ...process.env, CODEX_HOME: codexHome, MEMSTORE_RUNTIME_ROOT: runtimeRoot, MEMSTORE_INJECTION_MODE: "active" },
    input: JSON.stringify({ session_id: "child", cwd: root, prompt: "A private child task." }),
    encoding: "utf8", timeout: 1500
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ continue: true });
  expect(await readdir(runtimeRoot).catch(() => [])).toEqual([]);
});
}

for (const setting of ["false", '"true"', "broken TOML"]) {
test(`non-enabled subagent policy ${setting} skips transcript-identified children`, async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-subagent-policy-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  await mkdir(runtimeRoot);
  await writeFile(join(runtimeRoot, "config.toml"), `schema_version = 1\n[adapters]\nsubagents_enabled = ${setting}\n`);
  const transcript = join(root, "rollout.jsonl");
  await writeFile(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: "child", source: { subagent: { thread_spawn: { parent_thread_id: "parent", depth: 2 } } } } })}\n`);
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/hook.ts", "codex", "Stop"], {
    env: { ...process.env, CODEX_HOME: join(root, "absent-codex"), MEMSTORE_RUNTIME_ROOT: runtimeRoot },
    input: JSON.stringify({ session_id: "child", cwd: root, transcript_path: transcript, last_assistant_message: "Private fixture." }),
    encoding: "utf8", timeout: 1500
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ continue: true });
  expect(await readdir(runtimeRoot)).toEqual(["config.toml"]);
});
}

for (const metadata of ["absent", "mismatched", "malformed", "oversized"]) {
test(`unknown identity (${metadata}) skips memory without persisting diagnostic bodies`, async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-unknown-source-"));
  roots.push(root);
  const transcript = join(root, "rollout.jsonl");
  if (metadata !== "absent") await writeFile(transcript, metadata === "mismatched"
    ? `${JSON.stringify({ type: "session_meta", payload: { id: "different-parent", source: "cli" } })}\n`
    : metadata === "oversized" ? "x".repeat(1024 * 1024 + 1) : "not-json\n");
  const runtimeRoot = join(root, "runtime");
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/hook.ts", "codex", "Stop"], {
    env: { ...process.env, CODEX_HOME: join(root, "absent-codex"), MEMSTORE_RUNTIME_ROOT: runtimeRoot },
    input: JSON.stringify({ session_id: "child", cwd: root, transcript_path: transcript, last_assistant_message: "Private fixture must not be printed." }),
    encoding: "utf8", timeout: 1500
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("session_kind_unknown");
  expect(result.stdout + result.stderr).not.toContain("Private fixture");
  expect(result.stdout + result.stderr).not.toContain(root);
  expect(await readdir(runtimeRoot).catch(() => [])).toEqual([]);
});
}

test("opt-in restores subagent capture and injection, and disabling it takes effect on the next event", async () => {
  const root = await mkdtemp("/tmp/memstore-subagent-ipc-");
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  await mkdir(join(runtimeRoot, "state"), { recursive: true });
  const configPath = join(runtimeRoot, "config.toml");
  await writeFile(configPath, "schema_version = 1\n[adapters]\nsubagents_enabled = true\n");
  const transcript = join(root, "rollout.jsonl");
  await writeFile(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: "child", source: { subagent: "review" } } })}\n`);
  const memory = "<memstore-candidates>\n[M:1 S:P A:A R:C] Child fixture memory.\n</memstore-candidates>";
  let requests = 0;
  const server = createServer(socket => {
    let source = "";
    socket.setEncoding("utf8").on("data", (chunk: string) => {
      source += chunk;
      if (!source.includes("\n")) return;
      requests += 1;
      const request = z.object({ requestId: z.string() }).parse(JSON.parse(source.split("\n")[0] ?? "{}"));
      socket.end(`${JSON.stringify({ schemaVersion: 2, requestId: request.requestId, state: "completed", event: "UserPromptSubmit", text: memory, receiptId: "fixture", renderedTokenCount: 16 })}\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(foregroundRetrievalSocketPath(runtimeRoot), resolve));
  async function invoke(turnId: string): Promise<string> {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/hook.ts", "codex", "UserPromptSubmit"], {
      env: { ...process.env, CODEX_HOME: join(root, "absent-codex"), MEMSTORE_RUNTIME_ROOT: runtimeRoot, MEMSTORE_INJECTION_MODE: "active" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.end(JSON.stringify({ session_id: "child", turn_id: turnId, cwd: root, transcript_path: transcript, prompt: "Child fixture." }));
    const timeout = setTimeout(() => child.kill("SIGKILL"), 2000);
    const status = await new Promise<number | null>(resolve => child.once("close", resolve));
    clearTimeout(timeout);
    expect(status, stderr).toBe(0);
    return stdout;
  }
  try {
    expect(JSON.parse(await invoke("enabled"))).toMatchObject({ hookSpecificOutput: { additionalContext: memory } });
    expect(await inspectCaptureInbox(runtimeRoot)).toMatchObject({ pendingCount: 1 });
    await writeFile(configPath, "schema_version = 1\n[adapters]\nsubagents_enabled = false\n");
    expect(JSON.parse(await invoke("disabled"))).toEqual({ continue: true });
    expect(await inspectCaptureInbox(runtimeRoot)).toMatchObject({ pendingCount: 1 });
    expect(requests).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => {
      if (error) reject(error);
      else resolve();
    }));
  }
});
