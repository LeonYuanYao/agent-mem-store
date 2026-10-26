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
