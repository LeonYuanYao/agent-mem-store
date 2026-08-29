import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import { createMemStoreMcpServer } from "../../../src/mcp/server.js";
import { initializeMemStore } from "../../../src/operations/initialize.js";
import { buildRetrievalIndex, type EmbeddingAdapter } from "../../../src/retrieval/index.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const adapter: EmbeddingAdapter = {
  identity: {
    adapterVersion: "parity-v1",
    modelIdentity: "parity",
    artifactSha256: "1".repeat(64),
    dimensions: 1,
    normalization: "l2"
  },
  embed(texts) {
    return Promise.resolve(texts.map(() => [1]));
  }
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

test("CLI and MCP search normalize into the same Recall result", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-mcp-parity-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  await mkdir(workspace, { recursive: true });
  await initializeMemStore({ vaultRoot, runtimeRoot, preview: false });
  await writeCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174010",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174011",
      body: "Use pnpm for package management.",
      scope: { kind: "global" }
    })
  });
  await buildRetrievalIndex({
    runtimeRoot,
    vaultRoot,
    adapter,
    builtAt: "2026-08-07T00:00:00.000Z"
  });

  const server = createMemStoreMcpServer({
    runtimeRoot,
    vaultRoot,
    path: workspace,
    callerIdentity: `cli:${workspace}`,
    now: () => "2026-08-07T01:00:00.000Z"
  });
  const client = new Client({ name: "parity-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const mcp = await client.callTool({
    name: "memstore_search",
    arguments: { query: "pnpm package", scope: "global" }
  });
  const cli = await execFileAsync("pnpm", [
    "exec", "tsx", "src/cli/main.ts", "recall", "search", "pnpm package",
    "--scope", "global", "--path", workspace, "--json",
    "--vault", vaultRoot, "--runtime", runtimeRoot
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, MEMSTORE_CALLER_IDENTITY: `cli:${workspace}` }
  });
  const mcpContent = mcp.content as readonly { readonly type: string; readonly text?: string }[];
  const mcpEnvelope = JSON.parse(
    mcpContent[0]?.type === "text" ? (mcpContent[0].text ?? "{}") : "{}"
  ) as { result: { items: unknown } };
  const cliEnvelope = JSON.parse(cli.stdout) as { result: { items: unknown } };

  expect(mcpEnvelope.result.items).toEqual(cliEnvelope.result.items);
  await client.close();
  await server.close();
});

test("MCP deep reads accept a portable numeric Memory reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-mcp-memory-ref-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  await mkdir(workspace, { recursive: true });
  await initializeMemStore({ vaultRoot, runtimeRoot, preview: false });
  const memoryId = "msmem_123e4567-e89b-42d3-a456-426614174012";
  await writeCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    actor: "human",
    memory: makeCanonicalMemory({
      memoryId,
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174013",
      body: "Portable references resolve to canonical memory identities.",
      scope: { kind: "global" }
    })
  });
  const server = createMemStoreMcpServer({
    runtimeRoot,
    vaultRoot,
    path: workspace,
    callerIdentity: "mcp:memory-ref",
    now: () => "2026-08-07T01:00:00.000Z"
  });
  const client = new Client({ name: "memory-ref-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const result = await client.callTool({
    name: "memstore_get",
    arguments: { memory_id: "M:1", detail: "compact" }
  });
  const content = result.content as readonly { readonly type: string; readonly text?: string }[];
  const envelope = JSON.parse(
    content[0]?.type === "text" ? (content[0].text ?? "{}") : "{}"
  ) as { result: { memoryId?: string; memoryRef?: number } };
  expect(envelope.result).toMatchObject({ memoryId, memoryRef: 1 });

  await client.close();
  await server.close();
});
