import { expect, test } from "vitest";

import { userPromptText } from "../../../src/dreaming/stream.js";

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
