---
status: accepted
---

# Recall and judge on the user's own message; lower the Jev threshold to 0.4

Chat bridges such as botmux deliver prompts wrapped in their own rules
(`<botmux_reminder>…</botmux_reminder>`) around a `<user_message>`. Foreground
retrieval and Jev received the whole wrapper, so Jev scored the bridge's own
"botmux send" Memories near 0.5 for any bridged prompt ("继续", "页面我在 chrome
已经打开了"). Claude Code also submits background-task notices
(`<task-notification>`) as prompts, 11% of prompts, which name no task to recall for.

Evaluation of real prompts from 2026-10-22 20:53 to 10-26 (486 prompts): Codex
(gpt-6.1-sol, isolated, blind to scores) labeled the 191 candidates Jev scored and
the 3 nearest Memories of 120 prompts the local gate found nothing for. The local
gate missed little (7 of 120 prompts had a relevant Memory nearby, five of them one
doubtful label). Of the 10 prompts that received noise at threshold 0.5, 8 got a
botmux rule. Re-scoring the same 138 prompts with only the user's message (same
client and proxy; unwrapped prompts drifted by a median of 0.01):

| Jev input | Threshold | Precision | Relevant recall | Prompts served (of 21) | Prompts with noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| as sent | 0.5 | 47.6% | 41.7% | 9 | 10 |
| user message | 0.5 | 71.4% | 41.7% | 9 | 2 |
| user message | 0.4 | 62.5% | 62.5% | 13 | 2 |
| user message | 0.3 | 60.7% | 70.8% | 15 | 4 |

Jev's separation rose from AUC 0.889 to 0.954.

Decision:

- The foreground server reduces a UserPromptSubmit prompt to its `<user_message>`
  text before retrieval, recent-prompt history and Jev's conversation context, the
  rule dreaming already applies (`userPromptText`).
- A `<task-notification>` prompt skips retrieval and Jev like a bare continuation
  (`agent_notification`) and does not enter the history.
- The installed configuration sets `[jev].threshold = 0.4`. The schema default stays
  0.5 until a second evaluation; the sample has 24 relevant pairs.

Rejected: lowering the threshold without unwrapping (0.4 doubled the prompts that
received noise); dropping bridged prompts entirely (they carry most remote work).
