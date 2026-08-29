import { z } from "zod";

import { openRuntimeDatabase } from "../runtime/database.js";

const canonicalMemoryIdSchema = z.string().regex(
  /^msmem_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
);
const portableMemoryReferenceSchema = z.string().regex(/^M:[1-9][0-9]*$/u);

export interface ResolvedMemoryReference {
  readonly memoryId: string;
  readonly memoryRef: number;
  readonly reference: string;
}

export function formatMemoryReference(memoryRef: number): string {
  return `M:${String(z.number().int().positive().parse(memoryRef))}`;
}

export async function resolveMemoryReference(
  runtimeRoot: string,
  input: string
): Promise<ResolvedMemoryReference> {
  const identity = z.string().min(1).parse(input).trim();
  const portable = portableMemoryReferenceSchema.safeParse(identity);
  const canonical = canonicalMemoryIdSchema.safeParse(identity);
  if (!portable.success && !canonical.success) {
    throw new Error("Memory identity must be a canonical msmem_ UUID or portable M:<number> reference.");
  }
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const row = portable.success
      ? database.prepare(
          "SELECT memory_id, memory_ref FROM memory_catalog WHERE memory_ref = ?"
        ).get(Number.parseInt(portable.data.slice(2), 10))
      : database.prepare(
          "SELECT memory_id, memory_ref FROM memory_catalog WHERE memory_id = ?"
        ).get(identity);
    if (row === undefined) throw new Error("Memory identity is not present in the Runtime catalog.");
    const memoryId = canonicalMemoryIdSchema.parse(row.memory_id);
    const memoryRef = z.number().int().positive().parse(row.memory_ref);
    return { memoryId, memoryRef, reference: formatMemoryReference(memoryRef) };
  } finally {
    database.close();
  }
}
