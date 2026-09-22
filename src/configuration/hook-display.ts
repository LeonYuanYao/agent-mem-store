import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

export const hookDisplaySchema = z.enum(["off", "summary", "full"]);
export type HookDisplay = z.infer<typeof hookDisplaySchema>;

export const adapterDisplaySchema = z.object({
  hook_display: hookDisplaySchema.default("summary"),
  session_start_injection: z.boolean().default(false),
  subagents_enabled: z.boolean().default(false)
}).loose().default({ hook_display: "summary", session_start_injection: false, subagents_enabled: false });

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

export function renderHookDisplay(
  mode: HookDisplay, event: string, text: string, tokens: number
): string | undefined {
  if (mode === "off" || text.trim().length === 0) return undefined;
  const memoryCount = [...text.matchAll(/^\[M:([^\s\]]+)/gm)].length;
  if (memoryCount === 0) return undefined;
  const summary = `MemStore (${event}): ${String(memoryCount)} memories · ${String(tokens)} tokens`;
  return mode === "full" ? `${summary}\n${text}` : summary;
}
