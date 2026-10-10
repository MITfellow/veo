import { z } from 'zod';
import type { CognitiveJob, ModelRequest, ParseResult } from '../types.js';
import { contentTokens, estimateTokens, rankSentences, similarity, truncateWords } from '../text.js';
import { readableText } from '../../capability/browser/view.js';

/**
 * The attention jobs: what a page says, what a sentence asks for, and what
 * deserves a person's time.
 *
 * These three are named in §16.1 of the full specification and were the
 * gap between the eleven jobs that existed and the fifteen it calls for.
 * They share a theme — each one is a *judgement* that a model would make
 * fluently and a baseline must make conservatively.
 *
 * Conservative here has a precise meaning: when the baseline cannot tell,
 * it says so in the output rather than picking the likeliest answer. A
 * confident wrong intent sends the agent off to do the wrong thing; an
 * admitted `unknown` intent asks the user. The second failure is cheap.
 */

const JSON_RULES =
  'Reply with JSON only, matching the named schema exactly. No prose, no code fence, no explanation.';

function request(
  job: ModelRequest['job'],
  system: string,
  user: string,
  schema: string,
  maxOutputTokens = 1024,
): ModelRequest {
  return { job, system: `${system}\n\n${JSON_RULES}`, user, maxOutputTokens, temperature: 0, responseSchemaName: schema };
}

function parseJson<T>(raw: string, schema: z.ZodType<T>): ParseResult<T> {
  let data: unknown;
  try {
    data = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return { ok: false, error: 'Response was not valid JSON.' };
  }
  const parsed = schema.safeParse(data);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
}

// ─────────────────────────────────────────────────────────── page.extract

const PageIn = z.object({
  html: z.string(),
  url: z.string().default(''),
  maxChars: z.number().int().min(100).max(20_000).default(4000),
}).strict();

const PageOut = z.object({
  title: z.string(),
  text: z.string(),
  /** Sentences the baseline judged load-bearing, in document order. */
  keyPoints: z.array(z.string()),
  truncated: z.boolean(),
}).strict();

function pageTitle(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const raw = (title ?? heading ?? '').replace(/<[^>]+>/g, ' ');
  return truncateWords(raw.replace(/\s+/g, ' ').trim(), 200);
}

/**
 * Pull the readable content out of a page.
 *
 * **Output trust is FOREIGN, and this is the second job ever to be so.**
 * Extraction does not launder a web page. Whatever a page says after this
 * job has run, it is still something a stranger wrote, and the only
 * difference is that it is shorter. A DERIVED output here would let page
 * text reach a planner as though the agent had reasoned it out.
 */
export const pageExtractJob: CognitiveJob<z.infer<typeof PageIn>, z.infer<typeof PageOut>> = {
  name: 'page.extract',
  summary: 'Reduce a web page to its readable content and key points.',
  input: PageIn,
  output: PageOut,
  outputTrust: 'FOREIGN',
  baselineQuality:
    'Strips markup, drops script, style and navigation, then keeps the highest-scoring sentences in document order. It cannot tell an article from a cookie banner that happens to be wordy, and it never rewrites a sentence.',
  baseline: ({ html, maxChars }) => {
    const text = readableText(html);
    const clipped = truncateWords(text, maxChars);
    const ranked = rankSentences(clipped)
      .filter((s) => contentTokens(s.sentence).length >= 4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .sort((a, b) => a.index - b.index)
      .map((s) => s.sentence);
    return { title: pageTitle(html), text: clipped, keyPoints: ranked, truncated: text.length > maxChars };
  },
  model: {
    buildRequest: ({ html, url, maxChars }) =>
      request(
        'page.extract',
        'You are reading a web page on behalf of someone. Return its title, its readable content, and the points that carry the page. Quote the page; never add a fact it does not state.',
        `URL: ${url || '(not given)'}\nBudget: ${maxChars} characters\n\n${truncateWords(readableText(html), 12_000)}`,
        'PageOut',
        2048,
      ),
    parseResponse: (raw) => parseJson(raw, PageOut),
  },
};

// ─────────────────────────────────────────────────────────── intent.parse

const INTENTS = ['question', 'command', 'schedule', 'recall', 'capture', 'chitchat', 'unknown'] as const;

const IntentIn = z.object({ text: z.string(), hint: z.string().default('') }).strict();
const IntentOut = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
  /** Verbatim spans only — the baseline never invents a slot value. */
  entities: z.array(z.object({ kind: z.string(), value: z.string() })),
}).strict();

/** Ordered: the first rule that matches wins, so overlaps are decided here. */
const INTENT_RULES: ReadonlyArray<{ intent: (typeof INTENTS)[number]; pattern: RegExp; confidence: number }> = [
  { intent: 'schedule', pattern: /\b(schedule|meeting|calendar|appointment|book|reschedule|tomorrow at|next week)\b/i, confidence: 0.7 },
  { intent: 'recall', pattern: /\b(what did|remind me what|when did|who was|do you remember|last time)\b/i, confidence: 0.7 },
  { intent: 'capture', pattern: /\b(remember that|note that|save this|make a note|for later)\b/i, confidence: 0.75 },
  { intent: 'command', pattern: /^(please\s+)?(send|write|draft|open|find|search|delete|add|create|run|cancel)\b/i, confidence: 0.65 },
  { intent: 'question', pattern: /\?\s*$|^(who|what|when|where|why|how|is|are|can|could|should|does|did)\b/i, confidence: 0.6 },
  { intent: 'chitchat', pattern: /^(hi|hey|hello|thanks|thank you|good (morning|evening|night))\b/i, confidence: 0.8 },
];

const ENTITY_RULES: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: 'email', pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { kind: 'url', pattern: /https?:\/\/\S+/g },
  { kind: 'time', pattern: /\b(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?[ap]m)?\b|\b\d{1,2}\s?[ap]m\b/gi },
  { kind: 'date', pattern: /\b\d{4}-\d{2}-\d{2}\b|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(?:today|tomorrow|yesterday)\b/gi },
];

function extractEntities(text: string): Array<{ kind: string; value: string }> {
  const found: Array<{ kind: string; value: string }> = [];
  for (const rule of ENTITY_RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const value = match[0];
      if (!found.some((e) => e.kind === rule.kind && e.value === value)) found.push({ kind: rule.kind, value });
    }
  }
  return found;
}

/**
 * Work out what a person is asking for.
 *
 * The baseline returns `unknown` with low confidence rather than guessing,
 * and the caller is expected to ask. §15's autonomy ladder reads this
 * confidence: an `unknown` intent cannot clear the floor for an effect, so
 * a misread sentence stalls instead of acting.
 */
export const intentParseJob: CognitiveJob<z.infer<typeof IntentIn>, z.infer<typeof IntentOut>> = {
  name: 'intent.parse',
  summary: 'Decide what the user is asking for, or admit that it is unclear.',
  input: IntentIn,
  output: IntentOut,
  outputTrust: 'DERIVED',
  baselineQuality:
    'Ordered keyword and shape rules over the sentence, with verbatim entity spans. It reads an imperative or a question reliably and misreads anything indirect — "it would be good to have that by Friday" is not a command to it.',
  baseline: ({ text }) => {
    const entities = extractEntities(text);
    const matched = INTENT_RULES.find((rule) => rule.pattern.test(text.trim()));
    if (matched === undefined) return { intent: 'unknown', confidence: 0.2, entities };
    // A long sentence matching one keyword is weaker evidence than a short
    // one that is nothing but the keyword.
    const brevity = contentTokens(text).length <= 12 ? 1 : 0.85;
    return { intent: matched.intent, confidence: Number((matched.confidence * brevity).toFixed(2)), entities };
  },
  model: {
    buildRequest: ({ text, hint }) =>
      request(
        'intent.parse',
        `Classify the request into exactly one of: ${INTENTS.join(', ')}. Use "unknown" when it is genuinely unclear — that is a correct answer, not a failure. Entity values must be copied verbatim from the text.`,
        `${hint === '' ? '' : `Context: ${hint}\n\n`}Request: ${truncateWords(text, 2000)}`,
        'IntentOut',
        512,
      ),
    parseResponse: (raw) => parseJson(raw, IntentOut),
  },
};

// ────────────────────────────────────────────────────────── priority.score

const PriorityIn = z.object({
  subject: z.string().default(''),
  body: z.string().default(''),
  /** Milliseconds until it is due. Negative means already overdue. */
  dueInMs: z.number().nullable().default(null),
  fromKnownContact: z.boolean().default(false),
  /** What the user has said matters, lowercased by the caller. */
  interests: z.array(z.string()).default([]),
}).strict();

const PriorityOut = z.object({
  score: z.number().min(0).max(1),
  band: z.enum(['now', 'today', 'this_week', 'whenever']),
  reasons: z.array(z.string()),
}).strict();

const URGENT = /\b(urgent|asap|immediately|deadline|today|eod|overdue|final notice)\b/i;

function dueWeight(dueInMs: number | null): { weight: number; reason: string | null } {
  if (dueInMs === null) return { weight: 0, reason: null };
  const hours = dueInMs / 3_600_000;
  if (hours < 0) return { weight: 0.4, reason: 'already overdue' };
  if (hours <= 24) return { weight: 0.3, reason: 'due within a day' };
  if (hours <= 168) return { weight: 0.15, reason: 'due this week' };
  return { weight: 0, reason: null };
}

function band(score: number): z.infer<typeof PriorityOut>['band'] {
  if (score >= 0.7) return 'now';
  if (score >= 0.45) return 'today';
  if (score >= 0.2) return 'this_week';
  return 'whenever';
}

/**
 * Rank one thing against a person's attention.
 *
 * Every contribution is named in `reasons`. A priority score a user cannot
 * interrogate is a number they will learn to ignore the first time it is
 * wrong, so the explanation is part of the output rather than a debug log.
 */
export const priorityScoreJob: CognitiveJob<z.infer<typeof PriorityIn>, z.infer<typeof PriorityOut>> = {
  name: 'priority.score',
  summary: 'Score how much something deserves attention, and say why.',
  input: PriorityIn,
  output: PriorityOut,
  outputTrust: 'DERIVED',
  baselineQuality:
    'A transparent weighted sum of deadline, sender familiarity, stated interests and urgency wording. It cannot tell real urgency from a marketer who writes "URGENT", so wording alone is capped well below a deadline.',
  baseline: ({ subject, body, dueInMs, fromKnownContact, interests }) => {
    const text = `${subject}\n${body}`;
    const reasons: string[] = [];
    let score = 0.1;

    const due = dueWeight(dueInMs);
    score += due.weight;
    if (due.reason !== null) reasons.push(due.reason);

    if (fromKnownContact) { score += 0.2; reasons.push('from someone you know'); }

    const matched = interests.filter((i) => i.length > 0 && similarity(text, i) > 0 ).slice(0, 3);
    if (matched.length > 0) { score += 0.15; reasons.push(`mentions ${matched.join(', ')}`); }

    // Deliberately the smallest weight in the table: anyone can type "ASAP".
    if (URGENT.test(text)) { score += 0.1; reasons.push('uses urgent wording'); }

    const bounded = Math.min(1, Number(score.toFixed(2)));
    if (reasons.length === 0) reasons.push('nothing about it stands out');
    return { score: bounded, band: band(bounded), reasons };
  },
  model: {
    buildRequest: ({ subject, body, dueInMs, fromKnownContact, interests }) =>
      request(
        'priority.score',
        'Score how much this deserves the person\'s attention, from 0 to 1, and list the reasons plainly. Urgent wording from a stranger is not urgency.',
        [
          `Subject: ${subject}`,
          `Known contact: ${fromKnownContact ? 'yes' : 'no'}`,
          `Due in: ${dueInMs === null ? 'no deadline' : `${Math.round(dueInMs / 3_600_000)}h`}`,
          `Their stated interests: ${interests.join(', ') || '(none recorded)'}`,
          '',
          truncateWords(body, 2000),
        ].join('\n'),
        'PriorityOut',
        400,
      ),
    parseResponse: (raw) => parseJson(raw, PriorityOut),
  },
};

// ────────────────────────────────────────────────────── thread.summarize

const ThreadIn = z.object({
  messages: z.array(z.object({
    speaker: z.string(),
    text: z.string(),
    at: z.number().int().default(0),
  })).min(1),
  maxChars: z.number().int().min(80).max(4000).default(600),
}).strict();

const ThreadOut = z.object({
  summary: z.string(),
  participants: z.array(z.string()),
  /** Anything that looked like a commitment someone made. */
  openQuestions: z.array(z.string()),
}).strict();

const ASKED = /\?\s*$/;

/**
 * Summarise a conversation, not a passage.
 *
 * Separate from `text.summarize` because a thread has a property a passage
 * does not: **the last word is disproportionately the point.** Ranking a
 * conversation by term frequency alone surfaces whatever was discussed
 * longest, which is usually the part that got resolved and dropped.
 */
export const threadSummarizeJob: CognitiveJob<z.infer<typeof ThreadIn>, z.infer<typeof ThreadOut>> = {
  name: 'thread.summarize',
  summary: 'Say what a conversation was about and what is still open.',
  input: ThreadIn,
  output: ThreadOut,
  outputTrust: 'DERIVED',
  baselineQuality:
    'Extractive, weighted towards the end of the thread, with unanswered questions listed verbatim. It attributes nothing it cannot see a speaker label for, and it cannot tell a rhetorical question from a real one.',
  baseline: ({ messages, maxChars }) => {
    const participants = [...new Set(messages.map((m) => m.speaker))];
    const ranked = messages.map((m, index) => {
      const base = rankSentences(m.text)[0]?.score ?? 0;
      // Recency prior: the tail of a thread is where it ended up.
      const recency = 0.6 + 0.4 * ((index + 1) / messages.length);
      return { index, speaker: m.speaker, text: m.text.trim(), score: base * recency };
    });
    const chosen: typeof ranked = [];
    let length = 0;
    for (const line of [...ranked].sort((a, b) => b.score - a.score)) {
      if (length + line.text.length > maxChars && chosen.length > 0) continue;
      chosen.push(line);
      length += line.text.length + line.speaker.length + 2;
    }
    const summary = chosen
      .sort((a, b) => a.index - b.index)
      .map((line) => `${line.speaker}: ${line.text}`)
      .join(' ');

    // A question is open when nobody said anything after it.
    const last = messages.length - 1;
    const openQuestions = messages
      .filter((m, index) => ASKED.test(m.text.trim()) && index >= last - 1)
      .map((m) => m.text.trim());

    return { summary: truncateWords(summary, maxChars), participants, openQuestions };
  },
  model: {
    buildRequest: ({ messages, maxChars }) =>
      request(
        'thread.summarize',
        'Summarise this conversation in under the given budget. Say what was decided and what is still open. Attribute nothing to a speaker who did not say it.',
        `Budget: ${maxChars} characters\n\n${truncateWords(messages.map((m) => `${m.speaker}: ${m.text}`).join('\n'), 8000)}`,
        'ThreadOut',
        800,
      ),
    parseResponse: (raw) => parseJson(raw, ThreadOut),
  },
};

export const attentionJobs = [pageExtractJob, intentParseJob, priorityScoreJob, threadSummarizeJob] as const;

/** Exported for the budget tests: these prompts must stay small. */
export const ATTENTION_PROMPT_CEILING = estimateTokens('x'.repeat(60_000));
