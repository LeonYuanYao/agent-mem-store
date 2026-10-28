import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { captureEvent } from "../../../src/capture/index.js";
import { dreamingConfigurationSchema } from "../../../src/dreaming/config.js";
import { handOffCaptureToDreaming } from "../../../src/dreaming/handoff.js";
import { DreamModelError, type DreamModel, type Verdict } from "../../../src/dreaming/model.js";
import { inspectDreams, renderDreamReports, runNextDreamStep, scheduleDueDreams, startDreamRun } from "../../../src/dreaming/run.js";
import { rememberExtract } from "../../../src/operations/remember.js";
import { resolveProject } from "../../../src/projects/index.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { readCanonicalMemory } from "../../../src/vault/index.js";

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
  oneOff: "本次运行的 case 0_125 得分 0.8。",
  codeDetail: "1. setVideo 先调用 reloadEffect\n2. 重新加载后运行时状态被重置"
};

function fakeModel(log: string[]): DreamModel {
  return {
    extract(request) {
      log.push(`extract:${String(request.index)}/${String(request.total)}`);
      expect(request.chunk).toContain("reloadEffect");
      return Promise.resolve({ usage: { tokens: 100, seconds: 1 }, candidates: [
        { statement: statements.code, claim_type: "code_state", scope: "project", explicit_user: false, turn_refs: ["T01"],
          quote: "setVideo() { reloadEffect(); }", check_hints: ["reloadEffect"], detail: statements.codeDetail },
        { statement: statements.preference, claim_type: "preference", scope: "project", explicit_user: true, turn_refs: ["T01"],
          quote: "以后提 MR 都用 Bits", check_hints: [], detail: "" },
        { statement: statements.wrong, claim_type: "code_state", scope: "project", explicit_user: false, turn_refs: [], quote: "", check_hints: [],
          detail: "这是需要被丢弃的细节。" },
        { statement: statements.oneOff, claim_type: "workflow_process", scope: "project", explicit_user: false, turn_refs: [], quote: "", check_hints: [], detail: "" }
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
      // The user's own message travels with the user-stated claim, and only with it.
      for (const claim of request.claims) {
        if (claim.text.startsWith(statements.preference)) expect(claim.user_words?.[0]).toContain("以后提 MR 都用 Bits");
        else expect(claim.user_words).toBeUndefined();
        // Detail travels with its claim so the verifier can check it against evidence.
        if (claim.text.startsWith(statements.code)) expect(claim.text).toContain(`补充细节：${statements.codeDetail}`);
      }
      return Promise.resolve({ usage: { tokens: 50, seconds: 1 }, results: request.claims.map((claim): Verdict => {
        const verdict = claim.text.startsWith(statements.code) ? "confirmed"
          : claim.text.startsWith(statements.wrong) ? "contradicted"
          : claim.text.startsWith(statements.preference) ? "not_repo_verifiable" : "inconclusive";
        return { id: claim.id, claim_type: "code_state", durability: claim.text.startsWith(statements.oneOff) ? "episodic" : "long_term",
          scope: claim.text.startsWith(statements.preference) ? "global" : "project", subsystem: "preview", verdict, branch: "", evidence: ["clone@abc [R1-implementation 2026-01-01] src/preview.ts:1"], reason: "test",
          refined_statement: claim.text.startsWith(statements.code) ? "TTEH 的 `setVideo` 在预览中调用 `reloadEffect` 重新加载特效。" : "",
          documented_at: "", user_support: claim.user_words === undefined ? "not_applicable" : "user_stated_rule",
          detail_check: claim.text.includes("补充细节") ? (claim.text.startsWith(statements.wrong) ? "contradicted" : "consistent") : "none" };
      }) });
    },
    reconcile: () => Promise.reject(new Error("unexpected reconcile")),
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
  const dreams = join(vaultRoot, "_MemStore", "Dreams");
  const reports = (await readdir(dreams)).filter((name) => name !== "总览.md");
  // Named by the run's local day and the Project's root, not by UTC date and ID.
  expect(reports).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2}-clone-[0-9a-f]{8}\.md$/u)]);
  const reportName = reports[0] ?? "";
  const report = await readFile(join(dreams, reportName), "utf8");
  expect(report).toContain(`clone (\`${project.projectId}\`)`);
  expect(report).toContain("TTEH 的 `setVideo` 在预览中调用 `reloadEffect` 重新加载特效。");
  expect(report).toContain(`收窄前：${statements.code}`);
  expect(report).toContain("需要复核");
  // Global knowledge is tagged so it is not mistaken for this Project's knowledge.
  expect(report).toContain(`〔全局〕${statements.preference}`);
  await expect(access(join(vaultRoot, "Memories"))).rejects.toThrow();

  // The overview lists what dreaming kept across runs, global knowledge first, each item linked to its report.
  const overview = await readFile(join(dreams, "总览.md"), "utf8");
  expect(overview.indexOf("## 全局")).toBeGreaterThan(0);
  expect(overview.indexOf("## 全局")).toBeLessThan(overview.indexOf("## 项目"));
  expect(overview).toContain(`- ${statements.preference}\n  - 用户明确表达 · 来自 `);
  expect(overview).toContain(`- TTEH 的 \`setVideo\` 在预览中调用 \`reloadEffect\` 重新加载特效。\n  - 已用仓库证据验证 · [[${reportName.replace(/\.md$/u, "")}]]`);
  expect(overview).not.toContain(statements.oneOff);

  // Re-rendering replaces a report written under an earlier file name and refreshes the overview.
  const legacy = join(dreams, "2026-01-01-legacy.md");
  await rename(join(dreams, reportName), legacy);
  const legacyDatabase = await openRuntimeDatabase(runtimeRoot);
  try {
    legacyDatabase.prepare("UPDATE dream_runs SET report_path = ? WHERE run_id = ?").run(legacy, runId);
  } finally {
    legacyDatabase.close();
  }
  const rendered = await renderDreamReports({ runtimeRoot, vaultRoot, now, timeZone: configuration.timezone });
  expect(rendered).toMatchObject({ reports: [join(dreams, reportName)], removed: [legacy] });
  expect((await readdir(dreams)).sort()).toEqual([reportName, "总览.md"].sort());
  await expect(renderDreamReports({ runtimeRoot, vaultRoot, now, timeZone: configuration.timezone, runId: "msdream_missing" }))
    .rejects.toThrow(/No completed dream run/u);

  // The Session is never extracted twice, and the schedule creates nothing when no Session is waiting.
  const later = new Date(Date.now() + 4 * 3_600_000).toISOString();
  expect((await scheduleDueDreams({ runtimeRoot, now: later, configuration: { ...configuration, hour: 0 }, allowTemporaryRoots: true })).created).toEqual([]);
});

test("in apply mode a nightly run writes its inject tier as dreaming Memory before reporting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-dream-apply-run-"));
  directories.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await mkdir(vaultRoot, { recursive: true });
  const clone = await workspace(root);
  const project = await resolveProject({ sessionId: "apply-session", path: clone, runtimeRoot });
  if (project.status !== "resolved") throw new Error("Project did not resolve.");
  const events = [
    { eventKind: "UserPromptSubmit", turnId: "t1", payload: { prompt: "以后提 MR 都用 Bits。看看 setVideo 做了什么" } },
    { eventKind: "PostToolUse", turnId: "t1", payload: { toolName: "Bash", cwd: clone, input: { command: "cat src/preview.ts" },
      response: "export function setVideo() { reloadEffect(); }" } },
    { eventKind: "Stop", turnId: "t1", payload: { assistantMessage: "setVideo 会重新加载特效。" } },
    { eventKind: "SessionEnd", payload: { reason: "other" } }
  ] as const;
  for (const [index, event] of events.entries()) {
    await captureEvent({ runtimeRoot, event: {
      schemaVersion: 1, eventId: `msevent_apply_${String(index)}`, deduplicationKey: `apply:${String(index)}`, agent: "codex",
      eventKind: event.eventKind, occurredAt: new Date().toISOString(), projectId: project.projectId, sessionId: "apply-session",
      ...("turnId" in event ? { turnId: event.turnId } : {}), payload: event.payload
    } });
  }
  const now = new Date(Date.now() + 60_000).toISOString();
  const configuration = dreamingConfigurationSchema.parse({ enabled: true, mode: "apply", verify_batch_size: 8 });
  await startDreamRun({ runtimeRoot, projectId: project.projectId, now });
  const model = fakeModel([]);
  const steps: string[] = [];
  for (let step = 0; step < 50; step += 1) {
    const result = await runNextDreamStep({ runtimeRoot, vaultRoot, now, configuration, model, allowTemporaryRoots: true });
    if (result.state === "idle") break;
    steps.push(`${result.stage ?? ""}:${result.detail ?? ""}`);
  }
  expect(steps).toContain("report:applied 2");
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(database.prepare("SELECT authority, scope_kind, lifecycle FROM memory_catalog ORDER BY scope_kind").all())
      .toEqual([{ authority: "agent_derived", scope_kind: "global", lifecycle: "active" }, { authority: "agent_derived", scope_kind: "project", lifecycle: "active" }]);
    expect(database.prepare("SELECT apply_state, COUNT(*) AS n FROM dream_items GROUP BY apply_state ORDER BY apply_state").all())
      .toEqual([{ apply_state: null, n: 2 }, { apply_state: "written", n: 2 }]);
    // Two layers: the statement is what injection shows, the body adds the detail.
    const written = database.prepare("SELECT apply_memory_id FROM dream_items WHERE statement = ? AND apply_state = 'written'").get(statements.code);
    const memory = (await readCanonicalMemory({ vaultRoot, runtimeRoot, memoryId: String(written?.apply_memory_id) }))?.memory;
    const refined = "TTEH 的 `setVideo` 在预览中调用 `reloadEffect` 重新加载特效。";
    expect(memory?.representations.compact.text).toBe(refined);
    expect(memory?.body).toBe(`${refined}\n\n${statements.codeDetail}`);
    expect(memory?.representations.standard.text).toBe(memory?.body);
  } finally {
    database.close();
  }
  const reports = (await readdir(join(vaultRoot, "_MemStore", "Dreams"))).filter((name) => name !== "总览.md");
  const report = await readFile(join(vaultRoot, "_MemStore", "Dreams", reports[0] ?? ""), "utf8");
  expect(report).toContain("## 写入正式记忆 · 2");
  expect(report).toMatch(/### 新建 · 2[\s\S]*→ M:\d+/u);
});

test("a Session belongs to the Project it started in, and later activity is read once more as a new segment", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-dream-segments-"));
  directories.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await mkdir(vaultRoot, { recursive: true });
  const clone = await workspace(root);
  const nested = join(root, "nested");
  await mkdir(nested, { recursive: true });
  const home = await resolveProject({ sessionId: "resolve-home", path: clone, runtimeRoot });
  const elsewhere = await resolveProject({ sessionId: "resolve-elsewhere", path: nested, runtimeRoot });
  if (home.status !== "resolved" || elsewhere.status !== "resolved") throw new Error("Projects did not resolve.");
  const sessionId = "segmented-session";
  const start = Date.now() - 8 * 3_600_000;
  const at = (minutes: number): string => new Date(start + minutes * 60_000).toISOString();
  async function capture(
    id: string, eventKind: "UserPromptSubmit" | "PostToolUse" | "Stop", projectId: string, minutes: number, payload: Record<string, unknown>
  ): Promise<void> {
    await captureEvent({ runtimeRoot, event: {
      schemaVersion: 1, eventId: `msevent_segment_${id}`, deduplicationKey: `segment:${id}`, agent: "claude", eventKind,
      occurredAt: at(minutes), projectId, sessionId, turnId: id, payload
    } });
    const database = await openRuntimeDatabase(runtimeRoot);
    try {
      database.prepare("UPDATE capture_events SET created_at = ? WHERE event_id = ?").run(at(minutes), `msevent_segment_${id}`);
    } finally {
      database.close();
    }
  }
  const chunks: string[] = [];
  const model: DreamModel = {
    extract(request) {
      chunks.push(request.chunk);
      return Promise.resolve({ usage: { tokens: 1, seconds: 1 }, candidates: [] });
    },
    merge: () => Promise.reject(new Error("unexpected merge")),
    verify: () => Promise.reject(new Error("unexpected verify")),
    defend: () => Promise.reject(new Error("unexpected defend")),
    reconcile: () => Promise.reject(new Error("unexpected reconcile"))
  };
  const configuration = dreamingConfigurationSchema.parse({ enabled: true, hour: 0 });
  async function dream(now: string): Promise<void> {
    for (let step = 0; step < 50; step += 1) {
      if ((await runNextDreamStep({ runtimeRoot, vaultRoot, now, configuration, model, allowTemporaryRoots: true })).state === "idle") return;
    }
  }
  async function segment(): Promise<Record<string, unknown> | undefined> {
    const database = await openRuntimeDatabase(runtimeRoot);
    try {
      return database.prepare("SELECT project_id, segment_after, last_event_at FROM dream_sessions WHERE session_id = ?").get(sessionId);
    } finally {
      database.close();
    }
  }

  // The Session starts in the workspace, then `cd`s into another Project; it still belongs to the workspace.
  await capture("p1", "UserPromptSubmit", home.projectId, 0, { prompt: "第一段：看看 setVideo" });
  await capture("t1", "PostToolUse", elsewhere.projectId, 1, { toolName: "Bash", cwd: nested, input: { command: "ls nested" }, response: "ok" });
  await capture("s1", "Stop", elsewhere.projectId, 2, { assistantMessage: "第一段完成" });
  const firstNow = at(2 + 180);
  const scheduled = await scheduleDueDreams({ runtimeRoot, now: firstNow, configuration, allowTemporaryRoots: true });
  expect(scheduled.created).toHaveLength(1);
  expect((await inspectDreams(runtimeRoot, 1))[0]).toMatchObject({ project_id: home.projectId });
  await dream(firstNow);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toContain("第一段：看看 setVideo");
  expect(chunks[0]).toContain("ls nested");
  expect(chunks[0]).toContain("第一段完成");
  expect(await segment()).toMatchObject({ project_id: home.projectId, segment_after: null, last_event_at: at(2) });

  // Activity after the Session was dreamed about is read again later, without the earlier turns.
  await capture("p2", "UserPromptSubmit", elsewhere.projectId, 300, { prompt: "第二段：继续" });
  await capture("s2", "Stop", elsewhere.projectId, 301, { assistantMessage: "第二段完成" });
  const secondNow = at(301 + 180);
  await startDreamRun({ runtimeRoot, projectId: home.projectId, now: secondNow });
  await dream(secondNow);
  expect(chunks).toHaveLength(2);
  expect(chunks[1]).toContain("第二段：继续");
  expect(chunks[1]).toContain("之前的 dreaming 中处理");
  expect(chunks[1]).not.toContain("第一段");
  expect(await segment()).toMatchObject({ project_id: home.projectId, segment_after: at(2), last_event_at: at(301) });

  // Nothing new: no further extraction.
  await startDreamRun({ runtimeRoot, projectId: home.projectId, now: at(301 + 200) });
  await dream(at(301 + 200));
  expect(chunks).toHaveLength(2);
});

test("connection failures cost a chunk less than failures of the call itself", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-dream-outage-"));
  directories.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const folder = join(root, "notes");
  await mkdir(vaultRoot, { recursive: true });
  await mkdir(folder, { recursive: true });
  const project = await resolveProject({ sessionId: "resolve", path: folder, runtimeRoot });
  if (project.status !== "resolved") throw new Error("Project did not resolve.");
  const start = Date.now() - 8 * 3_600_000;
  for (const [index, sessionId] of ["outage", "broken"].entries()) {
    await captureEvent({ runtimeRoot, event: {
      schemaVersion: 1, eventId: `msevent_outage_${String(index)}`, deduplicationKey: `outage:${String(index)}`, agent: "codex",
      eventKind: "UserPromptSubmit", occurredAt: new Date(start).toISOString(), projectId: project.projectId, sessionId, turnId: "t1",
      payload: { prompt: `${sessionId} 会话` }
    } });
  }
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare("UPDATE capture_events SET created_at = ?").run(new Date(start).toISOString());
  } finally {
    database.close();
  }
  // The outage Session's chunk times out; the broken one's model output is invalid.
  const model: DreamModel = {
    extract: (request) => Promise.reject(new DreamModelError(request.chunk.includes("outage") ? "timeout" : "schema_invalid", "failed", "ERROR: Reconnecting... waiting for network")),
    merge: () => Promise.reject(new Error("unexpected merge")),
    verify: () => Promise.reject(new Error("unexpected verify")),
    defend: () => Promise.reject(new Error("unexpected defend")),
    reconcile: () => Promise.reject(new Error("unexpected reconcile"))
  };
  const configuration = dreamingConfigurationSchema.parse({ enabled: true });
  let clock = Date.now();
  await startDreamRun({ runtimeRoot, projectId: project.projectId, now: new Date(clock).toISOString() });
  async function chunks(): Promise<Record<string, string>> {
    const db = await openRuntimeDatabase(runtimeRoot);
    try {
      return Object.fromEntries(db.prepare("SELECT session_id, state, attempt_count FROM dream_chunks").all()
        .map((row) => [String(row.session_id), `${String(row.state)}:${String(row.attempt_count)}`]));
    } finally {
      db.close();
    }
  }
  // Each step comes after the longest retry backoff. Step 0 selects; the broken chunk is tried first (session order).
  for (let step = 0; step < 52; step += 1) {
    clock += 61 * 60_000;
    await runNextDreamStep({ runtimeRoot, vaultRoot, now: new Date(clock).toISOString(), configuration, model, allowTemporaryRoots: true });
    if (step === 2) {
      // After two failures in a row the run waits ten minutes, not five.
      const early = await runNextDreamStep({ runtimeRoot, vaultRoot, now: new Date(clock + 6 * 60_000).toISOString(), configuration, model, allowTemporaryRoots: true });
      expect(early.state).toBe("idle");
    }
    if (step === 3) expect(await chunks()).toEqual({ broken: "failed:48", outage: "pending:0" });
    if (step === 50) expect((await chunks()).outage).toBe("pending:47");
  }
  expect((await chunks()).outage).toBe("failed:48");
  const [run] = await inspectDreams(runtimeRoot, 1);
  expect(run?.stats).toMatchObject({ errors: 51 });
  expect(await readFile(join(runtimeRoot, "state", "dreaming", String(run?.run_id), "errors.log"), "utf8")).toContain("extract model_timeout");
});

test("remember extract hands its selection to dreaming, which verifies and writes what survives", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-dream-requested-"));
  directories.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await mkdir(vaultRoot, { recursive: true });
  const clone = await workspace(root);
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(join(runtimeRoot, "config.toml"), "schema_version = 1\n\n[dreaming]\nenabled = true\nmode = \"apply\"\n");
  const project = await resolveProject({ sessionId: "requested-session", path: clone, runtimeRoot });
  if (project.status !== "resolved") throw new Error("Project did not resolve.");
  const notes = join(root, "notes.md");
  await writeFile(notes, "奥德赛的归航奖励只在成功归航时发放。\n");
  for (const [index, event] of [
    { eventKind: "UserPromptSubmit", turnId: "t1", payload: { prompt: "这局奥德赛归航后才拿到资源奖励" } },
    { eventKind: "Stop", turnId: "t1", payload: { assistantMessage: "记下了：归航资源奖励只在归航成功时发放。" } }
  ].entries()) {
    await captureEvent({ runtimeRoot, event: {
      schemaVersion: 1, eventId: `msevent_requested_${String(index)}`, deduplicationKey: `requested:${String(index)}`, agent: "codex",
      eventKind: event.eventKind as "UserPromptSubmit" | "Stop", occurredAt: new Date().toISOString(), projectId: project.projectId,
      sessionId: "requested-session", turnId: event.turnId, payload: event.payload
    } });
  }
  const now = new Date().toISOString();
  const chunks: string[] = [];
  const model: DreamModel = {
    extract(request) {
      chunks.push(request.chunk);
      expect(request.requested).toBe(true);
      const statement = request.chunk.includes("### T01 FILE") ? "奥德赛的商港先补食物再补木料。" : "奥德赛的归航资源奖励只在归航成功时发放。";
      return Promise.resolve({ usage: { tokens: 1, seconds: 1 }, candidates: [{ statement,
        claim_type: "external_system", scope: "project", explicit_user: false, turn_refs: ["T01"], quote: "", check_hints: [], detail: "" }] });
    },
    merge: () => Promise.reject(new Error("unexpected merge")),
    verify: (request) => Promise.resolve({ usage: { tokens: 1, seconds: 1 }, results: request.claims.map((claim): Verdict => ({
      id: claim.id, claim_type: "external_system", durability: "long_term", scope: "project", subsystem: "Odyssey", verdict: "not_repo_verifiable",
      branch: "", evidence: [], reason: "external game rule", refined_statement: "", documented_at: "", user_support: "not_applicable",
      detail_check: "none" })) }),
    defend: () => Promise.reject(new Error("unexpected defend")),
    reconcile: (request) => Promise.resolve({ usage: { tokens: 1, seconds: 1 },
      results: request.items.map((item) => ({ id: item.id, decision: "new" as const, target: "", merged_statement: "", reason: "different fact" })) })
  };
  const configuration = dreamingConfigurationSchema.parse({ enabled: true, mode: "apply" });
  const drain = async () => {
    for (let step = 0; step < 50; step += 1) {
      if ((await runNextDreamStep({ runtimeRoot, vaultRoot, now, configuration, model, allowTemporaryRoots: true })).state === "idle") return;
    }
  };
  // The current Session is selected even after dreaming took its events over.
  expect(await handOffCaptureToDreaming({ runtimeRoot, now: new Date(Date.now() + 60_000).toISOString(), minimumAgeMilliseconds: 0 })).toBe(2);
  const accepted = await rememberExtract({ runtimeRoot, vaultRoot, path: clone, source: "current-session", scope: "project", startup: "auto",
    preview: false, requestedAt: now }) as Record<string, unknown>;
  expect(accepted).toMatchObject({ state: "queued", pipeline: "dreaming", applies: true });
  expect(String(accepted.run_id)).toMatch(/^msdream_/u);
  await drain();
  expect(chunks[0]).toContain("这局奥德赛归航后才拿到资源奖励");
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(database.prepare("SELECT tier, tier_reason, apply_state FROM dream_items").get())
      .toMatchObject({ tier: "inject", tier_reason: "user_requested", apply_state: "written" });
    expect(database.prepare("SELECT authority, scope_kind FROM memory_catalog").all()).toEqual([{ authority: "agent_derived", scope_kind: "project" }]);
    // No Luna operation is queued while dreaming is enabled.
    expect(database.prepare("SELECT COUNT(*) AS n FROM luna_operations").get()).toMatchObject({ n: 0 });
  } finally {
    database.close();
  }
  // A file can be requested too, and a global request writes globally; the file body is material the extractor reads.
  const global = await rememberExtract({ runtimeRoot, vaultRoot, path: clone, source: `file:${notes}`, scope: "global", startup: "auto",
    preview: false, requestedAt: now }) as Record<string, unknown>;
  expect(global).toMatchObject({ pipeline: "dreaming" });
  await drain();
  expect(chunks[1]).toContain("### T01 FILE");
  expect(chunks[1]).toContain("奥德赛的归航奖励只在成功归航时发放。");
  const after = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(after.prepare("SELECT scope_kind, COUNT(*) AS n FROM memory_catalog GROUP BY scope_kind ORDER BY scope_kind").all())
      .toEqual([{ scope_kind: "global", n: 1 }, { scope_kind: "project", n: 1 }]);
  } finally {
    after.close();
  }
});

test("dreaming is disabled by default and never schedules without configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-dream-off-"));
  directories.push(root);
  const configuration = dreamingConfigurationSchema.parse({});
  expect(configuration).toMatchObject({ enabled: false, mode: "shadow", hour: 3, verify_effort: "high", extract_effort: "medium" });
  expect((await scheduleDueDreams({ runtimeRoot: join(root, "runtime"), now: new Date().toISOString(), configuration })).created).toEqual([]);
  expect(dreamingConfigurationSchema.parse({ mode: "apply" }).mode).toBe("apply");
  expect(() => dreamingConfigurationSchema.parse({ mode: "live" })).toThrow();
});
