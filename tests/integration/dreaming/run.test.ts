import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { captureEvent } from "../../../src/capture/index.js";
import { dreamingConfigurationSchema } from "../../../src/dreaming/config.js";
import { handOffCaptureToDreaming } from "../../../src/dreaming/handoff.js";
import type { DreamModel, Verdict } from "../../../src/dreaming/model.js";
import { inspectDreams, runNextDreamStep, scheduleDueDreams, startDreamRun } from "../../../src/dreaming/run.js";
import { resolveProject } from "../../../src/projects/index.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "Owner", GIT_AUTHOR_EMAIL: "owner@example.com",
    GIT_COMMITTER_NAME: "Owner", GIT_COMMITTER_EMAIL: "owner@example.com" } });
}

async function workspace(root: string): Promise<string> {
  const seed = join(root, "seed");
  await mkdir(join(seed, "src"), { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  await writeFile(join(seed, "src", "preview.ts"), "export function setVideo() { reloadEffect(); }\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "baseline");
  git(root, "clone", "-q", "--bare", seed, join(root, "origin.git"));
  const clone = join(root, "clone");
  git(root, "clone", "-q", join(root, "origin.git"), clone);
  git(clone, "config", "user.email", "owner@example.com");
  return clone;
}

const statements = {
  code: "TTEH 的 `setVideo` 会调用 `reloadEffect` 重新加载特效。",
  preference: "用户要求创建 MR 时使用 Bits。",
  wrong: "`setVideo` 会保留运行时状态。",
  oneOff: "本次运行的 case 0_125 得分 0.8。"
};

function fakeModel(log: string[]): DreamModel {
  return {
    extract(request) {
      log.push(`extract:${String(request.index)}/${String(request.total)}`);
      expect(request.chunk).toContain("reloadEffect");
      return Promise.resolve({ usage: { tokens: 100, seconds: 1 }, candidates: [
        { statement: statements.code, claim_type: "code_state", scope: "project", explicit_user: false, turn_refs: ["T01"],
          quote: "setVideo() { reloadEffect(); }", check_hints: ["reloadEffect"] },
        { statement: statements.preference, claim_type: "preference", scope: "project", explicit_user: true, turn_refs: ["T01"],
          quote: "以后提 MR 都用 Bits", check_hints: [] },
        { statement: statements.wrong, claim_type: "code_state", scope: "project", explicit_user: false, turn_refs: [], quote: "", check_hints: [] },
        { statement: statements.oneOff, claim_type: "workflow_process", scope: "project", explicit_user: false, turn_refs: [], quote: "", check_hints: [] }
      ] });
    },
    merge(request) {
      log.push(`merge:${String(request.candidates.length)}`);
      // Drop one candidate on purpose: merging must never lose it.
      return Promise.resolve({ usage: { tokens: 10, seconds: 1 }, items: request.candidates.slice(1).map((candidate) => ({
        member_ids: [candidate.id], statement: candidate.statement, claim_type: candidate.claim_type as "code_state", scope: "project" as const, check_hints: []
      })) });
    },
    verify(request) {
      log.push(`verify:${String(request.claims.length)}`);
      expect(request.repoMap).toContain("origin/");
      return Promise.resolve({ usage: { tokens: 50, seconds: 1 }, results: request.claims.map((claim): Verdict => {
        const verdict = claim.text.startsWith(statements.code) ? "confirmed"
          : claim.text.startsWith(statements.wrong) ? "contradicted"
          : claim.text.startsWith(statements.preference) ? "not_repo_verifiable" : "inconclusive";
        return { id: claim.id, claim_type: "code_state", durability: claim.text.startsWith(statements.oneOff) ? "episodic" : "long_term",
          scope: "project", subsystem: "preview", verdict, branch: "", evidence: ["clone@abc [R1-implementation 2026-01-01] src/preview.ts:1"], reason: "test",
          refined_statement: claim.text.startsWith(statements.code) ? "TTEH 的 `setVideo` 在预览中调用 `reloadEffect` 重新加载特效。" : "" };
      }) });
    },
    defend(request) {
      log.push(`defend:${String(request.claims.length)}`);
      return Promise.resolve({ usage: { tokens: 5, seconds: 1 }, results: request.claims.map((claim) => ({
        id: String(claim.id), decision: "uphold" as const, final_verdict: "contradicted" as const, branch: "", evidence: [], reason: "baseline reloads"
      })) });
    }
  };
}

test("a dream run extracts, merges, verifies, defends and tiers a Session without writing canonical Memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-dream-run-"));
  directories.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await mkdir(vaultRoot, { recursive: true });
  const clone = await workspace(root);
  const sessionId = "dream-session-1";
  const project = await resolveProject({ sessionId, path: clone, runtimeRoot });
  expect(project.status).toBe("resolved");
  if (project.status !== "resolved") return;
  const events = [
    { eventKind: "UserPromptSubmit", turnId: "t1", payload: { prompt: "以后提 MR 都用 Bits。看看 setVideo 做了什么" } },
    { eventKind: "PostToolUse", turnId: "t1", payload: { toolName: "Bash", cwd: clone, input: { command: "cat src/preview.ts" },
      response: "export function setVideo() { reloadEffect(); }" } },
    { eventKind: "Stop", turnId: "t1", payload: { assistantMessage: "setVideo 会重新加载特效。" } },
    { eventKind: "SessionEnd", payload: { reason: "other" } }
  ] as const;
  for (const [index, event] of events.entries()) {
    await captureEvent({ runtimeRoot, event: {
      schemaVersion: 1, eventId: `msevent_dream_${String(index)}`, deduplicationKey: `dream:${String(index)}`, agent: "codex",
      eventKind: event.eventKind, occurredAt: new Date().toISOString(), projectId: project.projectId, sessionId,
      ...("turnId" in event ? { turnId: event.turnId } : {}), payload: event.payload
    } });
  }
  const now = new Date(Date.now() + 60_000).toISOString();
  expect(await handOffCaptureToDreaming({ runtimeRoot, now, minimumAgeMilliseconds: 0 })).toBe(4);

  const configuration = dreamingConfigurationSchema.parse({ enabled: true, verify_batch_size: 8 });
  const runId = await startDreamRun({ runtimeRoot, projectId: project.projectId, now });
  const log: string[] = [];
  const model = fakeModel(log);
  for (let step = 0; step < 50; step += 1) {
    const result = await runNextDreamStep({ runtimeRoot, vaultRoot, now, configuration, model, allowTemporaryRoots: true });
    if (result.state === "idle") break;
    expect(result.state).toBe("worked");
  }
  expect(log).toEqual(["extract:1/1", "merge:2", "verify:4", "defend:1"]);

  const [run] = await inspectDreams(runtimeRoot, 1);
  expect(run).toMatchObject({ run_id: runId, stage: "completed" });
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const tiers = Object.fromEntries(database.prepare("SELECT statement, tier, tier_reason FROM dream_items").all()
      .map((row) => [String(row.statement), `${String(row.tier)}:${String(row.tier_reason)}`]));
    expect(tiers).toEqual({
      [statements.code]: "inject:confirmed",
      [statements.preference]: "inject:explicit_user",
      [statements.wrong]: "review:contradicted",
      [statements.oneOff]: "drop:episodic"
    });
    const quote = database.prepare("SELECT quote_found, source_paths_json FROM dream_candidates WHERE statement = ?").get(statements.code);
    expect(quote).toMatchObject({ quote_found: 1, source_paths_json: JSON.stringify(["src/preview.ts"]) });
  } finally {
    database.close();
  }
  const reports = await readdir(join(vaultRoot, "_MemStore", "Dreams"));
  expect(reports).toHaveLength(1);
  const report = await readFile(join(vaultRoot, "_MemStore", "Dreams", reports[0] ?? ""), "utf8");
  expect(report).toContain("TTEH 的 `setVideo` 在预览中调用 `reloadEffect` 重新加载特效。");
  expect(report).toContain(`收窄前：${statements.code}`);
  expect(report).toContain("需要复核");
  await expect(access(join(vaultRoot, "Memories"))).rejects.toThrow();

  // The Session is never extracted twice, and the schedule creates nothing when no Session is waiting.
  const later = new Date(Date.now() + 4 * 3_600_000).toISOString();
  expect((await scheduleDueDreams({ runtimeRoot, now: later, configuration: { ...configuration, hour: 0 }, allowTemporaryRoots: true })).created).toEqual([]);
});

test("dreaming is disabled by default and never schedules without configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-dream-off-"));
  directories.push(root);
  const configuration = dreamingConfigurationSchema.parse({});
  expect(configuration).toMatchObject({ enabled: false, mode: "shadow", hour: 3, verify_effort: "high", extract_effort: "medium" });
  expect((await scheduleDueDreams({ runtimeRoot: join(root, "runtime"), now: new Date().toISOString(), configuration })).created).toEqual([]);
  expect(() => dreamingConfigurationSchema.parse({ mode: "apply" })).toThrow();
});
