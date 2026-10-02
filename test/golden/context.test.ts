import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { assembleContext, type Turn } from '../../src/cognition/context/assemble.js';

/**
 * Golden test (§31).
 *
 * The assembled context is the single most consequential artifact in the
 * system — it is what the model actually sees — and it is assembled by code
 * that will be rewritten at M5, M6 and M7. A golden file makes every change
 * to it *visible in review* rather than discovered in behaviour six months
 * later.
 *
 * Regenerate deliberately with `UPDATE_GOLDEN=1 npx vitest run test/golden`,
 * and read the diff before committing it. A golden file updated without
 * reading the diff is worse than no golden file.
 */

const GOLDEN = new URL('./context.golden.txt', import.meta.url).pathname;

function fixedSession(): Turn[] {
  const topics = [
    'I am moving to Lisbon in March.',
    'That is a big change. What is taking you there?',
    'A job at a climate startup.',
    'Congratulations. Do you have somewhere to live yet?',
    'Not yet. I am looking in Alfama.',
    'Alfama is beautiful but noisy at night. Worth visiting before you commit.',
    'Good point. My sister visited last year.',
    'Did she have a view on it?',
    'She loved it. She stayed near the castle.',
    'Then you have a local guide. When do you fly?',
    'The 14th of March.',
    'Noted. I will keep that date in mind.',
  ];
  return topics.map((content, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content,
    trust: i % 2 === 0 ? ('USER' as const) : ('DERIVED' as const),
    id: `turn-${String(i).padStart(2, '0')}`,
  }));
}

function render(): string {
  const result = assembleContext({
    system: 'You are a personal agent. You are careful, concrete and honest.',
    situation: ['Current time: 2026-03-01T09:00:00.000Z', 'Degradation level: L0'],
    history: fixedSession(),
    maxTokens: 120,
    countTokens: (text: string) => Math.ceil(text.length / 4),
  });

  const lines: string[] = [];
  lines.push(`total_tokens: ${result.totalTokens}`);
  lines.push(`truncated: ${result.truncated}`);
  lines.push('');
  lines.push('blocks:');
  for (const block of result.blocks) {
    lines.push(`  ${block.name}: tokens=${block.tokens} items=${block.items}`);
  }
  lines.push('');
  lines.push('evictions:');
  for (const eviction of result.evictions) {
    lines.push(`  ${eviction.id} (${eviction.reason}, ${eviction.tokens} tokens)`);
  }
  lines.push('');
  lines.push('messages:');
  for (const message of result.messages) {
    lines.push(`  [${message.role}/${message.trust ?? 'USER'}] ${message.content}`);
  }
  return lines.join('\n') + '\n';
}

describe('golden: assembled context', () => {
  it('matches the committed golden file', () => {
    const actual = render();
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, actual);
    }
    expect(actual).toBe(readFileSync(GOLDEN, 'utf8'));
  });

  it('is byte-stable across repeated assembly', () => {
    expect(render()).toBe(render());
  });
});
