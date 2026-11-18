/**
 * Node 22 prints "SQLite is an experimental feature" to stderr the first time
 * `node:sqlite` loads. Commands promise one JSON document on stdout, and agents
 * often read both streams together, so this warning made successful writes look
 * like failures and led to duplicate saves. Every other warning still prints.
 *
 * Only effective before `node:sqlite` loads: a static import of it warns while
 * the module graph links, so the entry must load the rest with dynamic import.
 */
export function silenceSqliteExperimentalWarning(): void {
  const emitWarning = process.emitWarning.bind(process);
  const filtered: typeof process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (warningType(rest[0]) === "ExperimentalWarning" && message.startsWith("SQLite is an experimental feature")) {
      return;
    }
    Reflect.apply(emitWarning, undefined, [warning, ...rest]);
  };
  process.emitWarning = filtered;
}

function warningType(options: unknown): unknown {
  if (typeof options === "string") return options;
  if (typeof options === "object" && options !== null && "type" in options) return options.type;
  return undefined;
}
