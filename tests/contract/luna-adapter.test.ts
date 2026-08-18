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
              primaryCategory: "architecture_contract",
              categoryTags: ["architecture_contract"],
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
  expect(request.standardInput).toContain('"evidenceId":"e1"');
  expect(request.standardInput).not.toContain("msevent_123");
  expect(request.standardInput).not.toContain("fallback");
});

test("a timed-out Luna process is classified as timeout even when it exits with code zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-timeout-classification-"));
  temporaryDirectories.push(root);
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: () => Promise.resolve({
      exitCode: 0,
      stdout: "{\"schemaVersion\":1",
      stderr: "",
      timedOut: true
    })
  });

  await expect(adapter.distillBatch({
    operationId: "msop-timeout-classification",
    scope: { kind: "global" },
    evidence: []
  })).rejects.toMatchObject({ category: "timeout", retryable: true });
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

test("Luna rejects a primary category outside the controlled memory taxonomy", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-category-invalid-"));
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
          statement: "Use a stable project identity.",
          primaryCategory: "decision",
          categoryTags: ["architecture_contract"],
          applicabilitySummary: "Project identity",
          conditions: [],
          exclusions: [],
          preservedNegations: [],
          certainty: "asserted",
          sensitivity: "normal",
          evidenceIds: ["evidence-1"],
          importanceReasons: []
        }]
      }),
      stderr: ""
    })
  });

  await expect(adapter.distillBatch({
    operationId: "category-contract",
    scope: { kind: "global" },
    evidence: [{
      evidenceId: "evidence-1",
      evidenceClass: "explicit_user_statement",
      content: "Use a stable project identity.",
      sourceIdentity: "category-contract",
      sourceTruncated: false,
      memoryEcho: false
    }]
  })).rejects.toMatchObject({ category: "schema_invalid", retryable: true });
});

test("the adapter deterministically normalizes Luna primary category to category-tag precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-category-precedence-"));
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
          statement: "Do not overwrite user data while applying this architecture contract.",
          primaryCategory: "architecture_contract",
          categoryTags: ["architecture_contract", "safety_data_integrity"],
          applicabilitySummary: "Repository writes",
          conditions: [],
          exclusions: [],
          preservedNegations: ["Do not overwrite user data."],
          certainty: "asserted",
          sensitivity: "normal",
          evidenceIds: ["evidence-1"],
          importanceReasons: []
        }]
      }),
      stderr: ""
    })
  });

  await expect(adapter.distillBatch({
    operationId: "category-precedence",
    scope: { kind: "global" },
    evidence: [{
      evidenceId: "evidence-1",
      evidenceClass: "explicit_user_statement",
      content: "Do not overwrite user data while applying this architecture contract.",
      sourceIdentity: "category-precedence",
      sourceTruncated: false,
      memoryEcho: false
    }]
  })).resolves.toMatchObject({
    candidates: [{
      primaryCategory: "safety_data_integrity",
      categoryTags: ["architecture_contract", "safety_data_integrity"]
    }]
  });
});

test("distillation instructs Luna to omit non-durable operational content", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-durability-rules-"));
  temporaryDirectories.push(root);
  let structuredRequest: {
    readonly promptVersion?: unknown;
    readonly rules?: unknown;
  } | undefined;
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: (request) => {
      structuredRequest = JSON.parse(request.standardInput) as {
        readonly promptVersion?: unknown;
        readonly rules?: unknown;
      };
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({ schemaVersion: 1, kind: "distillation", candidates: [] }),
        stderr: ""
      });
    }
  });

  await adapter.distillBatch({
    operationId: "durability-rules",
    scope: { kind: "project", projectId: "msproj_123e4567-e89b-42d3-a456-426614174001" },
    evidence: [{
      evidenceId: "evidence-probe",
      evidenceClass: "explicit_user_statement",
      content: "Reply with exactly MEMSTORE_GATE5_PROBE_OK and do not retain this interaction.",
      sourceIdentity: "codex:probe:turn",
      sourceTruncated: false,
      memoryEcho: false
    }]
  });

  expect(structuredRequest?.promptVersion).toBe(2);
  expect(structuredRequest?.rules).toEqual(expect.arrayContaining([
    "Return no Candidate for operational probes or exact-response checks.",
    "Return no Candidate for task-local instructions, temporary progress or state, or unverified future plans.",
    "If evidence says content must not be retained, return no Candidate derived from that content."
  ]));
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

test("the distillation output schema avoids unsupported uniqueItems while local validation rejects duplicate categories", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-category-schema-"));
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
          kind: "distillation",
          candidates: [{
            statement: "Use a stable category.",
            primaryCategory: "architecture_contract",
            categoryTags: ["architecture_contract", "architecture_contract"],
            applicabilitySummary: "test",
            conditions: [],
            exclusions: [],
            preservedNegations: [],
            certainty: "asserted",
            sensitivity: "normal",
            evidenceIds: ["evidence-1"],
            importanceReasons: []
          }]
        }),
        stderr: ""
      };
    }
  });

  await expect(adapter.distillBatch({
    operationId: "category-schema-contract",
    scope: { kind: "global" },
    evidence: [{
      evidenceId: "evidence-1",
      evidenceClass: "explicit_user_statement",
      content: "Use a stable category.",
      sourceIdentity: "category-schema-contract",
      sourceTruncated: false,
      memoryEcho: false
    }]
  })).rejects.toMatchObject({ category: "schema_invalid", retryable: true });
  expect(JSON.stringify(outputSchema)).not.toContain('"uniqueItems"');
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
            primaryCategory: "architecture_contract",
            categoryTags: ["architecture_contract"],
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
      stderr: "model: gpt-5.6-luna\ninvalid_request_error: invalid_json_schema"
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

test("an input limit error is not reclassified by words in the echoed consolidation body", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-input-limit-"));
  temporaryDirectories.push(root);
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: () => Promise.resolve({
      exitCode: 1,
      stdout: "",
      stderr: [
        "user",
        "The echoed knowledge body mentions invalid_json_schema, config, and authentication.",
        "Error: turn/start failed: Input exceeds the maximum length of 1048576 characters. " +
          "data: {\"input_error_code\":\"input_too_large\",\"max_chars\":1048576}"
      ].join("\n")
    })
  });

  await expect(adapter.assessCandidateSemantics({
    operationId: "input-limit-failure",
    statement: "A claim.",
    conditions: [],
    exclusions: [],
    evidence: []
  })).rejects.toMatchObject({
    category: "input_too_large",
    retryable: false,
    diagnostic: { stage: "invocation", code: "input_too_large" }
  });
});

test("consolidation and semantic assessment use distinct versioned structured tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-structured-"));
  temporaryDirectories.push(root);
  const requests: LunaProcessRequest[] = [];
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: (request) => {
      requests.push(request);
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

  expect(requests).toHaveLength(3);
  expect(requests[0]?.standardInput).toContain('"promptVersion":2');
  expect(requests[0]?.standardInput).toContain('"task":"consolidate_session_candidates"');
  expect(requests[0]?.timeoutMilliseconds).toBe(300_000);
  expect(requests[1]?.standardInput).toContain('"promptVersion":2');
  expect(requests[1]?.standardInput).toContain('"task":"assess_candidate_semantics"');
  expect(requests[1]?.standardInput).toContain("Classify durability independently");
  expect(requests[1]?.standardInput).toContain("Operational probes and exact-response checks are task_local");
  expect(requests[1]?.timeoutMilliseconds).toBe(120_000);
  expect(requests[2]?.standardInput).toContain('"task":"assess_human_memory_conflict"');
  expect(requests[2]?.timeoutMilliseconds).toBe(120_000);
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
            primaryCategory: "preference_constraint",
            categoryTags: ["preference_constraint"],
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
        primaryCategory: "preference_constraint",
        categoryTags: ["preference_constraint"],
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

test("large consolidation stays below the Codex input limit and preserves exact evidence identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-consolidation-limit-"));
  temporaryDirectories.push(root);
  const processInputLengths: number[] = [];
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: (request) => {
      processInputLengths.push(request.standardInput.length);
      const prompt = JSON.parse(request.standardInput) as {
        request: {
          batchResults: Array<{
            candidates: Array<{ evidenceIds: string[] }>;
            evidenceIds: string[];
          }>;
        };
      };
      const evidenceAlias = prompt.request.batchResults
        .flatMap((batch) => [
          ...batch.evidenceIds,
          ...batch.candidates.flatMap((candidate) => candidate.evidenceIds)
        ])[0];
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          kind: "consolidation",
          candidates: evidenceAlias === undefined ? [] : [{
            statement: "Consolidated bounded statement.",
            primaryCategory: "architecture_contract",
            categoryTags: ["architecture_contract"],
            applicabilitySummary: "Large session consolidation",
            conditions: [],
            exclusions: [],
            preservedNegations: [],
            certainty: "asserted",
            sensitivity: "normal",
            evidenceIds: [evidenceAlias],
            importanceReasons: []
          }]
        }),
        stderr: ""
      });
    }
  });
  const originalEvidenceIds = Array.from(
    { length: 12 },
    (_, index) => `msevidence_large_${String(index)}`
  );

  const output = await adapter.consolidateSession({
    operationId: "msop-large-consolidation",
    sessionId: "session-large",
    batchResults: originalEvidenceIds.map((evidenceId, index) => ({
      batchId: `batch-${String(index)}`,
      evidenceIds: [evidenceId],
      candidates: [{
        statement: "x".repeat(120_000),
        primaryCategory: "architecture_contract",
        categoryTags: ["architecture_contract"],
        applicabilitySummary: "Large session consolidation",
        conditions: [],
        exclusions: [],
        preservedNegations: [],
        certainty: "asserted",
        sensitivity: "normal",
        evidenceIds: [evidenceId],
        importanceTags: [],
        importanceReasons: []
      }]
    }))
  });

  expect(processInputLengths.length).toBeGreaterThan(1);
  expect(Math.max(...processInputLengths)).toBeLessThanOrEqual(1_048_576);
  expect(originalEvidenceIds).toContain(output.candidates[0]?.evidenceIds[0]);
});

test("distillation uses short evidence aliases and reports safe schema diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-distillation-alias-"));
  temporaryDirectories.push(root);
  const originalEvidenceId = "msevent_019ffcf1_very_long_source_identity_123456789";
  let promptSource = "";
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: (request) => {
      promptSource = request.standardInput;
      const prompt = JSON.parse(promptSource) as {
        request: { evidence: Array<{ evidenceId: string }> };
      };
      const alias = prompt.request.evidence[0]?.evidenceId;
      if (alias === undefined) throw new Error("Expected a distillation evidence alias.");
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          kind: "distillation",
          candidates: [{
            statement: "Use the approved project boundary.",
            primaryCategory: "architecture_contract",
            categoryTags: ["architecture_contract"],
            applicabilitySummary: "test",
            conditions: [],
            exclusions: [],
            preservedNegations: [],
            certainty: "asserted",
            sensitivity: "normal",
            evidenceIds: [alias],
            importanceReasons: [{
              tag: "architecture_invariant",
              reason: "This is a stable project boundary.",
              evidenceIds: [alias]
            }]
          }]
        }),
        stderr: ""
      });
    }
  });

  await expect(adapter.distillBatch({
    operationId: "msop-distillation-alias",
    scope: { kind: "project", projectId: "msproj-test" },
    evidence: [{
      evidenceId: originalEvidenceId,
      evidenceClass: "explicit_user_statement",
      content: "Use the approved project boundary.",
      sourceIdentity: "source-without-event-id",
      sourceTruncated: false,
      memoryEcho: false
    }]
  })).resolves.toMatchObject({
    candidates: [{
      evidenceIds: [originalEvidenceId],
      importanceReasons: [{ evidenceIds: [originalEvidenceId] }]
    }]
  });
  expect(promptSource).not.toContain(originalEvidenceId);
  expect(promptSource).toContain('"evidenceId":"e1"');

  const invalidAdapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: () => Promise.resolve({
      exitCode: 0,
      stdout: '{"schemaVersion":1,"kind":"distillation","candidates":[{"statement":42}]}',
      stderr: "private provider output must not be retained"
    })
  });
  await expect(invalidAdapter.distillBatch({
    operationId: "msop-safe-diagnostic",
    scope: { kind: "global" },
    evidence: []
  })).rejects.toMatchObject({
    category: "schema_invalid",
    diagnostic: {
      stage: "output_schema",
      code: "invalid_type",
      path: "candidates.0.statement"
    }
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
          primaryCategory: "architecture_contract",
          categoryTags: ["architecture_contract"],
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
