import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { codexSessionArguments } from "../../../src/luna/codex-sessions.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function userHome(): string {
  const root = mkdtempSync(join(tmpdir(), "memstore-codex-sessions-"));
  roots.push(root);
  mkdirSync(join(root, ".codex"));
  return root;
}

test("calls in the user's own Codex home stay ephemeral, also through a link or trailing slash", () => {
  const home = userHome();
  symlinkSync(join(home, ".codex"), join(home, "codex-link"));
  expect(codexSessionArguments(join(home, ".codex"), home)).toEqual(["--ephemeral"]);
  expect(codexSessionArguments(`${join(home, ".codex")}/`, home)).toEqual(["--ephemeral"]);
  expect(codexSessionArguments(join(home, "codex-link"), home)).toEqual(["--ephemeral"]);
});

test("a dedicated Codex home keeps session files, even before it exists", () => {
  const home = userHome();
  mkdirSync(join(home, ".codex-eval"));
  expect(codexSessionArguments(join(home, ".codex-eval"), home)).toEqual([]);
  expect(codexSessionArguments(join(home, "not-created"), home)).toEqual([]);
});
