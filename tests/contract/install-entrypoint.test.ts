import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

test("the repository installer explains the safe preview-first workflow without bootstrapping dependencies", async () => {
  const execution = await execFileAsync("/bin/sh", ["install.sh", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  expect(execution.stdout).toContain("./install.sh [--apply]");
  expect(execution.stdout).toContain("Defaults to a zero-write preview");
  expect(execution.stdout).toContain("--mode active|shadow");
  expect(execution.stdout).toContain("--vault /path/to/Obsidian/Vault");
});

test("the MemStore CLI exposes setup and everyday command help", async () => {
  const execution = await execFileAsync("pnpm", [
    "exec",
    "tsx",
    "src/cli/main.ts",
    "--help"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  expect(execution.stdout).toContain("memstore setup [--apply]");
  expect(execution.stdout).toContain("memstore doctor --deep");
  expect(execution.stdout).toContain("memstore recall search");
});

test("the repository installer keeps build progress out of JSON stdout", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-installer-json-"));
  temporaryDirectories.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  await Promise.all([
    writeFile(join(bin, "pnpm"), "#!/bin/sh\necho build-log\n", { mode: 0o755 }),
    writeFile(join(bin, "node"), "#!/bin/sh\necho '{\"ok\":true}'\n", { mode: 0o755 }),
    ...["swift", "codesign", "launchctl"].map((name) =>
      writeFile(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    )
  ]);

  const execution = await execFileAsync("/bin/sh", ["install.sh", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }
  });

  expect(execution.stdout).toBe("{\"ok\":true}\n");
  expect(execution.stderr).toContain("build-log");
});
