import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { applyBatch, loadApplyItems, statementKey } from "../../../src/dreaming/apply.js";
import type { DreamModel, ReconcileItem } from "../../../src/dreaming/model.js";
import { applyCompletedRuns, rollbackDreamMemories } from "../../../src/dreaming/run.js";
import { resolveProject } from "../../../src/projects/index.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { readCanonicalMemory, writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const texts = {
  code: "TTEH 的 `setVideo` 会重新加载特效并重置运行时状态。",
  sameAsHuman: "以后提 MR 都用 Bits。",
  againstHuman: "提 MR 时不要用 Bits。",
  userRule: "面向用户的回复使用简体中文。",
  globalTool: "`botmux history` 对话题会话只读取话题内历史。"
};

/** Reconciles like the model would: Human duplicates and conflicts by keyword, earlier items of the batch by key. */
function fakeModel(calls: ReconcileItem[][]): DreamModel {
  const unused = () => Promise.reject(new Error("unexpected call"));
  return {
    extract: unused, merge: unused, verify: unused, defend: unused,
    reconcile(request) {
      calls.push([...request.items]);
      return Promise.resolve({ usage: { tokens: 7, seconds: 1 }, results: request.items.map((item) => {
        const same = item.candidates.find((candidate) => candidate.id.startsWith("H") && statementKey(candidate.text) === statementKey(item.text));
        if (same !== undefined) return { id: item.id, decision: "duplicate" as const, target: same.id, reason: "already stated" };
        const human = item.candidates.find((candidate) => candidate.id.startsWith("H") && candidate.text.includes("Bits"));
        const earlier = item.candidates.find((candidate) => candidate.id.startsWith("N") && statementKey(candidate.text) === statementKey(item.text));
        if (human !== undefined && item.text.includes("Bits")) return { id: item.id, decision: item.text.includes("不要") ? "conflicts" as const : "duplicate" as const, target: human.id, reason: "test" };
        if (earlier !== undefined) return { id: item.id, decision: "duplicate" as const, target: earlier.id, reason: "same" };
        const corrected = item.candidates.find((candidate) => candidate.id.startsWith("D"));
        if (corrected !== undefined && item.text.includes("（更正）")) return { id: item.id, decision: "refines" as const, target: corrected.id, reason: "corrects" };
        return { id: item.id, decision: "new" as const, target: "", reason: "new" };
      }) });
    }
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memstore-dream-apply-"));
  directories.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const folder = join(root, "project");
  await mkdir(folder, { recursive: true });
  await mkdir(vaultRoot, { recursive: true });
  const project = await resolveProject({ sessionId: "resolve", path: folder, runtimeRoot });
  if (project.status !== "resolved") throw new Error("Project did not resolve.");
  await writeFile(join(runtimeRoot, "config.toml"), "schema_version = 1\n");
  const human = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614175001", revisionId: "msrev_123e4567-e89b-42d3-a456-426614175011",
    body: "用户要求提 MR 时使用 Bits。", scope: { kind: "project", projectId: project.projectId }
  });
  await writeCanonicalMemory({ vaultRoot, runtimeRoot, actor: "human", memory: human });
  return { runtimeRoot, vaultRoot, projectId: project.projectId, humanId: human.memoryId };
}

async function addRun(runtimeRoot: string, projectId: string, runId: string, createdAt: string,
  items: readonly { id: string; text: string; tier?: string; scope?: string; claimType?: string; explicit?: boolean; userSupport?: string }[]): Promise<void> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare(
      `INSERT INTO dream_runs(run_id, project_id, scheduled_for, mode, stage, window_end, created_at, updated_at)
       VALUES (?, ?, ?, 'shadow', 'completed', ?, ?, ?)`
    ).run(runId, projectId, createdAt.slice(0, 10), createdAt, createdAt, createdAt);
    for (const item of items) {
      database.prepare(
        `INSERT INTO dream_items(item_id, run_id, statement, claim_type, scope, member_ids_json, session_ids_json, explicit_user,
           first_seen_at, check_hints_json, source_paths_json, verdict_json, tier, tier_reason)
         VALUES (?, ?, ?, ?, ?, '[]', '["session-1"]', ?, ?, '[]', '[]', ?, ?, 'confirmed')`
      ).run(item.id, runId, item.text, item.claimType ?? "code_state", item.scope ?? "project", item.explicit === true ? 1 : 0, createdAt,
        JSON.stringify({ verdict: "confirmed", subsystem: "preview", evidence: ["tteh@abc1234567 [R1-implementation 2026-10-01] src/preview.ts:1 reload"],
          user_support: item.userSupport ?? "not_applicable" }), item.tier ?? "inject");
    }
  } finally {
    database.close();
  }
}

async function catalog(runtimeRoot: string): Promise<Record<string, string>> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    return Object.fromEntries(database.prepare("SELECT memory_id, authority, scope_kind, lifecycle FROM memory_catalog").all()
      .map((row) => [String(row.memory_id), `${String(row.authority)}/${String(row.scope_kind)}/${String(row.lifecycle)}`]));
  } finally {
    database.close();
  }
}

test("apply writes inject items as dreaming Memory, defers to Human-authored Memory, and rolls back", async () => {
  const { runtimeRoot, vaultRoot, projectId, humanId } = await fixture();
  await addRun(runtimeRoot, projectId, "msdream_00000001-0000-4000-8000-000000000001", "2026-10-16T19:00:00.000Z", [
    { id: "msdi_code", text: texts.code },
    { id: "msdi_code_again", text: `${texts.code} ` },
    { id: "msdi_same_as_human", text: texts.sameAsHuman, claimType: "preference", explicit: true, userSupport: "user_stated_rule" },
    { id: "msdi_against_human", text: texts.againstHuman, claimType: "preference" },
    { id: "msdi_user_rule", text: texts.userRule, scope: "global", claimType: "preference", explicit: true, userSupport: "user_stated_rule" },
    { id: "msdi_global_tool", text: texts.globalTool, scope: "global", claimType: "workflow_process" },
    { id: "msdi_pool", text: "只进可搜索池的条目。", tier: "pool" }
  ]);
  const calls: ReconcileItem[][] = [];
  const request = { runtimeRoot, vaultRoot, now: "2026-10-17T00:00:00.000Z", model: fakeModel(calls), timeZone: "Asia/Shanghai", from: "2026-10-16T00:00:00.000Z" };
  const before = await catalog(runtimeRoot);

  // A preview decides everything and writes nothing.
  const preview = await applyCompletedRuns({ ...request, preview: true });
  expect(Object.fromEntries(preview.outcomes.map((outcome) => [outcome.itemId, outcome.state]))).toMatchObject({
    msdi_code: "written", msdi_same_as_human: "duplicate_human", msdi_against_human: "conflict_human", msdi_user_rule: "written"
  });
  expect(await catalog(runtimeRoot)).toEqual(before);
  // The candidate the model compares with is the Human Memory on the same topic.
  expect(calls[0]?.find((item) => item.text === texts.sameAsHuman)?.candidates.map((candidate) => candidate.id)).toContain("H1");

  const applied = await applyCompletedRuns({ ...request, preview: false });
  const states = Object.fromEntries(applied.outcomes.map((outcome) => [outcome.itemId, outcome]));
  expect(Object.fromEntries(Object.entries(states).map(([id, outcome]) => [id, outcome.state]))).toEqual({
    msdi_code: "written", msdi_code_again: "observed", msdi_same_as_human: "duplicate_human", msdi_against_human: "conflict_human",
    msdi_user_rule: "written", msdi_global_tool: "written"
  });
  expect(states.msdi_code_again?.memoryId).toBe(states.msdi_code?.memoryId);
  expect(states.msdi_same_as_human?.memoryId).toBe(humanId);
  const written = await catalog(runtimeRoot);
  // The user's lasting rule is global; a global tool fact from one Project stays with that Project.
  expect(written[String(states.msdi_user_rule?.memoryId)]).toBe("agent_derived/global/active");
  expect(written[String(states.msdi_global_tool?.memoryId)]).toBe("agent_derived/project/active");
  expect(written[humanId]).toBe("human_authored/project/active");
  const code = await readCanonicalMemory({ vaultRoot, runtimeRoot, memoryId: String(states.msdi_code?.memoryId) });
  expect(code?.memory).toMatchObject({
    authority: "agent_derived", originKind: "model_extraction", policyVersion: "dreaming-v1", primaryCategory: "durable_reference",
    applicability: { summary: "preview" }, representations: { compact: { validated: true } }
  });
  expect(code?.memory.provenance).toEqual(expect.arrayContaining([
    "dream:msdream_00000001-0000-4000-8000-000000000001:msdi_code", "session:session-1", expect.stringMatching(/^evidence:tteh@abc1234567/u)
  ]));
  // Applying again finds nothing new.
  expect((await applyCompletedRuns({ ...request, preview: false })).outcomes).toEqual([]);

  // A later run that finds the statement wrong marks the Memory review_due, which stops its injection.
  await addRun(runtimeRoot, projectId, "msdream_00000002-0000-4000-8000-000000000002", "2026-10-18T19:00:00.000Z", [
    { id: "msdi_code_wrong", text: texts.code, tier: "review" }
  ]);
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const items = loadApplyItems(database, "i.item_id = ?", "msdi_code_wrong");
    const review = await applyBatch({ database, vaultRoot, runtimeRoot, items, model: fakeModel(calls), now: "2026-10-19T00:00:00.000Z", preview: false });
    expect(review.outcomes).toEqual([expect.objectContaining({ state: "review_due", memoryId: states.msdi_code?.memoryId })]);
  } finally {
    database.close();
  }
  expect((await readCanonicalMemory({ vaultRoot, runtimeRoot, memoryId: String(states.msdi_code?.memoryId) }))?.memory.validity.state).toBe("review_due");

  // Rollback previews by default, then archives only dreaming Memory.
  expect((await rollbackDreamMemories({ runtimeRoot, vaultRoot, now: "2026-10-19T01:00:00.000Z", apply: false })).memories).toHaveLength(3);
  await rollbackDreamMemories({ runtimeRoot, vaultRoot, now: "2026-10-19T01:00:00.000Z", apply: true });
  const rolledBack = await catalog(runtimeRoot);
  expect(Object.values(rolledBack).filter((value) => value.startsWith("agent_derived")).every((value) => value.endsWith("/archived"))).toBe(true);
  expect(rolledBack[humanId]).toBe("human_authored/project/active");
  // A rolled-back statement is not written again.
  await addRun(runtimeRoot, projectId, "msdream_00000003-0000-4000-8000-000000000003", "2026-10-19T19:00:00.000Z", [
    { id: "msdi_code_later", text: texts.code }
  ]);
  const later = await applyCompletedRuns({ ...request, preview: false, runId: "msdream_00000003-0000-4000-8000-000000000003" });
  expect(later.outcomes).toEqual([expect.objectContaining({ state: "skipped", reason: "rolled_back_or_archived" })]);
  expect(await readFile(join(vaultRoot, "_MemStore", "Projects", `${projectId}.md`), "utf8").catch(() => "")).not.toContain("undefined");
});

test("a later, more precise statement revises the dreaming Memory it corrects", async () => {
  const { runtimeRoot, vaultRoot, projectId } = await fixture();
  await addRun(runtimeRoot, projectId, "msdream_00000004-0000-4000-8000-000000000004", "2026-10-16T19:00:00.000Z", [{ id: "msdi_first", text: texts.code }]);
  const request = { runtimeRoot, vaultRoot, now: "2026-10-17T00:00:00.000Z", model: fakeModel([]), timeZone: "Asia/Shanghai", preview: false };
  const [first] = (await applyCompletedRuns({ ...request, runId: "msdream_00000004-0000-4000-8000-000000000004" })).outcomes;
  const corrected = `${texts.code}（更正）只在 classic 预览路径成立。`;
  await addRun(runtimeRoot, projectId, "msdream_00000005-0000-4000-8000-000000000005", "2026-10-18T19:00:00.000Z", [{ id: "msdi_second", text: corrected }]);
  const [second] = (await applyCompletedRuns({ ...request, now: "2026-10-19T00:00:00.000Z", runId: "msdream_00000005-0000-4000-8000-000000000005" })).outcomes;
  expect(second).toMatchObject({ state: "revised", memoryId: first?.memoryId });
  const memory = (await readCanonicalMemory({ vaultRoot, runtimeRoot, memoryId: String(first?.memoryId) }))?.memory;
  expect(memory?.body).toBe(corrected);
  expect(memory?.provenance.slice(0, 1)).toEqual(["dream:msdream_00000005-0000-4000-8000-000000000005:msdi_second"]);
  expect(memory?.provenance).toContain("dream:msdream_00000004-0000-4000-8000-000000000004:msdi_first");
  // The corrected statement is what dreaming recognises from now on.
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(database.prepare("SELECT statement_key, observation_count FROM dream_memories").get()).toMatchObject({ statement_key: statementKey(corrected), observation_count: 2 });
  } finally {
    database.close();
  }
});

test("knowledge a user-wide instruction file already states is not written", async () => {
  const { runtimeRoot, vaultRoot, projectId } = await fixture();
  const instructions = join(vaultRoot, "..", "CLAUDE.md");
  await writeFile(instructions, "# 全局规则\n\n## Subagent\n\n- 评测类 subagent 一律用 Codex，不允许用 Claude。\n- 其他规则。\n");
  await addRun(runtimeRoot, projectId, "msdream_00000006-0000-4000-8000-000000000006", "2026-10-16T19:00:00.000Z", [
    { id: "msdi_rule", text: "评测类 subagent 一律用 Codex，不允许用 Claude。", scope: "global", claimType: "preference", explicit: true, userSupport: "user_stated_rule" }
  ]);
  const [outcome] = (await applyCompletedRuns({ runtimeRoot, vaultRoot, now: "2026-10-17T00:00:00.000Z", model: fakeModel([]), timeZone: "Asia/Shanghai",
    preview: false, runId: "msdream_00000006-0000-4000-8000-000000000006", instructionFiles: [instructions] })).outcomes;
  expect(outcome?.state).toBe("duplicate_human");
  expect(outcome?.reason).toContain("CLAUDE.md");
  expect(outcome?.memoryId).toBeUndefined();
  expect(Object.values(await catalog(runtimeRoot)).filter((value) => value.startsWith("agent_derived"))).toEqual([]);
});

test("apply waits while the configuration is not current, and a later apply retries failed items", async () => {
  const { runtimeRoot, vaultRoot, projectId } = await fixture();
  await addRun(runtimeRoot, projectId, "msdream_00000007-0000-4000-8000-000000000007", "2026-10-16T19:00:00.000Z", [{ id: "msdi_wait", text: texts.code }]);
  const request = { runtimeRoot, vaultRoot, now: "2026-10-17T00:00:00.000Z", model: fakeModel([]), timeZone: "Asia/Shanghai", preview: false,
    runId: "msdream_00000007-0000-4000-8000-000000000007" };
  // An unreadable configuration defers the whole batch before anything is written.
  await mkdir(join(vaultRoot, "_MemStore"), { recursive: true });
  await writeFile(join(vaultRoot, "_MemStore", "policy.toml"), "schema_version = 1\n");
  await writeFile(join(runtimeRoot, "config.toml"), "schema_version = 1\n[adapters]\nhook_display = \"not-a-mode\"\n");
  await expect(applyCompletedRuns(request)).rejects.toThrow(/apply waits/u);
  expect(Object.values(await catalog(runtimeRoot)).filter((value) => value.startsWith("agent_derived"))).toEqual([]);
  // Without configuration documents there is no policy to honour, so apply proceeds.
  await rm(join(vaultRoot, "_MemStore", "policy.toml"));
  await writeFile(join(runtimeRoot, "config.toml"), "schema_version = 1\n");
  // An item recorded as failed is retried.
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare("UPDATE dream_items SET apply_state = 'failed', apply_reason = 'earlier failure' WHERE item_id = 'msdi_wait'").run();
  } finally {
    database.close();
  }
  expect((await applyCompletedRuns(request)).outcomes).toEqual([expect.objectContaining({ itemId: "msdi_wait", state: "written" })]);
});
