import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

test("project link and recoverable unlink share strict preview and marker semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-project-management-"));
  temporaryDirectories.push(root);
  const projectRoot = join(root, "workspace");
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const markerPath = join(projectRoot, ".memstore-project");
  const selectedProjectId = "msproj_123e4567-e89b-42d3-a456-426614174099";
  await mkdir(projectRoot, { recursive: true });
  const common = ["--path", projectRoot, "--vault", vaultRoot, "--runtime", runtimeRoot, "--json"];

  const preview = await execFileAsync("pnpm", [
    "exec", "tsx", "src/cli/main.ts", "project", "link",
    "--to", selectedProjectId, "--preview", ...common
  ], { cwd: process.cwd(), encoding: "utf8" });
  await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  const applied = await execFileAsync("pnpm", [
    "exec", "tsx", "src/cli/main.ts", "project", "link",
    "--to", selectedProjectId, ...common
  ], { cwd: process.cwd(), encoding: "utf8" });
  const unlinkPreview = await execFileAsync("pnpm", [
    "exec", "tsx", "src/cli/main.ts", "project", "unlink", "--preview", ...common
  ], { cwd: process.cwd(), encoding: "utf8" });
  await access(markerPath);
  const unlinked = await execFileAsync("pnpm", [
    "exec", "tsx", "src/cli/main.ts", "project", "unlink", ...common
  ], { cwd: process.cwd(), encoding: "utf8" });

  expect(JSON.parse(preview.stdout)).toMatchObject({ result: { dry_run: true } });
  expect(JSON.parse(applied.stdout)).toMatchObject({
    result: { dry_run: false, project_id: selectedProjectId }
  });
  expect(JSON.parse(unlinkPreview.stdout)).toMatchObject({ result: { dry_run: true } });
  expect(JSON.parse(unlinked.stdout)).toMatchObject({ result: { dry_run: false } });
  await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(projectRoot)).some((name) =>
    name.startsWith(".memstore-project.disabled.")
  )).toBe(true);
}, 15_000);
