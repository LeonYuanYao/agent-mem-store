import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { hostImports, importTargets } from "../../../src/dreaming/imports.js";

test("import targets are @ paths outside code, without trailing punctuation", () => {
  expect(importTargets([
    "@AGENT.md",
    "See @docs/handoff.md, and @~/.claude/rules.md.",
    "Mail owner@example.com; package `@types/node`.",
    "```", "@inside-block.md", "```",
    "（@../shared.md）"
  ].join("\n"))).toEqual(["AGENT.md", "docs/handoff.md", "~/.claude/rules.md", "../shared.md"]);
});

test("host imports are followed from CLAUDE.md files only, transitively and once", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-imports-"));
  try {
    await mkdir(join(root, "rules"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "@rules/a.md\n@missing.md\n");
    await writeFile(join(root, "rules", "a.md"), `@b.md\n@${join(root, "CLAUDE.md")}\n`);
    await writeFile(join(root, "rules", "b.md"), "rule b\n");
    await writeFile(join(root, "AGENTS.md"), "@rules/c.md\n");
    await writeFile(join(root, "rules", "c.md"), "rule c\n");
    expect(await hostImports([join(root, "CLAUDE.md"), join(root, "AGENTS.md")]))
      .toEqual([join(root, "rules", "a.md"), join(root, "rules", "b.md")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
