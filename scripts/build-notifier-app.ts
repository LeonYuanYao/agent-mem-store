import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packageRoot = join(repositoryRoot, "native", "memstore-notifier");
const releaseRoot = join(packageRoot, ".build", "release");
const appRoot = join(releaseRoot, "MemStore Notifier.app");
const contentsRoot = join(appRoot, "Contents");
const executableRoot = join(contentsRoot, "MacOS");
const executable = join(executableRoot, "memstore-notifier");

function run(executablePath: string, arguments_: readonly string[]): void {
  const result = spawnSync(executablePath, [...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`${executablePath} ${arguments_.join(" ")} failed: ${result.stderr}`);
  }
}

run("swift", ["build", "-c", "release", "--package-path", packageRoot]);
await rm(appRoot, { recursive: true, force: true });
await mkdir(executableRoot, { recursive: true, mode: 0o755 });
await Promise.all([
  copyFile(join(releaseRoot, "memstore-notifier"), executable),
  copyFile(join(packageRoot, "App", "Info.plist"), join(contentsRoot, "Info.plist"))
]);
await chmod(executable, 0o755);
run("codesign", ["--force", "--deep", "--sign", "-", appRoot]);
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appRoot]);
process.stdout.write(`${appRoot}\n`);
