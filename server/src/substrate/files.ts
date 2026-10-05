import { readFileSync, statSync } from 'node:fs';
import { normalize as normalizePath, resolve, sep } from 'node:path';

/**
 * The FileStore port (§8), deferred in M0 and needed now.
 *
 * `node:fs` is banned everywhere else, so this file is the entire filesystem
 * surface of the platform. That is the point: a reviewer checking whether
 * ARISH can read something it should not has one file to read.
 *
 * The only non-obvious thing here is `readWithin`, which refuses to escape
 * a root directory. A static file server that does not do this serves
 * `/etc/passwd` to anyone who asks for `../../../../etc/passwd`, and the
 * UI we are about to serve takes its path from the URL.
 */

export interface FileStore {
  /** Read a file as UTF-8, or undefined if it is absent. */
  readText(path: string): string | undefined;
  /** Read bytes, or undefined if absent. */
  readBytes(path: string): Uint8Array | undefined;
  exists(path: string): boolean;
  /**
   * Resolve `relative` against `root` and read it, refusing any path that
   * escapes the root. Returns undefined for both "missing" and "escaped" —
   * the caller must not be able to distinguish them, because the difference
   * is itself information about the filesystem.
   */
  readWithin(root: string, relative: string): Uint8Array | undefined;
}

export class RealFileStore implements FileStore {
  readText(path: string): string | undefined {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  }

  readBytes(path: string): Uint8Array | undefined {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      return undefined;
    }
  }

  exists(path: string): boolean {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  }

  readWithin(root: string, relative: string): Uint8Array | undefined {
    const base = resolve(root);
    // Strip any leading separators so `resolve` cannot be handed an
    // absolute path that ignores the base entirely.
    const cleaned = normalizePath(relative).replace(/^([/\\]|\.\.([/\\]|$))+/, '');
    const target = resolve(base, cleaned);
    if (target !== base && !target.startsWith(base + sep)) return undefined;
    return this.readBytes(target);
  }
}

/** In-memory implementation, so tests never touch a disk. */
export class MemoryFileStore implements FileStore {
  constructor(private readonly files: Map<string, string> = new Map()) {}

  set(path: string, contents: string): void {
    this.files.set(resolve(path), contents);
  }

  readText(path: string): string | undefined {
    return this.files.get(resolve(path));
  }

  readBytes(path: string): Uint8Array | undefined {
    const text = this.readText(path);
    return text === undefined ? undefined : new TextEncoder().encode(text);
  }

  exists(path: string): boolean {
    return this.files.has(resolve(path));
  }

  readWithin(root: string, relative: string): Uint8Array | undefined {
    const base = resolve(root);
    const cleaned = normalizePath(relative).replace(/^([/\\]|\.\.([/\\]|$))+/, '');
    const target = resolve(base, cleaned);
    if (target !== base && !target.startsWith(base + sep)) return undefined;
    return this.readBytes(target);
  }
}
