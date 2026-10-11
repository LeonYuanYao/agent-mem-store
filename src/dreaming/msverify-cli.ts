#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { capLines, EvidenceReader } from "./msverify.js";
import { repoMapSchema } from "./repo-map.js";

/**
 * Entry point the verifier model calls from its read-only sandbox. The repository
 * map is written by the Worker before verification and passed through MSVERIFY_MAP.
 */
const usage = `msverify map
msverify grep [-i] [--repo R] [--path GLOB] [--autoload] PATTERN
msverify show PATH [--from N] [--to M]
msverify ls PATH
msverify log-s [--repo R] TEXT
msverify branch-grep [-i] [--repo R] [--path GLOB] PATTERN`;

async function main(): Promise<number> {
  let argv = process.argv.slice(2);
  let mapPath = process.env.MSVERIFY_MAP;
  if (argv[0] === "--map") {
    mapPath = argv[1];
    argv = argv.slice(2);
  }
  const [command, ...rest] = argv;
  if (command === undefined || mapPath === undefined) {
    process.stdout.write(`${usage}\n`);
    return 2;
  }
  const map = repoMapSchema.parse(JSON.parse(await readFile(mapPath, "utf8")));
  const reader = new EvidenceReader(map);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      i: { type: "boolean", short: "i" },
      repo: { type: "string" },
      path: { type: "string" },
      autoload: { type: "boolean" },
      from: { type: "string" },
      to: { type: "string" }
    }
  });
  const target = positionals.join(" ");
  let lines: string[];
  if (command === "map") lines = reader.map();
  else if (command === "grep" && target !== "") {
    lines = await reader.grep(target, {
      ignoreCase: values.i === true,
      ...(values.repo === undefined ? {} : { repo: values.repo }),
      ...(values.path === undefined ? {} : { path: values.path }),
      autoload: values.autoload === true
    });
  } else if (command === "show" && target !== "") {
    lines = await reader.show(target, Number(values.from ?? "1"), values.to === undefined ? undefined : Number(values.to));
  } else if (command === "ls" && target !== "") lines = await reader.list(target);
  else if (command === "log-s" && target !== "") lines = await reader.pickaxe(target, values.repo);
  else if (command === "branch-grep" && target !== "") {
    lines = await reader.branchGrep(target, new Date().toISOString(), {
      ignoreCase: values.i === true,
      ...(values.repo === undefined ? {} : { repo: values.repo }),
      ...(values.path === undefined ? {} : { path: values.path })
    });
  } else {
    process.stdout.write(`${usage}\n`);
    return 2;
  }
  process.stdout.write(`${capLines(lines).join("\n")}\n`);
  return 0;
}

main().then((code) => { process.exitCode = code; }, (error: unknown) => {
  process.stderr.write(`msverify: ${error instanceof Error ? error.message : "failed"}\n`);
  process.exitCode = 1;
});
