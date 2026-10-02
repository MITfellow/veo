import type { FileStore } from '../../src/substrate/ports.js';

/** An in-memory FileStore. Deterministic, offline, and inspectable. */
export class MemoryFileStore implements FileStore {
  readonly files = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.files.set(key, bytes);
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    return this.files.get(key);
  }
  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
