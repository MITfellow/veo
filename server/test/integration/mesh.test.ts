import { describe, expect, it } from 'vitest';
import {
  confirmationWords, createInvite, decodeInvite, decodeSecret,
  deriveLinkKeys, encodeInvite, encodeSecret, groupCode,
} from '../../src/capability/mesh/pairing.js';
import { meshPair } from '../fakes/mesh.js';
import { FakeCrypto } from '../fakes/crypto.js';
import { must } from '../fakes/must.js';

/**
 * Two agents talking: pairing, asking, answering, sharing.
 *
 * The in-device case and the between-devices case are the same code
 * path — `InProcessSwitch` is what ships for local links, not a stub —
 * so these tests cover both. What differs in the field is latency and
 * the transport under the link, neither of which the protocol can see.
 */

describe('pairing is a ceremony a person performs', () => {
  it('round-trips a code through the form a human reads aloud', () => {
    const crypto = new FakeCrypto(5);
    const invite = createInvite({ id: 'device-a', label: 'Laptop', address: '' }, crypto);

    expect(invite.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{1,4})+$/);
    expect(decodeSecret(invite.code)).toHaveLength(16);
    expect(decodeSecret(invite.code.toLowerCase())).toEqual(decodeSecret(invite.code));
    // Typed with spaces instead of dashes, as it will be.
    expect(decodeSecret(invite.code.replace(/-/g, ' '))).toEqual(decodeSecret(invite.code));
  });

  it('round-trips the whole invite through one pasteable line', () => {
    const invite = createInvite({ id: 'device-a', label: 'My Laptop', address: '10.0.0.4:8788' }, new FakeCrypto(2));
    const decoded = decodeInvite(encodeInvite(invite));
    expect(decoded).toEqual(invite);
  });

  it('refuses a truncated code at pairing time, not at the first frame', () => {
    expect(() => decodeSecret('ABCD-EFGH')).toThrow(/bits/);
    expect(() => decodeInvite('arish-pair:1:a:b:c:SHORT')).toThrow(/bits/);
    expect(() => decodeInvite('https://example.com')).toThrow(/not an ARISH pairing invite/);
  });

  it('derives opposite key pairs on the two devices', async () => {
    const secret = new FakeCrypto().randomBytes(16);
    const onA = await deriveLinkKeys(secret, 'device-a', 'device-b');
    const onB = await deriveLinkKeys(secret, 'device-b', 'device-a');

    expect(onA.out).toEqual(onB.in);
    expect(onA.in).toEqual(onB.out);
    // A reflected frame must not open: sending and receiving differ.
    expect(onA.out).not.toEqual(onA.in);
  });

  it('shows both devices the same confirmation words, in either order', () => {
    const crypto = new FakeCrypto(9);
    const secret = crypto.randomBytes(16);
    const onA = confirmationWords(secret, crypto, 'device-a', 'device-b');
    const onB = confirmationWords(secret, crypto, 'device-b', 'device-a');

    expect(onA).toBe(onB);
    expect(confirmationWords(crypto.randomBytes(16), crypto, 'device-a', 'device-b')).not.toBe(onA);
  });

  it('will not pair a device with itself', async () => {
    const mesh = await meshPair();
    await expect(mesh.a.directory.pair({ ...mesh.a.invite, deviceId: 'device-a' }, ['presence']))
      .rejects.toThrow(/own/);
    mesh.close();
  });

  it('encodes a secret to base32 and back without loss', () => {
    const bytes = new Uint8Array([0, 1, 255, 128, 64, 32, 16, 8, 4, 2, 1, 200, 77, 99, 11, 250]);
    expect(decodeSecret(groupCode(encodeSecret(bytes)))).toEqual(bytes);
  });
});

describe('asking a peer a question', () => {
  it('answers a ping across the link', async () => {
    const mesh = await meshPair();
    const answer = await mesh.a.agent.ask(mesh.b.id, 'presence', {});

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect((answer.data as { label: string }).label).toBe('Phone');
    mesh.close();
  });

  it('carries a real question both ways, independently', async () => {
    const mesh = await meshPair();
    const fromA = await mesh.a.agent.ask(mesh.b.id, 'presence', {});
    const fromB = await mesh.b.agent.ask(mesh.a.id, 'presence', {});

    expect(fromA.ok && (fromA.data as { label: string }).label).toBe('Phone');
    expect(fromB.ok && (fromB.data as { label: string }).label).toBe('Laptop');
    mesh.close();
  });

  it('tells a peer when it does not answer that topic', async () => {
    const mesh = await meshPair();
    const answer = await mesh.a.agent.ask(mesh.b.id, 'launch.missiles', {});

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.code).toBe('unknown_topic');
    mesh.close();
  });

  it('times out rather than hanging when the device is unreachable', async () => {
    const mesh = await meshPair();
    mesh.wire.partition(mesh.b.id);

    const answer = await mesh.a.agent.ask(mesh.b.id, 'presence', {});
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.code).toBe('timeout');
    mesh.close();
  });

  it('does not expire a request that was answered', async () => {
    const mesh = await meshPair();
    const answer = await mesh.a.agent.ask(mesh.b.id, 'presence', {});
    expect(answer.ok).toBe(true);
    mesh.a.advance(60_000);
    expect(mesh.a.agent.expire()).toBe(0);
    mesh.close();
  });
});

describe('what a peer is allowed to know', () => {
  it('answers availability with intervals and no titles', async () => {
    const mesh = await meshPair();
    const start = mesh.b.now() + 3_600_000;
    mesh.b.memory.assert({
      subject: 'event:gcal:ev1', predicate: 'summary', object: 'Job interview at Acme',
      validFrom: start, validTo: start + 3_600_000,
      basis: 'world/1|OBSERVATION|WORK|gcal', confidence: 0.9,
      stability: 'volatile', sensitivity: 'sensitive', sourceTrust: 'FOREIGN',
    });

    const answer = await mesh.a.agent.ask(mesh.b.id, 'availability', { from: start - 60_000, to: start + 7_200_000 });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;

    const data = answer.data as { busy: Array<{ start: number; end: number }> };
    expect(data.busy).toEqual([{ start, end: start + 3_600_000 }]);
    expect(JSON.stringify(answer)).not.toContain('Acme');
    expect(JSON.stringify(answer)).not.toContain('interview');
    mesh.close();
  });

  it('never returns a sensitive fact to a recall query', async () => {
    const mesh = await meshPair();
    mesh.b.memory.assert({
      subject: 'person:me', predicate: 'medication', object: 'sertraline 50mg',
      basis: 'world/1|USER_ASSERTION|PERSONAL|user', confidence: 1,
      stability: 'slow', sensitivity: 'sensitive', sourceTrust: 'USER',
    });
    mesh.b.memory.assert({
      subject: 'person:me', predicate: 'favourite colour', object: 'sertraline-free blue',
      basis: 'world/1|USER_ASSERTION|PERSONAL|user', confidence: 1,
      stability: 'slow', sensitivity: 'normal', sourceTrust: 'USER',
    });

    const answer = await mesh.a.agent.ask(mesh.b.id, 'memory.recall', { query: 'sertraline' });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(JSON.stringify(answer.data)).not.toContain('50mg');
    mesh.close();
  });

  it('refuses a topic the peer was not granted, and records the refusal', async () => {
    const mesh = await meshPair({ grantsOnB: ['presence'] });
    const answer = await mesh.a.agent.ask(mesh.b.id, 'memory.recall', { query: 'anything' });

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.code).toBe('not_granted');

    const denials = mesh.b.harness.substrate.storage
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'policy.denied'").get<{ n: number }>();
    expect(must(denials, 'count').n).toBeGreaterThan(0);
    mesh.close();
  });

  it('stops answering a revoked peer, which the asker sees as silence', async () => {
    const mesh = await meshPair();
    mesh.b.directory.revoke(mesh.a.id);

    // B drops the frame without replying — it will not tell an
    // unrecognised device whether it exists. A finds out by timing out,
    // which it must be driven to notice (no ambient timers).
    const pending = mesh.a.agent.ask(mesh.b.id, 'presence', {});
    mesh.a.advance(31_000);
    expect(mesh.a.agent.expire()).toBe(1);

    const answer = await pending;
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.code).toBe('timeout');
    mesh.close();
  });

  it('lets grants be narrowed after pairing', async () => {
    const mesh = await meshPair();
    expect((await mesh.a.agent.ask(mesh.b.id, 'memory.recall', { query: 'x' })).ok).toBe(true);

    mesh.b.directory.setGrants(mesh.a.id, ['presence']);
    const after = await mesh.a.agent.ask(mesh.b.id, 'memory.recall', { query: 'x' });
    expect(after.ok).toBe(false);
    mesh.close();
  });
});

describe('what a peer offers', () => {
  it('lands as FOREIGN, with the peer named and its confidence halved', async () => {
    const mesh = await meshPair();
    const answer = await mesh.a.agent.ask(mesh.b.id, 'fact.share', {
      subject: 'person:ana', predicate: 'works at', object: 'Acme', confidence: 1,
    });

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const factId = (answer.data as { factId: string }).factId;
    const fact = must(mesh.b.memory.get(factId), 'fact');

    expect(fact.trust).toBe('FOREIGN');
    expect(fact.confidence).toBe(0.5);
    expect(fact.basis).toContain('peer:device-a');
    expect(fact.basis).toContain('OBSERVATION');
    mesh.close();
  });

  it('records a capture so the provenance of peer data is a query', async () => {
    const mesh = await meshPair();
    await mesh.a.agent.ask(mesh.b.id, 'fact.share', {
      subject: 'person:ana', predicate: 'works at', object: 'Acme',
    });

    const captures = mesh.b.harness.substrate.storage
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'capture.received' AND actor = 'peer:device-a'")
      .get<{ n: number }>();
    expect(must(captures, 'count').n).toBe(1);
    mesh.close();
  });

  it('cannot overwrite what the owner said themselves', async () => {
    const mesh = await meshPair();
    mesh.b.memory.assert({
      subject: 'person:ana', predicate: 'works at', object: 'Bellcorp',
      basis: 'world/1|USER_ASSERTION|PERSONAL|user', confidence: 1,
      stability: 'slow', sensitivity: 'normal', sourceTrust: 'USER',
    });

    await mesh.a.agent.ask(mesh.b.id, 'fact.share', {
      subject: 'person:ana', predicate: 'works at', object: 'Acme', confidence: 1,
    });

    // Both are present — the peer's claim was added, not substituted —
    // and the owner's assertion still outranks it.
    const history = mesh.b.memory.history('person:ana', 'works at');
    expect(history).toHaveLength(2);
    expect(must(history[0], 'first').object).toBe('Bellcorp');
    expect(must(history[0], 'first').trust).toBe('USER');
    mesh.close();
  });

  it('describes to the user exactly what a peer may ask', async () => {
    const mesh = await meshPair();
    const topics = mesh.b.agent.describeTopics();

    expect(topics.map((t) => t.topic).sort()).toEqual(['availability', 'fact.share', 'memory.recall', 'presence']);
    for (const topic of topics) expect(topic.describes.length).toBeGreaterThan(10);
    mesh.close();
  });
});
