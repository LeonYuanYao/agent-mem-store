import { expect, test } from "vitest";

import { userPromptText, userWordsFor } from "../../../src/dreaming/stream.js";

test("only the user's own message is kept from a chat-bridge prompt envelope", () => {
  const wrapped = [
    "<botmux_routing>",
    "本轮最终答复用 `botmux send --response-kind final` 标记且只发一次。",
    "</botmux_routing>",
    "<botmux_builtin_skills>",
    "- botmux-schedule: 在当前飞书/Lark 话题里创建定时提醒。",
    "</botmux_builtin_skills>",
    "<session_id>c51b8b06</session_id>",
    "<user_message>",
    "以后提 MR 都用 Bits",
    "</user_message>",
    "<sender type=\"user\" name=\"Owner\" />"
  ].join("\n");
  expect(userPromptText(wrapped)).toBe("以后提 MR 都用 Bits");
  expect(userPromptText("plain prompt with <tags> kept")).toBe("plain prompt with <tags> kept");
});

test("a user-stated candidate keeps the user message its quote came from", () => {
  const chunk = [
    "", "### T01 USER", "以后提 MR 都用 Bits，看看 setVideo", "### T01 ASSISTANT", "好的，默认用 optimize 类型。",
    "[tool T01] Bash: cat README.md", "→ build with npm run build", "", "### T02 USER", "继续"
  ].join("\n");
  expect(userWordsFor(chunk, ["T01"], "以后提 MR 都用 Bits")).toEqual({ source: "user", words: ["以后提 MR 都用 Bits，看看 setVideo"] });
  // Words from a reply or tool output are not the user's.
  expect(userWordsFor(chunk, ["T01"], "默认用 optimize 类型")).toEqual({ source: "other", words: [] });
  expect(userWordsFor(chunk, ["T01"], "npm run build").source).toBe("other");
  // A paraphrased quote falls back to the cited USER turns.
  expect(userWordsFor(chunk, ["T02"], "请继续执行")).toEqual({ source: "missing", words: ["继续"] });
});
