import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

async function listTypeScriptFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return listTypeScriptFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    })
  );
  return nested.flat();
}

test("repository code contains no user-specific or installed integration target", async () => {
  const sourceRoot = join(import.meta.dirname, "..", "..", "src");
  const files = await listTypeScriptFiles(sourceRoot);
  const forbiddenTargets = [
    "/Users/",
    "/.codex/",
    "/.agents/skills/",
    "/Library/LaunchAgents/",
    "/.obsidian/"
  ];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const target of forbiddenTargets) {
      expect(source, `${file} must not target ${target}`).not.toContain(target);
    }
  }
});
