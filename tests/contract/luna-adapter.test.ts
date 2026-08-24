import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import {
  CodexLunaAdapter,
  type LunaProcessRequest,
  type LunaProcessResult
} from "../../src/luna/index.js";
import { makeLongTermCandidateDurability } from "../helpers/candidate-durability.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

test("compact generation and fidelity validation use separate constrained Luna calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-compact-"));
  temporaryDirectories.push(root);
  const prompts: unknown[] = [];
  const outputs = [
    {
      schemaVersion: 1,
      kind: "compact_generation",
      items: [{ memoryId: "m1", compactText: "Run typecheck before release." }]
    },
    {
      schemaVersion: 1,
      kind: "compact_validation",
      items: [{
        memoryId: "m1",
        state: "preserves",
        reasonCode: "all_material_facts_preserved"
      }]
    }
  ];
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: (request) => {
      prompts.push(JSON.parse(request.standardInput) as unknown);
      const output = outputs.shift();
      if (output === undefined) throw new Error("Unexpected Luna call.");
      return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(output), stderr: "" });
    }
  });
  const memory = {
    memoryId: "msmem_1",
    revisionId: "msrev_1",
    body: "Run typecheck before release.",
    applicability: { summary: "Releases", conditions: [] },
    semanticContract: {
      schemaVersion: 1 as const,
      claims: ["Run typecheck before release."],
      conditions: [],
      exclusions: [],
      preservedNegations: []
    }
  };

  await expect(adapter.generateCompacts({
    operationId: "generation-1",
    memories: [memory]
  })).resolves.toMatchObject({ kind: "compact_generation" });
  await expect(adapter.validateCompacts({
    operationId: "validation-1",
    memories: [{ ...memory, compactText: "Run typecheck before release." }]
  })).resolves.toMatchObject({ kind: "compact_validation" });

  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toMatchObject({ task: "generate_compact_memory_representations" });
  expect(prompts[1]).toMatchObject({ task: "validate_compact_memory_fidelity" });
});

test("compact generation restores exact Memory identities from short aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-compact-alias-"));
  temporaryDirectories.push(root);
  const originalIds = [
    "msmem_8e24a0de-56fa-4ddb-9432-1e3d6274c828",
    "msmem_8e280294-a7dd-45fe-b16c-4f29de16ef2f"
  ];
  let prompt: {
    request?: { memories?: Array<{ memoryId?: unknown }> };
  } = {};
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: (request) => {
      prompt = JSON.parse(request.standardInput) as typeof prompt;
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          kind: "compact_generation",
          items: [
            { memoryId: "m1", compactText: "First compact." },
            { memoryId: "m2", compactText: "Second compact." }
          ]
        }),
        stderr: ""
      });
    }
  });
  const memories = originalIds.map((memoryId, index) => ({
    memoryId,
    revisionId: `msrev_123e4567-e89b-42d3-a456-42661417408${String(index)}`,
    body: `${index === 0 ? "First" : "Second"} durable claim.`,
    applicability: { summary: "Current project", conditions: [] },
    semanticContract: {
      schemaVersion: 1 as const,
      claims: [`${index === 0 ? "First" : "Second"} durable claim.`],
      conditions: [],
      exclusions: [],
      preservedNegations: []
    }
  }));

  await expect(adapter.generateCompacts({
    operationId: "generation-alias-1",
    memories
  })).resolves.toMatchObject({
    items: [
      { memoryId: originalIds[0] },
      { memoryId: originalIds[1] }
    ]
  });
  expect(prompt.request?.memories?.map((memory) => memory.memoryId)).toEqual(["m1", "m2"]);
});

test("compact generation repairs only drafts that exceed the measured token budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-compact-repair-"));
  temporaryDirectories.push(root);
  const prompts: Array<{
    task?: unknown;
    request?: { memories?: Array<{ memoryId?: unknown; renderedTokenCount?: unknown }> };
  }> = [];
  const outputs = [
    {
      schemaVersion: 1,
      kind: "compact_generation",
      items: [
        { memoryId: "m1", compactText: Array.from({ length: 120 }, () => "detail").join(" ") },
        { memoryId: "m2", compactText: "Already compact." }
      ]
    },
    {
      schemaVersion: 1,
      kind: "compact_generation",
      items: [{ memoryId: "m1", compactText: "Repaired compact." }]
    }
  ];
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: (request) => {
      prompts.push(JSON.parse(request.standardInput) as typeof prompts[number]);
      const output = outputs.shift();
      if (output === undefined) throw new Error("Unexpected Luna call.");
      return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(output), stderr: "" });
    }
  });
  const memories = ["First", "Second"].map((label, index) => ({
    memoryId: `msmem_${String(index + 1)}`,
    revisionId: `msrev_${String(index + 1)}`,
    body: `${label} durable claim.`,
    applicability: { summary: "Current project", conditions: [] },
    semanticContract: {
      schemaVersion: 1 as const,
      claims: [`${label} durable claim.`],
      conditions: [],
      exclusions: [],
      preservedNegations: []
    }
  }));

  await expect(adapter.generateCompacts({
    operationId: "generation-repair-1",
    memories
  })).resolves.toMatchObject({
    items: [
      { memoryId: "msmem_1", compactText: "Repaired compact." },
      { memoryId: "msmem_2", compactText: "Already compact." }
    ]
  });
  expect(prompts.map((prompt) => prompt.task)).toEqual([
    "generate_compact_memory_representations",
    "repair_overlong_compact_memory_representations"
  ]);
  expect(prompts[1]?.request?.memories).toHaveLength(1);
  expect(prompts[1]?.request?.memories?.[0]).toMatchObject({
    memoryId: "m1"
  });
  expect(typeof prompts[1]?.request?.memories?.[0]?.renderedTokenCount).toBe("number");
});

test("compact generation returns the best repaired draft when lossless compression cannot meet the hard limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-compact-uncompressible-"));
  temporaryDirectories.push(root);
  const overlong = Array.from({ length: 120 }, () => "detail").join(" ");
  let callCount = 0;
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: () => {
      callCount += 1;
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          kind: "compact_generation",
          items: [{ memoryId: "m1", compactText: overlong }]
        }),
        stderr: ""
      });
    }
  });

  await expect(adapter.generateCompacts({
    operationId: "generation-uncompressible-1",
    memories: [{
      memoryId: "msmem_1",
      revisionId: "msrev_1",
      body: "A dense durable claim.",
      applicability: { summary: "Current project", conditions: [] },
      semanticContract: {
        schemaVersion: 1,
        claims: ["A dense durable claim."],
        conditions: [],
        exclusions: [],
        preservedNegations: []
      }
    }]
  })).resolves.toMatchObject({
    items: [{ memoryId: "msmem_1", compactText: overlong }]
  });
  expect(callCount).toBe(2);
});

test("compact validation restores exact Memory identities from short aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-compact-validation-alias-"));
  temporaryDirectories.push(root);
  const originalId = "msmem_8e24a0de-56fa-4ddb-9432-1e3d6274c828";
  let prompt: {
    request?: { memories?: Array<{ memoryId?: unknown }> };
  } = {};
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: (request) => {
      prompt = JSON.parse(request.standardInput) as typeof prompt;
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          kind: "compact_validation",
          items: [{ memoryId: "m1", state: "preserves", reasonCode: "claim_preserved" }]
        }),
        stderr: ""
      });
    }
  });
  const memory = {
    memoryId: originalId,
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174080",
    body: "A durable claim.",
    compactText: "A durable claim.",
    applicability: { summary: "Current project", conditions: [] },
    semanticContract: {
      schemaVersion: 1 as const,
      claims: ["A durable claim."],
      conditions: [],
      exclusions: [],
      preservedNegations: []
    }
  };

  await expect(adapter.validateCompacts({
    operationId: "validation-alias-1",
    memories: [memory]
  })).resolves.toMatchObject({ items: [{ memoryId: originalId, state: "preserves" }] });
  expect(prompt.request?.memories?.map((item) => item.memoryId)).toEqual(["m1"]);
});

test("duplicate assessment returns only a bounded decision for supplied cluster identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-duplicates-"));
  temporaryDirectories.push(root);
  let prompt: unknown;
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: (request) => {
      prompt = JSON.parse(request.standardInput) as unknown;
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          kind: "duplicate_assessment",
          items: [{
            clusterId: "msdupe_1",
            decision: "equivalent",
            reasonCode: "same_claim_same_applicability"
          }]
        }),
        stderr: ""
      });
    }
  });
  const side = {
    memoryId: "msmem_1",
    revisionId: "msrev_1",
    body: "Run typecheck before release.",
    scope: { kind: "global" as const },
    applicability: { summary: "Releases", conditions: [] },
    semanticContract: {
      schemaVersion: 1 as const,
      claims: ["Run typecheck before release."],
      conditions: [],
      exclusions: [],
      preservedNegations: []
    }
  };

  await expect(adapter.assessDuplicateClusters({
    operationId: "duplicate-1",
    clusters: [{
      clusterId: "msdupe_1",
      similarity: 0.95,
      left: side,
      right: { ...side, memoryId: "msmem_2", revisionId: "msrev_2" }
    }]
  })).resolves.toMatchObject({ kind: "duplicate_assessment" });
  expect(prompt).toMatchObject({ task: "assess_memory_duplicate_clusters" });
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
  const codexHome = join(root, "codex-home");
  const skillPath = join(codexHome, "skills", "example", "SKILL.md");
  const externalSkillDirectory = join(root, "external-skill");
  const linkedSkillPath = join(codexHome, "skills", "linked", "SKILL.md");
  const isolatedHome = join(root, "persistent-luna-home");
  await mkdir(dirname(skillPath), { recursive: true });
  await writeFile(skillPath, "---\nname: example\ndescription: must stay hidden\n---\n", "utf8");
  await mkdir(externalSkillDirectory, { recursive: true });
  await writeFile(
    join(externalSkillDirectory, "SKILL.md"),
    "---\nname: linked\ndescription: must also stay hidden\n---\n",
    "utf8"
  );
  await symlink(externalSkillDirectory, dirname(linkedSkillPath), "dir");
  await mkdir(isolatedHome, { recursive: true });
  await chmod(isolatedHome, 0o755);
  const requests: LunaProcessRequest[] = [];
  const adapter = new CodexLunaAdapter({
    codexExecutable: "/opt/bin/codex",
    codexHome,
    isolatedHome,
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
              durability: {
                disposition: "long_term",
                futureReuseScenario: "Resolve Project Memory consistently in a future session.",
                horizon: "indefinite",
                invalidationTriggers: [],
                abstractionLevel: "reusable_rule",
                observableFromWorkspace: false
              },
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
  expect(result.candidates[0]?.durability).toEqual({
    disposition: "long_term",
    futureReuseScenario: "Resolve Project Memory consistently in a future session.",
    horizon: "indefinite",
    invalidationTriggers: [],
    abstractionLevel: "reusable_rule",
    observableFromWorkspace: false
  });
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
      "--strict-config",
      "--ignore-user-config",
      "--output-schema",
      "-"
    ])
  );
  expect(request.arguments).toEqual(expect.arrayContaining([
    "-c",
    'service_tier="default"'
  ]));
  expect(request.arguments).not.toContain('service_tier="fast"');
  const configIndex = request.arguments.indexOf("-c");
  expect(configIndex).toBeGreaterThan(-1);
  expect(request.arguments[configIndex + 1]).toBe(
    `skills.config=[{path=${JSON.stringify(skillPath)},enabled=false},{path=${JSON.stringify(linkedSkillPath)},enabled=false}]`
  );
  expect(request.standardInput).toContain("Split mixed evidence into atomic clauses before classifying retention");
  expect(request.environment.CODEX_HOME).toBe(codexHome);
  expect(request.environment.HOME).toBe(isolatedHome);
  expect((await stat(isolatedHome)).mode & 0o777).toBe(0o700);
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
          durability: makeLongTermCandidateDurability(),
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
          durability: makeLongTermCandidateDurability(),
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

  expect(structuredRequest?.promptVersion).toBe(5);
  expect(structuredRequest?.rules).toEqual(expect.arrayContaining([
    "Return no Candidate for operational probes or exact-response checks.",
    "Return no Candidate for task-local instructions, temporary progress or state, or unverified future plans.",
    "If evidence says content must not be retained, return no Candidate derived from that content.",
    "Split mixed evidence into atomic clauses before classifying retention; emit one Candidate per clause and never attach a transient observation to a durable rule.",
    "Project-specific knowledge is long_term when it is expected to remain useful across future sessions; use project_phase only when evidence explicitly binds it to a finite migration, feature, incident, experiment, or release phase. A possible future invalidation condition alone does not make knowledge project_phase."
  ]));
});

test("distillation exposes every atomic retention decision for downstream admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-atomic-admission-"));
  temporaryDirectories.push(root);
  const base = {
    primaryCategory: "architecture_contract",
    categoryTags: ["architecture_contract"],
    applicabilitySummary: "Release verification",
    conditions: [],
    exclusions: [],
    preservedNegations: [],
    certainty: "asserted",
    sensitivity: "normal",
    evidenceIds: ["e1"],
    importanceReasons: []
  };
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: () => Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        kind: "distillation",
        candidates: [
          {
            ...base,
            statement: "Run typecheck before every release.",
            retentionDecision: "long_term",
            durability: {
              futureReuseScenario: "Verify a future release.",
              horizon: "indefinite",
              invalidationTriggers: [],
              abstractionLevel: "reusable_rule",
              observableFromWorkspace: false
            }
          },
          {
            ...base,
            statement: "The current typecheck completed at 10:30.",
            retentionDecision: "session_only",
            durability: {
              futureReuseScenario: "Describe this run.",
              horizon: "session",
              invalidationTriggers: [],
              abstractionLevel: "task_observation",
              observableFromWorkspace: true
            }
          }
        ]
      }),
      stderr: ""
    })
  });

  const output = await adapter.distillBatch({
    operationId: "atomic-admission",
    scope: { kind: "global" },
    evidence: [{
      evidenceId: "source-1",
      evidenceClass: "explicit_user_statement",
      content: "Run typecheck before every release. It completed at 10:30 today.",
      sourceIdentity: "codex:atomic-admission",
      sourceTruncated: false,
      memoryEcho: false
    }]
  });

  expect(output.candidates).toHaveLength(2);
  expect(output.candidates[0]?.statement).toBe("Run typecheck before every release.");
  expect(output.candidates[0]?.retentionDecision).toBe("long_term");
  expect(output.candidates[0]?.durability.disposition).toBe("long_term");
  expect(output.candidates[1]?.statement).toBe("The current typecheck completed at 10:30.");
  expect(output.candidates[1]?.retentionDecision).toBe("session_only");
  expect(output.candidates[1]?.durability.disposition).toBe("session_only");
});

test("consolidation exposes rejected retention decisions for downstream admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-consolidation-admission-"));
  temporaryDirectories.push(root);
  const common = {
    primaryCategory: "workflow_environment_toolchain",
    categoryTags: ["workflow_environment_toolchain"],
    applicabilitySummary: "future project work",
    conditions: [],
    exclusions: [],
    preservedNegations: [],
    certainty: "asserted",
    sensitivity: "normal",
    evidenceIds: ["e1"],
    importanceReasons: []
  } as const;
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: () => Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        kind: "consolidation",
        candidates: [
          {
            ...common,
            statement: "Future releases require a clean typecheck.",
            retentionDecision: "long_term",
            durability: {
              futureReuseScenario: "Verify a future release.",
              horizon: "indefinite",
              invalidationTriggers: [],
              abstractionLevel: "reusable_rule",
              observableFromWorkspace: false
            }
          },
          {
            ...common,
            statement: "The typecheck completed at 10:00 today.",
            retentionDecision: "no_memory",
            durability: {
              futureReuseScenario: "Describe this run.",
              horizon: "session",
              invalidationTriggers: [],
              abstractionLevel: "task_observation",
              observableFromWorkspace: true
            }
          }
        ]
      }),
      stderr: ""
    })
  });

  const output = await adapter.consolidateSession({
    operationId: "consolidation-admission",
    sessionId: "consolidation-admission-session",
    batchResults: [{
      batchId: "batch-1",
      candidates: [],
      evidenceIds: ["source-evidence"]
    }]
  });

  expect(output.candidates.map((candidate) => candidate.retentionDecision))
    .toEqual(["long_term", "no_memory"]);
});

test("consolidation cannot upgrade project-phase evidence to long-term retention", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-consolidation-upgrade-"));
  temporaryDirectories.push(root);
  const candidate = {
    statement: "This migration workaround applies until the migration ends.",
    primaryCategory: "workflow_environment_toolchain" as const,
    categoryTags: ["workflow_environment_toolchain" as const],
    applicabilitySummary: "during the active migration",
    conditions: [],
    exclusions: [],
    preservedNegations: [],
    certainty: "asserted" as const,
    sensitivity: "normal" as const,
    evidenceIds: ["source-evidence"],
    retentionDecision: "project_phase" as const,
    durability: {
      disposition: "project_phase" as const,
      futureReuseScenario: "Reuse until the migration is complete.",
      horizon: "until_condition" as const,
      invalidationTriggers: ["Migration completed."],
      abstractionLevel: "project_fact" as const,
      observableFromWorkspace: false
    },
    importanceTags: [],
    importanceReasons: []
  };
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: () => Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        kind: "consolidation",
        candidates: [{
          ...candidate,
          evidenceIds: ["e1"],
          retentionDecision: "long_term",
          durability: {
            ...candidate.durability,
            disposition: undefined,
            horizon: "indefinite"
          }
        }]
      }),
      stderr: ""
    })
  });

  await expect(adapter.consolidateSession({
    operationId: "consolidation-upgrade",
    sessionId: "consolidation-upgrade-session",
    batchResults: [{
      batchId: "batch-1",
      candidates: [candidate],
      evidenceIds: ["source-evidence"]
    }]
  })).rejects.toMatchObject({
    category: "schema_invalid",
    diagnostic: { stage: "retention_validation", code: "retention_upgrade" }
  });
});

test("distillation accepts more than 64 raw clauses when admission can reduce them", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-raw-clause-limit-"));
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
        candidates: Array.from({ length: 70 }, (_, index) => ({
          statement: `Atomic clause ${String(index)}.`,
          primaryCategory: "durable_reference",
          categoryTags: ["durable_reference"],
          applicabilitySummary: "this recorded run",
          conditions: [],
          exclusions: [],
          preservedNegations: [],
          certainty: "asserted",
          sensitivity: "normal",
          evidenceIds: ["e1"],
          retentionDecision: index < 5 ? "long_term" : "no_memory",
          durability: {
            futureReuseScenario: index < 5 ? "Reuse in a future Session." : "No future reuse.",
            horizon: index < 5 ? "indefinite" : "session",
            invalidationTriggers: [],
            abstractionLevel: index < 5 ? "reusable_rule" : "task_observation",
            observableFromWorkspace: index >= 5
          },
          importanceReasons: []
        }))
      }),
      stderr: ""
    })
  });

  await expect(adapter.distillBatch({
    operationId: "raw-clause-limit",
    scope: { kind: "project", projectId: "msproj-raw-clause-limit" },
    evidence: [{
      evidenceId: "source-evidence",
      evidenceClass: "agent_summary",
      content: "A long Session with many atomic observations.",
      sourceIdentity: "codex:raw-clause-limit",
      sourceTruncated: false,
      memoryEcho: false
    }]
  })).resolves.toMatchObject({ candidates: { length: 70 } });
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
            durability: makeLongTermCandidateDurability(),
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
            durability: makeLongTermCandidateDurability(),
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

test("an uppercase Codex ERROR block preserves the invalid JSON schema classification", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-api-schema-uppercase-"));
  temporaryDirectories.push(root);
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: () => Promise.resolve({
      exitCode: 1,
      stdout: "",
      stderr: [
        "request failed",
        "ERROR: {",
        "  \"error\": {",
        "    \"code\": \"invalid_json_schema\",",
        "    \"message\": \"Schema must have a type key.\",",
        "    \"param\": \"text.format.schema\"",
        "  },",
        "  \"status\": 400",
        "}"
      ].join("\n")
    })
  });

  await expect(adapter.assessCandidateSemantics({
    operationId: "schema-failure-uppercase",
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
  expect(requests[0]?.standardInput).toContain('"promptVersion":5');
  expect(requests[0]?.standardInput).toContain('"task":"consolidate_session_candidates"');
  expect(requests[0]?.timeoutMilliseconds).toBe(300_000);
  expect(requests[1]?.standardInput).toContain('"promptVersion":3');
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
            durability: makeLongTermCandidateDurability(),
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
        durability: makeLongTermCandidateDurability(),
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
            durability: makeLongTermCandidateDurability(),
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
        durability: makeLongTermCandidateDurability(),
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
            durability: makeLongTermCandidateDurability(),
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

test("semantic assessment uses short evidence aliases and restores exact source identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-luna-semantic-alias-"));
  temporaryDirectories.push(root);
  const originalEvidenceId = "msevent_semantic_evidence_identity_that_must_not_be_retyped";
  let promptSource = "";
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: (request) => {
      promptSource = request.standardInput;
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          kind: "semantic_assessment",
          state: "supported",
          durabilityDisposition: "durable",
          evidenceIds: ["e1"]
        }),
        stderr: ""
      });
    }
  });

  await expect(adapter.assessCandidateSemantics({
    operationId: "msop-semantic-alias",
    statement: "Use a stable package manager for this repository.",
    conditions: [],
    exclusions: [],
    evidence: [{
      evidenceId: originalEvidenceId,
      evidenceClass: "explicit_user_statement",
      content: "Use pnpm for this repository.",
      sourceIdentity: "source-semantic-alias",
      sourceTruncated: false,
      memoryEcho: false
    }]
  })).resolves.toMatchObject({
    state: "supported",
    evidenceIds: [originalEvidenceId]
  });
  expect(promptSource).not.toContain(originalEvidenceId);
  expect(promptSource).toContain('"evidenceId":"e1"');
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
          durability: makeLongTermCandidateDurability(),
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
