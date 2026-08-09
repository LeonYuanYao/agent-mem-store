import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createMemStoreMcpServer } from "../../../src/mcp/server.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

test("the stdio server exposes exactly the five accepted progressive-recall tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-mcp-tools-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, ".memstore-project"), JSON.stringify({
    schema_version: 1,
    project_id: "msproj_123e4567-e89b-42d3-a456-426614174000"
  }));
  const server = createMemStoreMcpServer({
    runtimeRoot: join(root, "runtime"),
    vaultRoot: join(root, "vault"),
    path: workspace,
    callerIdentity: "mcp-test"
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tools = await client.listTools();

  expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
    "memstore_get",
    "memstore_provenance",
    "memstore_related",
    "memstore_report_irrelevant",
    "memstore_search"
  ]);
  const failed = await client.callTool({
    name: "memstore_get",
    arguments: { memory_id: "msmem_missing" }
  });
  const failedContent = failed.content as readonly { readonly type: string; readonly text?: string }[];
  expect(failed.isError).toBe(true);
  expect(JSON.parse(failedContent[0]?.text ?? "{}")).toMatchObject({
    schema_version: 1,
    ok: false,
    command: "recall.show"
  });
  await client.close();
  await server.close();
});
