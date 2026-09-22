import { z } from "zod";

export const corpusRetentionPolicySchema = z.object({
  activeLimit: z.number().int().min(2).optional(),
  activeHeadroom: z.number().int().positive().optional(),
  projectHighWater: z.number().int().positive(),
  projectTarget: z.number().int().positive(),
  aggregateHighWater: z.number().int().positive(),
  aggregateTarget: z.number().int().positive(),
  coldDays: z.number().int().min(14).max(3650),
  batchSize: z.number().int().min(1).max(200)
}).strict().refine((p) => p.projectTarget < p.projectHighWater && p.aggregateTarget < p.aggregateHighWater,
  "Retention targets must be below high water.").refine((p) =>
    p.activeLimit === undefined ? p.activeHeadroom === undefined :
      p.activeHeadroom !== undefined && p.activeHeadroom < p.activeLimit,
  "Fixed capacity requires headroom smaller than the Active limit.");

export type CorpusRetentionPolicy = z.infer<typeof corpusRetentionPolicySchema>;
export const defaultCorpusRetentionPolicy: CorpusRetentionPolicy = {
  projectHighWater: 3_000, projectTarget: 2_700,
  aggregateHighWater: 6_000, aggregateTarget: 5_500, coldDays: 14, batchSize: 50
};

export const corpusRetentionConfigurationSchema = z.object({
  mode: z.enum(["off", "preview", "apply"]).default("off"),
  active_limit: z.number().optional(), active_headroom: z.number().optional(),
  project_high_water: z.number().default(3_000), project_target: z.number().default(2_700),
  aggregate_high_water: z.number().default(6_000), aggregate_target: z.number().default(5_500),
  cold_days: z.number().default(14), batch_size: z.number().default(50)
}).strict().prefault({}).transform((value): { mode: "off" | "preview" | "apply"; policy: CorpusRetentionPolicy } => ({
  mode: value.mode,
  policy: { projectHighWater: value.project_high_water, projectTarget: value.project_target,
    activeLimit: value.active_limit,
    activeHeadroom: value.active_headroom,
    aggregateHighWater: value.aggregate_high_water, aggregateTarget: value.aggregate_target,
    coldDays: value.cold_days, batchSize: value.batch_size }
})).pipe(z.object({ mode: z.enum(["off", "preview", "apply"]), policy: corpusRetentionPolicySchema }));

export type CorpusRetentionConfiguration = z.infer<typeof corpusRetentionConfigurationSchema>;
