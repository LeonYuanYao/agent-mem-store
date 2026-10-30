import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { captureEvent } from "../../../src/capture/index.js";
import { dreamingConfigurationSchema } from "../../../src/dreaming/config.js";
import { DreamModelError, type DreamModel } from "../../../src/dreaming/model.js";
import { firstPromptRecentWork, runNextRecentWorkStep } from "../../../src/dreaming/recent-work.js";
import { resolveProject } from "../../../src/projects/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// ADR-0164: an idle Session's work becomes a short note for the next Session of the Project.
test("an idle Session gets a note that the next Session's first prompt receives", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-recent-work-"));
  directories.push(root);
  const runtimeRoot = join(root, "runtime");
  const folder = join(root, "project");
  await mkdir(folder, { recursive: true });
  const project = await resolveProject({ sessionId: "work-a", path: folder, runtimeRoot });
  if (project.status !== "resolved") throw new Error("Project did not resolve.");
  let sequence = 0;
  const capture = (sessionId: string, eventKind: "UserPromptSubmit" | "Stop", payload: Record<string, unknown>) => captureEvent({ runtimeRoot, event: {
    schemaVersion: 1, eventId: `msevent_work_${String(sequence)}`, deduplicationKey: `work:${String(sequence++)}`, agent: "codex",
    eventKind, occurredAt: new Date().toISOString(), projectId: project.projectId, sessionId, payload
  } });
  await capture("work-a", "UserPromptSubmit", { prompt: "把预览的重载逻辑改成按需加载" });
  await capture("work-a", "Stop", { assistantMessage: "已改好 src/preview.ts，还差单元测试。" });
  await capture("work-chat", "UserPromptSubmit", { prompt: "TypeScript 的 satisfies 是什么" });
  const calls: string[] = [];
  let failNext = false;
  const model = {
    summarizeWork(request: { transcript: string }) {
      calls.push(request.transcript);
      if (failNext) { failNext = false; return Promise.reject(new DreamModelError("network", "offline")); }
      const work = request.transcript.includes("重载逻辑");
      return Promise.resolve({ carryOver: work, summary: work ? "在把预览重载改成按需加载：src/preview.ts 已改，下一步补单元测试。" : "", usage: { tokens: 9, seconds: 1 } });
    }
  } as unknown as DreamModel;
  const configuration = dreamingConfigurationSchema.parse({ enabled: true });
  const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  const step = (minutes: number) => runNextRecentWorkStep({ runtimeRoot, now: at(minutes), configuration, model });

  // Not idle long enough yet.
  await expect(step(5)).resolves.toEqual({ state: "idle" });
  // The newest idle Session first; a plain question has nothing to carry over.
  const first = await step(30);
  const second = await step(30);
  expect([first, second].map((result) => result.state).sort()).toEqual(["noted", "nothing_to_carry"]);
  await expect(step(31)).resolves.toEqual({ state: "idle" });

  // A new Session's first prompt gets the note; the Session it came from and later prompts do not.
  await capture("work-b", "UserPromptSubmit", { prompt: "继续" });
  const recent = await firstPromptRecentWork({ runtimeRoot, projectId: project.projectId, sessionId: "work-b", now: at(40), configuration });
  expect(recent?.count).toBe(1);
  expect(recent?.text).toContain("下一步补单元测试");
  expect(recent?.text).toMatch(/^<memstore-recent-work>/u);
  await expect(firstPromptRecentWork({ runtimeRoot, projectId: project.projectId, sessionId: "work-a", now: at(40), configuration }))
    .resolves.toBeUndefined();
  await capture("work-b", "UserPromptSubmit", { prompt: "再看看测试" });
  await expect(firstPromptRecentWork({ runtimeRoot, projectId: project.projectId, sessionId: "work-b", now: at(40), configuration }))
    .resolves.toBeUndefined();

  // A failed call is retried after its backoff, not on the next step.
  failNext = true;
  await expect(step(70)).resolves.toMatchObject({ state: "failed", sessionId: "work-b" });
  await expect(step(80)).resolves.toEqual({ state: "idle" });
  await expect(step(110)).resolves.toMatchObject({ sessionId: "work-b" });

  // Off by configuration.
  const off = dreamingConfigurationSchema.parse({ enabled: true, recent_work: false });
  await expect(runNextRecentWorkStep({ runtimeRoot, now: at(200), configuration: off, model })).resolves.toEqual({ state: "idle" });
  await expect(firstPromptRecentWork({ runtimeRoot, projectId: project.projectId, sessionId: "work-c", now: at(200), configuration: off }))
    .resolves.toBeUndefined();
});

test("only the Sessions whose notes could still be injected get one", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-recent-work-latest-"));
  directories.push(root);
  const runtimeRoot = join(root, "runtime");
  const folder = join(root, "project");
  await mkdir(folder, { recursive: true });
  const project = await resolveProject({ sessionId: "old", path: folder, runtimeRoot });
  if (project.status !== "resolved") throw new Error("Project did not resolve.");
  for (const [index, sessionId] of ["old", "middle", "new"].entries()) {
    await captureEvent({ runtimeRoot, event: { schemaVersion: 1, eventId: `msevent_latest_${String(index)}`, deduplicationKey: `latest:${String(index)}`,
      agent: "claude", eventKind: "UserPromptSubmit", occurredAt: new Date().toISOString(), projectId: project.projectId, sessionId,
      payload: { prompt: `${sessionId} 会话的工作` } } });
    await new Promise((done) => setTimeout(done, 5));
  }
  const noted: string[] = [];
  const model = { summarizeWork: (request: { transcript: string }) => {
    noted.push(request.transcript.includes("old") ? "old" : request.transcript.includes("middle") ? "middle" : "new");
    return Promise.resolve({ carryOver: true, summary: "进行中", usage: { tokens: 1, seconds: 1 } });
  } } as unknown as DreamModel;
  const configuration = dreamingConfigurationSchema.parse({ enabled: true });
  const now = new Date(Date.now() + 30 * 60_000).toISOString();
  for (let step = 0; step < 4; step += 1) await runNextRecentWorkStep({ runtimeRoot, now, configuration, model });
  // Two newer notes already cover the Project: the oldest Session is never summarized.
  expect(noted).toEqual(["new", "middle"]);
});
