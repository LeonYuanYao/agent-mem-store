import { z } from "zod";

export interface ForegroundLaneRequest {
  readonly requestId: string;
  readonly deadlineAt: string;
}

export interface ForegroundExecutionControl {
  readonly signal: AbortSignal;
  checkpoint(stage: string): Promise<void>;
}

export interface ForegroundLaneAttempt {
  readonly requestId: string;
  readonly outcome: "completed" | "empty" | "busy" | "deadline_exceeded" |
    "cancelled" | "unavailable" | "failed";
  readonly admissionDelayMs: number;
  readonly computeMs: number;
  readonly postDeadlineWorkMs: number;
  readonly createdAt: string;
  readonly completedAt: string;
}

type ForegroundLaneInterruption =
  | { readonly state: "busy"; readonly requestId: string }
  | { readonly state: "deadline_exceeded"; readonly requestId: string }
  | { readonly state: "cancelled"; readonly requestId: string }
  | { readonly state: "unavailable"; readonly requestId: string };

class ForegroundExecutionAborted extends Error {
  constructor(readonly outcome: "deadline_exceeded" | "cancelled") {
    super(outcome);
  }
}

function abortOutcome(signal: AbortSignal): "deadline_exceeded" | "cancelled" {
  return signal.reason === "deadline" ? "deadline_exceeded" : "cancelled";
}

export function createForegroundRetrievalLane<
  Request extends ForegroundLaneRequest,
  Completed extends { readonly state: string; readonly requestId: string }
>(options: {
  readonly execute: (
    request: Request,
    control: ForegroundExecutionControl
  ) => Promise<Completed>;
  readonly onAttempt?: (
    attempt: ForegroundLaneAttempt,
    request: Request,
    result: Completed | ForegroundLaneInterruption
  ) => void;
}): {
  run(
    request: Request,
    execution?: { readonly signal?: AbortSignal }
  ): Promise<Completed | ForegroundLaneInterruption>;
  readonly occupied: boolean;
} {
  let occupied = false;
  return {
    get occupied() { return occupied; },
    run: async (request, execution = {}) => {
      const invokedAt = performance.now();
      const createdAt = new Date().toISOString();
      const deadlineAt = z.iso.datetime().parse(request.deadlineAt);
      if (occupied) {
        const result = { state: "busy" as const, requestId: request.requestId };
        options.onAttempt?.({
          requestId: request.requestId,
          outcome: "busy",
          admissionDelayMs: 0,
          computeMs: 0,
          postDeadlineWorkMs: 0,
          createdAt,
          completedAt: new Date().toISOString()
        }, request, result);
        return result;
      }
      const remainingMilliseconds = Date.parse(deadlineAt) - Date.now();
      if (remainingMilliseconds <= 0) {
        const result = { state: "deadline_exceeded" as const, requestId: request.requestId };
        options.onAttempt?.({
          requestId: request.requestId,
          outcome: "deadline_exceeded",
          admissionDelayMs: 0,
          computeMs: 0,
          postDeadlineWorkMs: 0,
          createdAt,
          completedAt: new Date().toISOString()
        }, request, result);
        return result;
      }
      const monotonicDeadline = invokedAt + remainingMilliseconds;
      occupied = true;
      const controller = new AbortController();
      const abortFromCaller = (): void => { controller.abort("caller"); };
      if (execution.signal?.aborted === true) abortFromCaller();
      else execution.signal?.addEventListener("abort", abortFromCaller, { once: true });
      const timer = setTimeout(() => { controller.abort("deadline"); }, remainingMilliseconds);
      const control: ForegroundExecutionControl = {
        signal: controller.signal,
        checkpoint: async () => {
          await new Promise<void>((resolve) => { setImmediate(resolve); });
          if (controller.signal.aborted) {
            throw new ForegroundExecutionAborted(abortOutcome(controller.signal));
          }
        }
      };
      let outcome: ForegroundLaneAttempt["outcome"] = "failed";
      let settledResult: Completed | ForegroundLaneInterruption | undefined;
      try {
        await control.checkpoint("admission");
        const result = await options.execute(request, control);
        await control.checkpoint("completion");
        outcome = result.state === "completed" || result.state === "empty"
          ? result.state
          : "unavailable";
        settledResult = result;
        return result;
      } catch (error) {
        if (error instanceof ForegroundExecutionAborted) {
          const result = { state: error.outcome, requestId: request.requestId };
          outcome = error.outcome;
          settledResult = result;
          return result;
        }
        const result = { state: "unavailable" as const, requestId: request.requestId };
        outcome = "failed";
        settledResult = result;
        return result;
      } finally {
        const completed = performance.now();
        clearTimeout(timer);
        execution.signal?.removeEventListener("abort", abortFromCaller);
        occupied = false;
        if (settledResult !== undefined) {
          options.onAttempt?.({
            requestId: request.requestId,
            outcome,
            admissionDelayMs: 0,
            computeMs: Math.max(0, completed - invokedAt),
            postDeadlineWorkMs: Math.max(0, completed - monotonicDeadline),
            createdAt,
            completedAt: new Date().toISOString()
          }, request, settledResult);
        }
      }
    }
  };
}
