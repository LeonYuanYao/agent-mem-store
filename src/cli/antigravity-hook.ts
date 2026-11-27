import { resolve } from "node:path";
import { text as consumeText } from "node:stream/consumers";

const hookBudgetMilliseconds = 1_700;
const handledEvents = new Set(["SessionStart", "PreInvocation", "PostToolUse", "Stop"]);

/**
 * Antigravity Hooks (ADR-0192): capture for dreaming and, with `MEMSTORE_INJECTION_MODE=active`,
 * injection before the first model call of a user turn through the same foreground retrieval as
 * Codex and Claude Code. Antigravity runs every hook synchronously and expects a JSON object on
 * stdout, so the hook always prints one (`{}` when it has nothing to add), sends diagnostics to
 * stderr, exits 0 and stops itself after 1.7 s. PreInvocation runs before every model call: calls
 * that cannot start a user turn return before the capture modules load.
 */
export async function runAntigravityHook(eventSource: unknown): Promise<void> {
  const event = typeof eventSource === "string" ? eventSource : "";
  let written = false;
  const respond = (output: Record<string, unknown> = {}, done?: () => void): void => {
    if (written) return;
    written = true;
    process.stdout.write(`${JSON.stringify(output)}\n`, done);
  };
  const watchdog = setTimeout(() => {
    process.stderr.write(`MemStore (antigravity ${event}): hook_deadline_exceeded; the session continues without it.\n`);
    if (written) process.exit(0);
    respond({}, () => process.exit(0));
  }, hookBudgetMilliseconds);
  watchdog.unref();
  try {
    if (!handledEvents.has(event)) {
      process.stderr.write(`MemStore (antigravity): unsupported_event ${event}\n`);
      return;
    }
    const runtimeRoot = process.env.MEMSTORE_RUNTIME_ROOT;
    if (runtimeRoot === undefined) {
      process.stderr.write("MemStore (antigravity): MEMSTORE_RUNTIME_ROOT is required.\n");
      return;
    }
    const raw: unknown = JSON.parse(await consumeText(process.stdin));
    const { mayStartUserTurn } = await import("../adapters/antigravity/hook.js");
    if (event === "PreInvocation" && !mayStartUserTurn(typeof raw === "object" && raw !== null ? raw : {})) return;
    const output = await handleEvent(resolve(runtimeRoot), event, raw);
    if (output !== undefined) respond(output);
  } catch (error) {
    process.stderr.write(`MemStore (antigravity ${event}): skipped: ${error instanceof Error ? error.name : "error"}\n`);
  } finally {
    respond();
    clearTimeout(watchdog);
  }
}

async function handleEvent(root: string, eventName: string, raw: unknown): Promise<Record<string, unknown> | undefined> {
  const deadlineAt = performance.now() + hookBudgetMilliseconds - 100;
  const [
    { antigravityCaptureInput, antigravityHookEventSchema, antigravityHookInputSchema, antigravityInjection, antigravityProjectPath,
      capturedEventKind, isAntigravitySubagent },
    { executionFollowsUserInput, readLastPlannerReply },
    { handleCodexHook },
    { CaptureProgress, renderCaptureDiagnostic },
    { excludedRootDecision, optInNotice },
    { readAntigravityHookDisplay, readExcludedRoots, readSessionStartInjection, readSubagentsEnabled, renderHookDisplay },
    { classifyLocalSensitivity },
    { readDreamingConfiguration },
    { firstPromptRecentWork, recentWorkDisplay },
    { boundConversationMessage },
    { requestForegroundRetrieval, sendForegroundContextUpdate }
  ] = await Promise.all([
    import("../adapters/antigravity/hook.js"),
    import("../adapters/antigravity/transcript.js"),
    import("../adapters/codex/hook.js"),
    import("../capture/deadline.js"),
    import("../capture/excluded-roots.js"),
    import("../configuration/hook-display.js"),
    import("../contracts/sensitivity.js"),
    import("../dreaming/config.js"),
    import("../dreaming/recent-work.js"),
    import("../retrieval/conversation-cache.js"),
    import("../retrieval/foreground-client.js")
  ]);
  const event = antigravityHookEventSchema.parse(eventName);
  const input = antigravityHookInputSchema.parse(raw);
  const injecting = process.env.MEMSTORE_INJECTION_MODE === "active";
  const dreaming = await readDreamingConfiguration(root);
  const capturing = dreaming.enabled;
  if (!capturing && !injecting) return undefined;
  // Subagents stay out of MemStore unless the user turns them on (ADR-0165).
  if (isAntigravitySubagent(input) && !await readSubagentsEnabled(root)) return undefined;
  // An execution started by something other than a user message, such as a subagent's report, is not a prompt.
  if (event === "PreInvocation" && input.transcriptPath !== undefined && input.initialNumSteps !== undefined &&
      await executionFollowsUserInput(input.transcriptPath, input.initialNumSteps) === false) return undefined;
  const kind = capturedEventKind(event);
  const projectPath = antigravityProjectPath(input);
  const sessionId = input.conversationId;
  const prompt = kind === "UserPromptSubmit" ? input.lastUserInput ?? "" : "";
  // Sessions under an excluded root stay out unless the user opts in with `ms：` (ADR-0173).
  const excludedRoots = await readExcludedRoots(root);
  let optedIn = false;
  if (excludedRoots.length > 0 && projectPath !== undefined) {
    const decision = await excludedRootDecision({ runtimeRoot: root, sessionId, path: projectPath, eventKind: kind,
      ...(kind === "UserPromptSubmit" ? { prompt } : {}), entries: excludedRoots });
    if (decision === "excluded") return undefined;
    optedIn = decision === "opted_in";
  }
  // The opt-in shows its notice even when nothing is injected; the model is sent nothing.
  const notice = (): Record<string, unknown> | undefined => optedIn ? antigravityInjection("", optInNotice) : undefined;
  const reply = event === "Stop" && input.transcriptPath !== undefined ? await readLastPlannerReply(input.transcriptPath) : undefined;
  const result = await handleCodexHook({
    runtimeRoot: root,
    input: antigravityCaptureInput(event, input, reply === undefined ? {} : { reply }),
    agent: "antigravity",
    ...(projectPath === undefined ? {} : { projectPath }),
    captureEnabled: capturing,
    progress: new CaptureProgress(Math.max(1, deadlineAt - performance.now() - 200))
  });
  if (result.state === "capture_unavailable") process.stderr.write(`${renderCaptureDiagnostic(result.diagnostic)}\n`);
  if (!injecting) return notice();
  // A new Session, or a sensitive prompt, must not leave conversation context behind.
  if (kind === "SessionStart" || (kind === "UserPromptSubmit" && classifyLocalSensitivity(prompt).state !== "normal")) {
    await sendForegroundContextUpdate({ runtimeRoot: root, sessionId, update: { action: "clear" } });
  }
  // Jev reads the reply that ended the previous turn with the next prompt (ADR-0167).
  if (kind === "Stop") {
    if (result.state !== "private_turn" && reply !== undefined) {
      await sendForegroundContextUpdate({ runtimeRoot: root, sessionId, update: classifyLocalSensitivity(reply).state === "normal"
        ? { action: "assistant", ...boundConversationMessage(reply) } : { action: "clear" } });
    }
    return undefined;
  }
  if (kind === "PostToolUse") return undefined;
  const injectable = kind === "UserPromptSubmit" || await readSessionStartInjection(root);
  if (!injectable || !(result.captured || result.state === "capture_disabled") || result.projectId === undefined) return notice();
  const foreground = await requestForegroundRetrieval({
    runtimeRoot: root,
    event: kind,
    projectId: result.projectId,
    sessionId,
    ...(result.captured ? { eventId: result.eventId } : {}),
    ...(kind === "UserPromptSubmit" ? { prompt } : {}),
    requestedAt: new Date().toISOString(),
    timeoutMilliseconds: Math.max(1, Math.min(1_500, Math.floor(deadlineAt - performance.now() - 75)))
  });
  // The first prompt of a Session also gets where the Project's recent Sessions left off (ADR-0164).
  const recent = kind === "UserPromptSubmit"
    ? await firstPromptRecentWork({ runtimeRoot: root, projectId: result.projectId, sessionId, now: new Date().toISOString(), configuration: dreaming })
      .catch(() => undefined)
    : undefined;
  const retrieved = foreground.state === "completed" ? foreground.text.trim() : "";
  if (retrieved === "" && recent === undefined) return notice();
  const display = await readAntigravityHookDisplay(root);
  const shown = [
    optedIn ? optInNotice : undefined,
    foreground.state === "completed" ? renderHookDisplay(display, kind, foreground.text, foreground.renderedTokenCount) : undefined,
    recent !== undefined && display !== "off" ? recentWorkDisplay(recent.count) : undefined
  ].filter((line) => line !== undefined).join("\n");
  return antigravityInjection([retrieved, recent?.text ?? ""].filter((part) => part !== "").join("\n\n"), shown);
}
