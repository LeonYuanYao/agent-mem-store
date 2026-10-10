import { classifyLocalSensitivity } from "../contracts/sensitivity.js";

export interface ConversationMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly truncated: boolean;
}
export interface ConversationView {
  readonly messages: readonly ConversationMessage[];
  readonly status: "missing" | "partial" | "available";
}
interface Turn {
  readonly id: string | undefined;
  readonly user: ConversationMessage;
  assistant?: ConversationMessage;
}
interface Entry { readonly sessionId: string; readonly turns: Turn[] }

export function boundConversationMessage(text: string): { readonly text: string; readonly truncated: boolean } {
  const limit = 16 * 1024;
  return text.length <= limit ? { text, truncated: false }
    : { text: `${text.slice(0, 8190)}\n…\n${text.slice(-8190)}`, truncated: true };
}

/** Ephemeral context only: no capture, database, model or filesystem operations. */
export class ConversationCache {
  readonly #entries = new Map<string, Entry>();

  clearSession(sessionId: string): void {
    for (const [key, entry] of this.#entries) if (entry.sessionId === sessionId) this.#entries.delete(key);
  }

  beginUser(projectId: string, sessionId: string, turnId: string | undefined, text: string): ConversationView {
    if (classifyLocalSensitivity(text).state !== "normal") {
      this.clearSession(sessionId);
      return { messages: [], status: "missing" };
    }
    const key = `${projectId}\0${sessionId}`;
    const entry = this.#entries.get(key) ?? { sessionId, turns: [] };
    // A repeated Hook for the same turn must not include the current User as history.
    const repeated = turnId !== undefined && entry.turns.at(-1)?.id === turnId;
    const prior = (repeated ? entry.turns.slice(0, -1) : entry.turns).slice(-3);
    const messages = prior.flatMap(turn => turn.assistant === undefined ? [turn.user] : [turn.user, turn.assistant]);
    const status = prior.length === 0 ? "missing"
      : prior.some(turn => turn.assistant === undefined) || messages.some(message => message.truncated) ? "partial" : "available";
    if (!repeated) entry.turns.push({ id: turnId, user: { role: "user", ...boundConversationMessage(text) } });
    if (entry.turns.length > 4) entry.turns.splice(0, entry.turns.length - 4);
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    if (this.#entries.size > 128) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    return { messages, status };
  }

  assistant(sessionId: string, turnId: string, text: string, truncated = false): boolean {
    if (classifyLocalSensitivity(text).state !== "normal") {
      this.clearSession(sessionId);
      return false;
    }
    const matches = [...this.#entries.values()].filter(entry => entry.sessionId === sessionId && entry.turns.at(-1)?.id === turnId);
    if (matches.length !== 1 || text.trim().length === 0) return false;
    const turn = matches[0]?.turns.at(-1);
    if (turn === undefined) return false;
    const bounded = boundConversationMessage(text);
    turn.assistant = { role: "assistant", ...bounded, truncated: truncated || bounded.truncated };
    return true;
  }
}
