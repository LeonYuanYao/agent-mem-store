import { createHash } from "node:crypto";
import { link, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export async function writeFileAtomically(
  targetPath: string,
  content: string,
  mode: number,
  expectedContentIdentity?: string
): Promise<void> {
  const parent = dirname(targetPath);
  const temporaryPath = join(
    parent,
    `.${basename(targetPath)}.${randomUUID()}.tmp`
  );
  const file = await open(temporaryPath, "wx", mode);
  let committed = false;

  try {
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    if (expectedContentIdentity !== undefined) {
      const currentSource = await readFile(targetPath);
      const currentIdentity = createHash("sha256")
        .update(currentSource)
        .digest("hex");
      if (currentIdentity !== expectedContentIdentity) {
        throw new Error("Atomic write precondition no longer matches the target.");
      }
    }
    await rename(temporaryPath, targetPath);
    committed = true;
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (!committed) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export async function writeFileAtomicallyExclusive(
  targetPath: string,
  content: string,
  mode: number
): Promise<void> {
  const parent = dirname(targetPath);
  const temporaryPath = join(
    parent,
    `.${basename(targetPath)}.${randomUUID()}.tmp`
  );
  const file = await open(temporaryPath, "wx", mode);
  let committed = false;
  try {
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await link(temporaryPath, targetPath);
    await unlink(temporaryPath);
    committed = true;
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (!committed) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
