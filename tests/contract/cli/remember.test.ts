import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

test("remember assert preview returns a stable envelope and performs zero mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cli-remember-preview-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");

  const result = await execFileAsync("pnpm", [
    "exec", "tsx", "src/cli/main.ts", "remember", "assert",
    "--scope", "global", "--text", "Prefer pnpm for this workspace.",
    "--preview", "--json", "--vault", vaultRoot, "--runtime", runtimeRoot
  ], { cwd: process.cwd(), encoding: "utf8" });

  expect(JSON.parse(result.stdout)).toEqual({
    schema_version: 1,
    ok: true,
    command: "remember.assert",
    result: {
      dry_run: true,
      would_accept: true,
      authority: "human_authored",
      scope: { kind: "global" },
      startup: "auto",
      would_create: ["canonical_memory"],
      warnings: []
    }
  });
  await expect(access(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(vaultRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

test("remember extract rejects unsupported Codex selection identities explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cli-selection-"));
  temporaryDirectories.push(root);
  const projectRoot = join(root, "workspace");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, ".memstore-project"), JSON.stringify({
    schema_version: 1,
    project_id: "msproj_123e4567-e89b-42d3-a456-426614174000"
  }));

  try {
    await execFileAsync("pnpm", [
      "exec", "tsx", "src/cli/main.ts", "remember", "extract",
      "--from", "selection:native-42", "--preview", "--json",
      "--path", projectRoot,
      "--vault", join(root, "vault"), "--runtime", join(root, "runtime")
    ], { cwd: process.cwd(), encoding: "utf8" });
    throw new Error("Expected unsupported selection failure.");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    expect("code" in error ? error.code : undefined).toBe(2);
    expect("stderr" in error ? error.stderr : undefined).toContain(
      "unsupported_selection_identity"
    );
  }
});

test("Project-scoped remember preview can describe registration without creating Runtime state", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cli-project-preview-"));
  temporaryDirectories.push(root);
  const projectRoot = join(root, "workspace");
  const runtimeRoot = join(root, "runtime");
  await mkdir(projectRoot, { recursive: true });

  const result = await execFileAsync("pnpm", [
    "exec", "tsx", "src/cli/main.ts", "remember", "assert",
    "--text", "Keep generated files outside source control.", "--preview", "--json",
    "--path", projectRoot, "--vault", join(root, "vault"), "--runtime", runtimeRoot
  ], { cwd: process.cwd(), encoding: "utf8" });

  expect(JSON.parse(result.stdout)).toMatchObject({
    result: {
      dry_run: true,
      would_accept: true,
      scope: { kind: "project", projectResolution: "unregistered_project" },
      would_create: ["project_registry_entry", "canonical_memory"]
    }
  });
  await expect(access(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
});
