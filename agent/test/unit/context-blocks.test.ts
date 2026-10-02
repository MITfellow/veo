import { describe, expect, it } from 'vitest';
import {
  IDENTITY_CARD_MAX_TOKENS,
  RENDER_ORDER,
  SURVIVAL_ORDER,
  UNEVICTABLE,
} from '../../src/cognition/context/types.js';
import { TEMPLATES, TEMPLATE_SET_VERSION } from '../../src/cognition/context/templates/index.js';
import { assembleContext } from '../../src/cognition/context/assemble.js';
import { policyFor } from '../../src/cognition/context/policy.js';
import { estimateTokens } from '../../src/cognition/tokens.js';
import { T0, snap } from '../fixtures/snapshots.js';

describe('the fourteen blocks (§21)', () => {
  it('names all fourteen exactly once in both orders', () => {
    expect(SURVIVAL_ORDER).toHaveLength(14);
    expect(new Set(SURVIVAL_ORDER).size).toBe(14);
    expect([...RENDER_ORDER].sort()).toEqual([...SURVIVAL_ORDER].sort());
  });

  it('reads in a different order than it dies in', () => {
    // The distinction is load-bearing and easy to collapse by accident:
    // kernel instructions survive everything but are read first, while the
    // conversation is read last and squeezed early. One array cannot say
    // both, so this test fails the day someone merges them.
    expect([...RENDER_ORDER]).not.toEqual([...SURVIVAL_ORDER]);
    const survival = (name: string): number => SURVIVAL_ORDER.indexOf(name as never);
    const render = (name: string): number => RENDER_ORDER.indexOf(name as never);
    expect(survival('conversation')).toBeGreaterThan(survival('situation'));
    expect(render('conversation')).toBeGreaterThan(render('situation'));
    expect(survival('foreign')).toBe(13);
  });

  it('marks exactly the four blocks that may never be dropped', () => {
    expect([...UNEVICTABLE].sort()).toEqual(['constitution', 'constraints', 'identity', 'kernel']);
  });

  it('gives every block a named, versioned template (§21)', () => {
    for (const name of SURVIVAL_ORDER) {
      const template = TEMPLATES[name];
      expect(template.name).toBe(name);
      expect(template.version).toMatch(/^[a-z]+-\d+$/);
      expect(['system', 'turns']).toContain(template.kind);
    }
    expect(TEMPLATE_SET_VERSION).toMatch(/^tpl-\d+$/);
  });

  it('clamps the identity card to 400 tokens and says that it did', () => {
    const long = 'This person is interesting. '.repeat(400);
    const context = assembleContext({
      principal: 'user:ara',
      sessionId: 's1',
      trust: 'USER',
      now: T0,
      policy: policyFor('gpt-4o'),
      snapshot: snap({ identity: { text: long, updatedAt: T0, factCount: 200 } }),
    });
    const identity = context.messages.find((message) => message.content.includes('distilled'));
    expect(identity).toBeDefined();
    expect(estimateTokens(identity!.content)).toBeLessThanOrEqual(IDENTITY_CARD_MAX_TOKENS + 40);
    // A card cut off mid-sentence reads like a complete description of
    // someone. The model has to be told it is partial.
    expect(identity!.content).toContain('It is partial.');
  });

  it('says a stranger is a stranger when there is no identity card (§24.4)', () => {
    const context = assembleContext({
      principal: 'user:ara',
      sessionId: 's1',
      trust: 'USER',
      now: T0,
      policy: policyFor('gpt-4o'),
      snapshot: snap(),
    });
    const text = context.messages.map((message) => message.content).join('\n');
    expect(text).toContain('You have not built a picture of this person yet');
    expect(text).toContain('Do not write as if');
  });
});
