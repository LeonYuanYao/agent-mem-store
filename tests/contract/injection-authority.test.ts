import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { adapterDisplaySchema, readHumanAuthoredOnlyInjection } from "../../src/configuration/hook-display.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test.each([
  { name: "legacy configuration", source: "schema_version = 1\n", expected: false },
  { name: "enabled", source: "schema_version = 1\n[adapters]\nhuman_authored_only_injection = true\n", expected: true },
  { name: "disabled", source: "schema_version = 1\n[adapters]\nhuman_authored_only_injection = false\n", expected: false },
  { name: "invalid switch", source: 'schema_version = 1\n[adapters]\nhuman_authored_only_injection = "false"\n', expected: true },
  { name: "malformed document", source: "broken TOML", expected: true },
  { name: "unsupported version", source: "schema_version = 2\n", expected: true },
  { name: "unavailable document", source: undefined, expected: true }
])("injection authority reads $name without broadening on failure", async ({ source, expected }) => {
  const root = await mkdtemp(join(tmpdir(), "memstore-injection-authority-"));
  roots.push(root);
  if (source !== undefined) await writeFile(join(root, "config.toml"), source);
  expect(await readHumanAuthoredOnlyInjection(root)).toBe(expected);
});

test("machine configuration activation rejects a non-boolean authority switch", () => {
  expect(adapterDisplaySchema.safeParse({ human_authored_only_injection: "false" }).success).toBe(false);
});
