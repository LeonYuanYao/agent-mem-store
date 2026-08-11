import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import {
  CodexLunaAdapter,
  type LunaProcessRequest,
  type LunaProcessResult
} from "../../src/luna/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

test("the Luna adapter makes the running Node executable discoverable in a restricted Worker PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-path-"));
  temporaryDirectories.push(root);
  const requests: LunaProcessRequest[] = [];
  vi.stubEnv("PATH", "/opt/homebrew/bin:/usr/bin:/bin");
  const adapter = new CodexLunaAdapter({
    codexExecutable: "/opt/bin/codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: (request) => {
      requests.push(request);
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({ schemaVersion: 1, kind: "distillation", candidates: [] }),
        stderr: ""
      });
    }
  });

  await adapter.distillBatch({
    operationId: "msop-path-contract",
    scope: { kind: "global" },
    evidence: []
  });

  expect(requests[0]?.environment.PATH).toBe(
    `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`
  );
});

test("the Luna adapter invokes only gpt-5.6-luna in an isolated read-only process", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-adapter-"));
  temporaryDirectories.push(root);
  const requests: LunaProcessRequest[] = [];
  const adapter = new CodexLunaAdapter({
    codexExecutable: "/opt/bin/codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: (request): Promise<LunaProcessResult> => {
      requests.push(request);
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          kind: "distillation",
          candidates: [
            {
              statement: "Use stable Project identities for Project Memory.",
              category: "decision",
              applicabilitySummary: "Project Memory resolution",
              conditions: ["A Project boundary is required."],
              exclusions: ["This does not create Global Memory."],
              preservedNegations: ["Do not merge unrelated repositories."],
              certainty: "asserted",
              sensitivity: "normal",
              evidenceIds: ["msevent_123"],
              importanceTags: ["architecture_invariant"],
              importanceReasons: [{
                tag: "architecture_invariant",
                reason: "This is a reusable architecture boundary.",
                evidenceIds: ["msevent_123"]
              }]
            }
          ]
        }),
        stderr: ""
      });
    }
  });

  const result = await adapter.distillBatch({
    operationId: "msop_123e4567-e89b-42d3-a456-426614174000",
    scope: { kind: "project", projectId: "msproj_123e4567-e89b-42d3-a456-426614174001" },
    evidence: [
      {
        evidenceId: "msevent_123",
        evidenceClass: "explicit_user_statement",
        content: "Keep Project Memory isolated by stable identity.",
        sourceIdentity: "codex:session-1:turn-1",
        sourceTruncated: false,
        memoryEcho: false
      }
    ]
  });

  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]?.statement).toContain("stable Project identities");
  expect(requests).toHaveLength(1);
  const request = requests[0];
  if (request === undefined) throw new Error("Expected Luna process request.");
  expect(request.executable).toBe("/opt/bin/codex");
  expect(request.arguments).toEqual(
    expect.arrayContaining([
      "exec",
      "--model",
      "gpt-5.6-luna",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--disable",
      "shell_tool",
      "--disable",
      "unified_exec",
      "--disable",
      "code_mode_host",
      "--ignore-user-config",
      "--output-schema",
      "-"
    ])
  );
  expect(request.environment.CODEX_HOME).toBe(join(root, "codex-home"));
  expect(request.environment.HOME).toBeUndefined();
  expect(request.environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(request.standardInput).toContain('"schemaVersion":1');
  expect(request.standardInput).toContain("msevent_123");
  expect(request.standardInput).not.toContain("fallback");
});

test("schema-invalid Luna output is rejected without a fallback model", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-invalid-"));
  temporaryDirectories.push(root);
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: () => Promise.resolve({
      exitCode: 0,
      stdout: '{"schemaVersion":1,"kind":"distillation","candidates":[{"statement":"missing evidence"}]}',
      stderr: ""
    })
  });

  await expect(
    adapter.distillBatch({
      operationId: "msop_123e4567-e89b-42d3-a456-426614174002",
      scope: { kind: "global" },
      evidence: []
    })
  ).rejects.toMatchObject({
    category: "schema_invalid",
    retryable: true
  });
});

test("the Responses API output schema gives every const field an explicit JSON type", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-schema-"));
  temporaryDirectories.push(root);
  let outputSchema: unknown;
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: async (request) => {
      const schemaIndex = request.arguments.indexOf("--output-schema") + 1;
      const schemaPath = request.arguments[schemaIndex];
      if (schemaPath === undefined) throw new Error("Expected an output schema path.");
      outputSchema = JSON.parse(await readFile(schemaPath, "utf8"));
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          kind: "semantic_assessment",
          state: "supported",
          evidenceIds: ["evidence-1"]
        }),
        stderr: ""
      };
    }
  });

  await adapter.assessCandidateSemantics({
    operationId: "schema-contract",
    statement: "A supported claim.",
    conditions: [],
    exclusions: [],
    evidence: [{
      evidenceId: "evidence-1",
      evidenceClass: "explicit_user_statement",
      content: "A supported claim.",
      sourceIdentity: "schema-contract",
      sourceTruncated: false,
      memoryEcho: false
    }]
  });

  expect(outputSchema).toMatchObject({
    properties: {
      schemaVersion: { type: "integer", const: 1 },
      kind: { type: "string", const: "semantic_assessment" }
    }
  });
});

test("importance reasons are the Luna wire source of truth and deterministically derive tags", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-importance-source-"));
  temporaryDirectories.push(root);
  let outputSchema: unknown;
  let prompt = "";
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: async (request) => {
      const schemaIndex = request.arguments.indexOf("--output-schema") + 1;
      const schemaPath = request.arguments[schemaIndex];
      if (schemaPath === undefined) throw new Error("Expected an output schema path.");
      outputSchema = JSON.parse(await readFile(schemaPath, "utf8"));
      prompt = request.standardInput;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          kind: "distillation",
          candidates: [{
            statement: "Keep program code separate from canonical personal data.",
            category: "architecture",
            applicabilitySummary: "MemStore",
            conditions: [],
            exclusions: [],
            preservedNegations: [],
            certainty: "asserted",
            sensitivity: "normal",
            evidenceIds: ["evidence-1"],
            importanceReasons: [{
              tag: "architecture_invariant",
              reason: "This boundary applies to every installation.",
              evidenceIds: ["evidence-1"]
            }]
          }]
        }),
        stderr: ""
      };
    }
  });

  const result = await adapter.distillBatch({
    operationId: "msop-importance-source",
    scope: { kind: "project", projectId: "msproj-test" },
    evidence: [{
      evidenceId: "evidence-1",
      evidenceClass: "explicit_user_statement",
      content: "Keep program code separate from canonical personal data.",
      sourceIdentity: "source-1",
      sourceTruncated: false,
      memoryEcho: false
    }]
  });

  expect(result.candidates[0]?.importanceTags).toEqual(["architecture_invariant"]);
  expect(JSON.stringify(outputSchema)).not.toContain('"importanceTags"');
  expect(prompt).toContain("Return at most one importance reason for each tag");
});

test("an API invalid_json_schema response is classified as a visible non-retryable configuration fault", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-api-schema-"));
  temporaryDirectories.push(root);
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: () => Promise.resolve({
      exitCode: 1,
      stdout: "",
      stderr: "invalid_request_error: invalid_json_schema"
    })
  });

  await expect(adapter.assessCandidateSemantics({
    operationId: "schema-failure",
    statement: "A claim.",
    conditions: [],
    exclusions: [],
    evidence: []
  })).rejects.toMatchObject({
    category: "invalid_configuration",
    retryable: false
  });
});

test("consolidation and semantic assessment use distinct versioned structured tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-structured-"));
  temporaryDirectories.push(root);
  const prompts: string[] = [];
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: (request) => {
      prompts.push(request.standardInput);
      const prompt = JSON.parse(request.standardInput) as { task: string };
      if (prompt.task === "consolidate_session_candidates") {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({ schemaVersion: 1, kind: "consolidation", candidates: [] }),
          stderr: ""
        });
      }
      if (prompt.task === "assess_human_memory_conflict") {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            schemaVersion: 1,
            kind: "conflict_assessment",
            state: "no_material_conflict",
            conflictingMemoryIds: []
          }),
          stderr: ""
        });
      }
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          kind: "semantic_assessment",
          state: "supported",
          evidenceIds: ["evidence-1"]
        }),
        stderr: ""
      });
    }
  });

  await adapter.consolidateSession({
    operationId: "msop-consolidate",
    sessionId: "session-1",
    batchResults: [{ batchId: "batch-1", candidates: [], evidenceIds: ["evidence-1"] }]
  });
  await adapter.assessCandidateSemantics({
    operationId: "msop-assess",
    statement: "A bounded claim.",
    conditions: [],
    exclusions: [],
    evidence: [{
      evidenceId: "evidence-1",
      evidenceClass: "explicit_user_statement",
      content: "A bounded claim.",
      sourceIdentity: "source-1",
      sourceTruncated: false,
      memoryEcho: false
    }]
  });
  await adapter.assessHumanConflict({
    operationId: "msop-conflict",
    proposedAssertion: "Use the beta endpoint in staging.",
    existingHumanMemories: [{
      memoryId: "msmem-existing",
      revisionId: "msrev-existing",
      body: "Use the stable endpoint in production.",
      applicabilitySummary: "Production",
      conditions: ["Environment is production."]
    }]
  });

  expect(prompts).toHaveLength(3);
  expect(prompts[0]).toContain('"promptVersion":1');
  expect(prompts[0]).toContain('"task":"consolidate_session_candidates"');
  expect(prompts[1]).toContain('"task":"assess_candidate_semantics"');
  expect(prompts[2]).toContain('"task":"assess_human_memory_conflict"');
});

test("consolidation uses short evidence aliases and restores exact source identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-consolidation-alias-"));
  temporaryDirectories.push(root);
  const originalEvidenceId = "msevidence_very_specific_original_identity_123456789";
  let promptSource = "";
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: (request) => {
      promptSource = request.standardInput;
      const prompt = JSON.parse(promptSource) as {
        request: { batchResults: Array<{ candidates: Array<{ evidenceIds: string[] }> }> };
      };
      const alias = prompt.request.batchResults[0]?.candidates[0]?.evidenceIds[0];
      if (alias === undefined) throw new Error("Expected an evidence alias.");
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          kind: "consolidation",
          candidates: [{
            statement: "Consolidated statement.",
            category: "lesson",
            applicabilitySummary: "test",
            conditions: [],
            exclusions: [],
            preservedNegations: [],
            certainty: "asserted",
            sensitivity: "normal",
            evidenceIds: [alias],
            importanceReasons: [{ tag: "constraint", reason: "Preserved constraint.", evidenceIds: [alias] }]
          }]
        }),
        stderr: ""
      });
    }
  });

  const output = await adapter.consolidateSession({
    operationId: "msop-consolidation-alias",
    sessionId: "session-alias",
    batchResults: [{
      batchId: "batch-alias",
      evidenceIds: [originalEvidenceId],
      candidates: [{
        statement: "Source statement.",
        category: "lesson",
        applicabilitySummary: "test",
        conditions: [],
        exclusions: [],
        preservedNegations: [],
        certainty: "asserted",
        sensitivity: "normal",
        evidenceIds: [originalEvidenceId],
        importanceTags: ["constraint"],
        importanceReasons: [{
          tag: "constraint",
          reason: "Source constraint.",
          evidenceIds: [originalEvidenceId]
        }]
      }]
    }]
  });

  expect(promptSource).not.toContain(originalEvidenceId);
  expect(output.candidates[0]).toMatchObject({
    evidenceIds: [originalEvidenceId],
    importanceReasons: [{ evidenceIds: [originalEvidenceId] }]
  });
});

test("structured output cannot cite evidence that MemStore did not supply", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-evidence-binding-"));
  temporaryDirectories.push(root);
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: () => Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        kind: "semantic_assessment",
        state: "supported",
        evidenceIds: ["invented-evidence"]
      }),
      stderr: ""
    })
  });

  await expect(adapter.assessCandidateSemantics({
    operationId: "msop-assess-invalid",
    statement: "A claim.",
    conditions: [],
    exclusions: [],
    evidence: []
  })).rejects.toMatchObject({ category: "schema_invalid", retryable: true });
});

test("duplicate Luna importance reasons for the same tag are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-importance-"));
  temporaryDirectories.push(root);
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: () => Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        kind: "distillation",
        candidates: [{
          statement: "A proposed invariant.",
          category: "architecture",
          applicabilitySummary: "test project",
          conditions: [],
          exclusions: [],
          preservedNegations: [],
          certainty: "asserted",
          sensitivity: "normal",
          evidenceIds: ["evidence-1"],
          importanceReasons: [{
            tag: "architecture_invariant",
            reason: "This boundary applies across the system.",
            evidenceIds: ["evidence-1"]
          }, {
            tag: "architecture_invariant",
            reason: "This is a duplicate reason for the same tag.",
            evidenceIds: ["evidence-1"]
          }]
        }]
      }),
      stderr: ""
    })
  });

  await expect(adapter.distillBatch({
    operationId: "msop-importance-invalid",
    scope: { kind: "global" },
    evidence: [{
      evidenceId: "evidence-1",
      evidenceClass: "explicit_user_statement",
      content: "A proposed invariant.",
      sourceIdentity: "source-1",
      sourceTruncated: false,
      memoryEcho: false
    }]
  })).rejects.toMatchObject({ category: "schema_invalid", retryable: true });
});
