#!/usr/bin/env node

import { resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMemStoreMcpServer } from "./server.js";
import { loadConfiguredEmbeddingAdapter } from "../retrieval/embeddings/configured.js";
import { CodexTerraRetrievalJudge } from "../retrieval/judge.js";

const runtimeRoot = process.env.MEMSTORE_RUNTIME_ROOT;
const vaultRoot = process.env.MEMSTORE_VAULT_ROOT;
if (runtimeRoot === undefined || vaultRoot === undefined) {
  process.stderr.write(
    "memstore-mcp: MEMSTORE_RUNTIME_ROOT and MEMSTORE_VAULT_ROOT are required.\n"
  );
  process.exitCode = 2;
} else {
  const embedding = await loadConfiguredEmbeddingAdapter(resolve(runtimeRoot));
  const codexHome = process.env.MEMSTORE_TERRA_CODEX_HOME ??
    process.env.MEMSTORE_LUNA_CODEX_HOME;
  const retrievalJudge = codexHome === undefined
    ? undefined
    : new CodexTerraRetrievalJudge({
        codexExecutable: process.env.MEMSTORE_CODEX_EXECUTABLE ?? "codex",
        codexHome: resolve(codexHome),
        isolatedHome: resolve(runtimeRoot, "terra-home"),
        temporaryRoot: resolve(runtimeRoot, "tmp")
      });
  const server = createMemStoreMcpServer({
    runtimeRoot: resolve(runtimeRoot),
    vaultRoot: resolve(vaultRoot),
    path: process.cwd(),
    ...(embedding === undefined ? {} : { embeddingAdapter: embedding.adapter }),
    ...(retrievalJudge === undefined ? {} : { retrievalJudge })
  });
  await server.connect(new StdioServerTransport());
}
