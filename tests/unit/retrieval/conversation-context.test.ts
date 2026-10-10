import { expect, test } from "vitest";
import { getEncoding } from "js-tiktoken";
import { ConversationCache } from "../../../src/retrieval/conversation-cache.js";
import { selectConversationContext } from "../../../src/retrieval/conversation-context.js";

const tokenizer = getEncoding("o200k_base");
test("assistant context is turn-bound, project-isolated, ephemeral and deduplicated", () => {
  const cache = new ConversationCache();
  expect(cache.beginUser("p1", "s", "t1", "Check MemStore changes.").status).toBe("missing");
  expect(cache.assistant("s", "wrong", "Wrong task.")).toBe(false);
  expect(cache.assistant("s", "t1", "Only MemStore code changed.")).toBe(true);
  expect(cache.assistant("s", "t1", "Only MemStore code changed.")).toBe(true);
  const prior = cache.beginUser("p1", "s", "t2", "commit push");
  expect(prior.status).toBe("available");
  expect(prior.messages.map(m => m.role)).toEqual(["user", "assistant"]);
  expect(prior.messages.map(m => m.text)).toEqual(["Check MemStore changes.", "Only MemStore code changed."]);
  expect(cache.assistant("s", "t1", "Late reply.")).toBe(false);
  expect(cache.beginUser("p2", "s", "t3", "Other project.").status).toBe("missing");
  expect(cache.beginUser("p1", "other", "t4", "Other session.").status).toBe("missing");
  cache.clearSession("s");
  expect(cache.assistant("s", "t3", "Late reply.")).toBe(false);
  expect(cache.beginUser("p1", "s", "t5", "Resume.").status).toBe("missing");
});

test("sensitive context is rejected before truncation and clears the session", () => {
  const cache = new ConversationCache();
  cache.beginUser("p", "s", "t1", "Safe request");
  expect(cache.assistant("s", "t1", `${"ordinary text ".repeat(3000)} Authorization: Bearer synthetic-secret-value`)).toBe(false);
  expect(cache.beginUser("p", "s", "t2", "Next request").status).toBe("missing");
});

test("missing replies remain partial and conversation cache is bounded", () => {
  const cache = new ConversationCache();
  for (let i = 0; i < 9; i++) cache.beginUser("p", "s", `t${String(i)}`, `Request ${String(i)}`);
  const view = cache.beginUser("p", "s", "next", "Next");
  expect(view.status).toBe("partial");
  expect(view.messages).toHaveLength(3);
  for (let i = 0; i < 129; i++) cache.beginUser("p", `s${String(i)}`, "t", "New session");
  expect(cache.beginUser("p", "s", "last", "Evicted").status).toBe("missing");
});

test("hybrid selection protects the referenced plan and intact restrictions under a hard budget", () => {
  const plan = "建议采用 30 秒、60 秒、120 秒、最多 5 分钟的退避；仅连接成功后重置，不得删除失败记录。";
  const messages = [
    { role: "user" as const, text: "检查 Botmux 反向隧道重试频率。", truncated: false },
    { role: "assistant" as const, text: `当前对象是 Botmux 反向隧道。\n\n${"历史探测已经失败，需要检查。\n\n".repeat(100)}${plan}\n\n尚未修改配置。`, truncated: false }
  ];
  const result = selectConversationContext({ prompt: "按照你推荐的方案优化一下", messages, tokenBudget: 160 });
  expect(result.text.join("\n")).toContain(plan);
  expect(result.text.join("\n")).toContain("Botmux");
  expect(result.tokens).toBeLessThanOrEqual(160);
  expect(tokenizer.encode(JSON.stringify(result.text)).length).toBe(result.tokens);
  expect(result.truncated).toBe(true);
  for (const fragment of result.fragments) expect(messages[fragment.messageIndex]?.text).toContain(fragment.text);
});

test("short messages release unused space to the recent assistant; role and uncertainty survive", () => {
  const important = "当前尚不能区分网络波动和服务端延迟，不支持继续扩大 timeout。";
  const result = selectConversationContext({ prompt: "那为什么之前会超时呢", tokenBudget: 256,
    messages: [
      { role: "user", text: "测过吗？", truncated: false },
      { role: "assistant", text: `Jev 请求复测成功。\n\n${important}`, truncated: false }
    ] });
  expect(result.text.join("\n")).toContain(important);
  expect(result.text.join("\n")).toContain("assistant");
  expect(result.truncated).toBe(false);
});

test("tiny budgets never cut a negation, command or conditional sentence to make it fit", () => {
  const result = selectConversationContext({ prompt: "执行", tokenBudget: 8,
    messages: [{ role: "user", text: "除非明确批准，否则不要运行 delete-all --force。", truncated: false }] });
  expect(result.text).toEqual([]);
  expect(result.tokens).toBeLessThanOrEqual(8);
  expect(result.truncated).toBe(true);
});
