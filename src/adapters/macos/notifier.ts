import { spawn } from "node:child_process";
import { z } from "zod";

export interface NotificationDelivery {
  readonly reminderId: string;
  readonly title: string;
  readonly body: string;
  readonly openUri: string;
  readonly snoozeDays: number;
}

export type NotificationDeliveryResult =
  | { readonly state: "delivered"; readonly receipt: string }
  | { readonly state: "permission_denied"; readonly errorCode: string }
  | { readonly state: "failed"; readonly errorCode: string };

export interface NotifierPort {
  deliver(notification: NotificationDelivery): Promise<NotificationDeliveryResult>;
}

export class RecordingNotifier implements NotifierPort {
  public readonly deliveries: NotificationDelivery[] = [];
  readonly #result: NotificationDeliveryResult;

  public constructor(result: NotificationDeliveryResult = {
    state: "delivered",
    receipt: "recording:notifier:delivered"
  }) {
    this.#result = result;
  }

  public deliver(notification: NotificationDelivery): Promise<NotificationDeliveryResult> {
    this.deliveries.push(notification);
    return Promise.resolve(this.#result);
  }
}

export class SwiftNotifierAdapter implements NotifierPort {
  readonly #executable: string;

  public constructor(executable: string) {
    this.#executable = executable;
  }

  public async deliver(notification: NotificationDelivery): Promise<NotificationDeliveryResult> {
    return new Promise((resolveResult) => {
      const child = spawn(this.#executable, ["deliver"], {
        stdio: ["pipe", "pipe", "ignore"]
      });
      const stdout: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
      });
      child.on("error", () => {
        resolveResult({ state: "failed", errorCode: "notifier_spawn_failed" });
      });
      child.on("close", (exitCode) => {
        if (exitCode !== 0) {
          resolveResult({ state: "failed", errorCode: "notifier_exit_failure" });
          return;
        }
        try {
          const output = z.discriminatedUnion("state", [
            z.object({ state: z.literal("delivered"), receipt: z.string().min(1) }),
            z.object({ state: z.literal("permission_denied"), errorCode: z.string().min(1) }),
            z.object({ state: z.literal("failed"), errorCode: z.string().min(1) })
          ]).parse(JSON.parse(Buffer.concat(stdout).toString("utf8")));
          resolveResult(output);
        } catch {
          resolveResult({ state: "failed", errorCode: "notifier_invalid_response" });
        }
      });
      child.stdin.end(JSON.stringify(notification));
    });
  }
}
