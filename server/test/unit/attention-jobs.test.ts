import { describe, expect, it } from 'vitest';
import { intentParseJob, pageExtractJob, priorityScoreJob, threadSummarizeJob } from '../../src/cognition/jobs/attention.js';
import type { JobContext } from '../../src/cognition/types.js';

/**
 * The four attention jobs added when §16.1 grew the list to fifteen.
 *
 * Each test asserts the baseline is *useful*, not merely present. A
 * baseline that returns an empty string without failing would pass a
 * schema check and fail a person.
 */

const ctx: JobContext = { inputTrust: 'USER', now: 1_700_000_000_000 };

const PAGE = `
<html><head><title>  The Tuesday Report  </title></head>
<body>
  <nav>Home About Contact</nav>
  <script>console.log('tracking')</script>
  <style>.a{color:red}</style>
  <article>
    <h1>Quarterly numbers</h1>
    <p>Revenue grew by eleven percent across the northern region this quarter.</p>
    <p>Hiring stayed flat because the second warehouse opened later than planned.</p>
    <p>The board meets again in March to review the warehouse decision.</p>
  </article>
</body></html>`;

describe('page.extract', () => {
  it('keeps the prose and drops the machinery', () => {
    const out = pageExtractJob.baseline(pageExtractJob.input.parse({ html: PAGE }), ctx);
    expect(out.title).toBe('The Tuesday Report');
    expect(out.text).toContain('Revenue grew by eleven percent');
    expect(out.text).not.toContain('console.log');
    expect(out.text).not.toContain('color:red');
    expect(out.truncated).toBe(false);
  });

  it('surfaces key points in document order, never reordered by score', () => {
    const out = pageExtractJob.baseline(pageExtractJob.input.parse({ html: PAGE }), ctx);
    expect(out.keyPoints.length).toBeGreaterThan(0);
    const positions = out.keyPoints.map((p) => out.text.indexOf(p));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('admits when it had to cut the page short', () => {
    const out = pageExtractJob.baseline(pageExtractJob.input.parse({ html: PAGE, maxChars: 100 }), ctx);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(101); // the ellipsis
  });

  it('falls back to the h1 when a page has no title', () => {
    const out = pageExtractJob.baseline(pageExtractJob.input.parse({ html: '<h1>Only a heading</h1><p>Body.</p>' }), ctx);
    expect(out.title).toBe('Only a heading');
  });

  it('survives a page that is nothing but markup', () => {
    const out = pageExtractJob.baseline(pageExtractJob.input.parse({ html: '<div><span></span></div>' }), ctx);
    expect(out.title).toBe('');
    expect(out.keyPoints).toEqual([]);
  });

  it('stays FOREIGN: shortening a stranger\'s words does not launder them', () => {
    expect(pageExtractJob.outputTrust).toBe('FOREIGN');
  });
});

describe('intent.parse', () => {
  const parse = (text: string): ReturnType<typeof intentParseJob.baseline> =>
    intentParseJob.baseline(intentParseJob.input.parse({ text }), ctx);

  it('reads an imperative as a command', () => {
    expect(parse('send Ana the notes').intent).toBe('command');
  });

  it('reads a trailing question mark as a question', () => {
    expect(parse('is the warehouse open?').intent).toBe('question');
  });

  it('prefers the more specific intent when rules overlap', () => {
    // "schedule" and "command" both match; the ordered table decides.
    expect(parse('schedule a meeting with Ana tomorrow at 3pm').intent).toBe('schedule');
  });

  it('says unknown rather than guessing at something indirect', () => {
    const out = parse('it would be good to have that sorted at some point');
    expect(out.intent).toBe('unknown');
    expect(out.confidence).toBeLessThan(0.3);
  });

  it('copies entity values verbatim and never invents one', () => {
    const out = parse('email ana@example.com at 09:30 on 2026-03-04');
    expect(out.entities).toContainEqual({ kind: 'email', value: 'ana@example.com' });
    expect(out.entities).toContainEqual({ kind: 'time', value: '09:30' });
    expect(out.entities).toContainEqual({ kind: 'date', value: '2026-03-04' });
    for (const entity of out.entities) expect('email ana@example.com at 09:30 on 2026-03-04').toContain(entity.value);
  });

  it('is less confident about a keyword buried in a long sentence', () => {
    const short = parse('book a room');
    const long = parse('book a room, although honestly whichever option works best for everyone involved is completely fine by me and we can revisit it later');
    expect(long.confidence).toBeLessThan(short.confidence);
  });

  it('is deterministic', () => {
    expect(parse('send the notes')).toEqual(parse('send the notes'));
  });
});

describe('priority.score', () => {
  const score = (input: Record<string, unknown>): ReturnType<typeof priorityScoreJob.baseline> =>
    priorityScoreJob.baseline(priorityScoreJob.input.parse(input), ctx);

  it('ranks an overdue item from a known contact at the top', () => {
    const out = score({ subject: 'Lease', body: 'needs signing', dueInMs: -3_600_000, fromKnownContact: true });
    expect(out.band).toBe('now');
    expect(out.reasons).toContain('already overdue');
    expect(out.reasons).toContain('from someone you know');
  });

  it('refuses to let a stranger shouting ASAP outrank a real deadline', () => {
    const shouting = score({ subject: 'URGENT! act immediately', body: 'final notice' });
    const real = score({ subject: 'Lease', body: 'sign it', dueInMs: 3_600_000, fromKnownContact: true });
    expect(real.score).toBeGreaterThan(shouting.score);
  });

  it('explains every contribution it made', () => {
    const out = score({ subject: 'warehouse costs', body: 'see attached', interests: ['warehouse'], fromKnownContact: true });
    expect(out.reasons).toContain('mentions warehouse');
    expect(out.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it('says plainly when nothing stands out', () => {
    const out = score({ subject: 'newsletter', body: 'this month in widgets' });
    expect(out.band).toBe('whenever');
    expect(out.reasons).toEqual(['nothing about it stands out']);
  });

  it('never exceeds the bounds of the scale', () => {
    const out = score({
      subject: 'URGENT overdue deadline', body: 'warehouse', dueInMs: -1,
      fromKnownContact: true, interests: ['warehouse'],
    });
    expect(out.score).toBeLessThanOrEqual(1);
    expect(out.score).toBeGreaterThanOrEqual(0);
  });

  it('bands monotonically with the score', () => {
    const order = ['whenever', 'this_week', 'today', 'now'];
    const a = score({ subject: 'x' });
    const b = score({ subject: 'x', dueInMs: 3_600_000, fromKnownContact: true });
    expect(order.indexOf(b.band)).toBeGreaterThan(order.indexOf(a.band));
  });
});

describe('thread.summarize', () => {
  const thread = [
    { speaker: 'Ara', text: 'The warehouse opening slipped to March.' },
    { speaker: 'Sam', text: 'Does that change the hiring plan?' },
  ];

  it('attributes every line to the speaker who said it', () => {
    const out = threadSummarizeJob.baseline(threadSummarizeJob.input.parse({ messages: thread }), ctx);
    expect(out.participants).toEqual(['Ara', 'Sam']);
    for (const speaker of out.participants) expect(out.summary).toContain(speaker);
  });

  it('lists a question nobody answered as still open', () => {
    const out = threadSummarizeJob.baseline(threadSummarizeJob.input.parse({ messages: thread }), ctx);
    expect(out.openQuestions).toEqual(['Does that change the hiring plan?']);
  });

  it('does not call a question open once somebody has replied', () => {
    const answered = [...thread, { speaker: 'Ara', text: 'No, hiring stays as planned.' }, { speaker: 'Sam', text: 'Good.' }];
    const out = threadSummarizeJob.baseline(threadSummarizeJob.input.parse({ messages: answered }), ctx);
    expect(out.openQuestions).toEqual([]);
  });

  it('respects the character budget', () => {
    const long = Array.from({ length: 40 }, (_, i) => ({ speaker: 'Ara', text: `Point number ${i} about the northern warehouse.` }));
    const out = threadSummarizeJob.baseline(threadSummarizeJob.input.parse({ messages: long, maxChars: 200 }), ctx);
    expect(out.summary.length).toBeLessThanOrEqual(201);
  });

  it('handles a thread of one', () => {
    const out = threadSummarizeJob.baseline(threadSummarizeJob.input.parse({ messages: [{ speaker: 'Ara', text: 'Hello.' }] }), ctx);
    expect(out.summary).toBe('Ara: Hello.');
  });
});
