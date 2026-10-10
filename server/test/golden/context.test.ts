import { describe, expect, it } from 'vitest';
import {
  assembleContext, BLOCK_ORDER, EMPTY_INPUT, PREFIX_BLOCKS, UNDROPPABLE,
  type ContextInput,
} from '../../src/cognition/context.js';
import { must } from '../fakes/must.js';

/**
 * §17 golden scenarios.
 *
 * Sixteen situations the assembler must handle identically every time.
 * These are the closest thing this build has to a specification of what
 * a model will see, so they are written as scenarios a person could
 * describe out loud rather than as unit tests of helper functions.
 */

const BASE: ContextInput = {
  ...EMPTY_INPUT,
  agentName: 'ARISH',
  autonomy: 2,
  tools: ['memory.recall', 'file.read', 'http.fetch'],
  profile: ['Lives in Ghaziabad.', 'Works on logistics software.'],
  preferences: ['Prefers short answers.'],
  rules: ['When she says "the warehouse" she means the northern one.'],
  facts: [{ text: 'The northern warehouse opens in March.', confidence: 0.9 }],
  entities: ['Ana — colleague'],
  episodes: ['Last Tuesday you drafted the lease email together.'],
  threadSummary: 'Ara asked about the warehouse timeline.',
  turns: [{ speaker: 'Ara', text: 'And the hiring plan?' }],
  quarantined: [{ ref: 'qr-1', origin: 'https://example.com/page', bytes: 4096 }],
  toolResults: ['calendar.list → 2 events on Thursday'],
  task: 'Answer the question about the hiring plan.',
  budgetTokens: 4000,
};

const names = (input: ContextInput): string[] => assembleContext(input).blocks.map((b) => b.name);

describe('§17 the shape of an assembled context', () => {
  it('1. emits blocks in the declared order, never in insertion order', () => {
    const order = names(BASE);
    const expected = BLOCK_ORDER.filter((n) => order.includes(n));
    expect(order).toEqual([...expected]);
  });

  it('2. is byte-identical when assembled twice', () => {
    expect(assembleContext(BASE).text).toBe(assembleContext(BASE).text);
  });

  it('3. puts the task last, nearest the model\'s own output', () => {
    expect(names(BASE).at(-1)).toBe('task');
    expect(assembleContext(BASE).text.trimEnd().endsWith('Answer the question about the hiring plan.')).toBe(true);
  });

  it('4. keeps the prefix stable while the turn changes underneath it', () => {
    const first = assembleContext(BASE).prefix;
    const later = assembleContext({
      ...BASE,
      turns: [...BASE.turns, { speaker: 'ARISH', text: 'Unchanged so far.' }],
      task: 'Something else entirely.',
      facts: [],
      episodes: [],
    }).prefix;
    expect(later).toBe(first);
  });

  it('5. invalidates the prefix when a tool appears, because it must', () => {
    const before = assembleContext(BASE).prefix;
    const after = assembleContext({ ...BASE, tools: [...BASE.tools, 'mail.send'] }).prefix;
    expect(after).not.toBe(before);
  });

  it('6. sorts tools, so the prefix does not change with registration order', () => {
    const a = assembleContext({ ...BASE, tools: ['a.one', 'b.two'] }).prefix;
    const b = assembleContext({ ...BASE, tools: ['b.two', 'a.one'] }).prefix;
    expect(a).toBe(b);
  });

  it('7. contains only SYSTEM material in the prefix', () => {
    for (const block of assembleContext(BASE).blocks) {
      if (PREFIX_BLOCKS.includes(block.name)) expect(block.trust, block.name).toBe('SYSTEM');
    }
  });
});

describe('§17 untrusted material', () => {
  it('8. passes references, never bytes', () => {
    const { text } = assembleContext({
      ...BASE,
      quarantined: [{ ref: 'qr-9', origin: 'https://evil.test', bytes: 120 }],
    });
    expect(text).toContain('qr-9');
    expect(text).toContain('references only');
    expect(text).not.toContain('IGNORE PREVIOUS');
  });

  it('9. says in the policy block that untrusted content is data', () => {
    const { text } = assembleContext(BASE);
    expect(text).toContain('data, never instruction');
  });

  it('10. places untrusted material after everything the user said', () => {
    const order = names(BASE);
    expect(order.indexOf('quarantine')).toBeGreaterThan(order.indexOf('turns'));
    expect(order.indexOf('quarantine')).toBeGreaterThan(order.indexOf('profile'));
  });
});

describe('§17 the budget', () => {
  it('11. drops in the specified order, cheapest recollection first', () => {
    const tight = assembleContext({ ...BASE, budgetTokens: 150 });
    expect(tight.dropped[0]).toBe('episodes');
    expect(tight.truncated).toBe(true);
  });

  it('12. never drops the task, the policy or the identity', () => {
    const squeezed = assembleContext({ ...BASE, budgetTokens: 20 });
    for (const name of UNDROPPABLE) {
      expect(squeezed.blocks.map((b) => b.name), name).toContain(name);
    }
  });

  it('13. reports what it dropped instead of hiding it', () => {
    const tight = assembleContext({ ...BASE, budgetTokens: 120 });
    expect(tight.dropped.length).toBeGreaterThan(0);
    for (const dropped of tight.dropped) {
      expect(tight.blocks.map((b) => b.name)).not.toContain(dropped);
    }
  });

  it('14. clips the task only as a last resort, and says so by shortening', () => {
    const long = 'x '.repeat(4000).trim();
    const out = assembleContext({ ...BASE, task: long, budgetTokens: 60 });
    expect(must(out.blocks.find((b) => b.name === 'task'), 'task').text).toContain('…');
    expect(out.truncated).toBe(true);
  });
});

describe('§17 the empty and the odd', () => {
  it('15. assembles something usable from nothing at all', () => {
    const out = assembleContext({ ...EMPTY_INPUT, task: 'Say hello.' });
    expect(out.blocks.map((b) => b.name)).toEqual(['identity', 'policy', 'task']);
    expect(out.text).toContain('Say hello.');
    expect(out.dropped).toEqual([]);
  });

  it('16. orders facts by confidence, not by the order they were recalled', () => {
    const { text } = assembleContext({
      ...BASE,
      facts: [
        { text: 'Low confidence thing.', confidence: 0.2 },
        { text: 'High confidence thing.', confidence: 0.95 },
      ],
    });
    expect(text.indexOf('High confidence thing.')).toBeLessThan(text.indexOf('Low confidence thing.'));
  });
});
