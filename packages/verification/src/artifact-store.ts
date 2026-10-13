import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { ArtifactReceiptV1, ArtifactRef, Sha256 } from "../../contracts/src/verification.js";

const hash = (b: Uint8Array): Sha256 => createHash("sha256").update(b).digest("hex");

/** Persistent content-addressed storage; callers must provide a dedicated, non-temporary root. */
export class DurableArtifactStore {
  readonly root: string;
  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new Error("artifact root must be absolute");
    this.root = path.resolve(root);
  }

  private async ensureRoot(): Promise<void> {
    const parsed = path.parse(this.root);
    let cursor = parsed.root;
    for (const component of this.root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, component);
      try { await mkdir(cursor, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("artifact path contains a symlink or non-directory component");
    }
    const s = await stat(this.root);
    if (!s.isDirectory()) throw new Error("artifact root must be a directory");
    await chmodPrivate(this.root);
  }

  async put(value: Uint8Array): Promise<ArtifactReceiptV1> {
    await this.ensureRoot();
    const bytes = Buffer.from(value), sha256 = hash(bytes), name = sha256;
    const target = path.join(this.root, name);
    try {
      const existing = await this.read(`sha256/${sha256}`);
      if (!existing.equals(bytes)) throw new Error("content address collision");
      return { key: `sha256/${sha256}`, sha256, bytes: bytes.length };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temp = path.join(this.root, `.pending-${randomUUID()}`);
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await link(temp, target); } catch (error) {
      await unlink(temp).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await unlink(temp).catch(() => undefined);
    if (process.platform !== "win32") {
      const dir = await open(this.root, constants.O_RDONLY);
      try { await dir.sync(); } finally { await dir.close(); }
    }
    const reread = await this.read(`sha256/${sha256}`);
    if (!reread.equals(bytes)) throw new Error("artifact read-back mismatch");
    return { key: `sha256/${sha256}`, sha256, bytes: bytes.length };
  }

  async read(ref: ArtifactRef, expectedSha?: Sha256): Promise<Buffer> {
    if (!/^sha256\/[a-f0-9]{64}$/.test(ref)) throw new Error("invalid artifact reference");
    await this.ensureRoot();
    const filename = path.join(this.root, ref.slice(7));
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("artifact is not a regular file");
      if (info.size > 16_777_216) throw new Error("artifact exceeds the maximum stored object size");
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    const actual = hash(bytes);
    if (actual !== ref.slice(7) || (expectedSha && actual !== expectedSha)) throw new Error("artifact hash mismatch");
    return bytes;
  }

  async verify(artifact: ArtifactReceiptV1): Promise<Buffer> {
    const bytes = await this.read(artifact.key, artifact.sha256);
    if (bytes.length !== artifact.bytes) throw new Error("artifact byte count mismatch");
    return bytes;
  }
}

async function chmodPrivate(directory: string): Promise<void> {
  const { chmod } = await import("node:fs/promises");
  await chmod(directory, 0o700);
}
