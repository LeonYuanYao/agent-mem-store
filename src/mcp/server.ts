import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { errorEnvelope, successEnvelope } from "../contracts/envelope.js";
import { executeRecall, type RecallContext } from "../operations/recall.js";

export interface MemStoreMcpServerOptions {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly path: string;
  readonly callerIdentity?: string;
  readonly now?: () => string;
}

function toolResult(command: string, result: unknown) {
  const envelope = successEnvelope(command, result);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
    structuredContent: z.record(z.string(), z.unknown()).parse(envelope)
  };
}

async function runTool(command: string, work: () => Promise<unknown>) {
  try {
    return toolResult(command, await work());
  } catch (error) {
    const envelope = errorEnvelope(command, error);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
      structuredContent: z.record(z.string(), z.unknown()).parse(envelope),
      isError: true
    };
  }
}

export function createMemStoreMcpServer(
  options: MemStoreMcpServerOptions
): McpServer {
  const server = new McpServer({ name: "memstore", version: "0.1.0" });
  const context = (): RecallContext => ({
    runtimeRoot: options.runtimeRoot,
    vaultRoot: options.vaultRoot,
    path: options.path,
    callerIdentity: options.callerIdentity ?? `mcp:${String(process.pid)}`,
    requestedAt: options.now?.() ?? new Date().toISOString()
  });

  server.registerTool("memstore_search", {
    title: "Search MemStore",
    description: "Search compact memory descriptions and return stable identities for deeper reads.",
    inputSchema: {
      query: z.string().min(1),
      scope: z.enum(["current", "global", "project", "all_projects"]).optional(),
      project_id: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      cursor: z.string().min(1).optional(),
      target_tokens: z.number().int().positive().optional()
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async (input) => runTool(
    "recall.search",
    () => executeRecall("search", input, context())
  ));

  server.registerTool("memstore_get", {
    title: "Read MemStore memory",
    description: "Read one eligible memory revision by stable identity.",
    inputSchema: {
      memory_id: z.string().min(1),
      revision: z.string().min(1).optional(),
      detail: z.enum(["compact", "standard", "full"]).optional()
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async (input) => runTool(
    "recall.show",
    () => executeRecall("get", input, context())
  ));

  server.registerTool("memstore_provenance", {
    title: "Read MemStore provenance",
    description: "Page identity-bearing provenance for one memory without dumping a source session.",
    inputSchema: {
      memory_id: z.string().min(1),
      revision: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      cursor: z.string().min(1).optional(),
      target_tokens: z.number().int().positive().optional()
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async (input) => runTool(
    "recall.provenance",
    () => executeRecall("provenance", input, context())
  ));

  server.registerTool("memstore_related", {
    title: "Read related MemStore memories",
    description: "Read exactly one typed relationship hop from a memory identity.",
    inputSchema: {
      memory_id: z.string().min(1),
      revision: z.string().min(1).optional(),
      direction: z.enum(["incoming", "outgoing", "both"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      cursor: z.string().min(1).optional(),
      target_tokens: z.number().int().positive().optional()
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async (input) => runTool(
    "recall.related",
    () => executeRecall("related", input, context())
  ));

  server.registerTool("memstore_report_irrelevant", {
    title: "Report irrelevant MemStore result",
    description: "Record a receipt-bound irrelevant retrieval Bad Case without free-form feedback.",
    inputSchema: {
      receipt_id: z.string().min(1),
      memory_id: z.string().min(1)
    },
    annotations: { readOnlyHint: false, idempotentHint: true }
  }, async (input) => runTool(
    "recall.report_irrelevant",
    () => executeRecall("report_irrelevant", input, context())
  ));

  return server;
}
