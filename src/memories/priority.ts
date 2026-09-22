import type { CanonicalMemory } from "../vault/index.js";

export function basePriorityTier(memory: CanonicalMemory): "critical" | "strong" | "normal" {
  if (
    memory.primaryCategory === "safety_data_integrity" ||
    (memory.authority === "human_authored" &&
      ["preference_constraint", "architecture_contract"].includes(memory.primaryCategory)) ||
    memory.importanceTags.some((tag) => ["safety", "architecture", "decision"].includes(tag))
  ) return "critical";
  if (
    ["failure_recovery_hazard", "workflow_environment_toolchain"].includes(memory.primaryCategory) ||
    memory.importanceTags.includes("constraint")
  ) return "strong";
  return "normal";
}
