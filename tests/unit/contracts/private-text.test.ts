import { expect, test } from "vitest";

import { withoutPrivateText } from "../../../src/contracts/prompt-text.js";

test("marked spans, an unclosed tag and a p: message are kept out of MemStore", () => {
  expect(withoutPrivateText("部署到 <pv>10.0.0.8 用户名 alice</pv> 那台机器")).toEqual({ text: "部署到  那台机器", whole: false });
  expect(withoutPrivateText("a <PRIVATE>x</PRIVATE> b <private>y")).toEqual({ text: "a  b ", whole: false });
  expect(withoutPrivateText("p：这条整条都别记")).toEqual({ text: "", whole: true });
  expect(withoutPrivateText("  P: whole message")).toEqual({ text: "", whole: true });
  // A bridged prompt is judged on the user's own message.
  expect(withoutPrivateText("<botmux_reminder>rules</botmux_reminder><user_message>p：私事</user_message>").whole).toBe(true);
  // Ordinary text is untouched, including HTML paragraphs and words that merely start with p.
  expect(withoutPrivateText("<p>段落</p> python: 3.12")).toEqual({ text: "<p>段落</p> python: 3.12", whole: false });
});
