import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

export const jevConfigurationSchema = z.object({
  enabled: z.boolean().default(false),
  threshold: z.number().min(0).max(1).default(0.5),
  timeout_ms: z.number().int().min(50).max(600).default(600)
}).strict();

export type JevConfiguration = z.infer<typeof jevConfigurationSchema>;

export async function readJevConfiguration(runtimeRoot: string): Promise<JevConfiguration> {
  const document = z.object({
    schema_version: z.literal(1),
    jev: jevConfigurationSchema.optional()
  }).parse(parse(await readFile(join(runtimeRoot, "config.toml"), "utf8")));
  return document.jev ?? jevConfigurationSchema.parse({});
}

// Credentials stay machine-local, outside portable policy, receipts and the Vault.
// A LaunchAgent need not inherit the user's interactive shell environment.
export async function readJevApiKey(runtimeRoot: string): Promise<string | undefined> {
  const environmentKey = process.env.JEV_MODEL_API_KEY;
  if (environmentKey !== undefined) return validKey(environmentKey);
  const file = await open(
    join(runtimeRoot, "secrets", "jev-api-key"), constants.O_RDONLY | constants.O_NOFOLLOW
  ).catch(() => undefined);
  if (file === undefined) return undefined;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 4096 || (metadata.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && metadata.uid !== process.getuid())) return undefined;
    return validKey(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}

function validKey(value: string): string | undefined {
  const key = value.trim();
  return key.length > 0 && key.length <= 4096 && !/\s/u.test(key) ? key : undefined;
}
