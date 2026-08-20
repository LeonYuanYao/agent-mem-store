import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getEncoding } from "js-tiktoken";
import { z } from "zod";

import {
  governanceOutputJsonSchema,
  governanceOutputSchema,
  type GovernancePageRequest,
  type GovernancePageReview
} from "../governance/contracts.js";
import {
  memoryCategoryJsonSchema,
  memoryCategoryPromptInstruction,
  memoryCategorySchema,
  selectPrimaryCategory
} from "../memories/categories.js";
import type {
  CompactGenerationMemory,
  CompactValidationMemory
} from "../quality/pipeline.js";
import type { DuplicateClusterInput } from "../quality/duplicates.js";

const compactTokenizer = getEncoding("o200k_base");
const compactHardTokenLimit = 96;

const importanceTagSchema = z.enum([
  "user_decision",
  "stable_preference",
  "constraint",
  "exception",
  "architecture_invariant",
  "api_contract",
  "security_boundary",
  "data_loss_risk",
  "irreversible_operation",
  "failure_root_cause",
  "effective_repair",
  "recovery_procedure",
  "recurrence_hazard",
  "expensive_rediscovery",
  "limitation",
  "negation",
  "applicability_correction"
]);

const importanceReasonSchema = z.object({
  tag: importanceTagSchema,
  reason: z.string().min(1).max(512),
  evidenceIds: z.array(z.string().min(1)).min(1).max(16)
});

const distilledCandidateSchema = z.object({
  statement: z.string().min(1).max(16_384),
  primaryCategory: memoryCategorySchema,
  categoryTags: z.array(memoryCategorySchema).min(1).max(7),
  applicabilitySummary: z.string().max(2048),
  conditions: z.array(z.string().max(2048)).max(32),
  exclusions: z.array(z.string().max(2048)).max(32),
  preservedNegations: z.array(z.string().max(2048)).max(32),
  certainty: z.enum(["asserted", "inferred", "speculative"]),
  sensitivity: z.enum(["normal", "private"]),
  evidenceIds: z.array(z.string().min(1)).min(1).max(64),
  importanceReasons: z.array(importanceReasonSchema).max(8)
}).superRefine((candidate, context) => {
  if (new Set(candidate.categoryTags).size !== candidate.categoryTags.length) {
    context.addIssue({
      code: "custom",
      message: "Controlled category tags must not contain duplicates.",
      path: ["categoryTags"]
    });
  }
}).transform((candidate) => ({
  ...candidate,
  primaryCategory: selectPrimaryCategory(candidate.categoryTags),
  importanceTags: candidate.importanceReasons.map((item) => item.tag)
}));

const distillationOutputSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("distillation"),
  candidates: z.array(distilledCandidateSchema).max(64)
});

const distillationOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "kind", "candidates"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    kind: { type: "string", const: "distillation" },
    candidates: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "statement",
          "primaryCategory",
          "categoryTags",
          "applicabilitySummary",
          "conditions",
          "exclusions",
          "preservedNegations",
          "certainty",
          "sensitivity",
          "evidenceIds",
          "importanceReasons"
        ],
        properties: {
          statement: { type: "string", minLength: 1, maxLength: 16_384 },
          primaryCategory: memoryCategoryJsonSchema,
          categoryTags: {
            type: "array",
            minItems: 1,
            maxItems: 7,
            items: memoryCategoryJsonSchema
          },
          applicabilitySummary: { type: "string", maxLength: 2048 },
          conditions: {
            type: "array",
            maxItems: 32,
            items: { type: "string", maxLength: 2048 }
          },
          exclusions: {
            type: "array",
            maxItems: 32,
            items: { type: "string", maxLength: 2048 }
          },
          preservedNegations: {
            type: "array",
            maxItems: 32,
            items: { type: "string", maxLength: 2048 }
          },
          certainty: {
            enum: ["asserted", "inferred", "speculative"]
          },
          sensitivity: {
            enum: ["normal", "private"]
          },
          evidenceIds: {
            type: "array",
            minItems: 1,
            maxItems: 64,
            items: { type: "string", minLength: 1 }
          },
          importanceReasons: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["tag", "reason", "evidenceIds"],
              properties: {
                tag: { enum: importanceTagSchema.options },
                reason: { type: "string", minLength: 1, maxLength: 512 },
                evidenceIds: {
                  type: "array",
                  minItems: 1,
                  maxItems: 16,
                  items: { type: "string", minLength: 1 }
                }
              }
            }
          }
        }
      }
    }
  }
} as const;

const consolidationOutputSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("consolidation"),
  candidates: z.array(distilledCandidateSchema).max(64)
});

const consolidationOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "kind", "candidates"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    kind: { type: "string", const: "consolidation" },
    candidates: distillationOutputJsonSchema.properties.candidates
  }
} as const;

const semanticAssessmentOutputSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("semantic_assessment"),
  state: z.enum([
    "supported",
    "partially_supported",
    "contradicted",
    "insufficient_evidence"
  ]),
  durabilityDisposition: z.enum([
    "durable",
    "task_local",
    "transient",
    "no_retention",
    "uncertain"
  ]).optional(),
  evidenceIds: z.array(z.string().min(1)).max(64)
});

const semanticAssessmentOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "kind", "state", "durabilityDisposition", "evidenceIds"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    kind: { type: "string", const: "semantic_assessment" },
    state: {
      enum: [
        "supported",
        "partially_supported",
        "contradicted",
        "insufficient_evidence"
      ]
    },
    durabilityDisposition: {
      enum: ["durable", "task_local", "transient", "no_retention", "uncertain"]
    },
    evidenceIds: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1 }
    }
  }
} as const;

const conflictAssessmentOutputSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("conflict_assessment"),
  state: z.enum(["material_conflict", "no_material_conflict", "uncertain"]),
  conflictingMemoryIds: z.array(z.string().min(1)).max(64)
});

const conflictAssessmentOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "kind", "state", "conflictingMemoryIds"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    kind: { type: "string", const: "conflict_assessment" },
    state: { enum: ["material_conflict", "no_material_conflict", "uncertain"] },
    conflictingMemoryIds: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1 }
    }
  }
} as const;

const compactGenerationOutputSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("compact_generation"),
  items: z.array(z.object({
    memoryId: z.string().min(1),
    compactText: z.string().min(1).max(4096)
  })).max(16)
});

const compactGenerationOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "kind", "items"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    kind: { type: "string", const: "compact_generation" },
    items: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["memoryId", "compactText"],
        properties: {
          memoryId: { type: "string", minLength: 1 },
          compactText: { type: "string", minLength: 1, maxLength: 4096 }
        }
      }
    }
  }
} as const;

const compactValidationOutputSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("compact_validation"),
  items: z.array(z.object({
    memoryId: z.string().min(1),
    state: z.enum(["preserves", "lossy", "uncertain"]),
    reasonCode: z.string().regex(/^[a-z0-9_]{1,128}$/u)
  })).max(16)
});

const compactValidationOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "kind", "items"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    kind: { type: "string", const: "compact_validation" },
    items: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["memoryId", "state", "reasonCode"],
        properties: {
          memoryId: { type: "string", minLength: 1 },
          state: { enum: ["preserves", "lossy", "uncertain"] },
          reasonCode: { type: "string", pattern: "^[a-z0-9_]{1,128}$" }
        }
      }
    }
  }
} as const;

const duplicateAssessmentOutputSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("duplicate_assessment"),
  items: z.array(z.object({
    clusterId: z.string().min(1),
    decision: z.enum([
      "equivalent",
      "left_subsumes_right",
      "right_subsumes_left",
      "conflicts",
      "unrelated",
      "uncertain"
    ]),
    reasonCode: z.string().regex(/^[a-z0-9_]{1,128}$/u)
  })).max(8)
});

const duplicateAssessmentOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "kind", "items"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    kind: { type: "string", const: "duplicate_assessment" },
    items: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["clusterId", "decision", "reasonCode"],
        properties: {
          clusterId: { type: "string", minLength: 1 },
          decision: {
            enum: [
              "equivalent",
              "left_subsumes_right",
              "right_subsumes_left",
              "conflicts",
              "unrelated",
              "uncertain"
            ]
          },
          reasonCode: { type: "string", pattern: "^[a-z0-9_]{1,128}$" }
        }
      }
    }
  }
} as const;

export type ImportanceTag = z.infer<typeof importanceTagSchema>;
export type ImportanceReason = z.infer<typeof importanceReasonSchema>;
export type DistilledCandidate = z.infer<typeof distilledCandidateSchema>;
export type DistillationOutput = z.infer<typeof distillationOutputSchema>;
export type ConsolidationOutput = z.infer<typeof consolidationOutputSchema>;
export type SemanticAssessmentOutput = z.infer<typeof semanticAssessmentOutputSchema>;
export type ConflictAssessmentOutput = z.infer<typeof conflictAssessmentOutputSchema>;

export interface LunaEvidence {
  readonly evidenceId: string;
  readonly evidenceClass:
    | "explicit_user_statement"
    | "code_or_configuration"
    | "command_outcome"
    | "human_memory_reference"
    | "agent_summary"
    | "other";
  readonly content: string;
  readonly sourceIdentity: string;
  readonly sourceTruncated: boolean;
  readonly memoryEcho: boolean;
  readonly occurredAt?: string;
  readonly projectId?: string;
  readonly repoRevision?: string;
  readonly evidenceContentIdentity?: string;
  readonly fileContentIdentity?: string;
  readonly filePath?: string;
  readonly repositoryRoot?: string;
  readonly command?: string;
  readonly commandCwd?: string;
  readonly commandResultIdentity?: string;
  readonly commandExitCode?: number;
  readonly humanMemoryId?: string;
  readonly humanRevisionId?: string;
  readonly humanContentIdentity?: string;
}

export interface DistillBatchRequest {
  readonly operationId: string;
  readonly scope:
    | { readonly kind: "project"; readonly projectId: string }
    | { readonly kind: "global" }
    | { readonly kind: "unresolved" };
  readonly evidence: readonly LunaEvidence[];
}

export interface ConsolidateSessionRequest {
  readonly operationId: string;
  readonly sessionId: string;
  readonly batchResults: readonly {
    readonly batchId: string;
    readonly candidates: readonly DistilledCandidate[];
    readonly evidenceIds: readonly string[];
  }[];
}

export interface SemanticAssessmentRequest {
  readonly operationId: string;
  readonly statement: string;
  readonly conditions: readonly string[];
  readonly exclusions: readonly string[];
  readonly evidence: readonly LunaEvidence[];
}

export interface ConflictAssessmentRequest {
  readonly operationId: string;
  readonly proposedAssertion: string;
  readonly existingHumanMemories: readonly {
    readonly memoryId: string;
    readonly revisionId: string;
    readonly body: string;
    readonly applicabilitySummary: string;
    readonly conditions: readonly string[];
  }[];
}

export interface LunaProcessRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly currentWorkingDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly standardInput: string;
  readonly timeoutMilliseconds: number;
}

export interface LunaProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
}

export type LunaFailureCategory =
  | "authentication"
  | "invalid_model"
  | "invalid_configuration"
  | "input_too_large"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "schema_invalid";

export interface LunaSafeDiagnostic {
  readonly stage:
    | "invocation"
    | "output_decode"
    | "output_schema"
    | "evidence_binding"
    | "importance_validation"
    | "local_processing";
  readonly code: string;
  readonly path?: string;
}

export class LunaInvocationError extends Error {
  public readonly category: LunaFailureCategory;
  public readonly retryable: boolean;
  public readonly diagnostic: LunaSafeDiagnostic | undefined;

  public constructor(
    category: LunaFailureCategory,
    retryable: boolean,
    message: string,
    diagnostic?: LunaSafeDiagnostic
  ) {
    super(message);
    this.name = "LunaInvocationError";
    this.category = category;
    this.retryable = retryable;
    this.diagnostic = diagnostic;
  }
}

type LunaProcessRunner = (
  request: LunaProcessRequest
) => Promise<LunaProcessResult>;

async function runLunaProcess(
  request: LunaProcessRequest
): Promise<LunaProcessResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(request.executable, [...request.arguments], {
      cwd: request.currentWorkingDirectory,
      env: request.environment,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, request.timeoutMilliseconds);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut
      });
    });
    child.stdin.end(request.standardInput);
  });
}

function classifyProcessFailure(result: LunaProcessResult): LunaInvocationError {
  const stderr = result.stderr.trim();
  const explicitErrorMatch = [...stderr.matchAll(/(?:^|\n)error:/giu)].at(-1);
  const diagnostic = (
    explicitErrorMatch?.index !== undefined
      ? stderr.slice(explicitErrorMatch.index).trimStart()
      : stderr.split(/\r?\n/u).slice(-4).join("\n")
  ).toLowerCase();
  if (result.timedOut === true) {
    return new LunaInvocationError("timeout", true, "Luna invocation timed out.");
  }
  if (/input_too_large|input exceeds the maximum length|max_chars/u.test(diagnostic)) {
    return new LunaInvocationError(
      "input_too_large",
      false,
      "The Luna request exceeds the configured process input limit.",
      { stage: "invocation", code: "input_too_large" }
    );
  }
  if (/invalid_json_schema|invalid schema/u.test(diagnostic)) {
    return new LunaInvocationError(
      "invalid_configuration",
      false,
      "The Luna response schema is not supported by the configured provider."
    );
  }
  if (/auth|credential|unauthorized|forbidden/u.test(diagnostic)) {
    return new LunaInvocationError(
      "authentication",
      false,
      "Luna authentication is unavailable."
    );
  }
  if (/model.+(not found|invalid|unavailable)|unknown model/u.test(diagnostic)) {
    return new LunaInvocationError(
      "invalid_model",
      false,
      "The configured Luna model is invalid or unavailable."
    );
  }
  if (/config|toml|invalid option/u.test(diagnostic)) {
    return new LunaInvocationError(
      "invalid_configuration",
      false,
      "The Luna process configuration is invalid."
    );
  }
  if (/rate.?limit|too many requests|429/u.test(diagnostic)) {
    return new LunaInvocationError(
      "rate_limited",
      true,
      "Luna is rate limited."
    );
  }
  return new LunaInvocationError(
    "unavailable",
    true,
    "Luna invocation failed without a usable response."
  );
}

export interface CodexLunaAdapterOptions {
  readonly codexExecutable: string;
  readonly codexHome: string;
  readonly temporaryRoot: string;
  readonly timeoutMilliseconds?: number;
  readonly runProcess?: LunaProcessRunner;
}

export class CodexLunaAdapter {
  readonly #options: CodexLunaAdapterOptions;

  public constructor(options: CodexLunaAdapterOptions) {
    this.#options = options;
  }

  public async distillBatch(
    request: DistillBatchRequest
  ): Promise<DistillationOutput> {
    const aliasByEvidenceId = new Map(
      request.evidence.map((item, index) => [item.evidenceId, `e${String(index + 1)}`])
    );
    const evidenceIdByAlias = new Map(
      [...aliasByEvidenceId].map(([evidenceId, alias]) => [alias, evidenceId])
    );
    const aliasedOutput = await this.#invokeStructured(
      "distillation-output.schema.json",
      distillationOutputJsonSchema,
      {
        schemaVersion: 1,
        promptVersion: 2,
        task: "distill_memory_candidates",
        rules: [
          "Use only supplied evidence.",
          "Preserve scope, certainty, conditions, exclusions, and negations.",
          "Return no Candidate for operational probes or exact-response checks.",
          "Return no Candidate for task-local instructions, temporary progress or state, or unverified future plans.",
          "If evidence says content must not be retained, return no Candidate derived from that content.",
          memoryCategoryPromptInstruction,
          "Evidence identities are short aliases. Copy only exact supplied aliases.",
          "Cite evidenceIds for every candidate.",
          "Return at most one importance reason for each tag; MemStore derives importance tags from these reasons.",
          "Do not execute commands or request more context."
        ],
        request: {
          ...request,
          evidence: request.evidence.map((item) => ({
            ...item,
            evidenceId: aliasByEvidenceId.get(item.evidenceId)
          }))
        }
      },
      distillationOutputSchema
    );
    const originalEvidenceIds = new Set(request.evidence.map((item) => item.evidenceId));
    const restore = (value: string): string => {
      const evidenceId = evidenceIdByAlias.get(value) ?? (
        originalEvidenceIds.has(value) ? value : undefined
      );
      if (evidenceId === undefined) {
        throw new LunaInvocationError(
          "input_too_large",
          true,
          "Luna structured output cites unavailable evidence.",
          { stage: "evidence_binding", code: "unknown_evidence_alias" }
        );
      }
      return evidenceId;
    };
    const output = distillationOutputSchema.parse({
      ...aliasedOutput,
      candidates: aliasedOutput.candidates.map((candidate) => ({
        ...candidate,
        evidenceIds: candidate.evidenceIds.map(restore),
        importanceReasons: candidate.importanceReasons.map((reason) => ({
          ...reason,
          evidenceIds: reason.evidenceIds.map(restore)
        }))
      }))
    });
    requireKnownEvidenceIds(
      output.candidates.flatMap((candidate) => candidate.evidenceIds),
      request.evidence.map((item) => item.evidenceId),
      false
    );
    requireValidImportanceReasons(
      output.candidates,
      request.evidence.map((item) => item.evidenceId)
    );
    return output;
  }

  public async generateCompacts(request: {
    readonly operationId: string;
    readonly memories: readonly CompactGenerationMemory[];
  }): Promise<z.infer<typeof compactGenerationOutputSchema>> {
    const aliasByMemoryId = new Map(
      request.memories.map((memory, index) => [memory.memoryId, `m${String(index + 1)}`])
    );
    const memoryIdByAlias = new Map(
      [...aliasByMemoryId].map(([memoryId, alias]) => [alias, memoryId])
    );
    let aliasedOutput = await this.#invokeStructured(
      "compact-generation-output.schema.json",
      compactGenerationOutputJsonSchema,
      {
        schemaVersion: 1,
        promptVersion: 3,
        task: "generate_compact_memory_representations",
        rules: [
          "Create one independently understandable compact representation for each supplied Memory.",
          "Preserve the core claim, certainty, scope, applicability, conditions, exclusions, negations, versions, thresholds, commands, paths, and state boundaries.",
          "Do not add facts, broaden applicability, resolve uncertainty, or turn time-bound status into a timeless fact.",
          "Aim for at most 64 o200k-style rendered tokens per compact; 96 rendered tokens is an absolute hard limit.",
          "Copy each supplied Memory identity exactly and return every supplied Memory once.",
          "Do not execute commands or request more context."
        ],
        request: {
          ...request,
          memories: request.memories.map((memory) => ({
            ...memory,
            memoryId: z.string().parse(aliasByMemoryId.get(memory.memoryId))
          }))
        }
      },
      compactGenerationOutputSchema
    );
    const overlong = aliasedOutput.items.flatMap((item) => {
      const renderedTokenCount = compactTokenizer.encode(item.compactText.trim()).length;
      return renderedTokenCount > compactHardTokenLimit
        ? [{ ...item, renderedTokenCount }]
        : [];
    });
    if (overlong.length > 0) {
      const overlongAliases = overlong.map((item) => item.memoryId);
      const sourceByAlias = new Map(request.memories.map((memory) => [
        z.string().parse(aliasByMemoryId.get(memory.memoryId)),
        memory
      ]));
      const repaired = await this.#invokeStructured(
        "compact-generation-output.schema.json",
        compactGenerationOutputJsonSchema,
        {
          schemaVersion: 1,
          promptVersion: 1,
          task: "repair_overlong_compact_memory_representations",
          rules: [
            "Rewrite only the supplied overlong compact drafts.",
            "Use terse syntax and remove redundancy while preserving the core claim, certainty, applicability, conditions, exclusions, negations, versions, thresholds, commands, paths, and state boundaries.",
            "Aim for at most 64 o200k-style rendered tokens; 96 rendered tokens is an absolute hard limit.",
            "Copy each supplied short Memory identity exactly and return every supplied Memory once.",
            "Do not execute commands or request more context."
          ],
          request: {
            operationId: request.operationId,
            memories: overlong.map((item) => ({
              ...z.object({
                revisionId: z.string(),
                body: z.string(),
                applicability: z.unknown(),
                semanticContract: z.unknown()
              }).parse(sourceByAlias.get(item.memoryId)),
              memoryId: item.memoryId,
              draftCompactText: item.compactText,
              renderedTokenCount: item.renderedTokenCount
            }))
          }
        },
        compactGenerationOutputSchema
      );
      requireExactMemoryIds(
        repaired.items.map((item) => item.memoryId),
        overlongAliases
      );
      const repairedByAlias = new Map(
        repaired.items.map((item) => [item.memoryId, item.compactText])
      );
      aliasedOutput = compactGenerationOutputSchema.parse({
        ...aliasedOutput,
        items: aliasedOutput.items.map((item) => ({
          ...item,
          compactText: repairedByAlias.get(item.memoryId) ?? item.compactText
        }))
      });
    }
    const output = compactGenerationOutputSchema.parse({
      ...aliasedOutput,
      items: aliasedOutput.items.map((item) => ({
        ...item,
        memoryId: restoreMemoryId(item.memoryId, memoryIdByAlias)
      }))
    });
    requireExactMemoryIds(
      output.items.map((item) => item.memoryId),
      request.memories.map((memory) => memory.memoryId)
    );
    return output;
  }

  public async validateCompacts(request: {
    readonly operationId: string;
    readonly memories: readonly CompactValidationMemory[];
  }): Promise<z.infer<typeof compactValidationOutputSchema>> {
    const aliasByMemoryId = new Map(
      request.memories.map((memory, index) => [memory.memoryId, `m${String(index + 1)}`])
    );
    const memoryIdByAlias = new Map(
      [...aliasByMemoryId].map(([memoryId, alias]) => [alias, memoryId])
    );
    const aliasedOutput = await this.#invokeStructured(
      "compact-validation-output.schema.json",
      compactValidationOutputJsonSchema,
      {
        schemaVersion: 1,
        promptVersion: 2,
        task: "validate_compact_memory_fidelity",
        rules: [
          "Act only as an independent fidelity assessor; do not rewrite the proposed compact text.",
          "Use preserves only when the compact retains the core claim, original certainty, applicability, every meaning-changing condition, exclusion, negation, version, threshold, command, path, and state boundary.",
          "Use lossy when meaning is omitted, broadened, contradicted, or added; use uncertain when the supplied contract is insufficient to decide.",
          "Return a bounded reasonCode, copy each supplied Memory identity exactly, and return every supplied Memory once.",
          "Do not execute commands or request more context."
        ],
        request: {
          ...request,
          memories: request.memories.map((memory) => ({
            ...memory,
            memoryId: z.string().parse(aliasByMemoryId.get(memory.memoryId))
          }))
        }
      },
      compactValidationOutputSchema
    );
    const output = compactValidationOutputSchema.parse({
      ...aliasedOutput,
      items: aliasedOutput.items.map((item) => ({
        ...item,
        memoryId: restoreMemoryId(item.memoryId, memoryIdByAlias)
      }))
    });
    requireExactMemoryIds(
      output.items.map((item) => item.memoryId),
      request.memories.map((memory) => memory.memoryId)
    );
    return output;
  }

  public async assessDuplicateClusters(request: {
    readonly operationId: string;
    readonly clusters: readonly DuplicateClusterInput[];
  }): Promise<z.infer<typeof duplicateAssessmentOutputSchema>> {
    const output = await this.#invokeStructured(
      "duplicate-assessment-output.schema.json",
      duplicateAssessmentOutputJsonSchema,
      {
        schemaVersion: 1,
        promptVersion: 1,
        task: "assess_memory_duplicate_clusters",
        rules: [
          "Compare only the supplied Agent-derived Memory pair in each precomputed cluster.",
          "Scope and applicability are immutable gates; do not propose equivalence across different scope or applicability.",
          "Use equivalent only for the same durable claim and material conditions; use subsumption only when one side preserves every claim and condition of the other without broadening it.",
          "Use conflicts for materially incompatible claims, unrelated for a false-positive cluster, and uncertain when evidence is insufficient.",
          "Do not rewrite, merge, archive, supersede, or execute commands.",
          "Copy every supplied cluster identity exactly once and return only a bounded reasonCode."
        ],
        request
      },
      duplicateAssessmentOutputSchema
    );
    requireExactMemoryIds(
      output.items.map((item) => item.clusterId),
      request.clusters.map((cluster) => cluster.clusterId)
    );
    return output;
  }

  public async consolidateSession(
    request: ConsolidateSessionRequest
  ): Promise<ConsolidationOutput> {
    return this.#consolidateSession(request, 0);
  }

  async #consolidateSession(
    request: ConsolidateSessionRequest,
    level: number
  ): Promise<ConsolidationOutput> {
    const maximumRequestCharacters = 900_000;
    if (JSON.stringify(request).length > maximumRequestCharacters) {
      if (level >= 8) {
        throw new LunaInvocationError(
          "input_too_large",
          false,
          "Luna consolidation could not be reduced below the process input limit.",
          { stage: "invocation", code: "input_too_large" }
        );
      }
      const groups: Array<typeof request.batchResults> = [];
      let current: typeof request.batchResults = [];
      for (const batch of request.batchResults) {
        const next = [...current, batch];
        const nextRequest = { ...request, batchResults: next };
        if (current.length > 0 && JSON.stringify(nextRequest).length > maximumRequestCharacters) {
          groups.push(current);
          current = [batch];
        } else {
          current = next;
        }
      }
      if (current.length > 0) groups.push(current);
      if (groups.length <= 1) {
        throw new LunaInvocationError(
          "input_too_large",
          false,
          "One Luna consolidation Batch exceeds the process input limit.",
          { stage: "invocation", code: "input_too_large" }
        );
      }
      const partialResults: Array<ConsolidateSessionRequest["batchResults"][number]> = [];
      for (const [index, group] of groups.entries()) {
        const output = await this.#consolidateSession(
          { ...request, batchResults: group },
          level + 1
        );
        partialResults.push({
          batchId: `${request.operationId}:level-${String(level)}:part-${String(index)}`,
          candidates: output.candidates,
          evidenceIds: [...new Set(output.candidates.flatMap((candidate) => [
            ...candidate.evidenceIds,
            ...candidate.importanceReasons.flatMap((reason) => reason.evidenceIds)
          ]))]
        });
      }
      return this.#consolidateSession(
        { ...request, batchResults: partialResults },
        level + 1
      );
    }
    const availableEvidenceIds = [
      ...new Set(request.batchResults.flatMap((batch) => batch.evidenceIds))
    ];
    const aliasByEvidenceId = new Map(
      availableEvidenceIds.map((evidenceId, index) => [evidenceId, `e${String(index + 1)}`])
    );
    const evidenceIdByAlias = new Map(
      [...aliasByEvidenceId].map(([evidenceId, alias]) => [alias, evidenceId])
    );
    const alias = (evidenceId: string): string => {
      const value = aliasByEvidenceId.get(evidenceId);
      if (value === undefined) {
        throw new LunaInvocationError(
          "schema_invalid",
          true,
          "A structured Batch result contains an unavailable evidence identity.",
          { stage: "evidence_binding", code: "unknown_batch_evidence" }
        );
      }
      return value;
    };
    const aliasedRequest = {
      ...request,
      batchResults: request.batchResults.map((batch) => ({
        ...batch,
        evidenceIds: batch.evidenceIds.map(alias),
        candidates: batch.candidates.map((candidate) => ({
          ...candidate,
          evidenceIds: candidate.evidenceIds.map(alias),
          importanceReasons: candidate.importanceReasons.map((reason) => ({
            ...reason,
            evidenceIds: reason.evidenceIds.map(alias)
          }))
        }))
      }))
    };
    const aliasedOutput = await this.#invokeStructured(
      "consolidation-output.schema.json",
      consolidationOutputJsonSchema,
      {
        schemaVersion: 1,
        promptVersion: 2,
        task: "consolidate_session_candidates",
        rules: [
          "Use only structured Batch results and their evidence identities.",
          "Omit operational probes, exact-response checks, task-local instructions, temporary progress or state, and unverified future plans.",
          "If a structured candidate says content must not be retained, omit it from the consolidation result.",
          "Evidence identities are short aliases. Copy only exact supplied aliases.",
          "Do not infer from raw transcripts or execute commands.",
          "Preserve material conditions, exclusions, certainty, and negations.",
          memoryCategoryPromptInstruction,
          "Return at most one importance reason for each tag; MemStore derives importance tags from these reasons.",
          "Deduplicate without broadening claims."
        ],
        request: aliasedRequest
      },
      consolidationOutputSchema,
      300_000
    );
    const restore = (evidenceAlias: string): string => {
      const evidenceId = evidenceIdByAlias.get(evidenceAlias);
      if (evidenceId === undefined) {
        throw new LunaInvocationError(
          "schema_invalid",
          true,
          "Luna structured output cites unavailable evidence.",
          { stage: "evidence_binding", code: "unknown_evidence_alias" }
        );
      }
      return evidenceId;
    };
    const output = consolidationOutputSchema.parse({
      ...aliasedOutput,
      candidates: aliasedOutput.candidates.map((candidate) => ({
        ...candidate,
        evidenceIds: candidate.evidenceIds.map(restore),
        importanceReasons: candidate.importanceReasons.map((reason) => ({
          ...reason,
          evidenceIds: reason.evidenceIds.map(restore)
        }))
      }))
    });
    requireKnownEvidenceIds(
      output.candidates.flatMap((candidate) => candidate.evidenceIds),
      availableEvidenceIds,
      false
    );
    requireValidImportanceReasons(
      output.candidates,
      availableEvidenceIds
    );
    return output;
  }

  public async assessCandidateSemantics(
    request: SemanticAssessmentRequest
  ): Promise<SemanticAssessmentOutput> {
    const aliasByEvidenceId = new Map(
      request.evidence.map((item, index) => [item.evidenceId, `e${String(index + 1)}`])
    );
    const evidenceIdByAlias = new Map(
      [...aliasByEvidenceId].map(([evidenceId, alias]) => [alias, evidenceId])
    );
    const aliasedOutput = await this.#invokeStructured(
      "semantic-assessment-output.schema.json",
      semanticAssessmentOutputJsonSchema,
      {
        schemaVersion: 1,
        promptVersion: 3,
        task: "assess_candidate_semantics",
        rules: [
          "Use only supplied evidence.",
          "Return a bounded support state and cite only supplied evidenceIds.",
          "Evidence identities are short aliases. Copy only exact supplied aliases.",
          "Classify durability independently: durable is reusable beyond the current task; task_local is only an instruction for the current task; transient is temporary progress or state; no_retention applies when evidence says not to retain the content; uncertain means durability is not established.",
          "Operational probes and exact-response checks are task_local unless evidence explicitly establishes a reusable rule.",
          "Missing evidence is insufficient_evidence, never approval.",
          "Do not execute commands or invent verification results."
        ],
        request: {
          ...request,
          evidence: request.evidence.map((item) => ({
            ...item,
            evidenceId: aliasByEvidenceId.get(item.evidenceId)
          }))
        }
      },
      semanticAssessmentOutputSchema
    );
    const originalEvidenceIds = new Set(request.evidence.map((item) => item.evidenceId));
    const restore = (value: string): string => {
      const evidenceId = evidenceIdByAlias.get(value) ?? (
        originalEvidenceIds.has(value) ? value : undefined
      );
      if (evidenceId === undefined) {
        throw new LunaInvocationError(
          "schema_invalid",
          true,
          "Luna structured output cites unavailable evidence.",
          { stage: "evidence_binding", code: "unknown_evidence_alias" }
        );
      }
      return evidenceId;
    };
    const output = semanticAssessmentOutputSchema.parse({
      ...aliasedOutput,
      evidenceIds: aliasedOutput.evidenceIds.map(restore)
    });
    requireKnownEvidenceIds(
      output.evidenceIds,
      request.evidence.map((item) => item.evidenceId),
      output.state === "supported"
    );
    return output;
  }

  public async assessHumanConflict(
    request: ConflictAssessmentRequest
  ): Promise<ConflictAssessmentOutput> {
    const output = await this.#invokeStructured(
      "conflict-assessment-output.schema.json",
      conflictAssessmentOutputJsonSchema,
      {
        schemaVersion: 1,
        promptVersion: 1,
        task: "assess_human_memory_conflict",
        rules: [
          "Compare only the exact supplied Human assertions and applicability.",
          "Do not rewrite either assertion or infer replacement intent.",
          "Cite only supplied Memory identities.",
          "Use uncertain when applicability is insufficient to decide."
        ],
        request
      },
      conflictAssessmentOutputSchema
    );
    requireKnownEvidenceIds(
      output.conflictingMemoryIds,
      request.existingHumanMemories.map((item) => item.memoryId),
      output.state === "material_conflict"
    );
    return output;
  }

  public async reviewPage(
    request: GovernancePageRequest
  ): Promise<GovernancePageReview> {
    return this.#invokeStructured(
      "governance-page-output.schema.json",
      governanceOutputJsonSchema,
      {
        schemaVersion: 1,
        promptVersion: 2,
        task: "review_memory_governance_page",
        rules: [
          "Use only the frozen Memory revisions and audit signals supplied in this page.",
          "Never propose an Agent action against Human-authored Memory; use a Review Suggestion instead.",
          "Archive Agent-derived Memory when its own body and provenance establish that it is an operational probe, exact-response check, temporary progress or current run state rather than reusable knowledge; cite those supplied fields as evidence.",
          "Do not preserve a time-bound status as a timeless fact. Archive an intrinsically transient Agent-derived status; use a Review Suggestion for Human-authored content or when staleness is only suspected.",
          "Use mark_review_due for an otherwise durable Agent-derived Memory whose current correctness is time-sensitive or plausibly outdated but not disproven; this removes it from automatic injection while preserving explicit identity reads with a warning.",
          "Prefer one condition-preserving successor when Agent-derived Memories in the same scope and applicability materially duplicate each other; supersede weaker duplicates without broadening the retained claim.",
          "For non-exact semantic duplicate, subsumption, or conflict decisions, act only when auditSignals includes a current reviewedDuplicateClusters entry; do not infer a cluster from similarity alone.",
          "Otherwise archive or supersede Agent-derived Memory only with stronger traceable evidence while preserving scope and applicability.",
          "Relationships must cite supplied evidence and connect only Memory identities in the frozen run.",
          "A future purge item records an obligation only; it does not authorize deletion.",
          "Do not change schedules, ranking, scope, model configuration, safety policy, or execute commands.",
          "Keep summaries factual and bounded. Missing evidence means no action."
        ],
        request
      },
      governanceOutputSchema
    );
  }

  async #invokeStructured<Output>(
    schemaFilename: string,
    outputJsonSchema: unknown,
    prompt: unknown,
    outputSchema: z.ZodType<Output>,
    timeoutMilliseconds = 120_000
  ): Promise<Output> {
    await mkdir(this.#options.temporaryRoot, { recursive: true, mode: 0o700 });
    const isolatedDirectory = await mkdtemp(
      join(this.#options.temporaryRoot, "memstore-luna-")
    );
    const schemaPath = join(isolatedDirectory, schemaFilename);
    await writeFile(
      schemaPath,
      `${JSON.stringify(outputJsonSchema, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    try {
      const inheritedEnvironment = Object.fromEntries(
        ["PATH", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"]
          .flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])
      );
      const lunaPath = process.env.PATH === undefined
        ? dirname(process.execPath)
        : `${dirname(process.execPath)}:${process.env.PATH}`;
      const result = await (this.#options.runProcess ?? runLunaProcess)({
        executable: this.#options.codexExecutable,
        arguments: [
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
          "--disable",
          "apps",
          "--disable",
          "browser_use",
          "--disable",
          "plugins",
          "--disable",
          "multi_agent",
          "--disable",
          "image_generation",
          "--disable",
          "in_app_browser",
          "--disable",
          "browser_use_external",
          "--disable",
          "browser_use_full_cdp_access",
          "--disable",
          "memories",
          "--skip-git-repo-check",
          "--ignore-user-config",
          "--ignore-rules",
          "--color",
          "never",
          "--output-schema",
          schemaPath,
          "--cd",
          isolatedDirectory,
          "-"
        ],
        currentWorkingDirectory: isolatedDirectory,
        environment: {
          ...inheritedEnvironment,
          PATH: lunaPath,
          CODEX_HOME: this.#options.codexHome
        },
        standardInput: JSON.stringify(prompt),
        timeoutMilliseconds: this.#options.timeoutMilliseconds ?? timeoutMilliseconds
      });
      if (result.timedOut === true) throw classifyProcessFailure(result);
      if (result.exitCode !== 0) throw classifyProcessFailure(result);
      let decoded: unknown;
      try {
        decoded = JSON.parse(result.stdout) as unknown;
      } catch {
        throw new LunaInvocationError(
          "schema_invalid",
          true,
          "Luna returned invalid JSON output.",
          { stage: "output_decode", code: "invalid_json" }
        );
      }
      const parsedOutput = outputSchema.safeParse(decoded);
      if (!parsedOutput.success) {
        const firstIssue = parsedOutput.error.issues[0];
        throw new LunaInvocationError(
          "schema_invalid",
          true,
          "Luna returned output that does not match the required schema.",
          {
            stage: "output_schema",
            code: firstIssue?.code ?? "schema_mismatch",
            ...(firstIssue === undefined || firstIssue.path.length === 0
              ? {}
              : { path: firstIssue.path.join(".") })
          }
        );
      }
      return parsedOutput.data;
    } finally {
      await rm(isolatedDirectory, { recursive: true, force: true });
    }
  }
}

function requireKnownEvidenceIds(
  citedEvidenceIds: readonly string[],
  availableEvidenceIds: readonly string[],
  requireCitation: boolean
): void {
  const available = new Set(availableEvidenceIds);
  if (
    (requireCitation && citedEvidenceIds.length === 0) ||
    citedEvidenceIds.some((evidenceId) => !available.has(evidenceId))
  ) {
    throw new LunaInvocationError(
      "schema_invalid",
      true,
      "Luna structured output cites unavailable evidence.",
      { stage: "evidence_binding", code: "unknown_evidence_id" }
    );
  }
}

function restoreMemoryId(
  alias: string,
  memoryIdByAlias: ReadonlyMap<string, string>
): string {
  const memoryId = memoryIdByAlias.get(alias);
  if (memoryId === undefined) {
    throw new LunaInvocationError(
      "schema_invalid",
      true,
      "Luna compact work returned an unavailable Memory alias.",
      { stage: "evidence_binding", code: "unknown_memory_alias" }
    );
  }
  return memoryId;
}

function requireExactMemoryIds(
  returnedMemoryIds: readonly string[],
  requestedMemoryIds: readonly string[]
): void {
  const returned = [...returnedMemoryIds].sort();
  const requested = [...requestedMemoryIds].sort();
  if (
    returned.length !== requested.length ||
    new Set(returned).size !== returned.length ||
    returned.some((memoryId, index) => memoryId !== requested[index])
  ) {
    throw new LunaInvocationError(
      "schema_invalid",
      true,
      "Luna compact work must return every supplied Memory identity exactly once.",
      { stage: "evidence_binding", code: "memory_identity_mismatch" }
    );
  }
}

function requireValidImportanceReasons(
  candidates: readonly DistilledCandidate[],
  availableEvidenceIds: readonly string[]
): void {
  for (const candidate of candidates) {
    const tags = new Set(candidate.importanceTags);
    const reasonTags = candidate.importanceReasons.map((item) => item.tag);
    if (
      tags.size !== candidate.importanceTags.length ||
      new Set(reasonTags).size !== reasonTags.length ||
      reasonTags.length !== tags.size ||
      reasonTags.some((tag) => !tags.has(tag))
    ) {
      throw new LunaInvocationError(
        "schema_invalid",
        true,
        "Luna must provide exactly one bounded reason for each importance tag.",
        { stage: "importance_validation", code: "importance_reason_mismatch" }
      );
    }
    requireKnownEvidenceIds(
      candidate.importanceReasons.flatMap((item) => item.evidenceIds),
      availableEvidenceIds,
      candidate.importanceTags.length > 0
    );
  }
}
