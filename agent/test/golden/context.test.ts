/**
 * Golden tests for the assembled context (§21, §31).
 *
 * §21 asks for roughly twelve scenarios, and here they are: cold start, long
 * session, memory-dense, tool-dense, post-compaction, near-overflow,
 * degraded, FOREIGN present, low-confidence, pinned, constraints, and
 * everything at once.
 *
 * The assembled context is the most consequential artifact in the system —
 * it is literally what the model sees — and it is produced by code that will
 * keep being rewritten at M6 and M7. A golden file makes every change to it
 * *visible in review* rather than discovered in behaviour six months later.
 *
 * Regenerate deliberately:
 *
 *     UPDATE_GOLDEN=1 npx vitest run test/golden
 *
 * and read the diff before committing it. §21: "a diff in a golden file is a
 * deliberate behavioural change and must be reviewed as such." A golden file
 * updated without reading the diff is worse than no golden file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { assembleContext } from '../../src/cognition/context/assemble.js';
import { policyFor } from '../../src/cognition/context/policy.js';
import { SCENARIOS, T0 } from '../fixtures/snapshots.js';
import type { StateSnapshot } from '../../src/cognition/context/types.js';
import type { TrustLevel } from '../../src/substrate/events/types.js';

const DIR = new URL('./context/', import.meta.url).pathname;

/** Deliberately small windows: a golden file nobody can read is not evidence. */
const WINDOWS: Record<string, number> = {
  'cold-start': 4_000,
  'long-session': 2_000,
  'memory-dense': 4_000,
  'tool-dense': 3_000,
  'post-compaction': 4_000,
  'near-overflow': 2_400,
  degraded: 4_000,
  'foreign-present': 4_000,
  'low-confidence': 4_000,
  pinned: 2_000,
  constraints: 4_000,
  everything: 4_000,
  'constitution-default': 4_000,
  'constitution-amended': 4_000,
  'cold-start-honest': 4_000,
  'scheduled-run': 4_000,
};

const TRUST: Record<string, TrustLevel> = { 'foreign-present': 'DERIVED' };

function render(name: string, snapshot: StateSnapshot): string {
  const window = WINDOWS[name] ?? 4_000;
  const result = assembleContext({
    principal: 'user:ara',
    sessionId: 'ses-golden',
    trust: TRUST[name] ?? 'USER',
    now: T0,
    policy: policyFor('golden-model', { window, reserveForOutput: 0 }),
    snapshot,
  });

  const lines = [
    `scenario: ${name}`,
    `window: ${window}`,
    `policy: ${result.policyVersion}`,
    `digest: ${result.digest}`,
    `total_tokens: ${result.totalTokens}`,
    `truncated: ${result.truncated}`,
    '',
    'blocks:',
    ...result.blocks.map((block) => `  ${block.name}: tokens=${block.tokens} items=${block.items}`),
    '',
    'tools offered:',
    ...result.tools.map((tool) => `  ${tool.name}`),
    '',
    `evictions: ${result.evictions.length}`,
    ...result.evictions
      .slice(0, 8)
      .map((eviction) => `  ${eviction.block}/${eviction.id} (${eviction.reason}, ${eviction.tokens} tokens)`),
    ...(result.evictions.length > 8 ? [`  …and ${result.evictions.length - 8} more`] : []),
    '',
    'messages:',
  ];
  for (const message of result.messages) {
    lines.push(`  ──[${message.role}/${message.trust ?? 'USER'}]──`);
    for (const line of message.content.split('\n')) lines.push(`  ${line}`);
  }
  return lines.join('\n') + '\n';
}

describe('golden: assembled context (§21)', () => {
  for (const [name, build] of Object.entries(SCENARIOS)) {
    it(`matches the golden file: ${name}`, () => {
      const actual = render(name, build());
      const path = `${DIR}${name}.golden.txt`;
      if (process.env.UPDATE_GOLDEN === '1' || !existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, actual);
      }
      expect(actual).toBe(readFileSync(path, 'utf8'));
    });
  }

  it("covers the scenarios §21 names, plus M7's three and M8's one", () => {
    // §21 asks for ~12; M7 adds the constitution as shipped, the
    // constitution amended, and the honest cold start (§24.4); M8 adds a
    // run nobody asked for.
    expect(Object.keys(SCENARIOS)).toHaveLength(16);
  });

  it('is byte-stable across repeated assembly', () => {
    for (const [name, build] of Object.entries(SCENARIOS)) {
      expect(render(name, build())).toBe(render(name, build()));
    }
  });
});
