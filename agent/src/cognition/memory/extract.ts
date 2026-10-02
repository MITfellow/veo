/**
 * Extraction (§22.5 step 1) — turning what was said into candidate facts.
 *
 * §22.5 says "extract candidates with a strict structured schema". With a
 * model, that is a structured-output call. Without one — the offline build,
 * and every test in this suite — there has to be something, or memory only
 * works for people who have an API key, and the test suite can only test
 * memory by mocking the interesting part.
 *
 * So extraction is a **port** with two implementations:
 *
 *   PatternExtractor  deterministic, offline, used by the tests and the
 *                     offline build. Narrow and dumb by design.
 *   ModelExtractor    structured output through a ModelProvider, validated
 *                     with the same schema before anything downstream sees it.
 *
 * The important consequence: the *gate*, the *reconciler* and the *retriever*
 * are all testable without a model, and those are where the failure modes
 * live. A model that extracts badly produces a bad candidate; a gate that
 * leaks produces a compromised agent.
 */
import { z } from 'zod';
import type { ModelProvider } from '../../substrate/ports.js';
import { CandidateSchema, type Candidate } from './types.js';

export interface ExtractInput {
  /** What the user said this turn. */
  text: string;
  /** The event the text came from, for the required source span. */
  eventId: string;
  /** What the agent replied, when the reply is what carries the fact. */
  reply?: string;
}

export interface Extractor {
  id: string;
  extract(input: ExtractInput): Promise<Candidate[]>;
}

/* ─────────────────────────── the offline extractor ────────────────────────── */

interface Pattern {
  re: RegExp;
  predicate: string;
  stability: Candidate['stability'];
  sensitivity?: Candidate['sensitivity'];
  confidence: number;
  /** Which capture group holds the value. */
  group?: number;
}

/**
 * Patterns for the handful of things people state outright about themselves.
 *
 * This list is deliberately short. A long list of regexes would extract more
 * and be wrong more often, and a wrong fact costs far more than a missing
 * one: the missing fact makes the agent ask, the wrong one makes it confident.
 */
const PATTERNS: Pattern[] = [
  { re: /\bi (?:work|'m working) (?:at|for) ([A-Z][\w&. -]{1,40})/i, predicate: 'works_at', stability: 'slow', confidence: 0.7 },
  { re: /\bmy (?:job|role|title) is (?:an? )?([\w -]{2,40})/i, predicate: 'job_title', stability: 'slow', confidence: 0.7 },
  { re: /\bi live in ([A-Z][\w .'-]{1,40})/i, predicate: 'lives_in', stability: 'slow', confidence: 0.7 },
  { re: /\bi'?m (?:based|located) in ([A-Z][\w .'-]{1,40})/i, predicate: 'lives_in', stability: 'slow', confidence: 0.65 },
  // Names stop at a conjunction or punctuation. `[\w .'-]{1,40}` would
  // happily swallow "Ara and I work at Anthropic" out of a perfectly
  // ordinary sentence and store the whole clause as someone's name.
  { re: /\b[Mm]y name is ([A-Z][\w'-]*(?: [A-Z][\w'-]*){0,2})\b/, predicate: 'name', stability: 'stable', confidence: 0.85 },
  { re: /\bcall me ([A-Z][\w .'-]{1,30})/i, predicate: 'preferred_name', stability: 'stable', confidence: 0.75 },
  { re: /\bi(?:'m| am) allergic to ([\w, -]{2,40})/i, predicate: 'allergic_to', stability: 'stable', sensitivity: 'private', confidence: 0.8 },
  { re: /\bi (?:prefer|like|love) ([\w ,'-]{2,60})/i, predicate: 'prefers', stability: 'slow', confidence: 0.55 },
  { re: /\bi (?:hate|dislike|can'?t stand) ([\w ,'-]{2,60})/i, predicate: 'dislikes', stability: 'slow', confidence: 0.55 },
  { re: /\bi(?:'m| am) (?:a |an )?(vegetarian|vegan|pescatarian)\b/i, predicate: 'diet', stability: 'slow', confidence: 0.75 },
  { re: /\bmy (?:timezone|time zone) is ([\w/+-]{2,30})/i, predicate: 'timezone', stability: 'slow', confidence: 0.8 },
  { re: /\bmy (?:birthday|dob) is ([\w ,/-]{3,30})/i, predicate: 'birthday', stability: 'stable', sensitivity: 'private', confidence: 0.8 },
  { re: /\bi(?:'m| am) (?:tired|exhausted|sick|busy|stressed)\b/i, predicate: 'feels', stability: 'volatile', confidence: 0.6 },
  // Deliberately present so the gate has something to refuse: a sentence
  // that *looks* like an assertion about a protected attribute. The
  // extractor's job is to notice it, not to decide what happens to it.
  { re: /\bi(?:'m| am) (\w+) by (?:faith|religion)\b/i, predicate: 'religion', stability: 'stable', sensitivity: 'private', confidence: 0.6 },
];

const PREFERENCE_RULES: Array<{ re: RegExp; instruction: string }> = [
  { re: /\b(?:always|please) (?:use )?(bullet points|bullets)\b/i, instruction: 'Answer in bullet points.' },
  { re: /\bno preamble\b/i, instruction: 'Skip the preamble; lead with the answer.' },
  { re: /\b(?:be|keep it) (brief|concise|short)\b/i, instruction: 'Keep answers short.' },
  { re: /\bdon'?t (?:send|email|message) .* without (?:asking|checking)\b/i, instruction: 'Confirm before sending anything on the user’s behalf.' },
  { re: /\bno (?:calls|meetings) before (\d{1,2})\s?(?:am|:00)?\b/i, instruction: 'No calls or meetings early in the morning.' },
  // "always" / "never" / "from now on" is the clearest signal a person
  // gives that they are stating a standing rule rather than making a
  // one-off request. The distinction is the whole difference between a
  // preference and an instruction, and it is worth matching explicitly.
  { re: /\b(?:always|from now on,?(?: always)?)\s+use metric\b/i, instruction: 'Use metric units.' },
  { re: /\b(?:always|from now on,?(?: always)?)\s+(?:reply|answer|write) in [A-Z][a-z]+\b/, instruction: 'Reply in the language the user asked for.' },
  { re: /\bnever (?:use|write) emoji/i, instruction: 'Never use emoji.' },
];

export class PatternExtractor implements Extractor {
  readonly id = 'pattern';

  async extract(input: ExtractInput): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const sentences = input.text.split(/(?<=[.!?])\s+|\n+/);

    for (const sentence of sentences) {
      for (const pattern of PATTERNS) {
        const match = pattern.re.exec(sentence);
        if (match === null) continue;
        const value = cleanValue(match[pattern.group ?? 1] ?? match[0]);
        if (value === '') continue;

        const start = input.text.indexOf(sentence);
        out.push(
          CandidateSchema.parse({
            subject: { id: 'self', kind: 'self', label: 'you' },
            predicate: pattern.predicate,
            object: value,
            // The user said it about themselves: that is an assertion, not an
            // inference, and the distinction is what the gate keys on.
            basis: 'asserted_by_user',
            confidence: pattern.confidence,
            sources: [
              {
                eventId: input.eventId,
                span: [Math.max(0, start), Math.max(0, start) + sentence.length],
                quote: sentence.trim().slice(0, 200),
              },
            ],
            stability: pattern.stability,
            sensitivity: pattern.sensitivity ?? 'normal',
            transient: pattern.stability === 'volatile',
            utterance: sentence.trim(),
          }),
        );
      }
    }
    return out;
  }
}

/** Candidate rules (§22.3) from the same text. Separate because a rule is
 *  about how to behave, not about what is true. */
/**
 * Trim the trailing words a greedy capture drags along.
 *
 * "I work at Globex now" must store "Globex", not "Globex now" — otherwise
 * the next mention of Globex looks like a different employer and the
 * reconciler supersedes a fact with itself.
 */
function cleanValue(raw: string): string {
  return raw
    .trim()
    .replace(/[.,;:!?]+$/, '')
    .replace(/\s+(?:now|currently|these days|at the moment|again|too|as well)$/i, '')
    // A new clause is a new statement: "allergic to peanuts and I work at X"
    // is two facts, and the first one ends at the "and".
    .replace(/\s+(?:and|but|so|because|although)\s+i\s+.*$/i, '')
    .trim();
}

export function extractRules(text: string, eventId: string): Array<{
  instruction: string;
  trigger: { kind: 'always'; value: string };
  sources: Array<{ eventId: string; quote: string }>;
  confidence: number;
}> {
  const out = [];
  for (const rule of PREFERENCE_RULES) {
    const match = rule.re.exec(text);
    if (match === null) continue;
    out.push({
      instruction: rule.instruction,
      trigger: { kind: 'always' as const, value: '' },
      sources: [{ eventId, quote: match[0].slice(0, 200) }],
      confidence: 0.5,
    });
  }
  return out;
}

/* ──────────────────────────── the model extractor ─────────────────────────── */

const ModelCandidate = z.object({
  predicate: z.string().min(1).max(64),
  object: z.union([z.string(), z.number(), z.boolean()]),
  about: z.enum(['user', 'other']).default('user'),
  subjectLabel: z.string().default('you'),
  basis: z.enum(['observed', 'inferred', 'asserted_by_user', 'imported']),
  confidence: z.number().min(0).max(1),
  quote: z.string().min(1),
  transient: z.boolean().default(false),
  stability: z.enum(['volatile', 'slow', 'stable']).default('slow'),
  sensitivity: z.enum(['normal', 'private', 'secret']).default('normal'),
});
const ModelCandidates = z.object({ facts: z.array(ModelCandidate).max(12) });

const EXTRACT_PROMPT = `You extract durable facts about the user from a conversation turn.

Rules you must follow:
- Only facts that will still be true next month. No moods, no "today".
- Every fact needs a verbatim quote from the text it came from.
- If the user was speculating, quoting someone, or role-playing, extract nothing.
- Never infer race, religion, health, sexuality, politics or immigration status.
  If the user states one outright, use basis "asserted_by_user".
- Prefer no facts over a doubtful fact.

Reply with JSON: {"facts":[{"predicate","object","about","subjectLabel","basis","confidence","quote","transient","stability","sensitivity"}]}`;

export class ModelExtractor implements Extractor {
  readonly id = 'model';

  constructor(private readonly model: ModelProvider) {}

  async extract(input: ExtractInput): Promise<Candidate[]> {
    const request = {
      model: this.model.id,
      messages: [
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: input.text },
      ],
      temperature: 0,
      responseFormat: 'json' as const,
    };

    let text = '';
    try {
      for await (const chunk of this.model.generate(request, new AbortController().signal)) {
        const c = chunk as { type?: string; text?: string };
        if (c.type === 'text-delta' && typeof c.text === 'string') text += c.text;
        // An error chunk ends extraction quietly. Memory is best-effort and
        // off the critical path; a provider outage must not fail a run that
        // already succeeded.
        if (c.type === 'error') return [];
      }
    } catch {
      return [];
    }

    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    let parsed: z.infer<typeof ModelCandidates>;
    try {
      parsed = ModelCandidates.parse(JSON.parse(json));
    } catch {
      // A model that cannot follow the schema does not get to write to
      // memory. Silently dropping is right here: the alternative is
      // half-parsed beliefs.
      return [];
    }

    return parsed.facts.map((fact) => {
      const at = input.text.indexOf(fact.quote);
      return CandidateSchema.parse({
        subject:
          fact.about === 'user'
            ? { id: 'self', kind: 'self', label: 'you' }
            : { id: `name:${fact.subjectLabel.toLowerCase()}`, kind: 'person', label: fact.subjectLabel },
        predicate: fact.predicate,
        object: fact.object,
        basis: fact.basis,
        confidence: fact.confidence,
        // No quote found in the source text means the model invented it, and
        // an invented source is worse than no source: it looks auditable.
        sources:
          at >= 0
            ? [{ eventId: input.eventId, span: [at, at + fact.quote.length], quote: fact.quote }]
            : [],
        stability: fact.stability,
        sensitivity: fact.sensitivity,
        transient: fact.transient,
        utterance: at >= 0 ? fact.quote : input.text.slice(0, 200),
      });
    });
  }
}
