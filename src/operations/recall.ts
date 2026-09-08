import { z } from "zod";

import { MemStoreCommandError } from "../contracts/envelope.js";
import { resolveMemoryReference } from "../memories/reference.js";
import { inspectProject } from "../projects/index.js";
import type { EmbeddingAdapter } from "../retrieval/index.js";
import type { RetrievalJudge } from "../retrieval/judge.js";
import {
  recallProvenance,
  recallRelated,
  recallSearch,
  recallShow,
  reportIrrelevant
} from "../retrieval/recall.js";

export interface RecallContext {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly path: string;
  readonly callerIdentity: string;
  readonly requestedAt: string;
  readonly sessionId?: string;
  readonly embeddingAdapter?: EmbeddingAdapter;
  readonly retrievalJudge?: RetrievalJudge;
}

async function currentProjectId(context: RecallContext): Promise<string | undefined> {
  const project = await inspectProject({
    path: context.path,
    runtimeRoot: context.runtimeRoot,
    ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId })
  });
  return project.status === "resolved" ? project.projectId : undefined;
}

export async function executeRecall(
  operation: "search" | "get" | "provenance" | "related" | "report_irrelevant",
  input: Readonly<Record<string, unknown>>,
  context: RecallContext
): Promise<unknown> {
  const sessionId = z.string().min(1).optional().parse(input.session_id ?? context.sessionId);
  const currentProject = await currentProjectId({ ...context, ...(sessionId === undefined ? {} : { sessionId }) });
  if (operation === "search") {
    const request = z.object({
      query: z.string().min(1),
      scope: z.enum(["current", "global", "project", "all_projects"]).default("current"),
      project_id: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      cursor: z.string().min(1).optional(),
      target_tokens: z.number().int().positive().optional()
    }).parse(input);
    if (request.scope === "project" && request.project_id === undefined) {
      throw new MemStoreCommandError("project_id_required", "Project scope requires project_id.");
    }
    return recallSearch({
      runtimeRoot: context.runtimeRoot,
      vaultRoot: context.vaultRoot,
      query: request.query,
      scope: request.scope,
      ...(request.scope === "current"
        ? { currentProjectId: currentProject ?? "unresolved" }
        : {}),
      ...(request.project_id === undefined ? {} : { projectId: request.project_id }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      ...(request.target_tokens === undefined ? {} : { targetTokens: request.target_tokens }),
      ...(context.embeddingAdapter === undefined ? {} : { adapter: context.embeddingAdapter }),
      ...(context.retrievalJudge === undefined ? {} : { judge: context.retrievalJudge }),
      callerIdentity: context.callerIdentity,
      requestedAt: context.requestedAt
    });
  }
  if (operation === "get") {
    const request = z.object({
      memory_id: z.string().min(1),
      revision: z.string().min(1).optional(),
      detail: z.enum(["compact", "standard", "full"]).optional()
    }).parse(input);
    const memory = await resolveMemoryReference(context.runtimeRoot, request.memory_id);
    return recallShow({
      runtimeRoot: context.runtimeRoot,
      vaultRoot: context.vaultRoot,
      memoryId: memory.memoryId,
      ...(request.revision === undefined ? {} : { revision: request.revision }),
      ...(request.detail === undefined ? {} : { detail: request.detail }),
      ...(currentProject === undefined ? {} : { currentProjectId: currentProject }),
      callerIdentity: context.callerIdentity,
      requestedAt: context.requestedAt
    });
  }
  if (operation === "provenance") {
    const request = z.object({
      memory_id: z.string().min(1),
      revision: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      cursor: z.string().min(1).optional(),
      target_tokens: z.number().int().positive().optional()
    }).parse(input);
    const memory = await resolveMemoryReference(context.runtimeRoot, request.memory_id);
    return recallProvenance({
      runtimeRoot: context.runtimeRoot,
      vaultRoot: context.vaultRoot,
      memoryId: memory.memoryId,
      ...(request.revision === undefined ? {} : { revision: request.revision }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      ...(request.target_tokens === undefined ? {} : { targetTokens: request.target_tokens }),
      callerIdentity: context.callerIdentity,
      requestedAt: context.requestedAt
    });
  }
  if (operation === "related") {
    const request = z.object({
      memory_id: z.string().min(1),
      revision: z.string().min(1).optional(),
      direction: z.enum(["incoming", "outgoing", "both"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      cursor: z.string().min(1).optional(),
      target_tokens: z.number().int().positive().optional()
    }).parse(input);
    const memory = await resolveMemoryReference(context.runtimeRoot, request.memory_id);
    return recallRelated({
      runtimeRoot: context.runtimeRoot,
      vaultRoot: context.vaultRoot,
      memoryId: memory.memoryId,
      ...(request.revision === undefined ? {} : { revision: request.revision }),
      ...(request.direction === undefined ? {} : { direction: request.direction }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      ...(request.target_tokens === undefined ? {} : { targetTokens: request.target_tokens }),
      ...(currentProject === undefined ? {} : { currentProjectId: currentProject }),
      callerIdentity: context.callerIdentity,
      requestedAt: context.requestedAt
    });
  }
  const request = z.object({
    receipt_id: z.string().min(1),
    memory_id: z.string().min(1)
  }).parse(input);
  const memory = await resolveMemoryReference(context.runtimeRoot, request.memory_id);
  return reportIrrelevant({
    runtimeRoot: context.runtimeRoot,
    receiptId: request.receipt_id,
    memoryId: memory.memoryId,
    callerIdentity: context.callerIdentity,
    observedAt: context.requestedAt
  });
}
