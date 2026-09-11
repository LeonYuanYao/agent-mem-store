import type { GovernanceAuditSignals, GovernanceMemoryInput } from "./contracts.js";

// Related bodies are evidence, not a recursive expansion of the audit scope.
// Keep normal page coverage unchanged and bound additional input independently.
export async function completePageEvidence(
  base: readonly GovernanceMemoryInput[],
  audit: GovernanceAuditSignals,
  load: (id: string) => Promise<GovernanceMemoryInput | undefined>
): Promise<{ memories: GovernanceMemoryInput[]; auditSignals: GovernanceAuditSignals }> {
  const baseIds = new Set(base.map(memory => memory.memoryId));
  const included = new Map(base.map(memory => [memory.memoryId, memory]));
  let extraBytes = 0;
  async function include(ids: readonly string[]): Promise<boolean> {
    if (!ids.some(id => baseIds.has(id))) return false;
    const anchor = base.find(memory => ids.includes(memory.memoryId));
    if (anchor === undefined) return false;
    const added: GovernanceMemoryInput[] = [];
    let bytes = 0;
    for (const id of new Set(ids)) {
      if (!included.has(id) && included.size - base.length + added.length >= 50) return false;
      const memory = included.get(id) ?? await load(id);
      if (memory === undefined || JSON.stringify(memory.scope) !== JSON.stringify(anchor.scope)) return false;
      if (!included.has(id)) {
        bytes += Buffer.byteLength(JSON.stringify(memory));
        if (extraBytes + bytes > 128 * 1024) return false;
        added.push(memory);
      }
    }
    for (const memory of added) included.set(memory.memoryId, memory);
    extraBytes += bytes;
    return true;
  }
  const reviewedDuplicateClusters: GovernanceAuditSignals["reviewedDuplicateClusters"][number][] = [];
  for (const cluster of audit.reviewedDuplicateClusters) {
    if (await include(cluster.memoryIds)) reviewedDuplicateClusters.push(cluster);
  }
  const exactDuplicateGroups: string[][] = [];
  for (const group of audit.exactDuplicateGroups) {
    if (await include(group)) exactDuplicateGroups.push([...group]);
  }
  return { memories: [...included.values()], auditSignals: { ...audit, reviewedDuplicateClusters, exactDuplicateGroups } };
}
