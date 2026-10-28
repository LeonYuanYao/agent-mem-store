import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

const reasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);

export const dreamingConfigurationSchema = z.object({
  enabled: z.boolean().default(false),
  // shadow writes reports only; apply also writes inject-tier items to canonical Memory (ADR-0148).
  mode: z.enum(["shadow", "apply"]).default("shadow"),
  hour: z.number().int().min(0).max(23).default(3),
  timezone: z.string().min(1).default("Asia/Shanghai"),
  lookback_days: z.number().int().min(1).max(30).default(7),
  inactivity_minutes: z.number().int().min(10).max(24 * 60).default(120),
  max_sessions_per_run: z.number().int().min(1).max(200).default(40),
  chunk_characters: z.number().int().min(20_000).max(400_000).default(150_000),
  extract_effort: reasoningEffortSchema.default("medium"),
  verify_effort: reasoningEffortSchema.default("high"),
  // Codex models: extraction and verification carry nearly all tokens and stay on Luna; merge,
  // reconciliation and defense decide what joins or replaces Memory and use Terra (ADR-0157).
  model: z.string().min(1).default("gpt-6-luna"),
  judge_model: z.string().min(1).default("gpt-6.1-terra"),
  verify_batch_size: z.number().int().min(1).max(8).default(3),
  verify_parallelism: z.number().int().min(1).max(6).default(3),
  fresh_days: z.number().int().min(1).max(90).default(7),
  // Machine-local agent skill directories searched as auto-loaded guidance ("~" expands to the home directory).
  host_skill_roots: z.array(z.string().min(1)).max(10).default([]),
  // User-wide instruction files every session loads (for example the agents' global AGENTS.md or
  // CLAUDE.md): knowledge they state is already known, and apply treats them as Human-authored.
  host_instruction_files: z.array(z.string().min(1)).max(10).default([]),
  // Codex home for dreaming's model calls. Independent of MEMSTORE_LUNA_CODEX_HOME so enabling
  // dreaming does not also restart legacy Luna governance and quality work.
  codex_home: z.string().min(1).default("~/.codex")
}).strict();

export type DreamingConfiguration = z.infer<typeof dreamingConfigurationSchema>;

export const defaultDreamingConfiguration: DreamingConfiguration = dreamingConfigurationSchema.parse({});

/**
 * Reads machine-local `[dreaming]`. A missing, unreadable or invalid section
 * leaves dreaming disabled so configuration errors never start model work.
 */
export async function readDreamingConfiguration(runtimeRoot: string): Promise<DreamingConfiguration> {
  try {
    const document = z.object({
      schema_version: z.literal(1),
      dreaming: dreamingConfigurationSchema.optional()
    }).loose().parse(parse(await readFile(join(runtimeRoot, "config.toml"), "utf8")));
    return document.dreaming ?? defaultDreamingConfiguration;
  } catch {
    return defaultDreamingConfiguration;
  }
}
