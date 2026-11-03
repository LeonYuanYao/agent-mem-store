import { expect, test } from "vitest";

import { ConversationCache } from "../../../src/retrieval/conversation-cache.js";

// ADR-0167: Claude Code replies carry no turn id; history rebuilt from capture never replaces live history.
test("a reply without a turn id joins the latest turn, and seeded history stays behind live turns", () => {
  const cache = new ConversationCache();
  cache.seed("p", "s", [{ user: "把预览重载改成按需加载", assistant: "已改 src/preview.ts，还差测试" }]);
  expect(cache.has("p", "s")).toBe(true);
  cache.seed("p", "s", [{ user: "不应覆盖" }]);
  const first = cache.beginUser("p", "s", undefined, "同意你的方案");
  expect(first.messages.map((message) => message.text)).toEqual(["把预览重载改成按需加载", "已改 src/preview.ts，还差测试"]);
  expect(cache.assistant("s", undefined, "测试已补上")).toBe(true);
  expect(cache.beginUser("p", "s", undefined, "push").messages.map((message) => message.text))
    .toEqual(["把预览重载改成按需加载", "已改 src/preview.ts，还差测试", "同意你的方案", "测试已补上"]);
  // Sensitive history is not seeded.
  cache.seed("p", "other", [{ user: "api_key = sk-live-1234567890abcdef" }]);
  expect(cache.beginUser("p", "other", undefined, "继续").messages).toEqual([]);
});
