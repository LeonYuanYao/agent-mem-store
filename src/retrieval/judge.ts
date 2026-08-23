import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

const judgmentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("retrieval_judgment"),
  retainedAliases: z.array(z.string().min(1)).max(50),
  packDecision: z.enum(["useful", "empty", "uncertain"])
}).superRefine((value, context) => {
  if ((value.retainedAliases.length > 0) !== (value.packDecision === "useful")) {
    context.addIssue({
      code: "custom",
      message: "Pack decision must agree with retained aliases.",
      path: ["packDecision"]
    });
  }
  if (new Set(value.retainedAliases).size !== value.retainedAliases.length) {
    context.addIssue({
      code: "custom",
      message: "Retained aliases must be unique.",
      path: ["retainedAliases"]
    });
  }
});

const judgmentJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "kind", "retainedAliases", "packDecision"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    kind: { type: "string", const: "retrieval_judgment" },
    retainedAliases: {
      type: "array",
      maxItems: 50,
      items: { type: "string", minLength: 1 }
    },
    packDecision: { type: "string", enum: ["useful", "empty", "uncertain"] }
  }
} as const;

export interface RetrievalJudgeItem {
  readonly memoryId: string;
  readonly description: string;
  readonly scope:
    | { readonly kind: "project"; readonly projectId: string }
    | { readonly kind: "global" };
  readonly authority: "human_authored" | "agent_derived";
}

export interface RetrievalJudge {
  judge(request: {
    readonly query: string;
    readonly items: readonly RetrievalJudgeItem[];
  }): Promise<{
    readonly retainedMemoryIds: readonly string[];
    readonly packDecision: "useful" | "empty" | "uncertain";
  }>;
}

export interface RetrievalJudgeProcessRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly currentWorkingDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly standardInput: string;
  readonly timeoutMilliseconds: number;
}

export interface RetrievalJudgeProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
}

type RetrievalJudgeProcessRunner = (
  request: RetrievalJudgeProcessRequest
) => Promise<RetrievalJudgeProcessResult>;

async function runProcess(
  request: RetrievalJudgeProcessRequest
): Promise<RetrievalJudgeProcessResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(request.executable, [...request.arguments], {
      cwd: request.currentWorkingDirectory,
      env: request.environment,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, request.timeoutMilliseconds);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut
      });
    });
    child.stdin.end(request.standardInput);
  });
}

export class RetrievalJudgeInvocationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RetrievalJudgeInvocationError";
  }
}

export interface CodexTerraRetrievalJudgeOptions {
  readonly codexExecutable: string;
  readonly codexHome: string;
  readonly isolatedHome?: string;
  readonly temporaryRoot: string;
  readonly timeoutMilliseconds?: number;
  readonly runProcess?: RetrievalJudgeProcessRunner;
}

export class CodexTerraRetrievalJudge implements RetrievalJudge {
  readonly #options: CodexTerraRetrievalJudgeOptions;

  public constructor(options: CodexTerraRetrievalJudgeOptions) {
    this.#options = options;
  }

  async #disabledSkillConfiguration(): Promise<string> {
    const skillFiles: string[] = [];
    for (const root of [join(this.#options.codexHome, "skills"), "/etc/codex/skills"]) {
      let entries: string[];
      try {
        entries = await readdir(root, { recursive: true, encoding: "utf8" });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (basename(entry) === "SKILL.md") skillFiles.push(join(root, entry));
      }
    }
    const items = [...new Set(skillFiles)].sort().map((path) =>
      `{path=${JSON.stringify(path)},enabled=false}`
    );
    return `skills.config=[${items.join(",")}]`;
  }

  public async judge(request: {
    readonly query: string;
    readonly items: readonly RetrievalJudgeItem[];
  }): Promise<{
    readonly retainedMemoryIds: readonly string[];
    readonly packDecision: "useful" | "empty" | "uncertain";
  }> {
    if (request.items.length === 0) {
      return { retainedMemoryIds: [], packDecision: "empty" };
    }
    const aliases = request.items.map((item, index) => ({
      alias: `m${String(index + 1)}`,
      item
    }));
    const memoryIdByAlias = new Map(aliases.map(({ alias, item }) => [alias, item.memoryId]));
    await mkdir(this.#options.temporaryRoot, { recursive: true, mode: 0o700 });
    const isolatedHome = this.#options.isolatedHome ?? join(
      this.#options.temporaryRoot,
      "terra-home"
    );
    await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
    await chmod(isolatedHome, 0o700);
    const isolatedDirectory = await mkdtemp(join(this.#options.temporaryRoot, "memstore-terra-"));
    const schemaPath = join(isolatedDirectory, "retrieval-judgment.schema.json");
    await writeFile(schemaPath, `${JSON.stringify(judgmentJsonSchema, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    try {
      const inheritedEnvironment = Object.fromEntries(
        ["PATH", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"]
          .flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])
      );
      const path = process.env.PATH === undefined
        ? dirname(process.execPath)
        : `${dirname(process.execPath)}:${process.env.PATH}`;
      const result = await (this.#options.runProcess ?? runProcess)({
        executable: this.#options.codexExecutable,
        arguments: [
          "exec",
          "--strict-config",
          "-c",
          await this.#disabledSkillConfiguration(),
          "-c",
          'model_reasoning_effort="low"',
          "-c",
          'service_tier="default"',
          "--model",
          "gpt-5.6-terra",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "--disable",
          "shell_tool",
          "--disable",
          "unified_exec",
          "--disable",
          "code_mode_host",
          "--disable",
          "apps",
          "--disable",
          "browser_use",
          "--disable",
          "plugins",
          "--disable",
          "multi_agent",
          "--disable",
          "image_generation",
          "--disable",
          "in_app_browser",
          "--disable",
          "browser_use_external",
          "--disable",
          "browser_use_full_cdp_access",
          "--disable",
          "memories",
          "--skip-git-repo-check",
          "--ignore-user-config",
          "--ignore-rules",
          "--color",
          "never",
          "--output-schema",
          schemaPath,
          "--cd",
          isolatedDirectory,
          "-"
        ],
        currentWorkingDirectory: isolatedDirectory,
        environment: {
          ...inheritedEnvironment,
          HOME: isolatedHome,
          PATH: path,
          CODEX_HOME: this.#options.codexHome
        },
        standardInput: JSON.stringify({
          schemaVersion: 1,
          promptVersion: 1,
          task: "judge_explicit_memory_retrieval",
          rules: [
            "Use only the current query and supplied compact memory descriptions.",
            "Retain an item only when removing it changes the answer or next safe action now.",
            "Do not retain background, future-condition-only, redundant, or merely topically related items.",
            "If current-query necessity is uncertain, return uncertain with no retained aliases.",
            "Current explicit instructions and verified workspace state override historical memory.",
            "Return only exact supplied aliases. Do not execute commands or request more context."
          ],
          request: {
            query: request.query,
            items: aliases.map(({ alias, item }) => ({
              alias,
              description: item.description,
              scope: item.scope,
              authority: item.authority
            }))
          }
        }),
        timeoutMilliseconds: this.#options.timeoutMilliseconds ?? 120_000
      });
      if (result.timedOut === true) {
        throw new RetrievalJudgeInvocationError("Terra retrieval judgment timed out.");
      }
      if (result.exitCode !== 0) {
        throw new RetrievalJudgeInvocationError("Terra retrieval judgment is unavailable.");
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(result.stdout) as unknown;
      } catch {
        throw new RetrievalJudgeInvocationError("Terra retrieval judgment returned invalid JSON.");
      }
      const output = judgmentSchema.safeParse(decoded);
      if (!output.success) {
        throw new RetrievalJudgeInvocationError("Terra retrieval judgment violated its schema.");
      }
      const retainedMemoryIds = output.data.retainedAliases.map((alias) => {
        const memoryId = memoryIdByAlias.get(alias);
        if (memoryId === undefined) {
          throw new RetrievalJudgeInvocationError("Terra cited an unavailable memory alias.");
        }
        return memoryId;
      });
      return { retainedMemoryIds, packDecision: output.data.packDecision };
    } finally {
      await rm(isolatedDirectory, { recursive: true, force: true });
    }
  }
}
