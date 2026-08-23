import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  CodexTerraRetrievalJudge,
  type RetrievalJudgeProcessRequest
} from "../../src/retrieval/judge.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

test("the explicit retrieval judge pins Terra low to the standard service tier", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-terra-judge-"));
  temporaryDirectories.push(root);
  const requests: RetrievalJudgeProcessRequest[] = [];
  const judge = new CodexTerraRetrievalJudge({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: (request) => {
      requests.push(request);
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          kind: "retrieval_judgment",
          retainedAliases: ["m1"],
          packDecision: "useful"
        }),
        stderr: ""
      });
    }
  });

  await expect(judge.judge({
    query: "How should the release be verified?",
    items: [{
      memoryId: "msmem_release",
      description: "Run typecheck before a release.",
      scope: { kind: "global" },
      authority: "human_authored"
    }]
  })).resolves.toMatchObject({ retainedMemoryIds: ["msmem_release"] });

  const request = requests[0];
  if (request === undefined) throw new Error("Expected a Terra process request.");
  expect(request.arguments).toEqual(expect.arrayContaining([
    "--model",
    "gpt-5.6-terra",
    "-c",
    'model_reasoning_effort="low"',
    "-c",
    'service_tier="default"',
    "--ignore-user-config",
    "--sandbox",
    "read-only"
  ]));
  expect(request.arguments).not.toContain('service_tier="fast"');
  expect(request.standardInput).toContain("changes the answer or next safe action now");
  expect(request.standardInput).not.toContain("msmem_release");
});

test("an uncertain foreground judgment fails closed to an empty pack", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-terra-uncertain-"));
  temporaryDirectories.push(root);
  const judge = new CodexTerraRetrievalJudge({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: () => Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        kind: "retrieval_judgment",
        retainedAliases: [],
        packDecision: "uncertain"
      }),
      stderr: ""
    })
  });

  await expect(judge.judge({
    query: "What should I do?",
    items: [{
      memoryId: "msmem_possible",
      description: "This might become useful after a future migration.",
      scope: { kind: "global" },
      authority: "agent_derived"
    }]
  })).resolves.toEqual({ retainedMemoryIds: [], packDecision: "uncertain" });
});
