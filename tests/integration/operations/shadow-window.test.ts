import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { handleCodexHook } from "../../../src/adapters/codex/hook.js";
import { recordAdmissionAudit } from "../../../src/admission/audit.js";
import { enqueueLunaOperation } from "../../../src/luna/operations.js";
import { initializeMemStore } from "../../../src/operations/initialize.js";
import {
  inspectOfficialShadowWindow,
  startOfficialShadowWindow
} from "../../../src/operations/shadow-window.js";
import {
  buildRetrievalIndex,
  type EmbeddingAdapter
} from "../../../src/retrieval/index.js";
import { approvedShadowEmbeddingProfile } from "../../../src/retrieval/shadow-profile.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { runWorkerOnce } from "../../../src/worker/main.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";
import { makeLongTermCandidateDurability } from "../../helpers/candidate-durability.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const approvedEmbedding: EmbeddingAdapter = {
  identity: {
    adapterVersion: approvedShadowEmbeddingProfile.adapterVersion,
    modelIdentity: approvedShadowEmbeddingProfile.modelIdentity,
    artifactSha256: approvedShadowEmbeddingProfile.artifactSha256,
    dimensions: approvedShadowEmbeddingProfile.dimensions,
    normalization: approvedShadowEmbeddingProfile.normalization
  },
  embed: (texts) => Promise.resolve(texts.map(() => {
    const vector = Array.from({ length: approvedShadowEmbeddingProfile.dimensions }, () => 0);
    vector[0] = 1;
    return vector;
  }))
};

test("an official Shadow window requires a completed real-Hook probe and records a frozen baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-official-shadow-"));
  roots.push(root);
  const homeRoot = join(root, "home");
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const projectRoot = join(root, "project");
  const repositoryRoot = join(root, "repository");
  await Promise.all([
    mkdir(join(homeRoot, ".codex"), { recursive: true }),
    mkdir(join(runtimeRoot, "install"), { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
    mkdir(join(repositoryRoot, "config"), { recursive: true }),
    mkdir(join(repositoryRoot, "dist", "cli"), { recursive: true })
  ]);
  await writeFile(
    join(repositoryRoot, "config", "gate5-shadow-v1.json"),
    await readFile(join(process.cwd(), "config", "gate5-shadow-v1.json"), "utf8")
  );
  const programPath = join(repositoryRoot, "dist", "cli", "main.js");
  await writeFile(programPath, "export const fixture = true;\n");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  await writeFile(join(projectRoot, ".memstore-project"), JSON.stringify({
    schema_version: 1,
    project_id: "msproj_123e4567-e89b-42d3-a456-426614174970"
  }));
  await writeFile(join(homeRoot, ".codex", "config.toml"), [
    "model = \"fixture\"",
    "",
    "[memories]",
    "generate_memories = true",
    "use_memories = true",
    "",
    "[mcp_servers.memstore]",
    "command = \"node\"",
    "args = [\"dist/mcp/main.js\"]",
    "startup_timeout_sec = 30",
    "",
    "[mcp_servers.memstore.env]",
    "MEMSTORE_RUNTIME_ROOT = \"/fixture/runtime\"",
    "MEMSTORE_VAULT_ROOT = \"/fixture/vault\"",
    ""
  ].join("\n"));
  await writeFile(join(homeRoot, ".codex", "hooks.json"), JSON.stringify({
    hooks: Object.fromEntries(
      ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"].map((event) => [
        event,
        [{ hooks: [{ command: `memstore:gate5-shadow-v1:${event}:shadow` }] }]
      ])
    )
  }));
  await writeFile(join(runtimeRoot, "install", "ownership-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    installationId: "msinstall_shadow_fixture",
    candidateId: "gate5-shadow-v1",
    state: "installed"
  }));

  const captured = await handleCodexHook({
    runtimeRoot,
    receivedAt: "2026-08-09T03:00:00.000Z",
    input: {
      hook_event_name: "UserPromptSubmit",
      session_id: "official-shadow-session",
      turn_id: "official-shadow-turn",
      cwd: projectRoot,
      prompt: "Verify the official Shadow baseline."
    }
  });
  if (!captured.captured) throw new Error("Expected the trusted Hook probe to be captured.");
  await runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "official-shadow-worker",
    now: "2026-08-09T03:00:01.000Z",
    workerStartedAt: "2026-08-09T03:00:01.000Z",
    adapters: { embedding: approvedEmbedding }
  });

  const request = {
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    probeEventId: captured.eventId,
    startedAt: "2026-08-09T03:00:02.000Z"
  };
  await expect(startOfficialShadowWindow({ ...request, preview: true })).resolves.toMatchObject({
    state: "preview",
    dryRun: true,
    minimumEndAt: "2026-08-16T03:00:02.000Z"
  });
  await expect(startOfficialShadowWindow(request)).resolves.toMatchObject({
    state: "active",
    dryRun: false,
    minimumEndAt: "2026-08-16T03:00:02.000Z"
  });
  const reviewMemory = makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174971",
    revisionId: "msrev_123e4567-e89b-42d3-a456-426614174972",
    scope: {
      kind: "project",
      projectId: "msproj_123e4567-e89b-42d3-a456-426614174970"
    },
    authority: "agent_derived",
    primaryCategory: "architecture_contract",
    body: "Keep the runtime database outside the portable Vault.",
    compact: "Keep runtime state outside the Vault.",
    standard: "Keep the runtime database outside the portable Obsidian Vault."
  });
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory: reviewMemory
  });
  const reviewFixture = await openRuntimeDatabase(runtimeRoot);
  try {
    reviewFixture.prepare(
      `INSERT INTO memory_candidates(
         candidate_id, fingerprint, scope_kind, project_id, statement,
         category, certainty, state, high_value, sensitivity,
         source_session_id, created_at, last_evidence_at, updated_at,
         promoted_memory_id, promotion_revision_id, promotion_generation
       ) VALUES (?, ?, 'project', ?, ?, 'architecture_contract', 'asserted',
                 'promoted', 1, 'normal', ?, ?, ?, ?, ?, ?, 1)`
    ).run(
      "mscandidate_123e4567-e89b-42d3-a456-426614174973",
      "f".repeat(64),
      "msproj_123e4567-e89b-42d3-a456-426614174970",
      "Keep the runtime database outside the portable Vault.",
      "official-shadow-session",
      "2026-08-09T03:00:02.100Z",
      "2026-08-09T03:00:02.100Z",
      "2026-08-09T03:00:02.100Z",
      reviewMemory.memoryId,
      reviewMemory.revisionId
    );
    reviewFixture.prepare(
      `INSERT INTO candidate_evidence(
         candidate_id, evidence_id, evidence_class, source_identity,
         project_id, occurred_at, integrity, source_truncated, memory_echo,
         command_text, command_cwd
       ) VALUES (?, ?, 'tool_result', ?, ?, ?, 'intact', 0, 0, ?, ?)`
    ).run(
      "mscandidate_123e4567-e89b-42d3-a456-426614174973",
      "msevidence_123e4567-e89b-42d3-a456-426614174974",
      "tool:exec_command",
      "msproj_123e4567-e89b-42d3-a456-426614174970",
      "2026-08-09T03:00:02.050Z",
      "memstore status --json",
      projectRoot
    );
  } finally {
    reviewFixture.close();
  }
  await expect(startOfficialShadowWindow({
    ...request,
    startedAt: "2026-08-09T03:00:03.000Z"
  })).rejects.toThrow("An official Shadow window is already active.");
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: approvedEmbedding,
    builtAt: "2026-08-09T03:00:04.000Z"
  });
  const readinessFixture = await openRuntimeDatabase(runtimeRoot);
  try {
    readinessFixture.prepare(
      `UPDATE retrieval_receipts
       SET created_at = '2026-08-09T03:00:03.000Z', latency_ms = 600,
           semantic_stage = 'complete',
           timing_json = '{"epochLoadMs":10,"scopeLoadMs":20,"embeddingMs":300,"vectorScanMs":40,"rankingAndRelationshipMs":50,"receiptWriteMs":180,"totalMs":600}'
       WHERE caller_kind = 'user_prompt'`
    ).run();
    const insertCandidate = readinessFixture.prepare(
      `INSERT INTO memory_candidates(
         candidate_id, fingerprint, scope_kind, project_id, statement,
         candidate_json, category, certainty, state, high_value, sensitivity,
         source_session_id, created_at, last_evidence_at, updated_at
       ) VALUES (?, ?, 'project', ?, ?, ?, 'workflow_environment_toolchain',
                 'asserted', 'waiting', 0, 'normal', ?, ?, ?, ?)`
    );
    const insertDecision = readinessFixture.prepare(
      `INSERT INTO governance_decisions(
         decision_id, candidate_id, decision, reason, decided_at
       ) VALUES (?, ?, 'wait', ?, ?)`
    );
    for (const [suffix, disposition, reason] of [
      ["session", "session_only", "durability_session_only_hold"],
      ["phase", "project_phase", "durability_project_phase_hold"]
    ] as const) {
      const candidateId = `mscandidate_shadow_durability_${suffix}`;
      const recordedAt = `2026-08-10T03:00:0${suffix === "session" ? "1" : "2"}.000Z`;
      insertCandidate.run(
        candidateId,
        `shadow-durability-${suffix}`,
        "msproj_123e4567-e89b-42d3-a456-426614174970",
        "This body must not appear in the Shadow report.",
        JSON.stringify({
          statement: "This body must not appear in the Shadow report.",
          primaryCategory: "workflow_environment_toolchain",
          categoryTags: ["workflow_environment_toolchain"],
          durability: {
            disposition,
            futureReuseScenario: "This explanation must not appear in the Shadow report.",
            horizon: disposition === "session_only" ? "session" : "until_condition",
            invalidationTriggers: ["This trigger must not appear in the Shadow report."],
            abstractionLevel: disposition === "session_only" ? "task_observation" : "project_fact",
            observableFromWorkspace: true
          }
        }),
        `shadow-durability-${suffix}`,
        recordedAt,
        recordedAt,
        recordedAt
      );
      insertDecision.run(
        `msdecision_shadow_durability_${suffix}`,
        candidateId,
        reason,
        recordedAt
      );
    }
  } finally {
    readinessFixture.close();
  }
  const admissionOperation = await enqueueLunaOperation({
    runtimeRoot,
    kind: "distill_batch",
    idempotencyKey: "shadow-admission-fixture",
    payload: { batchId: "shadow-admission-batch" },
    createdAt: "2026-08-10T04:00:00.000Z"
  });
  const admissionCommon = {
    primaryCategory: "durable_reference" as const,
    categoryTags: ["durable_reference" as const],
    applicabilitySummary: "future project work",
    conditions: [],
    exclusions: [],
    preservedNegations: [],
    certainty: "asserted" as const,
    sensitivity: "normal" as const,
    evidenceIds: ["shadow-admission-evidence"],
    importanceTags: [],
    importanceReasons: []
  };
  await recordAdmissionAudit({
    runtimeRoot,
    operationId: admissionOperation.operationId,
    sourceKind: "distillation",
    sourceId: "shadow-admission-batch",
    candidates: [
      {
        ...admissionCommon,
        statement: "Keep this durable rule.",
        retentionDecision: "long_term",
        durability: makeLongTermCandidateDurability()
      },
      {
        ...admissionCommon,
        statement: "The current run completed at 04:00.",
        retentionDecision: "no_memory",
        durability: {
          ...makeLongTermCandidateDurability(),
          disposition: "session_only",
          horizon: "session",
          abstractionLevel: "task_observation"
        }
      },
      {
        ...admissionCommon,
        statement: "A one-off finding may be durable.",
        retentionDecision: "uncertain",
        durability: {
          ...makeLongTermCandidateDurability(),
          disposition: "session_only",
          horizon: "session"
        }
      }
    ],
    promptVersion: 5,
    createdAt: "2026-08-10T04:00:01.000Z"
  });
  const consolidationOperation = await enqueueLunaOperation({
    runtimeRoot,
    kind: "consolidate_session",
    idempotencyKey: "shadow-consolidation-fixture",
    payload: { sessionId: "shadow-admission-session" },
    createdAt: "2026-08-10T04:00:02.000Z"
  });
  const dispositionFixture = await openRuntimeDatabase(runtimeRoot);
  try {
    dispositionFixture.prepare(
      `INSERT INTO distillation_batches(
         batch_id, session_id, project_id, batch_ordinal, state,
         operation_id, result_json, created_at, completed_at
       ) VALUES (?, ?, NULL, 0, 'completed', ?, ?, ?, ?)`
    ).run(
      "shadow-admission-batch",
      "shadow-admission-session",
      admissionOperation.operationId,
      JSON.stringify({
        schemaVersion: 1,
        kind: "distillation",
        candidates: [],
        rejectionSummary: {
          schemaVersion: 1,
          coverage: "considered_memory_shaped_rejections_only",
          counts: { no_memory: 2, session_only: 1, uncertain: 1, source_echo: 3 },
          samples: [{
            reason: "source_echo",
            proposition: "A supplied specification was repeated without a new conclusion.",
            evidenceIds: ["shadow-admission-evidence"]
          }]
        }
      }),
      "2026-08-10T04:00:00.000Z",
      "2026-08-10T04:00:01.000Z"
    );
    dispositionFixture.prepare(
      `INSERT INTO session_consolidations(
         session_id, operation_id, state, result_json, created_at, completed_at
       ) VALUES (?, ?, 'completed', ?, ?, ?)`
    ).run(
      "shadow-admission-session",
      consolidationOperation.operationId,
      JSON.stringify({
        schemaVersion: 1,
        kind: "consolidation",
        candidates: [],
        consolidationSummary: {
          schemaVersion: 1,
          counts: { dedup: 2, source_echo: 1, downgrade: 1 },
          samples: [{
            action: "dedup",
            evidenceIds: ["shadow-admission-evidence"],
            note: "Equivalent candidates were represented once."
          }]
        }
      }),
      "2026-08-10T04:00:02.000Z",
      "2026-08-10T04:00:03.000Z"
    );
  } finally {
    dispositionFixture.close();
  }
  await expect(inspectOfficialShadowWindow({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    now: "2026-08-16T03:00:02.000Z"
  })).resolves.toMatchObject({
    state: "active",
    elapsedCalendarDays: 7,
    minimumDurationMet: true,
    gate6ReviewEligible: true,
    coverage: {
      completed_evaluations: { baseline: 1, current: 1, delta: 0 }
    }
  });
  await expect(inspectOfficialShadowWindow({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    now: "2026-08-16T03:00:02.000Z",
    includeReadinessReport: true
  })).resolves.toMatchObject({
    readinessReport: {
      latency: {
        user_prompt: {
          count: 1,
          p50Ms: 600,
          p95Ms: 600,
          p99Ms: 600,
          over500MsCount: 1
        }
      },
      userPromptStageTimings: {
        embeddingMs: { count: 1, p50Ms: 300, p95Ms: 300, p99Ms: 300 },
        receiptWriteMs: { count: 1, p50Ms: 180, p95Ms: 180, p99Ms: 180 },
        totalMs: { count: 1, p50Ms: 600, p95Ms: 600, p99Ms: 600 }
      },
      snapshotRetention: {
        totalSnapshots: 2,
        pendingRetiredSnapshots: 1,
        prunedSnapshots: 0,
        activeDocuments: 1,
        retainedDocuments: 1
      },
      candidateDurability: {
        policyVersion: "candidate-durability-v1",
        classified: {
          longTerm: 0,
          projectPhase: 1,
          sessionOnly: 1,
          legacyUnclassified: 1
        },
        promotionComparison: {
          heldBeforeCanonical: 2,
          wouldHavePromotedWithoutDurabilityGate: 2
        },
        heldCandidateSamples: [
          {
            candidateId: "mscandidate_shadow_durability_phase",
            disposition: "project_phase"
          },
          {
            candidateId: "mscandidate_shadow_durability_session",
            disposition: "session_only"
          }
        ]
      },
      admissionAudit: {
        policyVersion: "durable-candidate-admission-v2",
        retentionDays: 14,
        totalCount: 3,
        outcomes: {
          admitted: 1,
          rejected: 1,
          isolated: 1
        },
        decisions: {
          long_term: 1,
          project_phase: 0,
          session_only: 0,
          no_memory: 1,
          uncertain: 1
        },
        reasons: {
          long_term: 1,
          project_phase: 0,
          session_only: 0,
          no_memory: 1,
          uncertain: 1,
          task_observation: 0
        },
        redactedCount: 0,
        admittedTiers: {
          long_term: 1,
          project_phase: 0
        },
        rejectedSamples: [
          expect.objectContaining({
            retentionDecision: "no_memory",
            reason: "no_memory",
            statement: "The current run completed at 04:00."
          })
        ],
        isolatedSamples: [
          expect.objectContaining({
            retentionDecision: "uncertain",
            reason: "uncertain",
            statement: "A one-off finding may be durable."
          })
        ]
      },
      modelDispositions: {
        distillation: {
          operationCount: 1,
          coverage: "considered_memory_shaped_rejections_only",
          counts: { no_memory: 2, session_only: 1, uncertain: 1, source_echo: 3 }
        },
        consolidation: {
          operationCount: 1,
          counts: { dedup: 2, source_echo: 1, downgrade: 1 }
        }
      },
      knowledgeVerification: {
        runCount: 0,
        latest: null
      },
      knowledgeSamples: {
        architecture_contract: [
          expect.objectContaining({
            memoryId: reviewMemory.memoryId,
            statement: "Keep the runtime database outside the portable Vault.",
            compactText: "Keep runtime state outside the Vault.",
            evidence: [
              expect.objectContaining({
                sourceIdentity: "tool:exec_command",
                commandText: "memstore status --json",
                memoryEcho: false
              })
            ]
          })
        ]
      },
      retrievalSamples: {
        complete: [
          expect.objectContaining({
            normalizedQuery: "Verify the official Shadow baseline.",
            selected: [],
            omitted: []
          })
        ],
        lexical_only: []
      }
    }
  });

  const changedAdapter: EmbeddingAdapter = {
    ...approvedEmbedding,
    identity: {
      ...approvedEmbedding.identity,
      adapterVersion: "transformers-changed-for-test"
    }
  };
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: changedAdapter,
    builtAt: "2026-08-16T03:00:02.100Z"
  });
  const changedIndexStatus = await inspectOfficialShadowWindow({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    now: "2026-08-16T03:00:02.200Z"
  });
  expect(changedIndexStatus).toMatchObject({
    state: "active",
    gate6ReviewEligible: true,
    observedChanges: ["retrieval_index_changed"]
  });
  expect(changedIndexStatus).not.toHaveProperty("invalidationReasons");
  expect(changedIndexStatus).not.toHaveProperty("continuityAdjustments");
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter: approvedEmbedding,
    builtAt: "2026-08-16T03:00:02.300Z"
  });
  await writeFile(programPath, "export const fixture = false;\n");
  await expect(inspectOfficialShadowWindow({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    now: "2026-08-16T03:00:02.500Z"
  })).resolves.toMatchObject({
    state: "active",
    gate6ReviewEligible: true,
    observedChanges: ["program_changed"],
    startedAt: "2026-08-09T03:00:02.000Z",
    minimumEndAt: "2026-08-16T03:00:02.000Z",
    coverage: { completed_evaluations: { baseline: 1, current: 1, delta: 0 } }
  });
  await writeFile(programPath, "export const fixture = true;\n");
  await writeFile(join(homeRoot, ".codex", "config.toml"), [
    "model = \"fixture\"",
    "",
    "[memories]",
    "generate_memories = false",
    "use_memories = false",
    "",
    "[mcp_servers.memstore]",
    "command = \"node\"",
    "args = [\"dist/mcp/main.js\"]",
    "startup_timeout_sec = 30",
    "",
    "[mcp_servers.memstore.env]",
    "MEMSTORE_RUNTIME_ROOT = \"/fixture/runtime\"",
    "MEMSTORE_VAULT_ROOT = \"/fixture/vault\"",
    ""
  ].join("\n"));
  await expect(inspectOfficialShadowWindow({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    now: "2026-08-16T03:00:03.000Z"
  })).resolves.toMatchObject({
    state: "active",
    gate6ReviewEligible: true,
    observedChanges: [],
    nativeMemory: { generateMemories: false, useMemories: false }
  });

  const hooksPath = join(homeRoot, ".codex", "hooks.json");
  const hooksWithUnrelatedChange = JSON.parse(await readFile(hooksPath, "utf8")) as {
    hooks: Record<string, unknown[]>;
  };
  hooksWithUnrelatedChange.hooks.PostToolUse?.unshift({
    matcher: "unrelated",
    hooks: [{ command: "unrelated-hook", timeout: 99 }]
  });
  await writeFile(hooksPath, JSON.stringify(hooksWithUnrelatedChange));
  await expect(inspectOfficialShadowWindow({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    now: "2026-08-16T03:00:03.100Z"
  })).resolves.toMatchObject({
    state: "active",
    observedChanges: []
  });

  await writeFile(join(homeRoot, ".codex", "config.toml"), [
    "model = \"fixture\"",
    "",
    "[memories]",
    "generate_memories = true",
    "use_memories = true",
    "",
    "[mcp_servers.memstore]",
    "command = \"node\"",
    "args = [\"dist/mcp/main.js\"]",
    "startup_timeout_sec = 31",
    "",
    "[mcp_servers.memstore.env]",
    "MEMSTORE_RUNTIME_ROOT = \"/fixture/runtime\"",
    "MEMSTORE_VAULT_ROOT = \"/fixture/vault\"",
    ""
  ].join("\n"));
  await expect(inspectOfficialShadowWindow({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    now: "2026-08-16T03:00:03.200Z"
  })).resolves.toMatchObject({
    state: "active",
    gate6ReviewEligible: true,
    observedChanges: ["codex_config_changed"]
  });
  const hooksWithManagedChange = JSON.parse(await readFile(hooksPath, "utf8")) as {
    hooks: Record<string, Array<{ hooks?: Array<Record<string, unknown>> }>>;
  };
  const managedPostToolUse = hooksWithManagedChange.hooks.PostToolUse
    ?.flatMap((route) => route.hooks ?? [])
    .find((hook) =>
      typeof hook.command === "string" &&
      hook.command.includes("memstore:gate5-shadow-v1:PostToolUse:shadow")
    );
  if (managedPostToolUse === undefined) throw new Error("Expected managed PostToolUse Hook.");
  managedPostToolUse.timeout = 2;
  await writeFile(hooksPath, JSON.stringify(hooksWithManagedChange));
  await expect(inspectOfficialShadowWindow({
    runtimeRoot,
    repositoryRoot,
    homeRoot,
    now: "2026-08-16T03:00:07.000Z"
  })).resolves.toMatchObject({
    state: "active",
    gate6ReviewEligible: true,
    observedChanges: ["codex_config_changed", "hooks_changed"]
  });
  await expect(startOfficialShadowWindow({
    ...request,
    startedAt: "2026-08-16T03:00:08.000Z"
  })).rejects.toThrow("An official Shadow window is already active.");
});
