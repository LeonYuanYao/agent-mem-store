#!/usr/bin/env node

import { resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMemStoreMcpServer } from "./server.js";

const runtimeRoot = process.env.MEMSTORE_RUNTIME_ROOT;
const vaultRoot = process.env.MEMSTORE_VAULT_ROOT;
if (runtimeRoot === undefined || vaultRoot === undefined) {
  process.stderr.write(
    "memstore-mcp: MEMSTORE_RUNTIME_ROOT and MEMSTORE_VAULT_ROOT are required.\n"
  );
  process.exitCode = 2;
} else {
  const server = createMemStoreMcpServer({
    runtimeRoot: resolve(runtimeRoot),
    vaultRoot: resolve(vaultRoot),
    path: process.cwd()
  });
  await server.connect(new StdioServerTransport());
}
