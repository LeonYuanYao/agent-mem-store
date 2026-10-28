import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { dreamingConfigurationSchema } from "../../../src/dreaming/config.js";
import { CodexDreamModel } from "../../../src/dreaming/model.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// ADR-0157: the high-volume calls stay on Luna; merge, reconciliation and defense use the judge model.
test("extraction and verification use the configured model; merge, reconcile and defend use the judge model", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-dream-models-"));
  directories.push(root);
  const log = join(root, "calls.log");
  const fake = join(root, "codex");
  // Records the model of each call and answers every schema with empty lists.
  await writeFile(fake, [
    "#!/bin/sh",
    "model=''; out=''; prev=''",
    "for a in \"$@\"; do [ \"$prev\" = --model ] && model=\"$a\"; [ \"$prev\" = -o ] && out=\"$a\"; prev=\"$a\"; done",
    `echo "$model" >> '${log}'`,
    "echo '{\"candidates\":[],\"items\":[],\"results\":[]}' > \"$out\""
  ].join("\n"));
  await chmod(fake, 0o755);
  const configuration = dreamingConfigurationSchema.parse({});
  expect(configuration).toMatchObject({ model: "gpt-6-luna", judge_model: "gpt-6.1-terra" });
  const model = new CodexDreamModel({ codexExecutable: fake, codexHome: root, isolatedHome: join(root, "home"), temporaryRoot: join(root, "tmp"),
    extractEffort: "medium", verifyEffort: "high", model: configuration.model, judgeModel: configuration.judge_model });
  await model.extract({ projectLabel: "p", chunk: "c", index: 1, total: 1 });
  await model.verify({ tool: "t", repoMap: "", claims: [] });
  await model.merge({ candidates: [] });
  await model.reconcile({ items: [] });
  await model.defend({ tool: "t", repoMap: "", claims: [] });
  expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["gpt-6-luna", "gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-terra", "gpt-6.1-terra"]);
});
