import { z } from 'zod';
import type { TrustLevel } from '../../substrate/events/types.js';
import { meetTrust } from '../../substrate/events/types.js';
import type { MemoryStore, Stability } from '../../capability/memory/store.js';
import type { EntityRegistry } from '../../capability/memory/entities.js';
import type { Quarantine } from '../../security/quarantine.js';
import { runJob, type RunOptions } from '../registry.js';

/**
 * Ingestion: from something that was said to something that is remembered.
 *
 * The order of the four steps is the whole design, and none of them may be
 * reordered for convenience:
 *
 *   1. capture   — the raw text, kept as-is
 *   2. extract   — `memory.extract`, a cognitive job, so a model can take
 *                  it over later without this file changing
 *   3. resolve   — `entity.resolve` turns a mention into an id, or refuses
 *   4. assert    — the fact lands, at a trust that is the *meet* of the
 *                  source's trust and the job's ceiling
 *
 * This lives in `cognition/` rather than `capability/` for one reason: it
 * calls jobs, and `capability` may not import `cognition`. The dependency
 * rule chose the location, which is what a dependency rule is for.
 */

export type IngestSource = 'user_message' | 'note' | 'web_page' | 'document' | 'tool_output';

/**
 * The trust a source may claim, before anything else is applied.
 *
 * A web page is FOREIGN no matter how authoritative it sounds. This table
 * is the only place that judgement is made, so there is one thing to audit
 * rather than a scattering of string comparisons.
 */
const SOURCE_TRUST: Record<IngestSource, TrustLevel> = {
  user_message: 'USER',
  note: 'USER',
  web_page: 'FOREIGN',
  document: 'FOREIGN',
  tool_output: 'TOOL',
};

export interface IngestRequest {
  text: string;
  source: IngestSource;
  /** Who the facts are about when the extractor says "I". */
  speaker?: string | undefined;
  sessionId?: string | undefined;
  runId?: string | undefined;
  /** Below this, a candidate fact is reported but not stored. */
  minConfidence?: number | undefined;
}

export interface IngestedFact {
  factId: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  entityId: string | null;
  trust: TrustLevel;
}

export interface SkippedFact {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  why: 'below_confidence' | 'duplicate' | 'quarantined';
}

export interface IngestResult {
  stored: IngestedFact[];
  skipped: SkippedFact[];
  /** Which strategy ran the extraction. Reported, never implied. */
  strategy: string;
  reason: string;
}

const ExtractOut = z.object({
  facts: z.array(
    z.object({
      subject: z.string(),
      predicate: z.string(),
      object: z.string(),
      confidence: z.number(),
      stability: z.enum(['volatile', 'slow', 'stable']),
      basis: z.string(),
    }),
  ),
});

export interface IngestDeps {
  memory: MemoryStore;
  entities: EntityRegistry;
  now: () => number;
  options: RunOptions;
  /**
   * Required for FOREIGN sources, optional for the rest.
   *
   * Without it, FOREIGN text is refused rather than quietly ingested on
   * the privileged path — a missing dependency must not downgrade into a
   * missing defence.
   */
  quarantine?: Quarantine | undefined;
}

/**
 * FOREIGN content gets a lower confidence floor than it claims.
 *
 * A page that says "the user's bank is X" with total syntactic confidence
 * is still a page. Scaling rather than refusing keeps the information —
 * which may well be useful — while making sure it never outranks something
 * the user said themselves.
 */
const FOREIGN_CONFIDENCE_SCALE = 0.5;

export async function ingest(request: IngestRequest, deps: IngestDeps): Promise<IngestResult> {
  const sourceTrust = SOURCE_TRUST[request.source];
  const speaker = request.speaker ?? 'user';
  const floor = request.minConfidence ?? 0.5;

  const extraction = await extract(request, speaker, sourceTrust, deps);

  const stored: IngestedFact[] = [];
  const skipped: SkippedFact[] = [];

  for (const candidate of extraction.output.facts) {
    const confidence = sourceTrust === 'FOREIGN'
      ? Number((candidate.confidence * FOREIGN_CONFIDENCE_SCALE).toFixed(2))
      : candidate.confidence;
    // The floor is checked against the *extractor's* confidence, not the
    // trust-scaled one. They answer different questions: "is this really
    // what the sentence said" versus "how much do we credit the source".
    // Conflating them made every web-page fact fall below the floor and
    // turned FOREIGN ingestion into dead code — which the demo found and
    // no test did, because the tests asserted trust rather than arrival.
    const why = reject(candidate, candidate.confidence, floor, deps);
    if (why !== null) {
      skipped.push({ ...pick(candidate), confidence, why });
      continue;
    }
    stored.push(await store(candidate, confidence, sourceTrust, request, deps));
  }

  return { stored, skipped, strategy: extraction.strategy, reason: extraction.reason };
}

type Candidate = z.infer<typeof ExtractOut>['facts'][number];

/** Why this candidate is not worth storing, or null if it is. */
function reject(
  candidate: Candidate,
  confidence: number,
  floor: number,
  deps: IngestDeps,
): SkippedFact['why'] | null {
  if (confidence < floor) return 'below_confidence';
  if (alreadyKnown(deps, candidate.subject, candidate.predicate, candidate.object)) return 'duplicate';
  return null;
}

/**
 * Resolve the subject and write the fact.
 *
 * The job's output ceiling is DERIVED (§20): an extraction is inference,
 * not testimony. Meeting it with the source's trust means a fact pulled
 * out of a web page can never arrive as anything better than FOREIGN, and
 * one pulled out of what the user typed arrives as DERIVED — true of the
 * extractor, not of the user.
 */
async function store(
  candidate: Candidate,
  confidence: number,
  sourceTrust: TrustLevel,
  request: IngestRequest,
  deps: IngestDeps,
): Promise<IngestedFact> {
  const entityId = await resolveSubject(candidate.subject, deps, request.runId);
  const trust = meetTrust(sourceTrust, 'DERIVED');
  const subject = entityId ?? candidate.subject;

  const factId = deps.memory.assert({
    subject,
    predicate: candidate.predicate,
    object: candidate.object,
    basis: candidate.basis,
    confidence,
    stability: candidate.stability as Stability,
    sourceTrust: trust,
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    ...(request.runId === undefined ? {} : { runId: request.runId }),
  });

  return { factId, subject, predicate: candidate.predicate, object: candidate.object, confidence, entityId, trust };
}

const pick = (f: { subject: string; predicate: string; object: string }) => ({
  subject: f.subject,
  predicate: f.predicate,
  object: f.object,
});

/**
 * Re-asserting something already believed is noise, not news.
 *
 * Compared case-insensitively on the object, because "Berlin" and "berlin"
 * are the same answer and storing both would manufacture a conflict out of
 * nothing.
 */
function alreadyKnown(deps: IngestDeps, subject: string, predicate: string, object: string): boolean {
  const target = object.trim().toLowerCase();
  return deps.memory
    .asOf({ subject, predicate, maxSensitivity: 'secret' })
    .some((f) => f.object.trim().toLowerCase() === target);
}

/**
 * Turn a mention into an entity id, or leave it alone.
 *
 * Note what this does *not* do: it never creates an entity to make a match
 * succeed. An unresolved mention is stored as plain text, which is
 * recoverable later; a wrongly created duplicate entity quietly splits a
 * person's history in two and nobody notices for months.
 */
async function resolveSubject(
  mention: string,
  deps: IngestDeps,
  runId: string | undefined,
): Promise<string | null> {
  if (mention === 'user' || mention.startsWith('ent_') || mention === '') return null;
  const candidates = deps.entities.candidates(mention);
  if (candidates.length === 0) return null;

  const resolved = await runJob<{ entityId: string | null; confidence: number; reason: string }>(
    'entity.resolve',
    { mention, candidates },
    { inputTrust: 'DERIVED', now: deps.now(), ...(runId === undefined ? {} : { runId }) },
    deps.options,
  );
  return resolved.output.entityId === null ? null : deps.entities.canonicalOf(resolved.output.entityId);
}

/**
 * Run the extraction, through the quarantine when the bytes are FOREIGN.
 *
 * §21: FOREIGN content is read inside the channel and only a typed,
 * schema-validated, passthrough-checked object comes back. Trusted text
 * the user typed does not need the channel — it is already on the
 * privileged path by definition — and routing it through anyway would
 * make every message a quarantine row for no gain.
 */
async function extract(
  request: IngestRequest,
  speaker: string,
  sourceTrust: TrustLevel,
  deps: IngestDeps,
): Promise<{ output: z.infer<typeof ExtractOut>; strategy: string; reason: string }> {
  const ctx = {
    inputTrust: sourceTrust,
    now: deps.now(),
    ...(request.runId === undefined ? {} : { runId: request.runId }),
  };
  const run = (text: string) =>
    runJob<z.infer<typeof ExtractOut>>('memory.extract', { text, speaker }, ctx, deps.options);

  if (sourceTrust !== 'FOREIGN') return run(request.text);

  if (deps.quarantine === undefined) {
    throw new IngestError(
      `Refusing to ingest ${request.source} content without a quarantine. ` +
        'FOREIGN bytes may not reach the privileged path (§21).',
    );
  }

  let strategy = 'baseline';
  let reason = 'no model configured — running at L1';
  const admission = await deps.quarantine.admitAsync(
    { content: request.text, source: request.source, kind: 'memory.extract' },
    ExtractOut,
    async (content) => {
      const result = await run(content);
      strategy = result.strategy;
      reason = result.reason;
      return { ok: true, value: result.output };
    },
  );
  return { output: admission.extraction, strategy, reason };
}

export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestError';
  }
}
