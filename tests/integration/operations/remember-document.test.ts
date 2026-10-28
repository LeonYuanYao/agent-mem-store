import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { fetchLarkDocument, rememberDocument } from "../../../src/operations/remember-document.js";
import { buildRetrievalIndex } from "../../../src/retrieval/index.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { readCanonicalMemory } from "../../../src/vault/index.js";

// ADR-0156: a document becomes one Human-authored Memory whose body is the full text.
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memstore-remember-document-"));
  roots.push(root);
  return { root, runtimeRoot: join(root, "runtime"), vaultRoot: join(root, "vault") };
}

const guide = `# 发布手册

## 准备
发布前运行 typecheck 和全部测试。

## 发布步骤
1. 合入 main
2. 打 tag 并推送
`;

test("a document is stored whole, re-imported as a revision of the same Memory, and skipped when unchanged", async () => {
  const { root, runtimeRoot, vaultRoot } = await fixture();
  const request = { runtimeRoot, vaultRoot, path: root, scope: "global" as const, preview: false };
  const source = "https://example.larkoffice.com/docx/abc";
  const created = await rememberDocument({ ...request, document: { content: guide, source }, importedAt: "2026-10-28T05:00:00.000Z" });
  expect(created).toMatchObject({ state: "created", title: "发布手册" });
  const memoryId = String(created.memoryId);
  const first = (await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId }))?.memory;
  expect(first?.authority).toBe("human_authored");
  expect(first?.startup).toBe("never");
  expect(first?.applicability.summary).toBe("发布手册");
  // Title once, then where it came from, then the document unchanged.
  expect(first?.body).toBe(`# 发布手册\n\n> 来源：${source}（导入于 2026-10-28）\n\n## 准备\n发布前运行 typecheck 和全部测试。\n\n## 发布步骤\n1. 合入 main\n2. 打 tag 并推送`);

  await expect(rememberDocument({ ...request, document: { content: guide, source }, importedAt: "2026-10-29T05:00:00.000Z" }))
    .resolves.toMatchObject({ state: "unchanged", memory_id: memoryId });

  const updated = await rememberDocument({ ...request, document: { content: `${guide}3. 在群里通知\n`, source }, importedAt: "2026-10-30T05:00:00.000Z" });
  expect(updated).toMatchObject({ state: "updated", memory_id: memoryId, memory_ref: first?.memoryRef });
  const second = (await readCanonicalMemory({ runtimeRoot, vaultRoot, memoryId }))?.memory;
  expect(second?.revisionId).not.toBe(first?.revisionId);
  expect(second?.body).toContain("3. 在群里通知");
  expect(second?.provenance.filter((entry) => entry.startsWith("document-sha256:"))).toHaveLength(1);
});

test("an uncertain match needs the user's confirmation of that exact value; a secret never passes", async () => {
  const { root, runtimeRoot, vaultRoot } = await fixture();
  const request = { runtimeRoot, vaultRoot, path: root, scope: "global" as const, preview: false, importedAt: "2026-10-28T05:00:00.000Z" };
  const content = "# 接入说明\n\nauth 示例值 AbC9xYz12345678901234567890QwE 只用于演示。\n";
  const held = await rememberDocument({ ...request, document: { content, source: "/docs/onboarding.md" } });
  expect(held).toMatchObject({ state: "needs_sensitivity_review", matched_value: "9xYz12345678901234567890QwE" });
  await expect(rememberDocument({ ...request, document: { content, source: "/docs/onboarding.md" }, confirmSensitive: "something-else" }))
    .resolves.toMatchObject({ state: "needs_sensitivity_review" });
  await expect(rememberDocument({ ...request, document: { content, source: "/docs/onboarding.md" }, confirmSensitive: "9xYz12345678901234567890QwE" }))
    .resolves.toMatchObject({ state: "created" });

  await expect(rememberDocument({ ...request, document: { content: "# 密钥\n\napi_key = sk-live-1234567890abcdef\n", source: "/docs/keys.md" } }))
    .resolves.toMatchObject({ state: "blocked_secret" });
});

test("a document too long to inject matches on its card, title and headings, not on its full text", async () => {
  const { root, runtimeRoot, vaultRoot } = await fixture();
  // A short document is its own compact and is injected whole; a long one is matched by its card.
  const long = `${guide}${Array.from({ length: 40 }, (_, index) => `${String(index + 3)}. 检查第 ${String(index + 3)} 个发布清单项并在群里确认`).join("\n")}\n`;
  const created = await rememberDocument({ runtimeRoot, vaultRoot, path: root, scope: "global", preview: false,
    document: { content: long, source: "/docs/release.md" }, importedAt: "2026-10-28T05:00:00.000Z" });
  await buildRetrievalIndex({ runtimeRoot, vaultRoot, builtAt: "2026-10-28T05:00:01.000Z", adapter: {
    identity: { adapterVersion: "document-fixture-v1", modelIdentity: "document-fixture", artifactSha256: "e".repeat(64), dimensions: 2, normalization: "l2" },
    embed: (texts) => Promise.resolve(texts.map(() => [1, 0]))
  } });
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const text = String(database.prepare("SELECT searchable_text FROM retrieval_documents WHERE memory_id = ?").get(String(created.memoryId))?.searchable_text);
    expect(text).toContain("发布手册");
    expect(text).toContain("发布步骤");
    expect(text).not.toContain("打 tag 并推送");
  } finally {
    database.close();
  }
});

test("a Lark document is fetched as Markdown through lark-cli", async () => {
  const { root } = await fixture();
  const fake = join(root, "lark-cli");
  // The fetch has no title; the metadata call does.
  await writeFile(fake, [
    "#!/bin/sh",
    "if [ \"$1\" = api ]; then echo '{\"ok\":true,\"data\":{\"document\":{\"title\":\"团队周报\"}}}'; exit 0; fi",
    "echo '{\"ok\":true,\"data\":{\"document\":{\"content\":\"# 周报\\\\n\\\\n本周完成发布。\",\"document_id\":\"doc1\",\"revision_id\":42}}}'"
  ].join("\n"));
  await chmod(fake, 0o755);
  vi.stubEnv("MEMSTORE_LARK_CLI", fake);
  await expect(fetchLarkDocument("https://example.larkoffice.com/docx/xyz")).resolves.toEqual({
    content: "# 周报\n\n本周完成发布。", source: "https://example.larkoffice.com/docx/xyz", title: "团队周报", revision: "42"
  });
});
