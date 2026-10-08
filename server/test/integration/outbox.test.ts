import { describe, expect, it } from 'vitest';
import { Outbox, type OutboxEntry, type Probe } from '../../src/capability/outbox.js';
import { createTestSubstrate } from '../fakes/substrate.js';
import { FakeCrypto } from '../fakes/crypto.js';
import { must } from '../fakes/must.js';

/**
 * Exactly-once external effects (§13).
 *
 * The scenario the whole mechanism exists for: the process dies between
 * "send the email" and "write down that we sent the email". Every test
 * below is a variation on who finds out, and how.
 */

function harness(): { outbox: Outbox; s: ReturnType<typeof createTestSubstrate> } {
  const s = createTestSubstrate();
  return { s, outbox: new Outbox({ storage: s.storage, events: s.events, crypto: new FakeCrypto() }) };
}

const EMAIL = {
  tool: 'mail.send',
  version: '1',
  stepId: 'step-3',
  input: { to: 'ana@example.com', subject: 'Thursday' },
  reversible: false,
  idempotent: false,
  summary: 'email Ana about Thursday',
  runId: 'run-1',
};

describe('the key', () => {
  it('is stable across argument order and across processes', () => {
    const { outbox } = harness();
    const a = outbox.key({ ...EMAIL, input: { to: 'ana@example.com', subject: 'Thursday' } });
    const b = outbox.key({ ...EMAIL, input: { subject: 'Thursday', to: 'ana@example.com' } });
    expect(a).toBe(b);
  });

  it('separates a genuine second message from a replay of the first', () => {
    const { outbox } = harness();
    const replay = outbox.key(EMAIL);
    const followUp = outbox.key({ ...EMAIL, stepId: 'step-9' });
    // Same content, different step: a follow-up is not a duplicate.
    expect(followUp).not.toBe(replay);
    expect(outbox.key(EMAIL)).toBe(replay);
  });

  it('changes when the content changes', () => {
    const { outbox } = harness();
    expect(outbox.key({ ...EMAIL, input: { to: 'bob@example.com' } })).not.toBe(outbox.key(EMAIL));
  });
});

describe('the ordinary path', () => {
  it('records an intention before anything happens, then the commitment', () => {
    const { outbox } = harness();
    const { key, alreadySettled } = outbox.intend(EMAIL);
    expect(alreadySettled).toBeNull();
    expect(must(outbox.get(key), 'entry').status).toBe('intended');

    outbox.commit(key, { remoteRef: 'msg-88', summary: 'sent' });
    const entry = must(outbox.get(key), 'entry');
    expect(entry.status).toBe('committed');
    expect(entry.remoteRef).toBe('msg-88');
    expect(outbox.pending()).toHaveLength(0);
  });

  it('never stores the arguments, only their digest', () => {
    const { outbox, s } = harness();
    const { key } = outbox.intend(EMAIL);

    const row = s.storage.prepare('SELECT * FROM outbox WHERE key = ?').get<Record<string, unknown>>(key);
    expect(JSON.stringify(row)).not.toContain('ana@example.com');
    const events = s.storage.prepare("SELECT payload FROM events WHERE type = 'effect.intended'").all<{ payload: string }>();
    expect(JSON.stringify(events)).not.toContain('ana@example.com');
  });

  it('refuses to re-run a step that already committed', () => {
    const { outbox } = harness();
    const first = outbox.intend(EMAIL);
    outbox.commit(first.key, { remoteRef: 'msg-88' });

    // The executor replays the same step after a restart.
    const second = outbox.intend(EMAIL);
    expect(second.key).toBe(first.key);
    expect(must(second.alreadySettled, 'settled').remoteRef).toBe('msg-88');
  });

  it('records a compensation without erasing what happened', () => {
    const { outbox } = harness();
    const { key } = outbox.intend({ ...EMAIL, tool: 'calendar.create', reversible: true });
    outbox.commit(key, { remoteRef: 'evt-1' });
    outbox.compensate(key, 'the meeting was cancelled');

    const entry = must(outbox.get(key), 'entry');
    expect(entry.status).toBe('compensated');
    expect(entry.remoteRef).toBe('evt-1'); // the thing still happened
  });

  it('will not commit something that was never intended', () => {
    const { outbox } = harness();
    expect(() => outbox.commit('made-up-key')).toThrow(/commit without intend/);
  });
});

describe('the crash', () => {
  it('leaves the uncertainty visible instead of invisible', () => {
    const { outbox } = harness();
    outbox.intend(EMAIL);
    // ...the process dies here, after the email may or may not have left.

    const pending = outbox.pending();
    expect(pending).toHaveLength(1);
    expect(must(pending[0], 'entry').summary).toBe('email Ana about Thursday');
  });

  it('asks the provider, and commits what the provider confirms', async () => {
    const { outbox } = harness();
    const { key } = outbox.intend(EMAIL);

    const probe: Probe = () => Promise.resolve({ found: true, remoteRef: 'msg-provider-12' });
    const tally = await outbox.reconcile(new Map([['mail.send', probe]]));

    expect(tally).toEqual({ committed: 1, absent: 0, needsAttention: 0 });
    const entry = must(outbox.get(key), 'entry');
    expect(entry.status).toBe('committed');
    expect(entry.remoteRef).toBe('msg-provider-12');
    expect(entry.detail).toBe('discovered by reconciliation');
  });

  it('marks it absent — the only state from which a retry is allowed', async () => {
    const { outbox } = harness();
    const { key } = outbox.intend(EMAIL);

    const tally = await outbox.reconcile(new Map([['mail.send', () => Promise.resolve({ found: false })]]));
    expect(tally.absent).toBe(1);
    expect(must(outbox.get(key), 'entry').status).toBe('absent');

    // And a retry is now a fresh intention rather than a swallowed duplicate.
    const again = outbox.intend(EMAIL);
    expect(again.alreadySettled).toBeNull();
    expect(must(outbox.get(key), 'entry').status).toBe('intended');
  });

  it('sends an unprobeable effect to a human rather than guessing', async () => {
    const { outbox } = harness();
    const { key } = outbox.intend(EMAIL);

    const tally = await outbox.reconcile(new Map()); // no probe for mail.send
    expect(tally.needsAttention).toBe(1);
    const entry = must(outbox.get(key), 'entry');
    expect(entry.status).toBe('needs_attention');
    expect(entry.detail).toMatch(/cannot be asked/);
    expect(outbox.needsAttention()).toHaveLength(1);
  });

  it('treats "I could not check" as needing a human, never as absent', async () => {
    const { outbox } = harness();
    outbox.intend(EMAIL);

    const unsure: Probe = () => Promise.resolve({ unknown: true, detail: 'the mailbox is unreachable' });
    const tally = await outbox.reconcile(new Map([['mail.send', unsure]]));
    expect(tally).toEqual({ committed: 0, absent: 0, needsAttention: 1 });
  });

  it('treats a probe that throws the same way', async () => {
    const { outbox } = harness();
    outbox.intend(EMAIL);
    const broken: Probe = () => Promise.reject(new Error('401 from the provider'));

    const tally = await outbox.reconcile(new Map([['mail.send', broken]]));
    expect(tally.needsAttention).toBe(1);
    expect(must(outbox.needsAttention()[0], 'entry').detail).toContain('401');
  });

  it('reconciles a mailbox of mixed outcomes in one pass', async () => {
    const { outbox } = harness();
    outbox.intend(EMAIL);
    outbox.intend({ ...EMAIL, stepId: 'step-4', tool: 'calendar.create', reversible: true });
    outbox.intend({ ...EMAIL, stepId: 'step-5', tool: 'payment.charge' });

    const probes = new Map<string, Probe>([
      ['mail.send', () => Promise.resolve({ found: true, remoteRef: 'm1' })],
      ['calendar.create', () => Promise.resolve({ found: false })],
    ]);
    const tally = await outbox.reconcile(probes);

    expect(tally).toEqual({ committed: 1, absent: 1, needsAttention: 1 });
    expect(outbox.pending()).toHaveLength(0);
    expect(must(outbox.needsAttention()[0], 'entry').tool).toBe('payment.charge');
  });

  it('is idempotent: reconciling twice changes nothing', async () => {
    const { outbox, s } = harness();
    outbox.intend(EMAIL);
    const probes = new Map<string, Probe>([['mail.send', () => Promise.resolve({ found: true, remoteRef: 'm1' })]]);

    await outbox.reconcile(probes);
    const after = s.storage.prepare('SELECT * FROM outbox').all<OutboxEntry>();
    const second = await outbox.reconcile(probes);

    expect(second).toEqual({ committed: 0, absent: 0, needsAttention: 0 });
    expect(s.storage.prepare('SELECT * FROM outbox').all<OutboxEntry>()).toEqual(after);
  });
});

describe('the outbox is a projection like any other', () => {
  it('rebuilds byte-identically from the log alone', () => {
    const { outbox, s } = harness();
    const a = outbox.intend(EMAIL);
    outbox.commit(a.key, { remoteRef: 'm1' });
    const b = outbox.intend({ ...EMAIL, stepId: 'step-7' });
    void b;
    outbox.intend({ ...EMAIL, stepId: 'step-8', tool: 'calendar.create', reversible: true });

    const before = s.storage.prepare('SELECT * FROM outbox ORDER BY key').all<OutboxEntry>();
    s.storage.prepare('DELETE FROM outbox').run();
    s.events.rebuild();
    const after = s.storage.prepare('SELECT * FROM outbox ORDER BY key').all<OutboxEntry>();

    expect(after).toEqual(before);
    expect(after.length).toBe(3);
  });
});
