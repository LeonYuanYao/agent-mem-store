import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

const managedEvents = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"] as const;
type ManagedEvent = typeof managedEvents[number];

const codexEventKeys: Readonly<Record<ManagedEvent, string>> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  PostToolUse: "post_tool_use",
  Stop: "stop",
  SessionEnd: "session_end"
};

export interface CodexHookStateIssue {
  readonly event: ManagedEvent;
  readonly key: string | null;
}

export interface CodexHookStateReport {
  /** MemStore events whose owned Hook is absent from the Codex Hook file. */
  readonly missing: readonly CodexHookStateIssue[];
  /** Owned Hooks that Codex has explicitly disabled. */
  readonly disabled: readonly CodexHookStateIssue[];
  /** Owned Hooks without a Codex trust entry; Codex lists them as untrusted until reviewed. */
  readonly unreviewed: readonly CodexHookStateIssue[];
  readonly enabledCount: number;
}

const routeSchema = z.object({ hooks: z.array(z.unknown()).default([]) }).loose();
const handlerSchema = z.object({ command: z.string().optional() }).loose();
const hookStateSchema = z.object({ enabled: z.boolean().optional() }).loose();

/**
 * Codex keys Hook enablement and trust by position
 * (`<hooks file>:<event>:<group index>:<handler index>`), not by Hook content.
 * When another tool reorders the Hook file, a disabled flag stays at its index
 * and silently applies to whichever Hook moves there, so this reads the state
 * at the owned Hooks' current positions.
 */
export function inspectCodexHookStates(request: {
  readonly hooksPath: string;
  readonly hooksSource: string;
  readonly configSource: string;
}): CodexHookStateReport {
  const document = z.object({ hooks: z.record(z.string(), z.unknown()).default({}) }).loose()
    .parse(JSON.parse(request.hooksSource));
  const config = z.record(z.string(), z.unknown()).parse(parseToml(request.configSource));
  const hooks = z.object({ state: z.record(z.string(), z.unknown()).default({}) }).loose()
    .parse(config.hooks ?? {});
  const missing: CodexHookStateIssue[] = [];
  const disabled: CodexHookStateIssue[] = [];
  const unreviewed: CodexHookStateIssue[] = [];
  let enabledCount = 0;
  for (const event of managedEvents) {
    const marker = `memstore:gate5-shadow-v1:${event}:`;
    const routes = z.array(z.unknown()).default([]).parse(document.hooks[event]);
    const keys = routes.flatMap((route, groupIndex) =>
      routeSchema.parse(route).hooks.flatMap((handler, handlerIndex) =>
        handlerSchema.parse(handler).command?.includes(marker) === true
          ? [`${request.hooksPath}:${codexEventKeys[event]}:${String(groupIndex)}:${String(handlerIndex)}`]
          : []));
    if (keys.length === 0) missing.push({ event, key: null });
    for (const key of keys) {
      const state = hooks.state[key];
      if (state === undefined) unreviewed.push({ event, key });
      else if (hookStateSchema.parse(state).enabled === false) disabled.push({ event, key });
      else enabledCount += 1;
    }
  }
  return { missing, disabled, unreviewed, enabledCount };
}

/** Reads the Codex Hook and configuration files recorded by the managed installation. */
export async function readManagedCodexHookStates(runtimeRoot: string): Promise<CodexHookStateReport | null> {
  let manifestSource: string;
  try {
    manifestSource = await readFile(join(resolve(runtimeRoot), "install", "ownership-manifest.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const manifest = z.object({
    state: z.string(),
    targets: z.array(z.object({ label: z.string(), path: z.string() }).loose()).default([])
  }).loose().parse(JSON.parse(manifestSource));
  if (manifest.state !== "installed") return null;
  const hooksPath = manifest.targets.find((target) => target.label === "codex_hooks")?.path;
  const configPath = manifest.targets.find((target) => target.label === "codex_config")?.path;
  if (hooksPath === undefined || configPath === undefined) return null;
  const [hooksSource, configSource] = await Promise.all([
    readFile(hooksPath, "utf8"),
    readFile(configPath, "utf8")
  ]);
  return inspectCodexHookStates({ hooksPath, hooksSource, configSource });
}
