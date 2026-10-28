import { spawn } from "node:child_process";
import { documentHashPrefix, documentSourcePrefix } from "../memories/documents.js";
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";

import { assertHumanKnowledge, recordHumanGlobalAuthorization } from "../candidates/human.js";
import { MemStoreCommandError } from "../contracts/envelope.js";
import { classifyLocalSensitivity } from "../contracts/sensitivity.js";
import { assessExactCompact } from "../memories/representations.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import { readCanonicalMemory, writeCanonicalMemory, type CanonicalMemory } from "../vault/index.js";
import { resolveRememberScope, type RememberScope } from "./remember.js";

/**
 * `memstore remember doc` (ADR-0156): a document the user hands over becomes one
 * Human-authored Memory whose body is the full text in the Vault. Retrieval matches
 * and injects a summary card; agents read the full text with `recall show`.
 * Importing the same source again revises that Memory, keeping its M:id.
 */


export interface DocumentSource {
  readonly content: string;
  /** URL or absolute path identifying the document across imports. */
  readonly source: string;
  readonly title?: string;
  readonly revision?: string;
}

function runLarkCli(args: readonly string[]): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(process.env.MEMSTORE_LARK_CLI ?? "lark-cli", [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    const timer = setTimeout(() => { child.kill("SIGTERM"); }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(Buffer.concat(chunks).toString("utf8"));
      else rejectPromise(new MemStoreCommandError("lark_fetch_failed",
        `lark-cli failed (exit ${String(code)}): ${Buffer.concat(errors).toString("utf8").slice(0, 300)}`));
    });
  });
}

/** Fetches a Lark/Feishu document as Markdown, with its title, through the user's lark-cli login. */
export async function fetchLarkDocument(url: string): Promise<DocumentSource> {
  const fetched = z.object({ data: z.object({ document: z.object({
    content: z.string().min(1), document_id: z.string().optional(), revision_id: z.number().int().optional()
  }) }) }).parse(JSON.parse(await runLarkCli(["docs", "+fetch", "--doc", url, "--doc-format", "markdown", "--as", "user"])));
  const document = fetched.data.document;
  // The Markdown export has no document title; the document's metadata does.
  let title: string | undefined;
  if (document.document_id !== undefined) {
    try {
      title = z.object({ data: z.object({ document: z.object({ title: z.string().min(1) }) }) })
        .parse(JSON.parse(await runLarkCli(["api", "GET", `/open-apis/docx/v1/documents/${document.document_id}`, "--as", "user"])))
        .data.document.title.trim();
    } catch { title = undefined; }
  }
  return {
    content: document.content, source: url,
    ...(title === undefined ? {} : { title }),
    ...(document.revision_id === undefined ? {} : { revision: String(document.revision_id) })
  };
}

function firstHeading(content: string): string | undefined {
  return /^#{1,3}\s+(.+?)\s*#*\s*$/mu.exec(content)?.[1]?.trim();
}

/** The Vault body: title, where it came from, then the document unchanged. */
export function documentBody(document: DocumentSource, title: string, importedAt: string): string {
  const content = document.content.trim();
  // A leading heading equal to the title would repeat it.
  const withoutTitle = content.replace(new RegExp(`^#{1,3}\\s+${title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*\\n+`, "u"), "");
  const origin = `> 来源：${document.source}（导入于 ${importedAt.slice(0, 10)}${document.revision === undefined ? "" : `，文档修订 ${document.revision}`}）`;
  return `# ${title}\n\n${origin}\n\n${withoutTitle}`;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content.trim().replace(/\r\n/gu, "\n")).digest("hex");
}

async function findDocumentMemory(runtimeRoot: string, vaultRoot: string, source: string): Promise<Awaited<ReturnType<typeof readCanonicalMemory>>> {
  const database = await openRuntimeDatabase(runtimeRoot);
  let ids: string[];
  try {
    ids = database.prepare("SELECT memory_id FROM memory_catalog WHERE authority = 'human_authored' AND lifecycle = 'active'")
      .all().map((row) => z.string().parse(row.memory_id));
  } finally {
    database.close();
  }
  for (const memoryId of ids) {
    const loaded = await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId });
    if (loaded?.memory.provenance.includes(`${documentSourcePrefix}${source}`) === true) return loaded;
  }
  return undefined;
}

export async function rememberDocument(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly path: string;
  readonly document: DocumentSource;
  readonly scope: RememberScope;
  readonly preview: boolean;
  readonly importedAt: string;
  /** The uncertain-sensitivity match the user reviewed; see the needs_review result. */
  readonly confirmSensitive?: string;
}): Promise<Record<string, unknown>> {
  const title = (request.document.title ?? firstHeading(request.document.content) ?? basename(request.document.source)).slice(0, 200);
  const body = documentBody(request.document, title, request.importedAt);
  const hash = contentHash(request.document.content);
  const sensitivity = classifyLocalSensitivity(body);
  const base = { source: request.document.source, title, characters: request.document.content.length };
  if (sensitivity.state === "secret") {
    return { ...base, state: "blocked_secret", category: sensitivity.category,
      message: "The document contains a secret (credential, key or authorization header). Remove it and import again." };
  }
  // Only the exact match the user reviewed passes; any other uncertain match still stops.
  const reviewedValue = sensitivity.state === "uncertain" && sensitivity.matchedValue === request.confirmSensitive
    ? { reviewedSensitiveValue: sensitivity.matchedValue } : {};
  if (sensitivity.state === "uncertain" && !("reviewedSensitiveValue" in reviewedValue)) {
    return { ...base, state: "needs_sensitivity_review", category: sensitivity.category, matched_value: sensitivity.matchedValue,
      next: `If this is not a credential, import again with --confirm-sensitive '${sensitivity.matchedValue}'.` };
  }
  const existing = await findDocumentMemory(request.runtimeRoot, request.vaultRoot, request.document.source);
  if (existing?.memory.provenance.includes(`${documentHashPrefix}${hash}`) === true) {
    return { ...base, state: "unchanged", memory_id: existing.memory.memoryId, memory_ref: existing.memory.memoryRef };
  }
  if (request.preview) {
    return { ...base, dry_run: true, state: existing === undefined ? "would_create" : "would_update",
      ...(existing === undefined ? {} : { memory_id: existing.memory.memoryId, memory_ref: existing.memory.memoryRef }) };
  }
  if (existing !== undefined) {
    // Same source: a new revision of the same Memory keeps its M:id; its summary is regenerated.
    const revisionId = `msrev_${randomUUID()}`;
    const operationId = `mshumanop_${randomUUID()}`;
    const compact = assessExactCompact({ body, conditions: [title], exclusions: [], preservedNegations: [] });
    const previous = existing.memory;
    const revised: CanonicalMemory = {
      ...previous,
      revisionId,
      predecessorRevisionId: previous.revisionId,
      revisedAt: request.importedAt,
      applicability: { summary: title, conditions: [] },
      semanticContract: { ...previous.semanticContract, claims: [body] },
      representations: {
        compact: { text: compact.text, validated: compact.validated, generatorIdentity: "direct-human-assertion",
          sourceRevisionId: revisionId, renderedTokenCount: compact.renderedTokenCount },
        standard: { text: body, validated: true, generatorIdentity: "direct-human-assertion",
          sourceRevisionId: revisionId, renderedTokenCount: compact.renderedTokenCount }
      },
      provenance: [`operation:${operationId}`,
        ...previous.provenance.filter((entry) => !entry.startsWith("operation:") && !entry.startsWith(documentHashPrefix)),
        `${documentHashPrefix}${hash}`],
      body
    };
    const written = await writeCanonicalMemory({ vaultRoot: request.vaultRoot, runtimeRoot: request.runtimeRoot, actor: "human",
      memory: revised, expectedContentIdentity: existing.contentIdentity, ...reviewedValue });
    return { ...base, state: "updated", memory_id: written.memoryId, memory_ref: written.memoryRef, path: written.path };
  }
  const scope = await resolveRememberScope({ scope: request.scope, path: request.path, runtimeRoot: request.runtimeRoot });
  if (scope.kind === "global") {
    await recordHumanGlobalAuthorization({ runtimeRoot: request.runtimeRoot, statement: body, maximumSensitivity: "private",
      authorizedAt: request.importedAt, sourceIdentity: "remember.document" });
  }
  const result = await assertHumanKnowledge({
    runtimeRoot: request.runtimeRoot, vaultRoot: request.vaultRoot, scope, body,
    primaryCategory: "durable_reference",
    // A reference document is read when relevant, not loaded at every Session start.
    startup: "never",
    applicability: { summary: title, conditions: [] },
    assertedAt: request.importedAt,
    sourceIdentity: `document:${request.document.source}`,
    extraProvenance: [`${documentHashPrefix}${hash}`],
    ...reviewedValue
  });
  return { ...base, scope, ...result };
}
