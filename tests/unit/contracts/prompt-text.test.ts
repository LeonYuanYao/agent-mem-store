import { expect, test } from "vitest";

import { isAgentNotification, userPromptText } from "../../../src/contracts/prompt-text.js";

test("only the user's message of a bridged prompt is kept", () => {
  const wrapped = "<botmux_reminder>回应规则</botmux_reminder>\n<user_message>\n 检查 MemStore 状态 \n</user_message>";
  expect(userPromptText(wrapped)).toBe("检查 MemStore 状态");
  expect(userPromptText("<user_message>一</user_message> <user_message>二</user_message>")).toBe("一\n\n二");
  expect(userPromptText("plain prompt with <tags> kept")).toBe("plain prompt with <tags> kept");
});

test("agent notifications are recognised only at the start of the prompt", () => {
  expect(isAgentNotification("<task-notification>\n<task-id>b1</task-id>\n</task-notification>")).toBe(true);
  expect(isAgentNotification("  <task-notification>done</task-notification>")).toBe(true);
  expect(isAgentNotification("why did <task-notification> appear?")).toBe(false);
});
