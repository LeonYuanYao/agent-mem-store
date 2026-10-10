import { getEncoding } from "js-tiktoken";
import type { ConversationMessage } from "./conversation-cache.js";

const tokenizer = getEncoding("o200k_base");
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const genericTerms = new Set(["一下", "这个", "那个", "当前", "现在", "之前", "目前", "帮我", "可以", "是否", "什么", "为什么", "怎么", "你的", "我的", "好的", "the", "this", "that", "please"]);
const planPattern = /建议|方案|改为|recommend|propos|plan/iu;
const constraintPattern = /不得|不能|不要|禁止|不应|除非|仅|不适用|尚未|没有|不代表|未获|尚不能|must not|do not|only|unless/iu;

export const contextTokenCount = (text: string): number => tokenizer.encode(text).length;
interface Fragment { readonly messageIndex: number; readonly text: string }
interface Candidate extends Fragment { readonly score: number; readonly priority: number; readonly ordinal: number; readonly tokens: number }

export function selectConversationContext(request: {
  readonly prompt: string;
  readonly messages: readonly ConversationMessage[];
  readonly tokenBudget: number;
}): { readonly text: readonly string[]; readonly tokens: number; readonly truncated: boolean; readonly fragments: readonly Fragment[] } {
  const messages = request.messages.slice(-6);
  const budget = Math.max(0, Math.floor(request.tokenBudget));
  const render = (fragments: readonly Fragment[]): string[] => fragments.map(item =>
    `[${messages[item.messageIndex]?.role ?? "unknown"}; previous_message=${String(messages.length - item.messageIndex)}] ${item.text}`);
  const size = (text: readonly string[]): number => text.length === 0 ? 0 : contextTokenCount(JSON.stringify(text));
  const all = messages.map((message, messageIndex) => ({ messageIndex, text: message.text }));
  const full = render(all);
  const fullTokens = size(full);
  if (fullTokens <= budget) return { text: full, tokens: fullTokens, truncated: messages.some(m => m.truncated), fragments: all };

  const terms = [...new Set([...segmenter.segment(request.prompt.toLocaleLowerCase("en-US"))]
    .filter(part => part.isWordLike && part.segment.length > 1 && !genericTerms.has(part.segment)).map(part => part.segment))];
  const latestAssistant = messages.findLastIndex(m => m.role === "assistant");
  const latestUser = messages.findLastIndex(m => m.role === "user");
  const refersToPlan = /推荐|建议|方案|按照|照做|recommend|propos|plan/iu.test(request.prompt);
  const candidates: Candidate[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    // Keep paragraphs (including their conditions and commands) intact. Oversized
    // paragraphs remain omitted, not rewritten into a potentially different claim.
    const paragraphs = message.text.split(/\n\s*\n/u).map(text => text.trim()).filter(Boolean);
    const substantive = paragraphs.findIndex(text => text.replace(/[*\s]/gu, "").length > 8);
    for (const [ordinal, text] of paragraphs.entries()) {
      const lower = text.toLocaleLowerCase("en-US");
      const overlap = Math.min(3, terms.filter(term => lower.includes(term)).length);
      const entities = Math.min(2, [...text.matchAll(/`[^`\n]+`|\b[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/gu)].length);
      const recent = 12 / (1 + (messages.length - 1 - messageIndex) * 0.65);
      const priority = messageIndex === latestAssistant && refersToPlan && planPattern.test(text) ? 0
        : messageIndex === latestAssistant && ordinal === Math.max(0, substantive) ? 1
          : messageIndex === latestUser && ordinal === Math.max(0, substantive) ? 2 : 3;
      const tokens = contextTokenCount(text);
      const score = (recent + overlap * 3 + entities * 1.5 + (constraintPattern.test(text) ? 4 : 0)
        + (planPattern.test(text) ? 4 : 0) + (ordinal === 0 ? 3 : 0)) / Math.sqrt(Math.max(24, tokens));
      candidates.push({ messageIndex, text, score, priority, ordinal, tokens });
    }
  }
  const selected: Candidate[] = [];
  let selectedTokens = 0;
  const seen = new Set<string>();
  const chronological = (items: readonly Candidate[]): Candidate[] => [...items].sort((a, b) => a.messageIndex - b.messageIndex || a.ordinal - b.ordinal);
  for (const candidate of candidates.sort((a, b) => a.priority - b.priority || b.score - a.score || b.messageIndex - a.messageIndex)) {
    const identity = `${messages[candidate.messageIndex]?.role ?? "unknown"}\0${candidate.text}`;
    if (seen.has(identity)) continue;
    // Skip paragraphs that cannot fit even before labels/JSON, avoiding repeated
    // encoding of a nearly-full context for every remaining paragraph.
    if (candidate.tokens > budget - selectedTokens) continue;
    const trial = chronological([...selected, candidate]);
    const trialTokens = size(render(trial));
    if (trialTokens > budget) continue;
    selectedTokens = trialTokens;
    selected.push(candidate);
    seen.add(identity);
  }
  const fragments = chronological(selected).map(({ messageIndex, text }) => ({ messageIndex, text }));
  const text = render(fragments);
  return { text, tokens: size(text), truncated: true, fragments };
}
