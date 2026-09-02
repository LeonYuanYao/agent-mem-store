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

  expect(tools.tools).toHaveLength(7);
  await client.close();
});

test("the MCP server remains available when the optional embedding adapter cannot start", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-mcp-degraded-"));
  temporaryDirectories.push(root);
  const modelDirectory = join(root, "invalid-model");
  await mkdir(modelDirectory, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/mcp/main.ts"],
    cwd: process.cwd(),
    env: {
      MEMSTORE_RUNTIME_ROOT: join(root, "runtime"),
      MEMSTORE_VAULT_ROOT: join(root, "vault"),
      MEMSTORE_EMBEDDING_MODEL_DIR: modelDirectory
    },
    stderr: "pipe"
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const client = new Client({ name: "stdio-degraded-test", version: "1.0.0" });

  await client.connect(transport);
  const tools = await client.listTools();

  expect(tools.tools).toHaveLength(7);
  expect(stderr).toContain("embedding_unavailable");
  await client.close();
});
