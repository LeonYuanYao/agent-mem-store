import { expect, test } from "vitest";

import { assessExactCompact } from "../../../src/memories/representations.js";

const exact = (body: string) => assessExactCompact({ body, conditions: [], exclusions: [], preservedNegations: [] });

// Write-time validation counts tokens as the retrieval index does (o200k), not by bytes.
test("a compact the index would inject is valid when written, and one it would reject is not", () => {
  // 94 o200k tokens but 99 by a bytes/4 estimate: an injectable Memory was once written as unvalidated.
  const mixed = "MemStore 的 scripts/prune-retired-data.ts 清理 tombstone 记忆文件、目录记录及关联运行时数据，并清理符合条件的退役 Luna 流水线已完成记录；Luna operations 仅清理超过 7 天且不再被相关流水线记录引用的项目。脚本保留 Memory 编号分配记录、采集事件、dreaming 数据、active 和 archived Memories，以及未完成工作。";
  expect(exact(mixed)).toMatchObject({ validated: true, renderedTokenCount: 94 });
  expect(exact(`${mixed}${mixed}`).validated).toBe(false);
});
