export interface SuccessEnvelope<Result> {
  readonly schema_version: 1;
  readonly ok: true;
  readonly command: string;
  readonly result: Result;
}

export interface ErrorEnvelope {
  readonly schema_version: 1;
  readonly ok: false;
  readonly command: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export function successEnvelope<Result>(
  command: string,
  result: Result
): SuccessEnvelope<Result> {
  return { schema_version: 1, ok: true, command, result };
}

export class MemStoreCommandError extends Error {
  public constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "MemStoreCommandError";
  }
}

export function errorEnvelope(command: string, error: unknown): ErrorEnvelope {
  const code = error instanceof MemStoreCommandError
    ? error.code
    : "command_failed";
  const message = error instanceof Error ? error.message : "Unknown MemStore error.";
  return {
    schema_version: 1,
    ok: false,
    command,
    error: { code, message }
  };
}
