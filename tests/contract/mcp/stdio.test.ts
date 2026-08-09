import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

test("the real stdio transport keeps stdout parseable as MCP protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-mcp-stdio-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/mcp/main.ts"],
    cwd: process.cwd(),
    env: {
      MEMSTORE_RUNTIME_ROOT: join(root, "runtime"),
      MEMSTORE_VAULT_ROOT: join(root, "vault")
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();

  expect(tools.tools).toHaveLength(5);
  await client.close();
});
