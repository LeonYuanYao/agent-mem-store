import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

import {
  assertHumanKnowledge,
  recordHumanGlobalAuthorization
} from "../candidates/human.js";
import { captureEvent } from "../capture/index.js";
import { MemStoreCommandError } from "../contracts/envelope.js";
import { classifyLocalSensitivity } from "../contracts/sensitivity.js";
import { inspectProject, resolveProject } from "../projects/index.js";
import { openRuntimeDatabase } from "../runtime/database.js";

export type RememberScope = "project" | "global";
export type StartupPolicy = "auto" | "always" | "never";

type ResolvedScope =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "global" };

async function resolveRememberScope(request: {
  readonly scope: RememberScope;
  readonly path: string;
  readonly runtimeRoot: string;
}): Promise<ResolvedScope> {
  if (request.scope === "global") return { kind: "global" };
  const project = await resolveProject({
    path: request.path,
    runtimeRoot: request.runtimeRoot
  });
  if (project.status !== "resolved") {
    throw new MemStoreCommandError(
      "project_unresolved",
      `Project scope is unavailable: ${project.reason}.`
    );
  }
  return { kind: "project", projectId: project.projectId };
}

export async function rememberAssert(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly path: string;
  readonly body: string;
  readonly scope: RememberScope;
  readonly startup: StartupPolicy;
  readonly preview: boolean;
  readonly assertedAt: string;
}): Promise<unknown> {
  const body = z.string().min(1).parse(request.body);
  const sensitivity = classifyLocalSensitivity(body);
  if (request.preview) {
    const inspected = request.scope === "global"
      ? undefined
      : await inspectProject({ path: request.path, runtimeRoot: request.runtimeRoot });
    const plannedScope = request.scope === "global"
      ? ({ kind: "global" } as const)
      : inspected?.status === "resolved"
        ? ({ kind: "project", projectId: inspected.projectId } as const)
        : ({ kind: "project", projectResolution: inspected?.reason ?? "unregistered_project" } as const);
    const projectBlocked = inspected !== undefined &&
      inspected.status === "unresolved" &&
      inspected.reason !== "unregistered_project";
    return {
      dry_run: true,
      would_accept: sensitivity.state === "normal" && !projectBlocked,
      authority: "human_authored",
      scope: plannedScope,
      startup: request.startup,
      would_create: sensitivity.state === "normal" && !projectBlocked
        ? [
            ...(inspected?.status === "unresolved" ? ["project_registry_entry"] : []),
            "canonical_memory"
          ]
        : [],
      warnings: [
        ...(sensitivity.state === "normal" ? [] : [{ code: sensitivity.state, category: sensitivity.category }]),
        ...(projectBlocked ? [{ code: "project_unresolved", reason: inspected.reason }] : [])
      ]
    };
  }
  const scope = await resolveRememberScope(request);
  let globalAuthorizationId: string | undefined;
  if (scope.kind === "global" && sensitivity.state === "normal") {
    const authorization = await recordHumanGlobalAuthorization({
      runtimeRoot: request.runtimeRoot,
      statement: body,
      maximumSensitivity: "private",
      authorizedAt: request.assertedAt,
      sourceIdentity: "remember.assert"
    });
    globalAuthorizationId = authorization.authorizationId;
  }
  const result = await assertHumanKnowledge({
    runtimeRoot: request.runtimeRoot,
    vaultRoot: request.vaultRoot,
    scope,
    body,
    category: "explicit_knowledge",
    startup: request.startup,
    assertedAt: request.assertedAt,
    sourceIdentity: "remember.assert"
  });
  return {
    dry_run: false,
    authority: "human_authored",
    scope,
    startup: request.startup,
    ...result,
    ...(globalAuthorizationId === undefined ? {} : { global_authorization_id: globalAuthorizationId }),
    next: `memstore operation status ${result.operationId} --json`
  };
}

export function parseExtractionSelector(source: string):
  | { readonly kind: "current_turn" }
  | { readonly kind: "current_session" }
  | { readonly kind: "turn"; readonly turnId: string }
  | { readonly kind: "file"; readonly path: string } {
  if (source === "current-turn") return { kind: "current_turn" };
  if (source === "current-session") return { kind: "current_session" };
  if (source.startsWith("turn:") && source.slice(5).length > 0) {
    return { kind: "turn", turnId: source.slice(5) };
  }
  if (source.startsWith("file:") && source.slice(5).length > 0) {
    return { kind: "file", path: source.slice(5) };
  }
  if (source.startsWith("selection:")) {
    throw new MemStoreCommandError(
      "unsupported_selection_identity",
      "Codex does not expose a stable arbitrary-selection identity in this version."
    );
  }
  throw new MemStoreCommandError("invalid_source_selector", "Unsupported extraction source selector.");
}

async function captureExplicitFile(request: {
  readonly runtimeRoot: string;
  readonly projectId?: string;
  readonly path: string;
  readonly now: string;
}): Promise<string> {
  const path = await realpath(resolve(request.path));
  const body = await readFile(path, "utf8");
  const identity = createHash("sha256").update(body).digest("hex");
  const eventId = `msexplicit_${randomUUID()}`;
  const result = await captureEvent({
    runtimeRoot: request.runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId,
      deduplicationKey: `explicit-file:${path}:${identity}`,
      agent: "codex",
      eventKind: "UserPromptSubmit",
      occurredAt: request.now,
      ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
      sessionId: `explicit-file:${identity}`,
      payload: { path, body, explicitExtraction: true }
    }
  });
  if (result.state === "blocked_secret" || result.state === "quarantined") {
    throw new MemStoreCommandError(result.state, `Explicit file was ${result.state}.`);
  }
  return result.eventId;
}

async function selectCaptureEventIds(request: {
  readonly runtimeRoot: string;
  readonly selector: ReturnType<typeof parseExtractionSelector>;
  readonly projectId?: string;
  readonly now: string;
}): Promise<{ readonly eventIds: readonly string[]; readonly sessionId: string }> {
  if (request.selector.kind === "file") {
    const eventId = await captureExplicitFile({
      runtimeRoot: request.runtimeRoot,
      ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
      path: request.selector.path,
      now: request.now
    });
    return { eventIds: [eventId], sessionId: `explicit:${eventId}` };
  }
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const projectClause = request.projectId === undefined
      ? ""
      : " AND project_id = ?";
    const projectArguments = request.projectId === undefined ? [] : [request.projectId];
    let rows: readonly Record<string, unknown>[];
    if (request.selector.kind === "turn") {
      rows = database.prepare(
        `SELECT event_id, session_id FROM capture_events
         WHERE turn_id = ? AND state = 'pending'${projectClause}
         ORDER BY created_at ASC`
      ).all(request.selector.turnId, ...projectArguments);
    } else {
      const column = request.selector.kind === "current_turn" ? "turn_id" : "session_id";
      const latest = database.prepare(
        `SELECT ${column} AS identity FROM capture_events
         WHERE ${column} IS NOT NULL AND state = 'pending'${projectClause}
         ORDER BY created_at DESC LIMIT 1`
      ).get(...projectArguments);
      if (typeof latest?.identity !== "string") {
        throw new MemStoreCommandError("source_not_found", "No eligible captured source is available.");
      }
      rows = database.prepare(
        `SELECT event_id, session_id FROM capture_events
         WHERE ${column} = ? AND state = 'pending'${projectClause}
         ORDER BY created_at ASC`
      ).all(latest.identity, ...projectArguments);
    }
    if (rows.length === 0) {
      throw new MemStoreCommandError("source_not_found", "No eligible captured source is available.");
    }
    return {
      eventIds: rows.map((row) => z.string().parse(row.event_id)),
      sessionId: typeof rows[0]?.session_id === "string"
        ? rows[0].session_id
        : `explicit:${z.string().parse(rows[0]?.event_id)}`
    };
  } finally {
    database.close();
  }
}

async function queueExplicitBatch(request: {
  readonly runtimeRoot: string;
  readonly eventIds: readonly string[];
  readonly sessionId: string;
  readonly projectId?: string;
  readonly scope: RememberScope;
  readonly startup: StartupPolicy;
  readonly selector: string;
  readonly now: string;
}): Promise<{ readonly operationId: string; readonly batchId: string }> {
  const batchId = `msbatch_${randomUUID()}`;
  const operationId = `msop_${randomUUID()}`;
  const payload = JSON.stringify({ batchId });
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    database.prepare(
      `INSERT INTO luna_operations(
         operation_id, operation_kind, idempotency_key, project_id, session_id,
         payload_json, payload_sha256, state, created_at, updated_at
       ) VALUES (?, 'distill_batch', ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(
      operationId,
      `explicit:${createHash("sha256").update(JSON.stringify(request)).digest("hex")}`,
      request.projectId ?? null,
      request.sessionId,
      payload,
      createHash("sha256").update(payload).digest("hex"),
      request.now,
      request.now
    );
    const ordinal = z.number().int().nonnegative().parse(database.prepare(
      `SELECT COALESCE(MAX(batch_ordinal), -1) + 1 AS value
       FROM distillation_batches WHERE session_id = ?`
    ).get(request.sessionId)?.value);
    database.prepare(
      `INSERT INTO distillation_batches(
         batch_id, session_id, project_id, batch_ordinal, state, operation_id,
         requested_scope_kind, requested_startup, source_selector, created_at
       ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`
    ).run(
      batchId,
      request.sessionId,
      request.projectId ?? null,
      ordinal,
      operationId,
      request.scope,
      request.startup,
      request.selector,
      request.now
    );
    const insert = database.prepare(
      `INSERT INTO distillation_batch_events(batch_id, event_id, event_ordinal)
       VALUES (?, ?, ?)`
    );
    request.eventIds.forEach((eventId, index) => insert.run(batchId, eventId, index));
    database.exec("COMMIT");
    return { operationId, batchId };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

export async function rememberExtract(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly path: string;
  readonly source: string;
  readonly scope: RememberScope;
  readonly startup: StartupPolicy;
  readonly preview: boolean;
  readonly requestedAt: string;
}): Promise<unknown> {
  const selector = parseExtractionSelector(request.source);
  if (selector.kind === "file") {
    await realpath(resolve(request.path, selector.path));
  }
  if (request.preview) {
    const inspected = request.scope === "global"
      ? undefined
      : await inspectProject({ path: request.path, runtimeRoot: request.runtimeRoot });
    const plannedScope = request.scope === "global"
      ? ({ kind: "global" } as const)
      : inspected?.status === "resolved"
        ? ({ kind: "project", projectId: inspected.projectId } as const)
        : ({ kind: "project", projectResolution: inspected?.reason ?? "unregistered_project" } as const);
    const projectBlocked = inspected !== undefined &&
      inspected.status === "unresolved" &&
      inspected.reason !== "unregistered_project";
    return {
      dry_run: true,
      would_accept: !projectBlocked,
      authority: "agent_derived",
      scope: plannedScope,
      startup: request.startup,
      source: request.source,
      would_create: projectBlocked
        ? []
        : [
            ...(inspected?.status === "unresolved" ? ["project_registry_entry"] : []),
            "luna_operation",
            "distillation_batch",
            "agent_candidate"
          ],
      warnings: projectBlocked
        ? [{ code: "project_unresolved", reason: inspected.reason }]
        : []
    };
  }
  const scope = await resolveRememberScope(request);
  let evidenceProjectId: string | undefined;
  if (scope.kind === "project") {
    evidenceProjectId = scope.projectId;
  } else {
    const evidenceProject = await resolveProject({
      path: request.path,
      runtimeRoot: request.runtimeRoot
    });
    evidenceProjectId = evidenceProject.status === "resolved"
      ? evidenceProject.projectId
      : undefined;
  }
  const selected = await selectCaptureEventIds({
    runtimeRoot: request.runtimeRoot,
    selector,
    ...(evidenceProjectId === undefined ? {} : { projectId: evidenceProjectId }),
    now: request.requestedAt
  });
  const queued = await queueExplicitBatch({
    runtimeRoot: request.runtimeRoot,
    eventIds: selected.eventIds,
    sessionId: selected.sessionId,
    ...(evidenceProjectId === undefined ? {} : { projectId: evidenceProjectId }),
    scope: request.scope,
    startup: request.startup,
    selector: request.source,
    now: request.requestedAt
  });
  return {
    dry_run: false,
    authority: "agent_derived",
    scope,
    startup: request.startup,
    state: "queued",
    operation_id: queued.operationId,
    batch_id: queued.batchId,
    next: `memstore operation status ${queued.operationId} --json`
  };
}
