/**
 * The artifact store (§17, L3).
 *
 * > Large outputs go to the artifact store; the model sees a reference plus a
 * > short summary. **This one decision is what will keep the context window
 * > survivable when browsing arrives.**
 *
 * The spec is right, and the discipline has to start now rather than when it
 * hurts: a 40MB page fetched at M3 is the same problem as a 40MB page fetched
 * at M9, except at M9 there are six call sites that assume results are small.
 */
import type { EventLog } from '../substrate/events/log.js';
import type { Clock, FileStore, Hashing, Ids, Storage } from '../substrate/ports.js';
import type { ArtifactRef } from './tool.js';

/** Anything above this goes to the store instead of into the context. */
export const INLINE_LIMIT_BYTES = 4096;

export interface StoreOptions {
  mediaType: string;
  summary: string;
  runId: string;
  stepId: string;
  principal: string;
  tool: string;
}

export class ArtifactStore {
  constructor(
    private readonly files: FileStore,
    private readonly storage: Storage,
    private readonly events: EventLog,
    private readonly clock: Clock,
    private readonly ids: Ids,
    private readonly hashing: Hashing,
  ) {}

  async put(bytes: Uint8Array, options: StoreOptions): Promise<ArtifactRef> {
    const id = this.ids.ulid();
    const digest = this.hashing.sha256Hex(bytes);
    await this.files.put(`artifacts/${id}`, bytes);

    this.storage.run(
      `INSERT INTO artifacts (id, run_id, step_id, kind, media_type, bytes, sha256, created_at, summary)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        id,
        options.runId,
        options.stepId,
        options.tool,
        options.mediaType,
        bytes.byteLength,
        digest,
        this.clock.now(),
        options.summary,
      ],
    );

    this.events.append({
      type: 'artifact.created',
      payload: {
        artifactId: id,
        kind: options.tool,
        bytes: bytes.byteLength,
        summary: options.summary,
      },
      principal: options.principal,
      trust: 'SYSTEM',
      runId: options.runId,
      stepId: options.stepId,
    });

    return { id, mediaType: options.mediaType, bytes: bytes.byteLength, summary: options.summary };
  }

  async read(id: string): Promise<Uint8Array | undefined> {
    return this.files.get(`artifacts/${id}`);
  }

  meta(id: string): { id: string; bytes: number; summary: string } | undefined {
    return this.storage.get('SELECT id, bytes, summary FROM artifacts WHERE id = ?', [id]);
  }
}
