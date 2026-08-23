import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createMemStoreMcpServer } from "../../../src/mcp/server.js";
import { buildRetrievalIndex, type EmbeddingAdapter } from "../../../src/retrieval/index.js";
import type { RetrievalJudge } from "../../../src/retrieval/judge.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

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

test("MCP explicit Recall uses the configured semantic adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-mcp-semantic-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174009";
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, ".memstore-project"), JSON.stringify({
    schema_version: 1,
    project_id: projectId
  }));
  const adapter: EmbeddingAdapter = {
    identity: {
      adapterVersion: "mcp-semantic-v1",
      modelIdentity: "mcp-semantic-fixture",
      artifactSha256: "c".repeat(64),
      dimensions: 2,
      normalization: "l2"
    },
    embed: (texts) => Promise.resolve(texts.map((text) =>
      /sqlite|wal/iu.test(text) ? [1, 0] : [0, 1]
    )),
    embedQuery: (texts) => Promise.resolve(texts.map(() => [1, 0]))
  };
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174209",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174219",
      scope: { kind: "project", projectId },
      body: "Use SQLite WAL for durable local state.",
      compact: "Use SQLite WAL for durable state."
    })
  });
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter,
    builtAt: "2026-08-18T01:00:00.000Z"
  });
  const server = createMemStoreMcpServer({
    runtimeRoot,
    vaultRoot,
    path: workspace,
    callerIdentity: "mcp-semantic-test",
    embeddingAdapter: adapter
  });
  const client = new Client({ name: "semantic-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const result = await client.callTool({
    name: "memstore_search",
    arguments: { query: "transaction journal persistence" }
  });

  expect(result.structuredContent).toMatchObject({
    ok: true,
    result: {
      semanticStage: "complete",
      items: [{ memoryId: "msmem_123e4567-e89b-42d3-a456-426614174209" }]
    }
  });
  await client.close();
  await server.close();
});

test("MCP explicit Recall applies the configured foreground retrieval judge", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-mcp-judge-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174019";
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, ".memstore-project"), JSON.stringify({
    schema_version: 1,
    project_id: projectId
  }));
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174229",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174239",
      scope: { kind: "project", projectId },
      body: "Use SQLite WAL for durable local state.",
      compact: "Use SQLite WAL for durable state."
    })
  });
  const adapter: EmbeddingAdapter = {
    identity: {
      adapterVersion: "mcp-judge-v1",
      modelIdentity: "mcp-judge-fixture",
      artifactSha256: "d".repeat(64),
      dimensions: 2,
      normalization: "l2"
    },
    embed: (texts) => Promise.resolve(texts.map(() => [1, 0]))
  };
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter,
    builtAt: "2026-08-18T01:00:00.000Z"
  });
  const judge: RetrievalJudge = {
    judge: () => Promise.resolve({ retainedMemoryIds: [], packDecision: "empty" })
  };
  const server = createMemStoreMcpServer({
    runtimeRoot,
    vaultRoot,
    path: workspace,
    callerIdentity: "mcp-judge-test",
    embeddingAdapter: adapter,
    retrievalJudge: judge
  });
  const client = new Client({ name: "judge-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const result = await client.callTool({
    name: "memstore_search",
    arguments: { query: "SQLite WAL durability" }
  });

  expect(result.structuredContent).toMatchObject({
    ok: true,
    result: { judgmentStage: "complete", items: [] }
  });
  await client.close();
  await server.close();
});
