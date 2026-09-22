/** Monotonic, process-local capture budget. Never includes user content. */
export type CaptureStage = "input" | "project_lookup" | "sanitize" | "inbox_lock" |
  "inbox_scan" | "inbox_write" | "health";
export type CapturePersistence = "not_saved" | "unconfirmed" | "saved" | "body_free";

export class CaptureFailure extends Error {
  constructor(readonly code: "capture_deadline_exceeded" | "inbox_lock_timeout" | "inbox_capacity_exceeded") {
    super(code === "inbox_capacity_exceeded" ? "Capture Inbox capacity exceeded." : code);
  }
}

export interface CaptureDiagnostic {
  readonly code: string;
  readonly eventKind: string;
  readonly stage: CaptureStage;
  readonly elapsedMs: number;
  readonly persistence: CapturePersistence;
}

export class CaptureProgress {
  readonly startedAt = performance.now();
  readonly deadlineAt: number;
  stage: CaptureStage = "input";
  persistence: CapturePersistence = "not_saved";

  constructor(maximumMilliseconds = Infinity) {
    this.deadlineAt = this.startedAt + maximumMilliseconds;
  }

  remaining(): number { return Math.max(0, this.deadlineAt - performance.now()); }

  enter(stage: CaptureStage): void {
    this.stage = stage;
    if (this.remaining() === 0) throw new CaptureFailure("capture_deadline_exceeded");
  }

  diagnostic(eventKind: string, code: string): CaptureDiagnostic {
    return { code, eventKind, stage: this.stage,
      elapsedMs: Math.round(performance.now() - this.startedAt), persistence: this.persistence };
  }
}

export function captureErrorCode(error: unknown): string {
  if (error instanceof CaptureFailure) return error.code;
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "ENOSPC") return "storage_full";
  if (code === "EACCES" || code === "EPERM") return "storage_permission_denied";
  if (code === "ENOENT" || code === "ENOTDIR") return "storage_path_unavailable";
  if (code === "SQLITE_BUSY" || code === "ERR_SQLITE_ERROR") return "sqlite_unavailable";
  return "capture_io_failed";
}

export function renderCaptureDiagnostic(diagnostic: CaptureDiagnostic): string {
  return `MemStore (${diagnostic.eventKind}): code=${diagnostic.code}; stage=${diagnostic.stage}; ` +
    `elapsed=${String(diagnostic.elapsedMs)}ms; persistence=${diagnostic.persistence}. The session will continue.`;
}
