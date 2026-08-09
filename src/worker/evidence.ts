import { z } from "zod";

import type { CaptureEvent } from "../capture/index.js";
import type { LunaEvidence } from "../luna/index.js";

function evidenceClass(eventKind: CaptureEvent["eventKind"]): LunaEvidence["evidenceClass"] {
  if (eventKind === "UserPromptSubmit") return "explicit_user_statement";
  if (eventKind === "PostToolUse") return "command_outcome";
  if (eventKind === "Stop") return "agent_summary";
  return "other";
}

export function mapCapturedEventToLunaEvidence(request: {
  readonly event: CaptureEvent;
  readonly sourceIdentity?: string;
  readonly sourceTruncated: boolean;
  readonly evidenceContentIdentity?: string;
}): LunaEvidence {
  const payload = z.record(z.string(), z.unknown()).safeParse(request.event.payload);
  const fields = payload.success ? payload.data : {};
  return {
    evidenceId: request.event.eventId,
    evidenceClass: evidenceClass(request.event.eventKind),
    content: JSON.stringify(request.event.payload),
    sourceIdentity:
      request.sourceIdentity ??
      `${request.event.agent}:${request.event.sessionId ?? "unknown"}:${request.event.turnId ?? request.event.eventId}`,
    sourceTruncated: request.sourceTruncated,
    memoryEcho:
      typeof fields.injectionReceiptId === "string" ||
      (Array.isArray(fields.injectedMemoryIds) && fields.injectedMemoryIds.length > 0),
    occurredAt: request.event.occurredAt,
    ...(request.event.projectId === undefined ? {} : { projectId: request.event.projectId }),
    ...(request.evidenceContentIdentity === undefined
      ? {}
      : { evidenceContentIdentity: request.evidenceContentIdentity }),
    ...(typeof fields.repoRevision === "string"
      ? { repoRevision: fields.repoRevision }
      : {}),
    ...(typeof fields.fileContentIdentity === "string"
      ? { fileContentIdentity: fields.fileContentIdentity }
      : {}),
    ...(typeof fields.filePath === "string" ? { filePath: fields.filePath } : {}),
    ...(typeof fields.repositoryRoot === "string"
      ? { repositoryRoot: fields.repositoryRoot }
      : {}),
    ...(typeof fields.command === "string" ? { command: fields.command } : {}),
    ...(typeof fields.cwd === "string" ? { commandCwd: fields.cwd } : {}),
    ...(typeof fields.resultContentIdentity === "string"
      ? { commandResultIdentity: fields.resultContentIdentity }
      : {}),
    ...(typeof fields.exitCode === "number"
      ? { commandExitCode: fields.exitCode }
      : {}),
    ...(typeof fields.humanMemoryId === "string"
      ? { humanMemoryId: fields.humanMemoryId }
      : {}),
    ...(typeof fields.humanRevisionId === "string"
      ? { humanRevisionId: fields.humanRevisionId }
      : {}),
    ...(typeof fields.humanContentIdentity === "string"
      ? { humanContentIdentity: fields.humanContentIdentity }
      : {})
  };
}
