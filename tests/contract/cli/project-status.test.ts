import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import { inspectProject } from "../../../src/projects/index.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

test("project status CLI keeps the read-only result in a stable envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-project-status-cli-"));
  temporaryDirectories.push(root);
  const projectRoot = join(root, "workspace");
  const runtimeRoot = join(root, "runtime");
  await mkdir(projectRoot, { recursive: true });

  const command = await execFileAsync("pnpm", [
    "exec", "tsx", "src/cli/main.ts", "project", "status",
    "--path", projectRoot, "--json", "--runtime", runtimeRoot,
    "--vault", join(root, "vault")
  ], { cwd: process.cwd(), encoding: "utf8" });

  expect(JSON.parse(command.stdout)).toMatchObject({
    schema_version: 1,
    ok: true,
    command: "project.status",
    result: { status: "unresolved", reason: "unregistered_project" }
  });
  await expect(access(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

test("Project inspection never registers an untracked non-Git directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-project-status-"));
  temporaryDirectories.push(root);
  const projectRoot = join(root, "workspace");
  const runtimeRoot = join(root, "runtime");
  await mkdir(projectRoot, { recursive: true });

  const result = await inspectProject({ path: projectRoot, runtimeRoot });

  expect(result).toMatchObject({
    status: "unresolved",
    reason: "unregistered_project",
    globalMemoryAvailable: true
  });
  await expect(access(join(runtimeRoot, "state", "memstore.sqlite"))).rejects.toMatchObject({
    code: "ENOENT"
  });
});
