import type { CanonicalMemory } from "../vault/index.js";

/**
 * A reference document imported with `memstore remember doc` (ADR-0156): its body
 * is the full text; matching and injection use a summary card, title and headings.
 */
export const documentSourcePrefix = "source:document:";
export const documentHashPrefix = "document-sha256:";

export function isDocumentMemory(memory: Pick<CanonicalMemory, "provenance">): boolean {
  return memory.provenance.some((entry) => entry.startsWith(documentSourcePrefix));
}

/** Markdown headings of a document body, for matching without its full text. */
export function documentHeadings(body: string): string[] {
  return [...body.matchAll(/^#{1,4}\s+(.+?)\s*#*\s*$/gmu)].map((match) => (match[1] ?? "").trim()).filter((heading) => heading !== "");
}
