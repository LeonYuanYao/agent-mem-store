import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { inspectCaptureInbox } from "../../src/capture/inbox.js";
import { isOptInPrompt, optInNotice, underExcludedRoot } from "../../src/capture/excluded-roots.js";

// ADR-0173: Sessions under `[adapters].excluded_roots` stay out of MemStore until a `ms：` prompt opts them in.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  await mkdir(runtimeRoot);
  // The configured paths are not canonical: the system temporary directory is a symlink on macOS.
  await writeFile(join(runtimeRoot, "config.toml"), [
    "schema_version = 1", "[adapters]", `excluded_roots = [${JSON.stringify(join(root, "editor"))}, ${JSON.stringify(join(root, "mcp_test_multi_*"))}]`,
    "[dreaming]", "enabled = true", ""
  ].join("\n"));
  for (const directory of ["editor/instance/workspace", "mcp_test_multi_run_1_exec_0", "mcp_test_multi", "editor-notes"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  return { root, runtimeRoot };
}

function runCodex(root: string, runtimeRoot: string, event: string, input: Record<string, unknown>) {
  const transcript = join(root, `rollout-${String(input.session_id)}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: input.session_id, source: "cli" } })}\n`);
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/hook.ts", "codex", event], {
    env: { ...process.env, CODEX_HOME: join(root, "absent-codex"), MEMSTORE_RUNTIME_ROOT: runtimeRoot, MEMSTORE_INJECTION_MODE: "" },
    input: JSON.stringify({ ...input, transcript_path: transcript }),
    encoding: "utf8", timeout: 5000
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function runClaude(runtimeRoot: string, event: string, input: Record<string, unknown>, projectDirectory: string) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/hook.ts", "claude", event], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDirectory, MEMSTORE_RUNTIME_ROOT: runtimeRoot, MEMSTORE_INJECTION_MODE: "" },
    input: JSON.stringify({ ...input, hook_event_name: event }),
    encoding: "utf8", timeout: 5000
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

const pending = async (runtimeRoot: string) => (await inspectCaptureInbox(runtimeRoot)).pendingCount;

test("a Codex Session under an excluded root is left out until a ms： prompt opts it in", async () => {
  const { root, runtimeRoot } = await fixture("memstore-excluded-codex-");
  const cwd = join(root, "editor", "instance", "workspace");
  expect(runCodex(root, runtimeRoot, "SessionStart", { session_id: "eval", cwd, source: "startup" })).toEqual({ continue: true });
  expect(runCodex(root, runtimeRoot, "UserPromptSubmit", { session_id: "eval", cwd, turn_id: "t1", prompt: "Build the case." })).toEqual({ continue: true });
  expect(runCodex(root, runtimeRoot, "Stop", { session_id: "eval", cwd, turn_id: "t1", last_assistant_message: "Built." })).toEqual({ continue: true });
  // Nothing was written: no capture, no Project resolution.
  expect(await readdir(runtimeRoot)).toEqual(["config.toml"]);

  expect(runCodex(root, runtimeRoot, "UserPromptSubmit", { session_id: "eval", cwd, turn_id: "t2", prompt: "ms：look this up" }))
    .toEqual({ continue: true, systemMessage: optInNotice });
  expect(runCodex(root, runtimeRoot, "Stop", { session_id: "eval", cwd, turn_id: "t2", last_assistant_message: "Found it." })).toEqual({ continue: true });
  expect(await pending(runtimeRoot)).toBe(2);
  // The opt-in belongs to that Session only.
  expect(runCodex(root, runtimeRoot, "UserPromptSubmit", { session_id: "other", cwd, turn_id: "t1", prompt: "Build another case." })).toEqual({ continue: true });
  expect(await pending(runtimeRoot)).toBe(2);
});

test("a trailing * matches sibling directories by name prefix only", async () => {
  const { root, runtimeRoot } = await fixture("memstore-excluded-glob-");
  runCodex(root, runtimeRoot, "UserPromptSubmit", { session_id: "run", cwd: join(root, "mcp_test_multi_run_1_exec_0"), turn_id: "t1", prompt: "Case." });
  expect(await readdir(runtimeRoot)).toEqual(["config.toml"]);
  runCodex(root, runtimeRoot, "UserPromptSubmit", { session_id: "plain", cwd: join(root, "mcp_test_multi"), turn_id: "t1", prompt: "Not a run." });
  runCodex(root, runtimeRoot, "UserPromptSubmit", { session_id: "notes", cwd: join(root, "editor-notes"), turn_id: "t1", prompt: "Not below editor." });
  expect(await pending(runtimeRoot)).toBe(2);
});

test("a Claude Code Session under an excluded root is left out until a ms： prompt opts it in", async () => {
  const { root, runtimeRoot } = await fixture("memstore-excluded-claude-");
  const directory = join(root, "editor", "instance", "workspace");
  // Claude Code reports the shell's current directory; the launch directory decides.
  const common = { session_id: "claude-eval", cwd: root };
  expect(runClaude(runtimeRoot, "UserPromptSubmit", { ...common, prompt: "Build the case." }, directory)).toBe("");
  expect(runClaude(runtimeRoot, "Stop", { ...common, last_assistant_message: "Built." }, directory)).toBe("");
  expect(await readdir(runtimeRoot)).toEqual(["config.toml"]);
  expect(JSON.parse(runClaude(runtimeRoot, "UserPromptSubmit", { ...common, prompt: "ms: remember this run" }, directory)))
    .toEqual({ systemMessage: optInNotice });
  runClaude(runtimeRoot, "Stop", { ...common, last_assistant_message: "Noted." }, directory);
  expect(await pending(runtimeRoot)).toBe(2);
});

test("only a prompt that starts with ms： or ms: opts in, and ~ expands", async () => {
  for (const prompt of ["ms：继续", " MS: go", "ms ：继续", "<user_message>ms：继续</user_message>"]) expect(isOptInPrompt(prompt)).toBe(true);
  for (const prompt of ["继续 ms：", "msg: hi", "p：私密", "ms"]) expect(isOptInPrompt(prompt)).toBe(false);
  expect(await underExcludedRoot(join(homedir(), "Library", "x"), ["~/Library"])).toBe(true);
  expect(await underExcludedRoot(join(homedir(), "Library2"), ["~/Library"])).toBe(false);
  expect(await underExcludedRoot("/anywhere", [])).toBe(false);
  // A directory that does not exist yet still resolves through its existing ancestors' symlinks.
  const root = await mkdtemp(join(tmpdir(), "memstore-excluded-missing-"));
  roots.push(root);
  expect(await underExcludedRoot(join(root, "mcp_test_multi_run_9", "missing"), [join(await realpath(root), "mcp_test_multi_*")])).toBe(true);
});
