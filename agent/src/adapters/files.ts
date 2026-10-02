/**
 * `DiskFileStore` — the production FileStore (L1 adapter).
 *
 * The invoker already scopes a tool to its own sandbox, so this class is not
 * the security boundary. It is the *second* one anyway: a key that escapes
 * the root after normalisation is rejected here too, because a store that
 * trusts its caller is one refactor away from writing to `/etc`.
 *
 * Keys are flat strings and may contain `/`. They are mapped to paths by
 * normalising and then proving the result is still inside the root — the
 * only check that survives `..`, symlink-shaped keys, URL encoding and
 * Windows separators without a blocklist.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { FileStore } from '../substrate/ports.js';

export class EscapedSandboxError extends Error {
  constructor(key: string) {
    super(`'${key}' resolves outside the file store root and was refused`);
    this.name = 'EscapedSandboxError';
  }
}

export class DiskFileStore implements FileStore {
  constructor(private readonly root: string) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else keys.push(relative(this.root, full).split(sep).join('/'));
      }
    };
    await walk(this.root);
    return keys.filter((key) => key.startsWith(prefix)).sort();
  }

  private pathFor(key: string): string {
    const path = resolve(this.root, key);
    const inside = relative(this.root, path);
    if (inside === '' || inside.startsWith('..') || resolve(this.root, inside) !== path) {
      throw new EscapedSandboxError(key);
    }
    return path;
  }
}
