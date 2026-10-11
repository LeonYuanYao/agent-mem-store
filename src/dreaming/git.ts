import { spawn } from "node:child_process";

export interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a read-only git command. Optional locks are disabled so a concurrent
 * interactive session never contends with dreaming over the index.
 */
export function git(
  directory: string,
  args: readonly string[],
  options: { readonly timeoutMilliseconds?: number; readonly executable?: string } = {}
): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(options.executable ?? process.env.MEMSTORE_GIT_EXECUTABLE ?? "git", ["-C", directory, ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMilliseconds ?? 90_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout: "", stderr: "git_unavailable" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

export async function gitText(directory: string, args: readonly string[]): Promise<string | undefined> {
  const result = await git(directory, args);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

export async function isAncestor(directory: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await git(directory, ["merge-base", "--is-ancestor", ancestor, descendant])).code === 0;
}
