import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import { initializeMemStore } from "../../../src/operations/initialize.js";
import { readCanonicalMemory } from "../../../src/vault/index.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

test("remember assert preserves Human authority, exact content, scope, and startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-explicit-assert-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  await initializeMemStore({ vaultRoot, runtimeRoot, preview: false });
  const body = "Never rewrite an existing migration after it has been applied.";

  const command = await execFileAsync("pnpm", [
    "exec", "tsx", "src/cli/main.ts", "remember", "assert",
    "--scope", "global", "--startup", "always", "--text", body,
    "--json", "--vault", vaultRoot, "--runtime", runtimeRoot
  ], { cwd: process.cwd(), encoding: "utf8" });
  const envelope = JSON.parse(command.stdout) as {
    result: { memoryId: string; operationId: string; state: string; authority: string };
  };
  const loaded = await readCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    memoryId: envelope.result.memoryId
  });

  expect(envelope.result).toMatchObject({ state: "created", authority: "human_authored" });
  expect(loaded?.memory).toMatchObject({
    authority: "human_authored",
    scope: { kind: "global" },
    startup: "always",
    body
  });
  const operation = await execFileAsync("pnpm", [
    "exec", "tsx", "src/cli/main.ts", "operation", "status", envelope.result.operationId,
    "--json", "--vault", vaultRoot, "--runtime", runtimeRoot
  ], { cwd: process.cwd(), encoding: "utf8" });
  const status = await execFileAsync("pnpm", [
    "exec", "tsx", "src/cli/main.ts", "status",
    "--json", "--vault", vaultRoot, "--runtime", runtimeRoot
  ], { cwd: process.cwd(), encoding: "utf8" });
  expect(JSON.parse(operation.stdout)).toMatchObject({
    command: "operation.status",
    result: { state: "completed", memory_id: envelope.result.memoryId }
  });
  expect(JSON.parse(status.stdout)).toMatchObject({
    command: "status",
    result: { mode: "read_only_inspection", luna: { state: "healthy" } }
  });
}, 15_000);

test("remember assert of the same text returns the existing Memory instead of a duplicate", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-explicit-assert-repeat-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  await initializeMemStore({ vaultRoot, runtimeRoot, preview: false });
  const assertText = async (text: string, ...options: string[]) => {
    const command = await execFileAsync("pnpm", [
      "exec", "tsx", "src/cli/main.ts", "remember", "assert", "--scope", "global",
      "--text", text, ...options, "--json", "--vault", vaultRoot, "--runtime", runtimeRoot
    ], { cwd: process.cwd(), encoding: "utf8" });
    return {
      stderr: command.stderr,
      result: (JSON.parse(command.stdout) as { result: Record<string, unknown> }).result
    };
  };
  const body = "Run evaluation cases in English by default.";

  const first = await assertText(body);
  const repeated = await assertText(`${body}\n`);
  const preview = await assertText(body, "--preview");
  const differentStartup = await assertText(body, "--startup", "always");

  expect(first.result).toMatchObject({ state: "created" });
  expect(repeated.result).toMatchObject({ state: "unchanged", memoryId: first.result.memoryId });
  expect(repeated.result).not.toHaveProperty("operationId");
  expect(preview.result).toMatchObject({
    dry_run: true, would_create: [], existing_memory_id: first.result.memoryId
  });
  expect(differentStartup.result).toMatchObject({ state: "created" });
  expect(differentStartup.result.memoryId).not.toBe(first.result.memoryId);
  // Agents read stdout and stderr together; the node:sqlite warning broke their JSON parse.
  expect(first.stderr).not.toContain("ExperimentalWarning");
}, 30_000);
