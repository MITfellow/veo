import { z } from 'zod';
import type { Clock, Ids, Storage } from '../substrate/ports.js';
import type { TrustLevel } from '../substrate/events/types.js';

/**
 * The quarantine channel (§21), dual-path, model-ready.
 *
 *   PRIVILEGED PATH  planner · tools · vault · effects — never sees FOREIGN bytes
 *          │ symbolic ref ($VAR_7)        ▲ typed extraction (schema-validated)
 *          ▼                              │
 *   QUARANTINE       reads FOREIGN bytes · no tools · no vault · no effects
 *
 * Three properties make this structural rather than decorative:
 *
 * **The reference carries no content.** A `SymbolicRef` is an id, a kind and
 * a field *shape*. There is no `.value`, no `.text`, no lazy getter. The
 * bytes live in a side table that the privileged path has no handle to.
 *
 * **There is no `deref()` on the ref.** Dereferencing is a method on the
 * quarantine and it demands a FOREIGN-trust context. If the ref owned its own
 * dereference, it would be a pointer, and the whole construction would reduce
 * to "please don't read this".
 *
 * **The extraction is schema-validated.** What crosses back into the
 * privileged path is a typed object the caller declared in advance — not a
 * string the model was asked nicely to summarise. A parse failure is an
 * error, never a guess.
 *
 * The extractor itself is a Cognitive Job with a deterministic baseline
 * (`quarantine.extract`, M4). This file builds the channel and takes the
 * extractor as a parameter, so M4 plugs a job in without touching the
 * security boundary.
 */

/** Opaque by construction: no bytes, no accessor, no escape hatch. */
export interface SymbolicRef {
  readonly id: string;
  readonly kind: string;
  /** Field names present in the extraction. Names only — never values. */
  readonly fields: readonly string[];
  readonly bytes: number;
  readonly source: string;
}

export interface QuarantineEvents {
  entered(refId: string, source: string, bytes: number, at: number): void;
  extracted(refId: string, kind: string, fields: readonly string[], at: number): void;
  released(refId: string, to: string, at: number): void;
}

export type ExtractionResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A schema-constrained extractor over FOREIGN bytes.
 *
 * Runs *inside* the quarantine: it gets the content and nothing else — no
 * tools, no vault, no storage, no clock. The signature is the sandbox.
 */
export type Extractor<T> = (content: string) => ExtractionResult<T>;

/**
 * The longest verbatim span of source content an extraction may carry.
 *
 * A typed extraction legitimately contains short scalars lifted from the
 * text — a date, a handle, an amount, an entity name like "Priya Sharma".
 * Those are *extractions*. A forty-character span is not an extraction; it
 * is **passthrough**, and passthrough is how FOREIGN bytes end up in a
 * privileged context no matter how carefully the schema is written.
 *
 * Thirty-two characters is the line: long enough for any realistic named
 * entity or identifier, too short to carry an instruction. See decision 007.
 */
export const MAX_VERBATIM_SPAN = 32;

/**
 * Refuse an extraction that is really a copy.
 *
 * This is §21.5 enforced at the boundary rather than asserted in a test.
 * The test proves the rule holds; this makes it hold for every future
 * extractor, including ones written by someone who has not read §21.
 */
function assertNoPassthrough(value: unknown, content: string, path = 'extraction'): void {
  if (typeof value === 'string') {
    if (value.length > MAX_VERBATIM_SPAN && content.includes(value)) {
      throw new QuarantineError(
        'extraction_failed',
        `Field '${path}' carries ${value.length} verbatim characters of FOREIGN content. ` +
          `Extractions may contain bounded scalars, not spans (max ${MAX_VERBATIM_SPAN}). ` +
          'Passing raw bytes through a typed field defeats the quarantine (§21.5).',
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoPassthrough(item, content, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertNoPassthrough(item, content, `${path}.${key}`);
    }
  }
}

export class QuarantineError extends Error {
  constructor(readonly kind: 'extraction_failed' | 'not_found' | 'forbidden', message: string) {
    super(message);
    this.name = 'QuarantineError';
  }
}

export interface QuarantineOptions {
  storage: Storage;
  clock: Clock;
  ids: Ids;
  events: QuarantineEvents;
}

export interface Admission<T> {
  ref: SymbolicRef;
  /** The typed, schema-validated extraction. Safe for the privileged path. */
  extraction: T;
}

export class Quarantine {
  constructor(private readonly options: QuarantineOptions) {}

  /**
   * Admit FOREIGN bytes.
   *
   * The content is written to the side table and **never returned**. What the
   * caller gets back is a reference plus whatever the extractor could prove
   * about the content against a schema.
   */
  admit<T>(input: { content: string; source: string; kind: string }, schema: z.ZodType<T>, extract: Extractor<T>): Admission<T> {
    const held = this.hold(input);
    return this.release(held, input, schema, extract(input.content));
  }

  /**
   * The same channel, for an extractor that has to await something.
   *
   * A Cognitive Job is async because one day a model will serve it, and a
   * model extracting from FOREIGN bytes is precisely the case the
   * quarantine exists for. Forcing the sync signature would have pushed
   * that call outside the channel, which is how a boundary quietly stops
   * being one. The ordering is identical: content is held *before* the
   * extractor runs, so a crash mid-extraction still leaves the bytes
   * accounted for.
   */
  async admitAsync<T>(
    input: { content: string; source: string; kind: string },
    schema: z.ZodType<T>,
    extract: (content: string) => Promise<ExtractionResult<T>>,
  ): Promise<Admission<T>> {
    const held = this.hold(input);
    return this.release(held, input, schema, await extract(input.content));
  }

  /** Write the bytes to the side table. They are never returned from here. */
  private hold(input: { content: string; source: string; kind: string }): { refId: string; bytes: number; at: number } {
    const at = this.options.clock.now();
    const refId = `$VAR_${this.options.ids.ulid()}`;
    const bytes = Buffer.byteLength(input.content, 'utf8');
    this.options.storage.prepare(
      'INSERT INTO quarantined_content (ref_id, source, kind, content, created_at) VALUES (?,?,?,?,?)',
    ).run(refId, input.source, input.kind, input.content, at);
    this.options.events.entered(refId, input.source, bytes, at);
    return { refId, bytes, at };
  }

  /** Validate what the extractor produced and let only that cross back. */
  private release<T>(
    held: { refId: string; bytes: number; at: number },
    input: { content: string; source: string; kind: string },
    schema: z.ZodType<T>,
    raw: ExtractionResult<T>,
  ): Admission<T> {
    if (!raw.ok) {
      throw new QuarantineError('extraction_failed', `Quarantine extraction failed: ${raw.error}`);
    }
    // Validate even though the extractor is typed: the extractor may later be
    // a model strategy, and the schema is the only thing standing between a
    // plausible-looking object and the privileged path.
    const parsed = schema.safeParse(raw.value);
    if (!parsed.success) {
      throw new QuarantineError('extraction_failed', `Extraction did not match its schema: ${parsed.error.message}`);
    }

    // The schema says the shape is right. This says the content did not
    // simply walk through it.
    assertNoPassthrough(parsed.data, input.content);

    const fields = fieldNames(parsed.data);
    const ref: SymbolicRef = { id: held.refId, kind: input.kind, fields, bytes: held.bytes, source: input.source };
    this.options.events.extracted(held.refId, input.kind, fields, held.at);
    return { ref, extraction: parsed.data };
  }

  /**
   * Dereference — the only way back to raw bytes.
   *
   * §21.3: permitted at a rendering boundary the user sees, or inside a tool
   * declaring `minTrust: FOREIGN`. Both present themselves here as a context
   * whose trust is FOREIGN. A privileged caller asking for the bytes is a bug
   * in that caller, and it fails loudly rather than quietly obliging.
   */
  dereference(ref: SymbolicRef, ctx: { trust: TrustLevel; to: string }): string {
    if (ctx.trust !== 'FOREIGN') {
      throw new QuarantineError(
        'forbidden',
        `Refusing to dereference ${ref.id} into a ${ctx.trust} context. ` +
          'Raw FOREIGN bytes may only be read at a user-visible rendering boundary ' +
          'or inside a tool declaring minTrust: FOREIGN (§21.3).',
      );
    }
    const row = this.options.storage
      .prepare('SELECT content FROM quarantined_content WHERE ref_id = ?')
      .get<{ content: string }>(ref.id);
    if (!row) throw new QuarantineError('not_found', `No quarantined content for ${ref.id}.`);
    this.options.events.released(ref.id, ctx.to, this.options.clock.now());
    return row.content;
  }

  /** For the architectural test: what the privileged path could possibly hold. */
  describe(ref: SymbolicRef): string {
    return `[${ref.kind} from ${ref.source}, ${ref.bytes} bytes, fields: ${ref.fields.join(', ') || 'none'}]`;
  }
}

function fieldNames(value: unknown): string[] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>).sort();
  }
  return [];
}
