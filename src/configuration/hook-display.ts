import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

// items: the summary line plus one readable line per memory, without the pack's legend and tags.
export const hookDisplaySchema = z.enum(["off", "summary", "items", "full"]);
export type HookDisplay = z.infer<typeof hookDisplaySchema>;

export const adapterDisplaySchema = z.object({
  hook_display: hookDisplaySchema.default("summary"),
  session_start_injection: z.boolean().default(false),
  subagents_enabled: z.boolean().default(false),
  // Standalone `codex exec` runs are primary Sessions; a machine can opt them out (ADR-0170).
  exec_sessions_enabled: z.boolean().default(true),
  // Sessions started at or under these directories stay out of MemStore unless the user opts in (ADR-0173).
  excluded_roots: z.array(z.string().min(1)).max(20).default([]),
  human_authored_only_injection: z.boolean().default(false),
  dreaming_injection: z.boolean().default(false),
  // Claude Code shows a Hook systemMessage on every prompt, so a one-line summary is its default.
  claude_hook_display: hookDisplaySchema.default("summary")
}).loose().default({ hook_display: "summary", session_start_injection: false, subagents_enabled: false,
  exec_sessions_enabled: true, excluded_roots: [], human_authored_only_injection: false, dreaming_injection: false, claude_hook_display: "summary" });

export async function readHumanAuthoredOnlyInjection(runtimeRoot: string): Promise<boolean> {
  try {
    const config = z.object({
      schema_version: z.literal(1),
      adapters: z.object({ human_authored_only_injection: z.boolean().default(false) })
        .default({ human_authored_only_injection: false })
    }).parse(parse(await readFile(join(runtimeRoot, "config.toml"), "utf8")));
    return config.adapters.human_authored_only_injection;
  } catch {
    // Unreadable or invalid configuration must not broaden injection authority.
    return true;
  }
}

/**
 * Which authorities automatic injection admits: every authority, or Human-authored
 * Memory plus, with `dreaming_injection`, Memory dreaming verified (ADR-0148).
 */
export interface InjectionAuthorityGate {
  readonly humanAuthoredOnly: boolean;
  readonly dreamingVerified: boolean;
}

export async function readInjectionAuthorityGate(runtimeRoot: string): Promise<InjectionAuthorityGate> {
  try {
    const config = z.object({
      schema_version: z.literal(1),
      adapters: z.object({
        human_authored_only_injection: z.boolean().default(false),
        dreaming_injection: z.boolean().default(false)
      }).default({ human_authored_only_injection: false, dreaming_injection: false })
    }).parse(parse(await readFile(join(runtimeRoot, "config.toml"), "utf8")));
    return { humanAuthoredOnly: config.adapters.human_authored_only_injection, dreamingVerified: config.adapters.dreaming_injection };
  } catch {
    // Unreadable or invalid configuration must not broaden injection authority.
    return { humanAuthoredOnly: true, dreamingVerified: false };
  }
}

export async function readSubagentsEnabled(runtimeRoot: string): Promise<boolean> {
  try {
    const config = z.object({
      schema_version: z.literal(1),
      adapters: z.object({ subagents_enabled: z.boolean().default(false) })
    }).parse(parse(await readFile(join(runtimeRoot, "config.toml"), "utf8")));
    return config.adapters.subagents_enabled;
  } catch {
    return false;
  }
}

/**
 * Whether standalone `codex exec` Sessions are captured and served (ADR-0170).
 * Missing, invalid or unreadable settings keep the default: they are, like any
 * primary Session.
 */
export async function readExecSessionsEnabled(runtimeRoot: string): Promise<boolean> {
  try {
    const config = z.object({
      schema_version: z.literal(1),
      adapters: z.object({ exec_sessions_enabled: z.boolean().default(true) }).default({ exec_sessions_enabled: true })
    }).parse(parse(await readFile(join(runtimeRoot, "config.toml"), "utf8")));
    return config.adapters.exec_sessions_enabled;
  } catch {
    return true;
  }
}

/**
 * Directories whose Sessions stay out of MemStore (ADR-0173). Missing, invalid or
 * unreadable settings exclude nothing, so a broken setting never silently stops
 * capture of Sessions the user expects to keep.
 */
export async function readExcludedRoots(runtimeRoot: string): Promise<string[]> {
  try {
    const config = z.object({
      schema_version: z.literal(1),
      adapters: z.object({ excluded_roots: z.array(z.string().min(1)).max(20).default([]) }).default({ excluded_roots: [] })
    }).parse(parse(await readFile(join(runtimeRoot, "config.toml"), "utf8")));
    return config.adapters.excluded_roots;
  } catch {
    return [];
  }
}

export async function readSessionStartInjection(runtimeRoot: string): Promise<boolean> {
  try {
    const config = z.object({
      schema_version: z.literal(1),
      adapters: z.object({ session_start_injection: z.boolean().default(false) }).default({ session_start_injection: false })
    }).parse(parse(await readFile(join(runtimeRoot, "config.toml"), "utf8")));
    return config.adapters.session_start_injection;
  } catch {
    return false;
  }
}

export async function readHookDisplay(runtimeRoot: string): Promise<HookDisplay> {
  try {
    const config = z.object({
      schema_version: z.literal(1),
      adapters: adapterDisplaySchema
    }).parse(parse(await readFile(join(runtimeRoot, "config.toml"), "utf8")));
    return config.adapters.hook_display;
  } catch {
    // Presentation failure must not prevent capture or model context delivery.
    return "summary";
  }
}

export async function readClaudeHookDisplay(runtimeRoot: string): Promise<HookDisplay> {
  try {
    const config = z.object({
      schema_version: z.literal(1),
      adapters: adapterDisplaySchema
    }).parse(parse(await readFile(join(runtimeRoot, "config.toml"), "utf8")));
    return config.adapters.claude_hook_display;
  } catch {
    return "summary";
  }
}

export function renderHookDisplay(
  mode: HookDisplay, event: string, text: string, tokens: number
): string | undefined {
  if (mode === "off" || text.trim().length === 0) return undefined;
  const memoryCount = [...text.matchAll(/^\[M:([^\s\]]+)/gm)].length;
  if (memoryCount === 0) return undefined;
  const summary = `MemStore (${event}): ${String(memoryCount)} memories · ${String(tokens)} tokens`;
  if (mode === "items") {
    const scopes: Record<string, string> = { P: "项目", G: "全局" };
    const authorities: Record<string, string> = { H: "手写", A: "自动沉淀" };
    const lines = [...text.matchAll(/^\[M:([^\s\]]+)([^\]]*)\]\s*(.*)$/gmu)].map((match) => {
      const tags = match[2] ?? "";
      const scope = scopes[/\bS:(\w)/u.exec(tags)?.[1] ?? ""];
      const authority = authorities[/\bA:(\w)/u.exec(tags)?.[1] ?? ""];
      const detail = /\bR:C\+/u.test(tags) ? "有详情" : undefined;
      const label = [scope, authority, detail].filter((value) => value !== undefined).join("·");
      return `  M:${match[1] ?? ""}${label === "" ? "" : ` ${label}`}｜${(match[3] ?? "").trim()}`;
    });
    return [summary, ...lines].join("\n");
  }
  return mode === "full" ? `${summary}\n${text}` : summary;
}
