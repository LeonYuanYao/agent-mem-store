import { idleSocketMilliseconds } from "./proxy-fetch.js";

/**
 * Keeps the proxied Jev connection open while an agent Session is in use (ADR-0151).
 * Foreground traffic (prompts, Session boundaries, assistant replies) marks
 * activity; while the last activity is recent, the connection is used at least
 * once per `intervalMs`, so a prompt minutes after the previous one still finds
 * it open. The far side sometimes closes an idle connection early, so the pool is
 * checked every `checkMs` (locally, without sending) and a closed connection is
 * reopened. Without activity for `activeWindowMs` nothing is sent.
 */
export const jevWarmIntervalMilliseconds = Math.floor(idleSocketMilliseconds * 0.75);
export const jevWarmCheckMilliseconds = 15_000;
export const jevWarmActiveWindowMilliseconds = 30 * 60_000;

export class JevConnectionWarmer {
  #lastActivityAt = Number.NEGATIVE_INFINITY;
  #timer: ReturnType<typeof setInterval> | undefined;
  #warming = false;
  #closed = false;

  constructor(private readonly options: {
    readonly warm: (options: { readonly reuseAfterMs: number }) => Promise<unknown>;
    readonly intervalMs?: number;
    readonly checkMs?: number;
    readonly activeWindowMs?: number;
  }) {}

  /**
   * `warmNow` opens the connection right away, for a Session boundary where a
   * prompt is about to follow; a retrieval request opens it itself.
   */
  noteActivity(options: { readonly warmNow: boolean }): void {
    if (this.#closed) return;
    this.#lastActivityAt = performance.now();
    this.#timer ??= setInterval(() => { this.#tick(); }, this.options.checkMs ?? jevWarmCheckMilliseconds);
    this.#timer.unref();
    if (options.warmNow) this.#warm();
  }

  close(): void {
    this.#closed = true;
    this.#stop();
  }

  #tick(): void {
    if (performance.now() - this.#lastActivityAt > (this.options.activeWindowMs ?? jevWarmActiveWindowMilliseconds)) {
      this.#stop();
      return;
    }
    this.#warm();
  }

  #warm(): void {
    if (this.#warming) return;
    this.#warming = true;
    void this.options.warm({ reuseAfterMs: this.options.intervalMs ?? jevWarmIntervalMilliseconds })
      .catch(() => undefined)
      .finally(() => { this.#warming = false; });
  }

  #stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
