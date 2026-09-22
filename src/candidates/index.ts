import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

import {
  capacityLimitsForScope,
  loadMemoryCapacityPolicy,
  reconcileMemoryCapacity
} from "../capacity/index.js";
import { readCapturedEvent } from "../capture/index.js";
import type { RetentionAssessment } from "../capacity/retention-value.js";
import { recordRetentionAssessment } from "../capacity/retention-cache.js";
import { ActiveCapacityError } from "../vault/active-capacity.js";
import { classifyLocalSensitivity } from "../contracts/sensitivity.js";
import type { ImportanceReason, ImportanceTag } from "../luna/index.js";
import {
  memoryCategorySchema,
  selectPrimaryCategory,
  type MemoryCategory
} from "../memories/categories.js";
import { assessExactCompact } from "../memories/representations.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import { readSessionProjectRoute } from "../projects/session-route.js";
import {
  readCanonicalMemory,
  writeCanonicalMemory,
  type CanonicalMemory
} from "../vault/index.js";

const candidateStateSchema = z.enum([
  "waiting",
  "promoted",
  "merged",
  "conflict",
  "rejected",
  "expired"
]);

export type CandidateState = z.infer<typeof candidateStateSchema>;

export interface CandidateDurability {
  readonly disposition: "long_term" | "project_phase" | "session_only";
  readonly futureReuseScenario: string;
  readonly horizon: "indefinite" | "until_condition" | "days_30" | "session";
  readonly invalidationTriggers: readonly string[];
  readonly abstractionLevel: "reusable_rule" | "project_fact" | "task_observation";
  readonly observableFromWorkspace: boolean;
}

export interface CandidateContent {
  readonly statement: string;
  readonly primaryCategory: MemoryCategory;
  readonly categoryTags: readonly MemoryCategory[];
  readonly applicabilitySummary: string;
  readonly conditions: readonly string[];
  readonly exclusions: readonly string[];
  readonly preservedNegations: readonly string[];
  readonly certainty: "asserted" | "inferred" | "speculative";
  readonly importanceTags: readonly ImportanceTag[];
  readonly importanceReasons?: readonly ImportanceReason[];
  readonly sensitivity?: "normal" | "private";
  readonly durability?: CandidateDurability;
  readonly retentionAssessment?: RetentionAssessment;
}

export interface CandidateEvidence {
  readonly evidenceId: string;
  readonly evidenceClass:
    | "explicit_user_statement"
    | "code_or_configuration"
    | "command_outcome"
    | "human_memory_reference"
    | "agent_summary"
    | "other";
  readonly sourceIdentity: string;
  readonly projectId?: string;
  readonly occurredAt: string;
  readonly integrity: "intact" | "ambiguous" | "truncated";
  readonly sourceTruncated: boolean;
  readonly memoryEcho: boolean;
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

export interface SemanticAssessment {
  readonly state:
    | "supported"
    | "partially_supported"
    | "contradicted"
    | "insufficient_evidence";
  readonly evidenceIds: readonly string[];
  readonly durabilityDisposition?:
    | "durable"
    | "task_local"
    | "transient"
    | "no_retention"
    | "uncertain"
    | "legacy_unclassified";
  readonly assessedBy: string;
  readonly operationId?: string;
}

export type CreateCandidateResult =
  | { readonly state: "candidate" | "merged"; readonly candidateId: string }
  | { readonly state: "blocked_secret"; readonly category: string }
  | { readonly state: "quarantined"; readonly category: string };

const controlledImportanceTags = new Set<ImportanceTag>([
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

const stableExplicitUserTags = new Set<ImportanceTag>([
  "user_decision",
  "stable_preference",
  "constraint",
  "exception"
]);

export function candidateFingerprint(
  scope: { readonly kind: "project"; readonly projectId: string } | { readonly kind: "global" },
  candidate: Pick<CandidateContent, "statement" | "applicabilitySummary" | "conditions" | "exclusions" | "preservedNegations" | "sensitivity">
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      scope,
      statement: candidate.statement.trim(),
      applicabilitySummary: candidate.applicabilitySummary.trim(),
      conditions: [...candidate.conditions],
      exclusions: [...candidate.exclusions],
      preservedNegations: [...candidate.preservedNegations],
      sensitivity: candidate.sensitivity ?? "normal"
    }))
    .digest("hex");
}

function durabilityStrictness(disposition: CandidateDurability["disposition"]): number {
  if (disposition === "session_only") return 2;
  if (disposition === "project_phase") return 1;
  return 0;
}

function hasEligibleEvidenceShape(evidence: CandidateEvidence): boolean {
  if (
    evidence.memoryEcho ||
    evidence.sourceTruncated ||
    evidence.integrity !== "intact"
  ) {
    return false;
  }
  if (evidence.evidenceClass === "explicit_user_statement") {
    return (
      evidence.evidenceContentIdentity !== undefined &&
      /^[0-9a-f]{64}$/u.test(evidence.evidenceContentIdentity)
    );
  }
  if (evidence.evidenceClass === "human_memory_reference") {
    return (
      evidence.humanMemoryId !== undefined &&
      evidence.humanRevisionId !== undefined &&
      evidence.humanContentIdentity !== undefined &&
      /^[0-9a-f]{64}$/u.test(evidence.humanContentIdentity) &&
      evidence.sourceIdentity ===
        `${evidence.humanMemoryId}:${evidence.humanRevisionId}`
    );
  }
  if (evidence.evidenceClass === "code_or_configuration") {
    const hasGitBinding =
      evidence.repoRevision !== undefined &&
      evidence.repositoryRoot !== undefined;
    const hasNoGitBinding =
      evidence.repoRevision === undefined &&
      evidence.repositoryRoot === undefined;
    return (
      evidence.fileContentIdentity !== undefined &&
      evidence.filePath !== undefined &&
      isAbsolute(evidence.filePath) &&
      /^[0-9a-f]{64}$/u.test(evidence.fileContentIdentity) &&
      ((hasGitBinding &&
        /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(z.string().parse(evidence.repoRevision)) &&
        isAbsolute(z.string().parse(evidence.repositoryRoot))) ||
        hasNoGitBinding)
    );
  }
  if (evidence.evidenceClass === "command_outcome") {
    return (
      evidence.command !== undefined &&
      evidence.command.length > 0 &&
      evidence.commandCwd !== undefined &&
      evidence.commandCwd.startsWith("/") &&
      evidence.commandExitCode !== undefined &&
      evidence.commandResultIdentity !== undefined &&
      /^[0-9a-f]{64}$/u.test(evidence.commandResultIdentity) &&
      evidence.evidenceContentIdentity !== undefined &&
      /^[0-9a-f]{64}$/u.test(evidence.evidenceContentIdentity)
    );
  }
  return false;
}

function hasIntactCapturedEvidenceShape(evidence: CandidateEvidence): boolean {
  return (
    !evidence.memoryEcho &&
    !evidence.sourceTruncated &&
    evidence.integrity === "intact" &&
    evidence.evidenceContentIdentity !== undefined &&
    /^[0-9a-f]{64}$/u.test(evidence.evidenceContentIdentity)
  );
}

function readGitHead(repositoryRoot: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      ["-C", repositoryRoot, "rev-parse", "HEAD"],
      { encoding: "utf8", timeout: 5_000 },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(new Error("Git revision lookup failed.", { cause: error }));
          return;
        }
        resolvePromise(stdout.trim());
      }
    );
  });
}

async function evidenceMatchesScope(runtimeRoot: string, evidence: CandidateEvidence,
  scope: { readonly kind: "global" } | { readonly kind: "project"; readonly projectId: string }): Promise<boolean> {
  if (scope.kind === "global" || evidence.projectId === scope.projectId) return true;
  const database = await openRuntimeDatabase(runtimeRoot);
  let sessionId: unknown;
  try {
    sessionId = database.prepare("SELECT session_id FROM capture_events WHERE event_id = ?").get(evidence.evidenceId)?.session_id;
  } finally { database.close(); }
  if (typeof sessionId !== "string") return false;
  const route = await readSessionProjectRoute(runtimeRoot, sessionId);
  return route?.projectId === scope.projectId;
}

async function isEligibleEvidence(request: {
  readonly evidence: CandidateEvidence;
  readonly runtimeRoot: string;
  readonly vaultRoot?: string;
}): Promise<boolean> {
  const { evidence } = request;
  if (!hasEligibleEvidenceShape(evidence)) return false;
  if (evidence.evidenceClass === "explicit_user_statement") {
    const database = await openRuntimeDatabase(request.runtimeRoot);
    let captureRow: Record<string, unknown> | undefined;
    try {
      captureRow = database.prepare(
        `SELECT event_kind, occurred_at, project_id, session_id, turn_id,
                source_truncated, whole_content_sha256
         FROM capture_events WHERE event_id = ?`
      ).get(evidence.evidenceId);
    } finally {
      database.close();
    }
    if (captureRow?.event_kind !== "UserPromptSubmit") return false;
    const expectedSourceIdentity = `codex:${
      typeof captureRow.session_id === "string" ? captureRow.session_id : "unknown"
    }:${
      typeof captureRow.turn_id === "string" ? captureRow.turn_id : evidence.evidenceId
    }`;
    if (
      captureRow.source_truncated !== 0 ||
      captureRow.whole_content_sha256 !== evidence.evidenceContentIdentity ||
      captureRow.occurred_at !== evidence.occurredAt ||
      captureRow.project_id !== (evidence.projectId ?? null) ||
      evidence.sourceIdentity !== expectedSourceIdentity
    ) {
      return false;
    }
    return (await readCapturedEvent(request.runtimeRoot, evidence.evidenceId)) !== undefined;
  }
  if (evidence.evidenceClass === "human_memory_reference") {
    if (request.vaultRoot === undefined) return false;
    const memory = await readCanonicalMemory({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      memoryId: z.string().parse(evidence.humanMemoryId)
    });
    return (
      memory !== undefined &&
      memory.memory.authority === "human_authored" &&
      memory.memory.revisionId === evidence.humanRevisionId &&
      memory.contentIdentity === evidence.humanContentIdentity
    );
  }
  if (evidence.evidenceClass === "code_or_configuration") {
    try {
      const filePath = await realpath(resolve(z.string().parse(evidence.filePath)));
      const content = await readFile(filePath);
      const contentIdentity = createHash("sha256").update(content).digest("hex");
      if (contentIdentity !== evidence.fileContentIdentity) return false;
      if (evidence.repositoryRoot !== undefined && evidence.repoRevision !== undefined) {
        const repositoryRoot = await realpath(resolve(evidence.repositoryRoot));
        const relativePath = relative(repositoryRoot, filePath);
        if (relativePath.startsWith("..") || isAbsolute(relativePath)) return false;
        const head = await readGitHead(repositoryRoot);
        return (
          head === evidence.repoRevision &&
          evidence.sourceIdentity ===
            `git:${evidence.repoRevision}:${relativePath}:${contentIdentity}`
        );
      }
      if (evidence.projectId === undefined) return false;
      const database = await openRuntimeDatabase(request.runtimeRoot);
      let roots: readonly Record<string, unknown>[];
      try {
        roots = database.prepare(
          `SELECT canonical_root FROM project_roots
           WHERE project_id = ? AND root_kind = 'non_git'`
        ).all(evidence.projectId);
      } finally {
        database.close();
      }
      const registeredRoots = await Promise.all(
        roots.map((row) => realpath(resolve(z.string().parse(row.canonical_root))))
      );
      const belongsToRegisteredRoot = registeredRoots.some((root) => {
        const relativePath = relative(root, filePath);
        return !relativePath.startsWith("..") && !isAbsolute(relativePath);
      });
      return (
        belongsToRegisteredRoot &&
        evidence.sourceIdentity === `file:${filePath}:${contentIdentity}`
      );
    } catch {
      return false;
    }
  }
  if (evidence.evidenceClass === "command_outcome") {
    const database = await openRuntimeDatabase(request.runtimeRoot);
    let captureRow: Record<string, unknown> | undefined;
    try {
      captureRow = database.prepare(
        `SELECT event_kind, occurred_at, project_id, source_truncated,
                whole_content_sha256
         FROM capture_events WHERE event_id = ?`
      ).get(evidence.evidenceId);
    } finally {
      database.close();
    }
    if (
      captureRow?.event_kind !== "PostToolUse" ||
      captureRow.source_truncated !== 0 ||
      captureRow.whole_content_sha256 !== evidence.evidenceContentIdentity ||
      captureRow.occurred_at !== evidence.occurredAt ||
      (evidence.projectId !== undefined && captureRow.project_id !== evidence.projectId)
    ) {
      return false;
    }
    const event = await readCapturedEvent(request.runtimeRoot, evidence.evidenceId);
    if (event?.eventKind !== "PostToolUse") return false;
    const payload = z.record(z.string(), z.unknown()).safeParse(event.payload);
    if (!payload.success) return false;
    return (
      payload.data.command === evidence.command &&
      payload.data.cwd === evidence.commandCwd &&
      payload.data.exitCode === evidence.commandExitCode &&
      payload.data.resultContentIdentity === evidence.commandResultIdentity
    );
  }
  return true;
}

async function isSemanticallyAssessableEvidence(request: {
  readonly evidence: CandidateEvidence;
  readonly runtimeRoot: string;
}): Promise<boolean> {
  const { evidence } = request;
  if (
    evidence.evidenceClass !== "command_outcome" ||
    !hasIntactCapturedEvidenceShape(evidence)
  ) {
    return false;
  }
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let captureRow: Record<string, unknown> | undefined;
  try {
    captureRow = database.prepare(
      `SELECT event_kind, agent, occurred_at, project_id, session_id, turn_id,
              source_truncated, whole_content_sha256
       FROM capture_events WHERE event_id = ?`
    ).get(evidence.evidenceId);
  } finally {
    database.close();
  }
  if (
    captureRow?.event_kind !== "PostToolUse" ||
    captureRow.source_truncated !== 0 ||
    captureRow.whole_content_sha256 !== evidence.evidenceContentIdentity ||
    captureRow.occurred_at !== evidence.occurredAt ||
    (evidence.projectId !== undefined && captureRow.project_id !== evidence.projectId)
  ) {
    return false;
  }
  const expectedSourceIdentity = `${z.string().parse(captureRow.agent)}:${
    typeof captureRow.session_id === "string" ? captureRow.session_id : "unknown"
  }:${
    typeof captureRow.turn_id === "string" ? captureRow.turn_id : evidence.evidenceId
  }`;
  if (evidence.sourceIdentity !== expectedSourceIdentity) return false;
  return (await readCapturedEvent(request.runtimeRoot, evidence.evidenceId))?.eventKind === "PostToolUse";
}

function confirmsHighValueTag(
  tag: ImportanceTag,
  eligibleEvidence: readonly CandidateEvidence[],
  importanceReasons: readonly ImportanceReason[]
): boolean {
  const reason = importanceReasons.find((item) => item.tag === tag);
  if (reason === undefined || reason.reason.trim().length === 0) return false;
  const citedEvidenceIds = new Set(reason.evidenceIds);
  const classes = new Set(
    eligibleEvidence
      .filter((item) => citedEvidenceIds.has(item.evidenceId))
      .map((item) => item.evidenceClass)
  );
  if (["user_decision", "stable_preference", "constraint", "exception"].includes(tag)) {
    return classes.has("explicit_user_statement");
  }
  if ([
    "failure_root_cause",
    "effective_repair",
    "recovery_procedure",
    "recurrence_hazard",
    "expensive_rediscovery"
  ].includes(tag)) {
    return classes.has("command_outcome") || classes.has("code_or_configuration");
  }
  return (
    classes.has("explicit_user_statement") ||
    classes.has("code_or_configuration") ||
    classes.has("human_memory_reference")
  );
}

function tokenEstimate(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4));
}

function materialContentIdentity(evidence: CandidateEvidence): string | undefined {
  return evidence.evidenceContentIdentity ??
    evidence.fileContentIdentity ??
    evidence.commandResultIdentity ??
    evidence.humanContentIdentity;
}

export async function createAgentCandidate(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot?: string;
  readonly scope:
    | { readonly kind: "project"; readonly projectId: string }
    | { readonly kind: "global" };
  readonly candidate: CandidateContent;
  readonly evidence: readonly CandidateEvidence[];
  readonly sourceSessionId?: string;
  readonly globalAuthorizationId?: string;
  readonly startup?: "auto" | "always" | "never";
  readonly createdAt: string;
}): Promise<CreateCandidateResult> {
  const createdAt = z.iso.datetime().parse(request.createdAt);
  const normalizedCandidate: CandidateContent = {
    ...request.candidate,
    sensitivity: request.candidate.sensitivity ?? "normal",
    importanceReasons: request.candidate.importanceReasons ?? []
  };
  if (request.candidate.statement.trim().length === 0) {
    throw new Error("A Candidate statement cannot be empty.");
  }
  const primaryCategory = memoryCategorySchema.parse(request.candidate.primaryCategory);
  const categoryTags = request.candidate.categoryTags.map((category) =>
    memoryCategorySchema.parse(category)
  );
  if (
    new Set(categoryTags).size !== categoryTags.length ||
    selectPrimaryCategory(categoryTags) !== primaryCategory
  ) {
    throw new Error("A Candidate contains invalid controlled categories.");
  }
  if (request.evidence.length === 0) {
    throw new Error("An Agent-derived Candidate requires provenance-bound evidence.");
  }
  if (request.candidate.importanceTags.some((tag) => !controlledImportanceTags.has(tag))) {
    throw new Error("A Candidate contains an uncontrolled importance tag.");
  }
  const availableEvidenceIds = new Set(request.evidence.map((item) => item.evidenceId));
  const reasonTags = request.candidate.importanceReasons?.map((item) => item.tag) ?? [];
  if (
    new Set(reasonTags).size !== reasonTags.length ||
    reasonTags.some((tag) => !request.candidate.importanceTags.includes(tag)) ||
    (request.candidate.importanceReasons ?? []).some((item) =>
      item.evidenceIds.some((evidenceId) => !availableEvidenceIds.has(evidenceId))
    )
  ) {
    throw new Error("A Candidate contains invalid importance-tag evidence.");
  }
  const sensitivity = classifyLocalSensitivity(JSON.stringify(normalizedCandidate));
  if (sensitivity.state === "secret") {
    return { state: "blocked_secret", category: sensitivity.category };
  }
  if (sensitivity.state === "uncertain") {
    return { state: "quarantined", category: sensitivity.category };
  }
  const eligibleEvidence = (
    await Promise.all(request.evidence.map(async (evidence) => ({
      evidence,
      inScope: await evidenceMatchesScope(request.runtimeRoot, evidence, request.scope),
      eligible:
        await isEligibleEvidence({
          evidence,
          runtimeRoot: request.runtimeRoot,
          ...(request.vaultRoot === undefined ? {} : { vaultRoot: request.vaultRoot })
        }) ||
        await isSemanticallyAssessableEvidence({
          evidence,
          runtimeRoot: request.runtimeRoot
        })
    })))
  ).filter((item) =>
    item.eligible && item.inScope
  ).map((item) => item.evidence);

  let globalAuthorization:
    | {
        readonly authorizationId: string;
        readonly operationId: string;
        readonly sourceIdentity: string;
      }
    | undefined;
  if (request.globalAuthorizationId !== undefined) {
    if (request.scope.kind !== "global") {
      throw new Error("Global authorization cannot be attached to Project Memory.");
    }
    const authorizationDatabase = await openRuntimeDatabase(request.runtimeRoot);
    try {
      const row = authorizationDatabase.prepare(
        `SELECT operation_id, source_identity, statement_identity,
                maximum_sensitivity
         FROM human_global_authorizations WHERE authorization_id = ?`
      ).get(request.globalAuthorizationId);
      const statementIdentity = createHash("sha256")
        .update(normalizedCandidate.statement.trim())
        .digest("hex");
      if (
        row === undefined ||
        row.statement_identity !== statementIdentity ||
        ((normalizedCandidate.sensitivity ?? "normal") === "private" &&
          row.maximum_sensitivity !== "private")
      ) {
        throw new Error("Global authorization does not cover this Candidate.");
      }
      globalAuthorization = {
        authorizationId: request.globalAuthorizationId,
        operationId: z.string().parse(row.operation_id),
        sourceIdentity: z.string().parse(row.source_identity)
      };
    } finally {
      authorizationDatabase.close();
    }
  }

  const fingerprint = candidateFingerprint(request.scope, normalizedCandidate);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = database
        .prepare(
          `SELECT candidate_id, candidate_json, promotion_generation FROM memory_candidates
           WHERE fingerprint = ? AND state != 'expired'`
        )
        .get(fingerprint);
      if (typeof existing?.promotion_generation === "number") {
        throw new Error("Candidate promotion is in progress; retry evidence merge.");
      }
      const tombstone =
        existing === undefined
          ? database
              .prepare(
                `SELECT candidate_id, source_identities_json
                 FROM candidate_tombstones WHERE fingerprint = ?
                 ORDER BY expired_at DESC LIMIT 1`
              )
              .get(fingerprint)
          : undefined;
      let predecessorTombstoneCandidateId: string | null = null;
      if (tombstone !== undefined) {
        const previousSources = new Set(
          z.array(z.string()).parse(
            JSON.parse(z.string().parse(tombstone.source_identities_json))
          )
        );
        const hasMateriallyNewEvidence = request.evidence.some(
          (item) => !item.memoryEcho && !previousSources.has(item.sourceIdentity)
        );
        if (!hasMateriallyNewEvidence) {
          database.exec("COMMIT");
          return {
            state: "merged",
            candidateId: z.string().parse(tombstone.candidate_id)
          };
        }
        predecessorTombstoneCandidateId = z.string().parse(tombstone.candidate_id);
      }
      const candidateId =
        existing === undefined
          ? `mscand_${randomUUID()}`
          : z.string().parse(existing.candidate_id);
      if (existing === undefined) {
        const highValue =
          normalizedCandidate.certainty !== "speculative" &&
          normalizedCandidate.importanceTags.length > 0 &&
          normalizedCandidate.importanceTags.every((tag) =>
            confirmsHighValueTag(
              tag,
              eligibleEvidence,
              normalizedCandidate.importanceReasons ?? []
            )
          );
        const validEvidenceTimes = eligibleEvidence
          .map((item) => z.iso.datetime().parse(item.occurredAt));
        const lastEvidenceAt = validEvidenceTimes.sort().at(-1) ?? createdAt;
        database
          .prepare(
            `INSERT INTO memory_candidates(
               candidate_id, fingerprint, scope_kind, project_id, statement,
               candidate_json, category, certainty, state, high_value, sensitivity,
               global_authorization_id, global_authorization_operation_id,
               global_authorization_source_identity, source_session_id, created_at,
               last_evidence_at, updated_at, predecessor_tombstone_candidate_id, startup
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            candidateId,
            fingerprint,
            request.scope.kind,
            request.scope.kind === "project" ? request.scope.projectId : null,
            normalizedCandidate.statement,
            JSON.stringify(normalizedCandidate),
            normalizedCandidate.primaryCategory,
            normalizedCandidate.certainty,
            highValue ? 1 : 0,
            normalizedCandidate.sensitivity ?? "normal",
            globalAuthorization?.authorizationId ?? null,
            globalAuthorization?.operationId ?? null,
            globalAuthorization?.sourceIdentity ?? null,
            request.sourceSessionId ?? null,
            createdAt,
            lastEvidenceAt,
            createdAt,
            predecessorTombstoneCandidateId,
            request.startup ?? "auto"
          );
      }
      if (
        existing !== undefined &&
        typeof existing.candidate_json === "string" &&
        normalizedCandidate.durability !== undefined
      ) {
        const existingCandidate = JSON.parse(existing.candidate_json) as CandidateContent;
        if (
          existingCandidate.durability !== undefined &&
          durabilityStrictness(normalizedCandidate.durability.disposition) >
            durabilityStrictness(existingCandidate.durability.disposition)
        ) {
          database.prepare(
            `UPDATE memory_candidates
             SET candidate_json = ?, updated_at = ?
             WHERE candidate_id = ?`
          ).run(
            JSON.stringify({
              ...existingCandidate,
              durability: normalizedCandidate.durability
            }),
            createdAt,
            candidateId
          );
        }
      }
      if (existing !== undefined && globalAuthorization !== undefined) {
        database.prepare(
          `UPDATE memory_candidates
           SET global_authorization_id = COALESCE(global_authorization_id, ?),
               global_authorization_operation_id =
                 COALESCE(global_authorization_operation_id, ?),
               global_authorization_source_identity =
                 COALESCE(global_authorization_source_identity, ?),
               updated_at = ?
           WHERE candidate_id = ?`
        ).run(
          globalAuthorization.authorizationId,
          globalAuthorization.operationId,
          globalAuthorization.sourceIdentity,
          createdAt,
          candidateId
        );
      }

      const insertEvidence = database.prepare(
        `INSERT OR IGNORE INTO candidate_evidence(
           candidate_id, evidence_id, evidence_class, source_identity,
           project_id, occurred_at, integrity, source_truncated, memory_echo,
               repo_revision, evidence_content_identity, file_content_identity,
               file_path, repository_root,
               command_text, command_cwd, command_result_identity,
               command_exit_code, human_memory_id, human_revision_id,
               human_content_identity
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const existingEvidence = existing === undefined
        ? []
        : database.prepare(
            `SELECT source_identity, evidence_content_identity
             FROM candidate_evidence WHERE candidate_id = ?`
          ).all(candidateId);
      const existingSourceIdentities = new Set(
        existingEvidence.map((item) => z.string().parse(item.source_identity))
      );
      const existingContentIdentities = new Set(
        existingEvidence.flatMap((item) =>
          typeof item.evidence_content_identity === "string"
            ? [item.evidence_content_identity]
            : []
        )
      );
      let addedMaterialEvidence = false;
      let newestMaterialEvidenceAt: string | undefined;
      const eligibleEvidenceIds = new Set(eligibleEvidence.map((item) => item.evidenceId));
      for (const evidence of request.evidence) {
        const inserted = insertEvidence.run(
          candidateId,
          evidence.evidenceId,
          evidence.evidenceClass,
          evidence.sourceIdentity,
          evidence.projectId ?? null,
          z.iso.datetime().parse(evidence.occurredAt),
          evidence.integrity,
          evidence.sourceTruncated ? 1 : 0,
          evidence.memoryEcho ? 1 : 0,
          evidence.repoRevision ?? null,
          materialContentIdentity(evidence) ?? null,
          evidence.fileContentIdentity ?? null,
          evidence.filePath ?? null,
          evidence.repositoryRoot ?? null,
          evidence.command ?? null,
          evidence.commandCwd ?? null,
          evidence.commandResultIdentity ?? null,
          evidence.commandExitCode ?? null,
          evidence.humanMemoryId ?? null,
          evidence.humanRevisionId ?? null,
          evidence.humanContentIdentity ?? null
        );
        const sourceIsNew = !existingSourceIdentities.has(evidence.sourceIdentity);
        const contentIdentity = materialContentIdentity(evidence);
        const contentIsNew =
          contentIdentity !== undefined &&
          !existingContentIdentities.has(contentIdentity);
        if (
          inserted.changes === 1 &&
          !evidence.memoryEcho &&
          !evidence.sourceTruncated &&
          evidence.integrity === "intact" &&
          eligibleEvidenceIds.has(evidence.evidenceId) &&
          sourceIsNew &&
          contentIsNew
        ) {
          addedMaterialEvidence = true;
          const occurredAt = z.iso.datetime().parse(evidence.occurredAt);
          newestMaterialEvidenceAt =
            newestMaterialEvidenceAt === undefined || occurredAt > newestMaterialEvidenceAt
              ? occurredAt
              : newestMaterialEvidenceAt;
        }
        existingSourceIdentities.add(evidence.sourceIdentity);
        if (contentIdentity !== undefined) {
          existingContentIdentities.add(contentIdentity);
        }
      }
      if (existing !== undefined && addedMaterialEvidence) {
        database
          .prepare(
            `UPDATE memory_candidates
             SET last_evidence_at = ?, updated_at = ?,
                 evidence_generation = evidence_generation + 1,
                 successful_evaluation_at = NULL
             WHERE candidate_id = ?`
          )
          .run(newestMaterialEvidenceAt ?? createdAt, createdAt, candidateId);
        database.prepare(
          `UPDATE candidate_expiration_obligations
           SET state = 'cancelled' WHERE candidate_id = ? AND state = 'pending'`
        ).run(candidateId);
      }
      database
        .prepare(
          `INSERT INTO governance_decisions(
             decision_id, candidate_id, decision, reason, decided_at
           ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          `msdecision_${randomUUID()}`,
          candidateId,
          existing === undefined ? "wait" : "merge",
          existing === undefined ? "novelty_insert" : "novelty_update_exact_alias",
          createdAt
        );
      database.exec("COMMIT");
      return { state: existing === undefined ? "candidate" : "merged", candidateId };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function listSessionCandidates(
  runtimeRoot: string,
  sessionId: string
): Promise<readonly { readonly candidateId: string; readonly state: CandidateState }[]> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    return database
      .prepare(
        `SELECT candidate_id, state FROM memory_candidates
         WHERE source_session_id = ? ORDER BY created_at, candidate_id`
      )
      .all(sessionId)
      .map((row) => ({
        candidateId: z.string().parse(row.candidate_id),
        state: candidateStateSchema.parse(row.state)
      }));
  } finally {
    database.close();
  }
}

export {
  evaluateHighValueAnomalies
} from "./anomalies.js";
function canonicalFromCandidate(request: {
  readonly candidate: CandidateContent;
  readonly scope:
    | { readonly kind: "project"; readonly projectId: string }
    | { readonly kind: "global" };
  readonly evidence: readonly CandidateEvidence[];
  readonly now: string;
  readonly memoryId: string;
  readonly revisionId: string;
  readonly startup: "auto" | "always" | "never";
  readonly globalAuthorization?: {
    readonly operationId: string;
    readonly sourceIdentity: string;
  };
}): CanonicalMemory {
  const memoryId = request.memoryId;
  const revisionId = request.revisionId;
  const compact = assessExactCompact({
    body: request.candidate.statement,
    conditions: request.candidate.conditions,
    exclusions: request.candidate.exclusions,
    preservedNegations: request.candidate.preservedNegations
  });
  return {
    schemaVersion: 1,
    memoryId,
    revisionId,
    scope: request.scope,
    authority: "agent_derived",
    originKind: "model_extraction",
    sensitivity: request.candidate.sensitivity ?? "normal",
    lifecycle: "active",
    lifecycleDetails: {},
    primaryCategory: request.candidate.primaryCategory,
    categoryTags: [...request.candidate.categoryTags],
    importanceTags: [...request.candidate.importanceTags],
    startup: request.startup,
    applicability: {
      summary: request.candidate.applicabilitySummary,
      conditions: [...request.candidate.conditions]
    },
    validity: { state: "valid" },
    createdAt: request.now,
    revisedAt: request.now,
    semanticContract: {
      schemaVersion: 1,
      claims: [request.candidate.statement],
      conditions: [...request.candidate.conditions],
      exclusions: [...request.candidate.exclusions],
      preservedNegations: [...request.candidate.preservedNegations]
    },
    representations: {
      compact: {
        text: compact.text,
        validated: compact.validated,
        generatorIdentity: "gpt-5.6-luna",
        sourceRevisionId: revisionId,
        renderedTokenCount: compact.renderedTokenCount
      },
      standard: {
        text: request.candidate.statement,
        validated: true,
        generatorIdentity: "gpt-5.6-luna",
        sourceRevisionId: revisionId,
        renderedTokenCount: tokenEstimate(request.candidate.statement)
      }
    },
    provenance: [
      ...request.evidence.map((item) => item.sourceIdentity),
      ...(request.globalAuthorization === undefined
        ? []
        : [
            `operation:${request.globalAuthorization.operationId}`,
            `source:${request.globalAuthorization.sourceIdentity}`
          ])
    ],
    injectionReceiptIds: [],
    relationships: [],
    contentIdentity: "0".repeat(64),
    policyVersion: "candidate-governance-v1",
    body: request.candidate.statement
  };
}

export type CandidateEvaluationResult =
  | { readonly state: "promoted"; readonly candidateId: string; readonly memoryId: string }
  | {
      readonly state: "wait";
      readonly candidateId: string;
      readonly reason: string;
      readonly verificationRequestId?: string;
    }
  | { readonly state: "rejected" | "conflict"; readonly candidateId: string; readonly reason: string };

async function loadDurableSemanticAssessment(request: {
  readonly runtimeRoot: string;
  readonly candidateId: string;
  readonly operationId?: string;
}): Promise<SemanticAssessment | undefined> {
  if (request.operationId === undefined) {
    const reader = await openRuntimeDatabase(request.runtimeRoot);
    try {
      const cached = reader.prepare(`SELECT w.assessment_operation_id FROM active_capacity_waiters w
        JOIN memory_candidates c USING(candidate_id)
        JOIN luna_operations o ON o.operation_id=w.assessment_operation_id
        WHERE w.candidate_id=? AND w.evidence_generation=c.evidence_generation AND o.state='completed'`)
        .get(request.candidateId);
      if (typeof cached?.assessment_operation_id !== "string") return undefined;
      request = { ...request, operationId: cached.assessment_operation_id };
    } finally { reader.close(); }
  }
  const operationId = z.string().parse(request.operationId);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const row = database.prepare(
      `SELECT assessment.state, assessment.evidence_ids_json,
              assessment.durability_disposition,
              assessment.assessed_by, assessment.evidence_generation,
              operation.payload_json, candidate.evidence_generation AS current_generation,
              operation.operation_kind, operation.state AS operation_state
       FROM semantic_assessments AS assessment
       JOIN luna_operations AS operation
         ON operation.operation_id = assessment.operation_id
       JOIN memory_candidates AS candidate
         ON candidate.candidate_id = assessment.candidate_id
       WHERE assessment.operation_id = ? AND assessment.candidate_id = ?`
    ).get(operationId, request.candidateId);
    if (
      row === undefined ||
      row.operation_kind !== "semantic_assessment" ||
      (row.operation_state !== "processing" && row.operation_state !== "completed")
    ) {
      throw new Error("Semantic assessment is not a durable Luna result for this Candidate.");
    }
    const operationPayload = z.object({
      candidateId: z.string(),
      evidenceGeneration: z.number().int().positive()
    }).parse(
      JSON.parse(z.string().parse(row.payload_json))
    );
    if (
      operationPayload.candidateId !== request.candidateId ||
      operationPayload.evidenceGeneration !== row.evidence_generation ||
      row.evidence_generation !== row.current_generation
    ) {
      throw new Error("Semantic assessment is stale or bound to another Candidate.");
    }
    return {
      state: z.enum([
        "supported",
        "partially_supported",
        "contradicted",
        "insufficient_evidence"
      ]).parse(row.state),
      evidenceIds: z.array(z.string()).parse(
        JSON.parse(z.string().parse(row.evidence_ids_json))
      ),
      durabilityDisposition: z.enum([
        "durable",
        "task_local",
        "transient",
        "no_retention",
        "uncertain",
        "legacy_unclassified"
      ]).parse(row.durability_disposition),
      assessedBy: z.literal("gpt-5.6-luna").parse(row.assessed_by),
      operationId
    };
  } finally {
    database.close();
  }
}

export async function evaluateCandidate(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly candidateId: string;
  readonly evaluatedAt: string;
  readonly semanticAssessmentOperationId?: string;
  readonly verificationNeed?: {
    readonly description: string;
    readonly proposedAction: string;
  };
  readonly materialConflict?: boolean;
  readonly onPromotionReserved?: () => Promise<void>;
}): Promise<CandidateEvaluationResult> {
  const evaluatedAt = z.iso.datetime().parse(request.evaluatedAt);
  const semanticAssessment = await loadDurableSemanticAssessment({
    runtimeRoot: request.runtimeRoot,
    candidateId: request.candidateId,
    ...(request.semanticAssessmentOperationId === undefined
      ? {}
      : { operationId: request.semanticAssessmentOperationId })
  });
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let row: Record<string, unknown>;
  let evidenceRows: readonly Record<string, unknown>[];
  try {
    const found = database
      .prepare("SELECT * FROM memory_candidates WHERE candidate_id = ?")
      .get(request.candidateId);
    if (found === undefined) throw new Error("Candidate does not exist.");
    row = found;
    evidenceRows = database
      .prepare("SELECT * FROM candidate_evidence WHERE candidate_id = ? ORDER BY occurred_at")
      .all(request.candidateId);
  } finally {
    database.close();
  }
  if (row.state === "promoted" && typeof row.promoted_memory_id === "string") {
    return {
      state: "promoted",
      candidateId: request.candidateId,
      memoryId: row.promoted_memory_id
    };
  }
  const candidate = JSON.parse(z.string().parse(row.candidate_json)) as CandidateContent;
  const evaluationGeneration = z.number().int().positive().parse(row.evidence_generation);
  const scope =
    row.scope_kind === "global"
      ? ({ kind: "global" } as const)
      : ({ kind: "project", projectId: z.string().parse(row.project_id) } as const);
  const evidence: CandidateEvidence[] = evidenceRows.map((item) => ({
    evidenceId: z.string().parse(item.evidence_id),
    evidenceClass: z
      .enum(["explicit_user_statement", "code_or_configuration", "command_outcome", "human_memory_reference", "agent_summary", "other"])
      .parse(item.evidence_class),
    sourceIdentity: z.string().parse(item.source_identity),
    ...(typeof item.project_id === "string" ? { projectId: item.project_id } : {}),
    occurredAt: z.string().parse(item.occurred_at),
    integrity: z.enum(["intact", "ambiguous", "truncated"]).parse(item.integrity),
    sourceTruncated: item.source_truncated === 1,
    memoryEcho: item.memory_echo === 1,
    ...(typeof item.repo_revision === "string" ? { repoRevision: item.repo_revision } : {}),
    ...(typeof item.evidence_content_identity === "string"
      ? { evidenceContentIdentity: item.evidence_content_identity }
      : {}),
    ...(typeof item.file_content_identity === "string"
      ? { fileContentIdentity: item.file_content_identity }
      : {}),
    ...(typeof item.file_path === "string" ? { filePath: item.file_path } : {}),
    ...(typeof item.repository_root === "string"
      ? { repositoryRoot: item.repository_root }
      : {}),
    ...(typeof item.command_text === "string" ? { command: item.command_text } : {}),
    ...(typeof item.command_cwd === "string" ? { commandCwd: item.command_cwd } : {}),
    ...(typeof item.command_result_identity === "string"
      ? { commandResultIdentity: item.command_result_identity }
      : {}),
    ...(typeof item.command_exit_code === "number"
      ? { commandExitCode: item.command_exit_code }
      : {}),
    ...(typeof item.human_memory_id === "string"
      ? { humanMemoryId: item.human_memory_id }
      : {}),
    ...(typeof item.human_revision_id === "string"
      ? { humanRevisionId: item.human_revision_id }
      : {}),
    ...(typeof item.human_content_identity === "string"
      ? { humanContentIdentity: item.human_content_identity }
      : {})
  }));

  if (request.verificationNeed !== undefined) {
    const verificationRequestId = `msverify_${randomUUID()}`;
    const update = await openRuntimeDatabase(request.runtimeRoot);
    try {
      update.exec("BEGIN IMMEDIATE");
      update.prepare(
        `INSERT INTO verification_requests(
           verification_request_id, candidate_id, description, proposed_action,
           state, created_at
         ) VALUES (?, ?, ?, ?, 'open', ?)`
      ).run(
        verificationRequestId,
        request.candidateId,
        request.verificationNeed.description,
        request.verificationNeed.proposedAction,
        evaluatedAt
      );
      update.prepare(
        `UPDATE memory_candidates SET successful_evaluation_at = ?, updated_at = ?
         WHERE candidate_id = ?`
      ).run(evaluatedAt, evaluatedAt, request.candidateId);
      recordDecision(update, request.candidateId, "wait", "verification_required", evaluatedAt);
      update.exec("COMMIT");
    } catch (error) {
      update.exec("ROLLBACK");
      throw error;
    } finally {
      update.close();
    }
    return { state: "wait", candidateId: request.candidateId, reason: "verification_required", verificationRequestId };
  }

  if (semanticAssessment !== undefined) {
    const availableEvidenceIds = new Set(evidence.map((item) => item.evidenceId));
    if (
      (semanticAssessment.state === "supported" &&
        semanticAssessment.evidenceIds.length === 0) ||
      semanticAssessment.evidenceIds.some(
        (evidenceId) => !availableEvidenceIds.has(evidenceId)
      )
    ) {
      throw new Error("Semantic assessment cites unavailable Candidate evidence.");
    }
  }

  if (request.materialConflict === true) {
    return commitNonPromotion(request.runtimeRoot, request.candidateId, "conflict", "material_conflict", evaluatedAt);
  }
  if (semanticAssessment?.state === "contradicted") {
    return commitNonPromotion(request.runtimeRoot, request.candidateId, "rejected", "semantic_contradiction", evaluatedAt);
  }
  const evidenceEligibility = await Promise.all(evidence.map(async (item) => ({
    item,
    inScope: await evidenceMatchesScope(request.runtimeRoot, item, scope),
    deterministic: await isEligibleEvidence({
      evidence: item,
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot
    }),
    semanticallyAssessable: await isSemanticallyAssessableEvidence({
      evidence: item,
      runtimeRoot: request.runtimeRoot
    })
  })));
  const scopedEvidenceEligibility = evidenceEligibility.filter(({ inScope }) => inScope);
  const deterministicEvidence = scopedEvidenceEligibility
    .filter((item) => item.deterministic)
    .map((item) => item.item);
  const semanticOnlyEvidence = scopedEvidenceEligibility
    .filter((item) => item.semanticallyAssessable && !item.deterministic)
    .map((item) => item.item);
  if (deterministicEvidence.length === 0 && semanticOnlyEvidence.length === 0) {
    return commitNonPromotion(request.runtimeRoot, request.candidateId, "wait", "insufficient_evidence", evaluatedAt);
  }
  const onlyExplicitUserEvidence = scopedEvidenceEligibility.length > 0 &&
    scopedEvidenceEligibility.every(
      (item) => item.item.evidenceClass === "explicit_user_statement"
    );
  const hasStableExplicitUserClassification = candidate.importanceTags.some(
    (tag) => stableExplicitUserTags.has(tag)
  );
  const fullValidationRequired =
    scope.kind === "global" ||
    evidence.length > 1 ||
    candidate.certainty !== "asserted" ||
    semanticOnlyEvidence.length > 0 ||
    (onlyExplicitUserEvidence && !hasStableExplicitUserClassification);
  if (
    fullValidationRequired &&
    semanticAssessment?.state !== "supported"
  ) {
    return commitNonPromotion(
      request.runtimeRoot,
      request.candidateId,
      "wait",
      "semantic_assessment_required",
      evaluatedAt,
      semanticAssessment !== undefined
    );
  }
  const assessedEvidenceIds = new Set(semanticAssessment?.evidenceIds ?? []);
  const eligibleEvidence = [
    ...deterministicEvidence,
    ...semanticOnlyEvidence.filter((item) => assessedEvidenceIds.has(item.evidenceId))
  ];
  if (eligibleEvidence.length === 0) {
    return commitNonPromotion(
      request.runtimeRoot,
      request.candidateId,
      "wait",
      "insufficient_evidence",
      evaluatedAt
    );
  }
  if (semanticAssessment !== undefined) {
    const disposition = semanticAssessment.durabilityDisposition ?? "legacy_unclassified";
    if (["task_local", "transient", "no_retention"].includes(disposition)) {
      return commitNonPromotion(
        request.runtimeRoot,
        request.candidateId,
        "rejected",
        `non_durable_${disposition}`,
        evaluatedAt,
        true
      );
    }
    if (disposition === "uncertain" || disposition === "legacy_unclassified") {
      return commitNonPromotion(
        request.runtimeRoot,
        request.candidateId,
        "wait",
        disposition === "uncertain"
          ? "durability_uncertain"
          : "durability_assessment_required",
        evaluatedAt,
        true
      );
    }
  }
  if (
    scope.kind === "global" &&
    (candidate.sensitivity ?? "normal") === "private" &&
    typeof row.global_authorization_id !== "string"
  ) {
    return commitNonPromotion(
      request.runtimeRoot,
      request.candidateId,
      "wait",
      "private_global_requires_human_authorization",
      evaluatedAt
    );
  }
  if (scope.kind === "global" && typeof row.global_authorization_id !== "string") {
    const independentProjects = new Set(
      eligibleEvidence.flatMap((item) =>
        item.projectId === undefined || !assessedEvidenceIds.has(item.evidenceId)
          ? []
          : [item.projectId]
      )
    );
    const assessedEligibleEvidence = eligibleEvidence.filter((item) =>
      assessedEvidenceIds.has(item.evidenceId)
    );
    const independentSources = new Set(
      assessedEligibleEvidence.map((item) => item.sourceIdentity)
    );
    const independentContents = new Set(
      assessedEligibleEvidence.flatMap((item) => {
        const identity = materialContentIdentity(item);
        return identity === undefined ? [] : [identity];
      })
    );
    if (
      independentProjects.size < 2 ||
      independentSources.size < 2 ||
      independentContents.size < 2
    ) {
      return commitNonPromotion(request.runtimeRoot, request.candidateId, "wait", "global_corroboration_missing", evaluatedAt);
    }
  }

  if (
    candidate.durability?.disposition === "session_only" ||
    candidate.durability?.disposition === "project_phase"
  ) {
    return commitNonPromotion(
      request.runtimeRoot,
      request.candidateId,
      "wait",
      `durability_${candidate.durability.disposition}_hold`,
      evaluatedAt
    );
  }

  const capacityPolicy = await loadMemoryCapacityPolicy({
    runtimeRoot: request.runtimeRoot,
    vaultRoot: request.vaultRoot
  });
  const capacityLimits = capacityLimitsForScope(capacityPolicy, scope);
  const reservationDatabase = await openRuntimeDatabase(request.runtimeRoot);
  let memoryId: string;
  let revisionId: string;
  let capacityBlocked = false;
  try {
    reservationDatabase.exec("BEGIN IMMEDIATE");
    const activeCountRow = reservationDatabase.prepare(
      `SELECT
         (SELECT COUNT(*) FROM memory_catalog
          WHERE lifecycle = 'active' AND authority = 'agent_derived'
            AND scope_kind = ? AND (? = 'global' OR project_id = ?)
            AND NOT EXISTS (
              SELECT 1 FROM memory_ranking_exclusions AS exclusion
              WHERE exclusion.memory_id = memory_catalog.memory_id
                AND exclusion.revision_id = memory_catalog.current_revision_id
                AND exclusion.space_key = CASE
                  WHEN memory_catalog.scope_kind = 'global' THEN 'global'
                  ELSE 'project:' || memory_catalog.project_id END
            ))
         +
         (SELECT COUNT(*) FROM memory_candidates
          WHERE state = 'waiting' AND promotion_generation IS NOT NULL
            AND scope_kind = ? AND (? = 'global' OR project_id = ?)) AS count`
    ).get(
      scope.kind,
      scope.kind,
      scope.kind === "project" ? scope.projectId : null,
      scope.kind,
      scope.kind,
      scope.kind === "project" ? scope.projectId : null
    );
    const activeCount = z.number().int().nonnegative().parse(activeCountRow?.count);
    if (activeCount >= capacityLimits.hardLimit) {
      capacityBlocked = true;
      reservationDatabase.exec("COMMIT");
      memoryId = "";
      revisionId = "";
    } else {
    const reserved = reservationDatabase.prepare(
      `UPDATE memory_candidates
       SET promoted_memory_id = COALESCE(promoted_memory_id, ?),
           promotion_revision_id = COALESCE(promotion_revision_id, ?),
           promotion_generation = COALESCE(promotion_generation, ?),
           updated_at = ?
       WHERE candidate_id = ? AND state = 'waiting'
         AND evidence_generation = ?
         AND (promotion_generation IS NULL OR promotion_generation = ?)`
    ).run(
      `msmem_${randomUUID()}`,
      `msrev_${randomUUID()}`,
      evaluationGeneration,
      evaluatedAt,
      request.candidateId,
      evaluationGeneration,
      evaluationGeneration
    );
    if (reserved.changes !== 1) {
      throw new Error("Candidate changed before promotion could be reserved.");
    }
    const reservation = reservationDatabase.prepare(
      `SELECT promoted_memory_id, promotion_revision_id
       FROM memory_candidates WHERE candidate_id = ?`
    ).get(request.candidateId);
    memoryId = z.string().parse(reservation?.promoted_memory_id);
    revisionId = z.string().parse(reservation?.promotion_revision_id);
      reservationDatabase.exec("COMMIT");
    }
  } catch (error) {
    reservationDatabase.exec("ROLLBACK");
    throw error;
  } finally {
    reservationDatabase.close();
  }
  if (capacityBlocked) {
    await reconcileMemoryCapacity({
      runtimeRoot: request.runtimeRoot,
      policy: capacityPolicy,
      observedAt: evaluatedAt
    });
    return commitNonPromotion(
      request.runtimeRoot,
      request.candidateId,
      "wait",
      "memory_space_capacity_hard_limit",
      evaluatedAt
    );
  }
  await request.onPromotionReserved?.();
  const memory = canonicalFromCandidate({
    candidate,
    scope,
    evidence,
    now: evaluatedAt,
    memoryId,
    revisionId,
    startup: z.enum(["auto", "always", "never"]).parse(row.startup),
    ...(typeof row.global_authorization_operation_id === "string" &&
    typeof row.global_authorization_source_identity === "string"
      ? {
          globalAuthorization: {
            operationId: row.global_authorization_operation_id,
            sourceIdentity: row.global_authorization_source_identity
          }
        }
      : {})
  });
  const existingMemory = await readCanonicalMemory({
    vaultRoot: request.vaultRoot,
    runtimeRoot: request.runtimeRoot,
    memoryId
  });
  if (existingMemory === undefined) {
    try {
    await writeCanonicalMemory({
      vaultRoot: request.vaultRoot,
      runtimeRoot: request.runtimeRoot,
      actor: "agent",
      memory
    });
    } catch (error) {
      if (!(error instanceof ActiveCapacityError)) throw error;
      const writer = await openRuntimeDatabase(request.runtimeRoot);
      try {
        writer.exec("BEGIN IMMEDIATE");
        writer.prepare(`UPDATE memory_candidates SET promotion_generation=NULL, successful_evaluation_at=?, updated_at=?
          WHERE candidate_id=? AND evidence_generation=? AND promotion_generation=?`)
          .run(evaluatedAt, evaluatedAt, request.candidateId, evaluationGeneration, evaluationGeneration);
        writer.prepare(`INSERT INTO active_capacity_waiters VALUES (?, ?, ?, ?)
          ON CONFLICT(candidate_id) DO UPDATE SET evidence_generation=excluded.evidence_generation,
            assessment_operation_id=excluded.assessment_operation_id`)
          .run(request.candidateId, evaluationGeneration, semanticAssessment?.operationId ?? null, evaluatedAt);
        recordDecision(writer, request.candidateId, "wait", "aggregate_active_capacity_limit", evaluatedAt);
        writer.exec("COMMIT");
      } catch (cause) { writer.exec("ROLLBACK"); throw cause; }
      finally { writer.close(); }
      return { state: "wait", candidateId: request.candidateId, reason: "aggregate_active_capacity_limit" };
    }
  } else if (
    existingMemory.memory.authority !== "agent_derived" ||
    existingMemory.memory.revisionId !== revisionId ||
    existingMemory.memory.body !== candidate.statement ||
    JSON.stringify(existingMemory.memory.scope) !== JSON.stringify(scope)
  ) {
    throw new Error("Reserved promotion identity belongs to different Canonical content.");
  }
  if (candidate.retentionAssessment !== undefined) {
    await recordRetentionAssessment({ ...request, memory,
      assessment: candidate.retentionAssessment, assessedAt: evaluatedAt });
  }
  const update = await openRuntimeDatabase(request.runtimeRoot);
  try {
    update.exec("BEGIN IMMEDIATE");
    const committed = update.prepare(
      `UPDATE memory_candidates
       SET state = 'promoted', promoted_memory_id = ?, updated_at = ?,
           successful_evaluation_at = ?, promotion_generation = NULL
       WHERE candidate_id = ? AND state = 'waiting'
         AND evidence_generation = ? AND promotion_generation = ?`
    ).run(
      memoryId,
      evaluatedAt,
      evaluatedAt,
      request.candidateId,
      evaluationGeneration,
      evaluationGeneration
    );
    if (committed.changes !== 1) {
      throw new Error("Candidate changed before promotion could commit.");
    }
    recordDecision(update, request.candidateId, "promote", "promotion_gate_passed", evaluatedAt);
    update.prepare("DELETE FROM active_capacity_waiters WHERE candidate_id=?").run(request.candidateId);
    update.exec("COMMIT");
  } catch (error) {
    update.exec("ROLLBACK");
    throw error;
  } finally {
    update.close();
  }
  await reconcileMemoryCapacity({
    runtimeRoot: request.runtimeRoot,
    policy: capacityPolicy,
    observedAt: evaluatedAt
  });
  return { state: "promoted", candidateId: request.candidateId, memoryId };
}

function recordDecision(
  database: Awaited<ReturnType<typeof openRuntimeDatabase>>,
  candidateId: string,
  decision: "promote" | "merge" | "wait" | "conflict" | "reject" | "expire",
  reason: string,
  decidedAt: string
): void {
  database.prepare(
    `INSERT INTO governance_decisions(
       decision_id, candidate_id, decision, reason, decided_at
     ) VALUES (?, ?, ?, ?, ?)`
  ).run(`msdecision_${randomUUID()}`, candidateId, decision, reason, decidedAt);
}

async function commitNonPromotion(
  runtimeRoot: string,
  candidateId: string,
  state: "wait" | "rejected" | "conflict",
  reason: string,
  now: string,
  successfulEvaluation = true
): Promise<CandidateEvaluationResult> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    const persistedState = state === "wait" ? "waiting" : state;
    const updated = database.prepare(
      `UPDATE memory_candidates
       SET state = ?, updated_at = ?,
           successful_evaluation_at = CASE WHEN ? = 1 THEN ? ELSE successful_evaluation_at END
       WHERE candidate_id = ? AND promotion_generation IS NULL`
    ).run(
      persistedState,
      now,
      successfulEvaluation ? 1 : 0,
      now,
      candidateId
    );
    if (updated.changes !== 1) {
      const candidate = database.prepare(
        "SELECT promotion_generation FROM memory_candidates WHERE candidate_id = ?"
      ).get(candidateId);
      if (typeof candidate?.promotion_generation === "number") {
        throw new Error("Candidate promotion is in progress; retry governance evaluation.");
      }
      throw new Error("Candidate changed before governance evaluation could commit.");
    }
    recordDecision(database, candidateId, state === "rejected" ? "reject" : state, reason, now);
    database.prepare("DELETE FROM active_capacity_waiters WHERE candidate_id=?").run(candidateId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  return { state, candidateId, reason };
}

export {
  expireDueCandidates,
  inspectCandidate,
  inspectVerificationRequest,
  listRecallEligibleMemoryIds,
  purgeDueCandidateTombstones,
  scheduleDueCandidateExpirations
} from "./retention.js";
