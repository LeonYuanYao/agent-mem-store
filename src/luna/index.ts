import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  governanceOutputJsonSchema,
  governanceOutputSchema,
  type GovernancePageRequest,
  type GovernancePageReview
} from "../governance/contracts.js";

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
  category: z.string().min(1).max(128),
  applicabilitySummary: z.string().max(2048),
  conditions: z.array(z.string().max(2048)).max(32),
  exclusions: z.array(z.string().max(2048)).max(32),
  preservedNegations: z.array(z.string().max(2048)).max(32),
  certainty: z.enum(["asserted", "inferred", "speculative"]),
  sensitivity: z.enum(["normal", "private"]),
  evidenceIds: z.array(z.string().min(1)).min(1).max(64),
  importanceTags: z.array(importanceTagSchema).max(8),
  importanceReasons: z.array(importanceReasonSchema).max(8)
});

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
          "category",
          "applicabilitySummary",
          "conditions",
          "exclusions",
          "preservedNegations",
          "certainty",
          "sensitivity",
          "evidenceIds",
          "importanceTags",
          "importanceReasons"
        ],
        properties: {
          statement: { type: "string", minLength: 1, maxLength: 16_384 },
          category: { type: "string", minLength: 1, maxLength: 128 },
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
          importanceTags: {
            type: "array",
            maxItems: 8,
            items: { enum: importanceTagSchema.options }
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
  evidenceIds: z.array(z.string().min(1)).max(64)
});

const semanticAssessmentOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "kind", "state", "evidenceIds"],
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
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "schema_invalid";

export class LunaInvocationError extends Error {
  public readonly category: LunaFailureCategory;
  public readonly retryable: boolean;

  public constructor(
    category: LunaFailureCategory,
    retryable: boolean,
    message: string
  ) {
    super(message);
    this.name = "LunaInvocationError";
    this.category = category;
    this.retryable = retryable;
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
  const diagnostic = result.stderr.toLowerCase();
  if (result.timedOut === true) {
    return new LunaInvocationError("timeout", true, "Luna invocation timed out.");
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
  if (/config|toml|invalid option|invalid_json_schema|invalid schema/u.test(diagnostic)) {
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
    const output = await this.#invokeStructured(
      "distillation-output.schema.json",
      distillationOutputJsonSchema,
      {
        schemaVersion: 1,
        promptVersion: 1,
        task: "distill_memory_candidates",
        rules: [
          "Use only supplied evidence.",
          "Preserve scope, certainty, conditions, exclusions, and negations.",
          "Cite evidenceIds for every candidate.",
          "Do not execute commands or request more context."
        ],
        request
      },
      distillationOutputSchema
    );
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

  public async consolidateSession(
    request: ConsolidateSessionRequest
  ): Promise<ConsolidationOutput> {
    const output = await this.#invokeStructured(
      "consolidation-output.schema.json",
      consolidationOutputJsonSchema,
      {
        schemaVersion: 1,
        promptVersion: 1,
        task: "consolidate_session_candidates",
        rules: [
          "Use only structured Batch results and their evidence identities.",
          "Do not infer from raw transcripts or execute commands.",
          "Preserve material conditions, exclusions, certainty, and negations.",
          "Deduplicate without broadening claims."
        ],
        request
      },
      consolidationOutputSchema
    );
    requireKnownEvidenceIds(
      output.candidates.flatMap((candidate) => candidate.evidenceIds),
      request.batchResults.flatMap((batch) => batch.evidenceIds),
      false
    );
    requireValidImportanceReasons(
      output.candidates,
      request.batchResults.flatMap((batch) => batch.evidenceIds)
    );
    return output;
  }

  public async assessCandidateSemantics(
    request: SemanticAssessmentRequest
  ): Promise<SemanticAssessmentOutput> {
    const output = await this.#invokeStructured(
      "semantic-assessment-output.schema.json",
      semanticAssessmentOutputJsonSchema,
      {
        schemaVersion: 1,
        promptVersion: 1,
        task: "assess_candidate_semantics",
        rules: [
          "Use only supplied evidence.",
          "Return a bounded support state and cite only supplied evidenceIds.",
          "Missing evidence is insufficient_evidence, never approval.",
          "Do not execute commands or invent verification results."
        ],
        request
      },
      semanticAssessmentOutputSchema
    );
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
        promptVersion: 1,
        task: "review_memory_governance_page",
        rules: [
          "Use only the frozen Memory revisions and audit signals supplied in this page.",
          "Never propose an Agent action against Human-authored Memory; use a Review Suggestion instead.",
          "Archive or supersede Agent-derived Memory only with stronger traceable evidence while preserving scope and applicability.",
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
    outputSchema: z.ZodType<Output>
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
          CODEX_HOME: this.#options.codexHome
        },
        standardInput: JSON.stringify(prompt),
        timeoutMilliseconds: this.#options.timeoutMilliseconds ?? 120_000
      });
      if (result.exitCode !== 0) throw classifyProcessFailure(result);
      try {
        return outputSchema.parse(JSON.parse(result.stdout));
      } catch (error) {
        throw new LunaInvocationError(
          "schema_invalid",
          true,
          `Luna returned invalid structured output: ${error instanceof Error ? error.message : "unknown error"}`
        );
      }
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
      "Luna structured output cites unavailable evidence."
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
        "Luna must provide exactly one bounded reason for each importance tag."
      );
    }
    requireKnownEvidenceIds(
      candidate.importanceReasons.flatMap((item) => item.evidenceIds),
      availableEvidenceIds,
      candidate.importanceTags.length > 0
    );
  }
}
