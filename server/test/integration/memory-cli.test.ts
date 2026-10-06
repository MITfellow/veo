import { describe, expect, it } from 'vitest';
import { runMemory } from '../../src/interface/memory-cli.js';
import { createTestSubstrate } from '../fakes/substrate.js';
import { configFromEnv } from '../../src/substrate/config.js';
import { must } from '../fakes/must.js';

/** M2 §8 — the surface, against a real database and real projections. */

function cli() {
  const substrate = createTestSubstrate();
  const out: string[] = [];
  const err: string[] = [];
  const deps = { substrate, config: configFromEnv({}) };
  const io = { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l) };
  return {
    substrate,
    out,
    err,
    run: (...argv: string[]) => runMemory(argv, deps, io),
    text: () => out.join('\n'),
    close: () => substrate.close(),
  };
}

describe('arish memory', () => {
  it('adds, lists and recalls', async () => {
    const c = cli();
    expect(await c.run('add', 'My name is Ara. I live in Berlin.')).toBe(0);
    expect(c.text()).toContain('lives_in = Berlin');

    c.out.length = 0;
    expect(await c.run('list')).toBe(0);
    expect(c.text()).toContain('user lives_in = Berlin');

    c.out.length = 0;
    expect(await c.run('recall', 'where do I live')).toBe(0);
    expect(c.text()).toContain('Berlin');
    c.close();
  });

  it('captures a name without the sentence that ended it', async () => {
    const c = cli();
    await c.run('add', 'I work at Acme.');
    expect(c.text()).toContain('employer = Acme');
    expect(c.text()).not.toContain('Acme.');
    c.close();
  });

  it('keeps an abbreviation that really ends in a stop', async () => {
    const c = cli();
    await c.run('add', 'I work at Acme Inc.');
    expect(c.text()).toContain('Acme Inc.');
    c.close();
  });

  it('forgets a fact and leaves the history', async () => {
    const c = cli();
    await c.run('add', 'I live in Berlin.');
    c.out.length = 0;
    await c.run('list', '--json');
    const id = must(JSON.parse(c.text())[0], 'the stored fact').id as string;

    c.out.length = 0;
    expect(await c.run('forget', id, '--reason', 'I was wrong')).toBe(0);

    c.out.length = 0;
    await c.run('list');
    expect(c.text()).toBe('memory is empty');

    c.out.length = 0;
    await c.run('history', 'user', 'lives_in');
    expect(c.text()).toContain('Berlin');
    expect(c.text()).toContain('retracted');
    c.close();
  });

  it('reports conflicts rather than resolving them', async () => {
    const c = cli();
    await c.run('add', 'I live in Berlin.');
    await c.run('add', 'I live in Lisbon.');
    c.out.length = 0;
    expect(await c.run('conflicts')).toBe(0);
    expect(c.text()).toContain('Berlin');
    expect(c.text()).toContain('Lisbon');

    c.out.length = 0;
    expect(await c.run('consolidate')).toBe(0);
    expect(c.text()).toContain('1 contradiction(s) raised');
    c.close();
  });

  it('lists entities with their former names', async () => {
    const c = cli();
    const s = c.substrate;
    s.events.append({ type: 'entity.created', actor: 'user', trust: 'USER', payload: { entityId: 'e1', kind: 'org', name: 'Acme' } });
    s.events.append({ type: 'entity.renamed', actor: 'user', trust: 'USER', payload: { entityId: 'e1', name: 'Acme Global', previousName: 'Acme', normalizedPrevious: 'acme' } });

    expect(await c.run('entities')).toBe(0);
    expect(c.text()).toContain('Acme Global');
    expect(c.text()).toContain('also: Acme');
    c.close();
  });

  it('says so clearly when there is nothing to show', async () => {
    const c = cli();
    expect(await c.run('list')).toBe(0);
    expect(c.text()).toBe('memory is empty');
    c.out.length = 0;
    expect(await c.run('recall', 'anything')).toBe(0);
    expect(c.text()).toBe('nothing relevant');
    c.out.length = 0;
    expect(await c.run('entities')).toBe(0);
    expect(c.text()).toBe('nobody is known yet');
    c.close();
  });

  it('uses the documented exit codes', async () => {
    const c = cli();
    // 0 ok, 1 usage or not found, 2 a missing argument.
    expect(await c.run('help')).toBe(0);
    expect(await c.run()).toBe(1);
    expect(await c.run('bogus')).toBe(1);
    expect(await c.run('forget', 'nope')).toBe(1);
    expect(await c.run('forget')).toBe(2);
    expect(await c.run('add')).toBe(2);
    expect(await c.run('history', 'user')).toBe(2);
    c.close();
  });

  it('emits parseable JSON for every read command', async () => {
    const c = cli();
    await c.run('add', 'I live in Berlin.');
    for (const command of [['list'], ['recall', 'Berlin'], ['entities'], ['conflicts']]) {
      c.out.length = 0;
      expect(await c.run(...command, '--json')).toBe(0);
      expect(() => JSON.parse(c.text())).not.toThrow();
    }
    c.close();
  });

  it('refuses FOREIGN text no quarantine could hold, and ingests it when one can', async () => {
    const c = cli();
    expect(await c.run('add', 'I live in Atlantis.', '--source', 'web_page')).toBe(0);
    c.out.length = 0;
    await c.run('list', '--json');
    const facts = JSON.parse(c.text()) as Array<{ trust: string }>;
    for (const fact of facts) expect(fact.trust).toBe('FOREIGN');
    // And the bytes are in the side table, not in the belief.
    const held = c.substrate.storage.prepare('SELECT COUNT(*) AS n FROM quarantined_content').get<{ n: number }>()?.n;
    expect(held).toBe(1);
    c.close();
  });
});
