import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { dreamDigest } from "../../../src/dreaming/digest.js";
import {
  dismissInstructionSuggestion,
  readInstructionSuggestions,
  refreshInstructionSuggestions
} from "../../../src/dreaming/instructions.js";
import type { DreamModel, InstructionJudgment } from "../../../src/dreaming/model.js";
import { readCanonicalMemory, writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

// ADR-0181: Global rules that hold in every session are suggested for the instruction files.
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const chinese = makeCanonicalMemory({ memoryId: "msmem_123e4567-e89b-42d3-a456-426614177001", revisionId: "msrev_123e4567-e89b-42d3-a456-426614177011",
  body: "默认用中文回复用户；代码和命令保持原样。", scope: { kind: "global" } });
const proxy = makeCanonicalMemory({ memoryId: "msmem_123e4567-e89b-42d3-a456-426614177002", revisionId: "msrev_123e4567-e89b-42d3-a456-426614177012",
  body: "没有用户同意时不要碰代理和 VPS 配置。", scope: { kind: "global" } });
const devbox = makeCanonicalMemory({ memoryId: "msmem_123e4567-e89b-42d3-a456-426614177003", revisionId: "msrev_123e4567-e89b-42d3-a456-426614177013",
  body: "排查 devbox 故障时先登录检查进程和内存。", scope: { kind: "global" } });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memstore-instructions-"));
  directories.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(vaultRoot, { recursive: true });
  await writeFile(join(runtimeRoot, "config.toml"), "schema_version = 1\n");
  for (const memory of [chinese, proxy, devbox]) await writeCanonicalMemory({ vaultRoot, runtimeRoot, actor: "human", memory });
  const claude = join(root, ".claude", "CLAUDE.md");
  const codex = join(root, ".codex", "AGENTS.md");
  await mkdir(join(root, ".claude"));
  await mkdir(join(root, ".codex"));
  await writeFile(claude, "# 全局规则\n\n## 不要碰代理\n\n没有同意不要碰代理配置。\n");
  await writeFile(codex, "# Global\n\n## Proxy\n\nDo not touch proxy settings without consent.\n");
  return { runtimeRoot, vaultRoot, claude, codex };
}

/** Judges the Chinese rule missing everywhere, the proxy rule present, the devbox note not universal. */
function judgeModel(calls: { rules: string[] }[], fail = false): Pick<DreamModel, "judgeInstructions"> {
  return {
    judgeInstructions: (request) => {
      calls.push({ rules: request.rules.map((rule) => rule.text) });
      if (fail) return Promise.reject(new Error("network down"));
      const results: InstructionJudgment[] = request.rules.map((rule) => {
        const universal = !rule.text.includes("devbox");
        const missing = rule.text.includes("中文");
        return { id: rule.id, applies_everywhere: universal, reason: "test",
          files: request.files.map((file) => ({ file: file.id, covered: !(universal && missing),
            merge_into: universal && missing && file.path.includes(".codex") ? "Personality and Behavior" : "",
            proposal: universal && missing ? `${file.path.includes(".codex") ? "Codex" : "Claude Code"}: reply in Chinese` : "" })) };
      });
      return Promise.resolve({ results, usage: { tokens: 10, seconds: 1 } });
    }
  };
}

test("only a rule for every session that a file lacks is suggested, once per change of input", async () => {
  const { runtimeRoot, vaultRoot, claude, codex } = await fixture();
  const calls: { rules: string[] }[] = [];
  const base = { runtimeRoot, vaultRoot, files: [claude, codex], model: judgeModel(calls) };
  const first = await refreshInstructionSuggestions({ ...base, now: "2026-11-20T03:00:00.000Z" });
  expect(first.outcome).toBe("judged");
  expect(first.state.suggestions.map((suggestion) => suggestion.memoryId)).toEqual([chinese.memoryId]);
  expect(first.state.suggestions[0]?.files).toEqual([
    { path: claude, mergeInto: "", text: "Claude Code: reply in Chinese" },
    { path: codex, mergeInto: "Personality and Behavior", text: "Codex: reply in Chinese" }
  ]);

  // Nothing changed: no model call.
  expect((await refreshInstructionSuggestions({ ...base, now: "2026-11-20T04:00:00.000Z" })).outcome).toBe("current");
  expect(calls).toHaveLength(1);

  // An edited file is judged again; the suggestion keeps when it was first made.
  await writeFile(codex, "# Global\n\n## Proxy\n\nDo not touch proxy settings without consent.\n\nBe concise.\n");
  const second = await refreshInstructionSuggestions({ ...base, now: "2026-11-21T03:00:00.000Z" });
  expect(second.outcome).toBe("judged");
  expect(calls).toHaveLength(2);
  expect(second.state.suggestions[0]?.firstSuggestedAt).toBe("2026-11-20T03:00:00.000Z");

  // The digest lists a suggestion in the window it was first made, and not again.
  const ref = (await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId: chinese.memoryId }))?.memory.memoryRef;
  const day = await dreamDigest({ runtimeRoot, vaultRoot, since: "2026-11-19T03:00:00.000Z", now: "2026-11-20T03:30:00.000Z", timeZone: "Asia/Shanghai" });
  expect(day.instructionSuggestions).toBe(1);
  expect(day.text).toContain("MemStore 11-20：dreaming 没有改动记忆。");
  expect(day.text).toContain(`- M:${String(ref)} 默认用中文回复用户`);
  expect(day.text).toContain(`写进 \`${codex}\`（并入「Personality and Behavior」）：Codex: reply in Chinese`);
  const next = await dreamDigest({ runtimeRoot, vaultRoot, since: "2026-11-20T03:30:00.000Z", now: "2026-11-21T03:30:00.000Z", timeZone: "Asia/Shanghai" });
  expect(next.instructionSuggestions).toBe(0);
  expect(next.text).toBe("MemStore 11-21：dreaming 没有改动记忆。");

  // A dismissed rule is neither suggested nor sent to the judge again.
  await dismissInstructionSuggestion({ runtimeRoot, memoryRef: Number(ref), now: "2026-11-21T05:00:00.000Z" });
  expect((await readInstructionSuggestions(runtimeRoot)).suggestions).toEqual([]);
  const third = await refreshInstructionSuggestions({ ...base, now: "2026-11-22T03:00:00.000Z" });
  expect(third.outcome).toBe("judged");
  expect(calls.at(-1)?.rules.some((text) => text.includes("中文"))).toBe(false);
  expect(third.state.suggestions).toEqual([]);
});

test("a failed judgment is recorded and retried the next night, never thrown", async () => {
  const { runtimeRoot, vaultRoot, claude, codex } = await fixture();
  const calls: { rules: string[] }[] = [];
  const failing = { runtimeRoot, vaultRoot, files: [claude, codex], model: judgeModel(calls, true) };
  const failed = await refreshInstructionSuggestions({ ...failing, now: "2026-11-20T03:00:00.000Z" });
  expect(failed.outcome).toBe("failed");
  expect(failed.state).toMatchObject({ failedAt: "2026-11-20T03:00:00.000Z", failure: "network down" });
  expect((await refreshInstructionSuggestions({ ...failing, now: "2026-11-20T05:00:00.000Z" })).outcome).toBe("waiting_after_failure");
  expect(calls).toHaveLength(1);
  const retried = await refreshInstructionSuggestions({ ...failing, model: judgeModel(calls), now: "2026-11-21T03:00:00.000Z" });
  expect(retried.outcome).toBe("judged");
  expect(retried.state.suggestions).toHaveLength(1);
  expect(retried.state.failedAt).toBeUndefined();
});
