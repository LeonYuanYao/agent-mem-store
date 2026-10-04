import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";

import { CodexLunaAdapter, type LunaEvidence } from "../../src/luna/index.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const promptSchema = z.object({ request: z.object({
  statement: z.string(), conditions: z.array(z.string()), exclusions: z.array(z.string()),
  evidence: z.array(z.object({ evidenceId: z.string(), content: z.string(), command: z.string().optional() }))
}) });

function largeEvidence(): LunaEvidence[] {
  return [1, 2, 3].map(index => ({
    evidenceId: `source-${String(index)}`, evidenceClass: "command_outcome",
    content: JSON.stringify({ command: `patch-${String(index)}:${"x".repeat(490_000)}` }),
    command: `patch-${String(index)}:${"x".repeat(490_000)}`,
    sourceIdentity: `session:turn-${String(index)}`, sourceTruncated: false, memoryEcho: false
  }));
}

test.each(["supported", "mixed", "durability_mixed", "failure"])(
  "large semantic assessment preserves complete evidence and handles %s pages conservatively",
  async scenario => {
    const root = await mkdtemp(join(tmpdir(), "ms-semantic-")); roots.push(root);
    const evidence = largeEvidence();
    const original = JSON.stringify(evidence);
    const received: string[] = [];
    let calls = 0;
    const adapter = new CodexLunaAdapter({
      codexExecutable: "codex", codexHome: join(root, "home"), temporaryRoot: root,
      runProcess: request => {
        expect(request.standardInput.length).toBeLessThan(1_048_576);
        const prompt = promptSchema.parse(JSON.parse(request.standardInput));
        expect(prompt.request).toMatchObject({ statement: "A conditional claim.",
          conditions: ["Only in this project"], exclusions: ["Except legacy versions"] });
        calls++;
        for (const item of prompt.request.evidence) {
          received.push(item.content);
          expect(evidence.some(source => source.content === item.content && source.command === item.command)).toBe(true);
        }
        if (scenario === "failure" && calls === 2) return Promise.resolve({ exitCode: 1, stdout: "", stderr: "rate limit exceeded" });
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: JSON.stringify({
          schemaVersion: 1, kind: "semantic_assessment",
          state: scenario === "mixed" && calls === 2 ? "contradicted" : "supported",
          durabilityDisposition: scenario === "durability_mixed" && calls === 2 ? "task_local" : "durable",
          evidenceIds: prompt.request.evidence.map(item => item.evidenceId)
        }) });
      }
    });
    const result = adapter.assessCandidateSemantics({ operationId: "large-assessment",
      statement: "A conditional claim.", conditions: ["Only in this project"],
      exclusions: ["Except legacy versions"], evidence });
    if (scenario === "failure") {
      await expect(result).rejects.toMatchObject({ category: "rate_limited" });
      expect(calls).toBe(2);
    } else {
      await expect(result).resolves.toMatchObject({
        state: scenario === "mixed" ? "insufficient_evidence" : "supported",
        durabilityDisposition: scenario === "durability_mixed" ? "uncertain" : "durable",
        evidenceIds: evidence.map(item => item.evidenceId)
      });
      expect(received).toEqual(evidence.map(item => item.content));
      expect(calls).toBe(3);
    }
    expect(JSON.stringify(evidence)).toBe(original);
  }
);

test("an indivisible oversized evidence item fails before any model calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "ms-semantic-")); roots.push(root);
  let calls = 0;
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex", codexHome: join(root, "home"), temporaryRoot: root,
    runProcess: () => { calls++; return Promise.reject(new Error("Must not invoke the model")); }
  });
  await expect(adapter.assessCandidateSemantics({ operationId: "indivisible",
    statement: "A claim.", conditions: [], exclusions: [],
    evidence: [...largeEvidence(), { evidenceId: "huge", evidenceClass: "other",
      content: "x".repeat(1_050_000), sourceIdentity: "huge-source", sourceTruncated: false, memoryEcho: false }]
  })).rejects.toMatchObject({ category: "input_too_large", retryable: false });
  expect(calls).toBe(0);
});

test("semantic pages share one deadline and stop before a new call after expiry", async () => {
  const root = await mkdtemp(join(tmpdir(), "ms-semantic-")); roots.push(root);
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const budgets: number[] = [];
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex", codexHome: join(root, "home"), temporaryRoot: root,
    timeoutMilliseconds: 200,
    runProcess: request => {
      budgets.push(request.timeoutMilliseconds);
      const prompt = promptSchema.parse(JSON.parse(request.standardInput));
      now += 100;
      return Promise.resolve({ exitCode: 0, stderr: "", stdout: JSON.stringify({
        schemaVersion: 1, kind: "semantic_assessment", state: "supported",
        durabilityDisposition: "durable", evidenceIds: prompt.request.evidence.map(item => item.evidenceId)
      }) });
    }
  });
  await expect(adapter.assessCandidateSemantics({ operationId: "shared-deadline",
    statement: "A claim.", conditions: [], exclusions: [], evidence: largeEvidence()
  })).rejects.toMatchObject({ category: "timeout", retryable: true });
  expect(budgets).toEqual([200, 100]);
});
