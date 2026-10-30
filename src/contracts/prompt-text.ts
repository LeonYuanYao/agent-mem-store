/**
 * Chat bridges such as botmux wrap each prompt in routing rules, skill lists and
 * identity blocks around a `<user_message>` element. Only that element is the
 * user's own text; the wrapper would otherwise read as rules the user stated, and
 * retrieval would match the bridge's own rules to every bridged prompt (ADR-0154).
 */
export function userPromptText(prompt: string): string {
  const messages = [...prompt.matchAll(/<user_message>([\s\S]*?)<\/user_message>/gu)].map((match) => (match[1] ?? "").trim());
  return messages.length === 0 ? prompt : messages.join("\n\n");
}

/** Claude Code's notice that a background task finished, sent as a prompt the user did not write. */
export function isAgentNotification(prompt: string): boolean {
  return /^\s*<task-notification>/u.test(prompt);
}

const privateSpan = /<(private|pv)>[\s\S]*?<\/\1>/giu;
const unclosedPrivate = /<(?:private|pv)>[\s\S]*$/iu;
const strayPrivateClose = /<\/(?:private|pv)>/giu;
const privateMessagePrefix = /^\s*p\s*[：:]/iu;

/**
 * Text the user marked private stays out of MemStore (ADR-0161): it is not captured,
 * matched, sent to Jev or kept as conversation history. `<private>…</private>` and
 * `<pv>…</pv>` hide a span, an unclosed tag the rest of the message; a message that
 * starts with `p：` or `p:` is private as a whole, and so is the rest of its turn.
 * The agent itself still reads the prompt as written.
 */
export function withoutPrivateText(prompt: string): { readonly text: string; readonly whole: boolean } {
  if (privateMessagePrefix.test(userPromptText(prompt))) return { text: "", whole: true };
  return { text: prompt.replace(privateSpan, "").replace(unclosedPrivate, "").replace(strayPrivateClose, ""), whole: false };
}
