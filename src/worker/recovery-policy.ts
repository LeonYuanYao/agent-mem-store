import { z } from "zod";

import { openRuntimeDatabaseReadOnly } from "../runtime/database.js";

export interface BackgroundRecoveryStatus {
  readonly active: boolean;
  readonly lunaHealth: "healthy" | "degraded" | "unavailable";
  readonly lunaBacklogCount: number;
  readonly captureBacklogCount: number;
  readonly reasons: readonly ("luna_health" | "luna_backlog" | "capture_backlog")[];
}

export async function inspectBackgroundRecovery(
  runtimeRoot: string
): Promise<BackgroundRecoveryStatus> {
  const database = await openRuntimeDatabaseReadOnly(runtimeRoot);
  try {
    const row = database.prepare(
      `SELECT
         (SELECT state FROM luna_health_state WHERE singleton = 1) AS luna_health,
         (SELECT COUNT(*) FROM luna_operations
          WHERE state IN ('pending', 'processing', 'retrying')) AS luna_backlog,
         (SELECT COUNT(*) FROM capture_events
          WHERE state IN ('pending', 'processing', 'retrying')) AS capture_backlog`
    ).get();
    const lunaHealth = z.enum(["healthy", "degraded", "unavailable"]).parse(row?.luna_health);
    const lunaBacklogCount = z.number().int().nonnegative().parse(row?.luna_backlog);
    const captureBacklogCount = z.number().int().nonnegative().parse(row?.capture_backlog);
    const reasons: Array<"luna_health" | "luna_backlog" | "capture_backlog"> = [];
    if (lunaHealth !== "healthy") reasons.push("luna_health");
    if (lunaBacklogCount >= 32) reasons.push("luna_backlog");
    if (captureBacklogCount >= 128) reasons.push("capture_backlog");
    return {
      active: reasons.length > 0,
      lunaHealth,
      lunaBacklogCount,
      captureBacklogCount,
      reasons
    };
  } finally {
    database.close();
  }
}
