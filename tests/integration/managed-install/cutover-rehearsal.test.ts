import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { rehearseNativeMemoryCutover } from "../../../src/integration/managed.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

test("cutover and rollback rehearsal restores configuration without reading or changing native data", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cutover-"));
  roots.push(root);
  const configPath = join(root, "config.toml");
  const hooksPath = join(root, "hooks.json");
  const nativeStorePath = join(root, "native-memories", "opaque.bin");
  await mkdir(join(root, "native-memories"));
  const originalConfig = "[memories]\ngenerate_memories = true\nuse_memories = true\ndisable_on_external_context = false\n\n[mcp_servers.keep]\ncommand = \"keep\"\n";
  const originalHooks = '{"hooks":{"SessionStart":[{"matcher":"keep","hooks":[{"type":"command","command":"keep"}]},{"matcher":"*","hooks":[{"type":"command","command":"MEMSTORE_INJECTION_MODE=shadow memstore hook # memstore:gate5-shadow-v1:SessionStart:shadow"}]}]}}\n';
  await writeFile(configPath, originalConfig);
  await writeFile(hooksPath, originalHooks);
  await writeFile(nativeStorePath, "opaque native body must not be inventoried or read");

  const result = await rehearseNativeMemoryCutover({
    configPath,
    hooksPath,
    nativeStorePaths: [join(root, "native-memories")],
    rehearsedAt: "2026-08-08T13:00:00.000Z"
  });

  expect(result).toMatchObject({
    cutover: { generateMemories: false, useMemories: false, injectionMode: "active" },
    rollback: { restored: true },
    nativeData: { operation: "none", bodiesRead: 0 }
  });
  expect(await readFile(configPath, "utf8")).toBe(originalConfig);
  expect(await readFile(hooksPath, "utf8")).toBe(originalHooks);
  expect(await readFile(nativeStorePath, "utf8")).toBe("opaque native body must not be inventoried or read");
});
