import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

export const hookDisplaySchema = z.enum(["off", "summary", "full"]);
export type HookDisplay = z.infer<typeof hookDisplaySchema>;

export const adapterDisplaySchema = z.object({
  hook_display: hookDisplaySchema.default("summary"),
  session_start_injection: z.boolean().default(false)
}).loose().default({ hook_display: "summary", session_start_injection: false });

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
  const refs = [...text.matchAll(/^\[M:([^\s\]]+)/gm)].map((match) => match[0].slice(1));
  if (refs.length === 0) return undefined;
  const summary = `MemStore (${event}): ${String(refs.length)} memories · ${String(tokens)} tokens · ${refs.join(", ")}`;
  return mode === "full" ? `${summary}\n${text}` : summary;
}
