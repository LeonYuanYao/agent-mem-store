import { z } from "zod";

export const memoryCategorySchema = z.enum([
  "safety_data_integrity",
  "applicability_limitation",
  "preference_constraint",
  "architecture_contract",
  "failure_recovery_hazard",
  "workflow_environment_toolchain",
  "durable_reference"
]);

export type MemoryCategory = z.infer<typeof memoryCategorySchema>;

export const memoryCategoryPrecedence: readonly MemoryCategory[] = [
  "safety_data_integrity",
  "applicability_limitation",
  "preference_constraint",
  "architecture_contract",
  "failure_recovery_hazard",
  "workflow_environment_toolchain",
  "durable_reference"
];

export const memoryCategoryJsonSchema = {
  enum: memoryCategorySchema.options
} as const;

export const memoryCategoryPromptInstruction =
  "Use one or more controlled categoryTags. Set primaryCategory to the first matching tag in this exact precedence: safety_data_integrity, applicability_limitation, preference_constraint, architecture_contract, failure_recovery_hazard, workflow_environment_toolchain, durable_reference. MemStore also enforces this deterministically.";

export function selectPrimaryCategory(
  categories: readonly MemoryCategory[]
): MemoryCategory {
  const categorySet = new Set(categories);
  return memoryCategoryPrecedence.find((category) => categorySet.has(category)) ??
    "durable_reference";
}

export interface LegacyCategoryMapping {
  readonly legacyCategory: string;
  readonly primaryCategory: MemoryCategory;
  readonly categoryTags: readonly MemoryCategory[];
  readonly matchedSignals: readonly string[];
  readonly usedFallback: boolean;
}

const categorySignals: readonly {
  readonly category: MemoryCategory;
  readonly expressions: readonly RegExp[];
}[] = [
  {
    category: "safety_data_integrity",
    expressions: [
      /safety|security|secret|integrity|data[_ -]?loss|destructive|protection|safe[_ -]?guard/u,
      /安全|完整性|数据丢失|破坏性|机密/u
    ]
  },
  {
    category: "applicability_limitation",
    expressions: [
      /applicab|limit|scope|boundary|uncertain|caveat|exception|compatib|rollout|truncat|interpretation/u,
      /适用|限制|范围|边界|不确定|兼容|截断/u
    ]
  },
  {
    category: "preference_constraint",
    expressions: [
      /preference|constraint|decision|requirement|policy|instruction|user[_ -]?(?:request|decision|requirement)|goal/u,
      /偏好|约束|决定|要求|规则|指令|目标/u
    ]
  },
  {
    category: "architecture_contract",
    expressions: [
      /architect|api|contract|invariant|schema|state[_ -]?machine|identity|hierarch|serializ|structure|design|artifact|format|coordinate|geometry|wiring|binding|composition|dsl|model/u,
      /架构|契约|不变量|身份|结构|格式|坐标|模型/u
    ]
  },
  {
    category: "failure_recovery_hazard",
    expressions: [
      /failure|recovery|repair|hazard|diagnos|troubleshoot|pitfall|error|recurrence|cleanup/u,
      /失败|恢复|修复|故障|诊断|清理/u
    ]
  },
  {
    category: "workflow_environment_toolchain",
    expressions: [
      /workflow|procedure|verification|evaluation|build|install|configur|environment|tooling|operation|protocol|process|execution|delivery|publication|test|validation|editing|synchron|migration|maintenance|governance|implementation|method|planning|status|state|outcome|behavior|result|observation|discovery|input|interaction|render|preview|session|repository|spreadsheet|resource|runtime|telemetry|preflight|development|project|movement|physics|material|camera|animation|ui/u,
      /工作流|流程|验证|评估|构建|安装|配置|环境|工具|操作|执行|交付|维护|治理|实现|状态|结果|输入|交互|渲染|会话|仓库|运行/u
    ]
  }
];

function normalizedLegacyCategory(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

const importanceTagCategories: Readonly<Record<string, MemoryCategory>> = {
  security_boundary: "safety_data_integrity",
  data_loss_risk: "safety_data_integrity",
  irreversible_operation: "safety_data_integrity",
  limitation: "applicability_limitation",
  negation: "applicability_limitation",
  applicability_correction: "applicability_limitation",
  exception: "applicability_limitation",
  user_decision: "preference_constraint",
  stable_preference: "preference_constraint",
  constraint: "preference_constraint",
  architecture_invariant: "architecture_contract",
  api_contract: "architecture_contract",
  failure_root_cause: "failure_recovery_hazard",
  effective_repair: "failure_recovery_hazard",
  recovery_procedure: "failure_recovery_hazard",
  recurrence_hazard: "failure_recovery_hazard",
  expensive_rediscovery: "workflow_environment_toolchain"
};

export function mapLegacyCategory(
  value: string,
  importanceTags: readonly string[] = []
): LegacyCategoryMapping {
  const legacyCategory = z.string().min(1).max(256).parse(value);
  const direct = memoryCategorySchema.safeParse(legacyCategory);
  if (direct.success) {
    return {
      legacyCategory,
      primaryCategory: direct.data,
      categoryTags: [direct.data],
      matchedSignals: [`controlled:${direct.data}`],
      usedFallback: false
    };
  }

  const normalized = normalizedLegacyCategory(legacyCategory);
  const matches = categorySignals.filter((signal) =>
    signal.expressions.some((expression) => expression.test(normalized))
  );
  const importanceCategories = importanceTags.flatMap((tag) => {
    const category = importanceTagCategories[tag];
    return category === undefined ? [] : [category];
  });
  const tags = memoryCategoryPrecedence.filter((category) =>
    matches.some((match) => match.category === category) ||
    importanceCategories.includes(category)
  );
  const categoryTags = tags.length === 0
    ? (["durable_reference"] as const)
    : tags;
  return {
    legacyCategory,
    primaryCategory: selectPrimaryCategory(categoryTags),
    categoryTags,
    matchedSignals: [
      ...matches.map((match) => `legacy:${match.category}`),
      ...importanceTags.flatMap((tag) => {
        const category = importanceTagCategories[tag];
        return category === undefined ? [] : [`importance:${tag}->${category}`];
      })
    ],
    usedFallback: tags.length === 0
  };
}
