import { describe, expect, it } from 'vitest';
import { GENESIS_HASH } from '../../src/substrate/events/envelope.js';
import { createTestSubstrate } from '../../src/substrate/index.js';
import type { Projector } from '../../src/substrate/events/log.js';

function msg(s: ReturnType<typeof createTestSubstrate>, text: string, session = 'sess-1') {
  return s.events.append({
    type: 'message.user',
    payload: { text, attachments: [] },
    principal: 'user:ara',
    trust: 'USER',
    sessionId: session,
  });
}

describe('append', () => {
  it('assigns seq monotonically with no gaps', () => {
    const s = createTestSubstrate();
    for (let i = 0; i < 1000; i++) {
      s.clock.advance(1);
      msg(s, `m${i}`);
    }
    const seqs = s.storage.all<{ seq: number }>('SELECT seq FROM events ORDER BY seq').map((r) => r.seq);
    expect(seqs).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1));
    s.close();
  });

  it('defaults correlationId to the event id so nothing is unattributable', () => {
    const s = createTestSubstrate();
    const e = msg(s, 'hello');
    expect(e.correlationId).toBe(e.id);

    const child = s.events.append({
      type: 'message.agent',
      payload: { text: 'hi' },
      principal: 'system',
      trust: 'SYSTEM',
      sessionId: 'sess-1',
      causationId: e.id,
      correlationId: e.correlationId,
    });
    expect(child.correlationId).toBe(e.id);
    expect(child.causationId).toBe(e.id);
    s.close();
  });

  it('rolls the event back if a projector throws', () => {
    const exploding: Projector = {
      name: 'exploding',
      version: 1,
      handles: ['message.user'],
      reset: () => {},
      apply: () => {
        throw new Error('projector failed');
      },
    };
    const s = createTestSubstrate({ projectors: [exploding] });
    expect(() => msg(s, 'boom')).toThrow(/projector failed/);
    // A projection that cannot be built must not leave a half-applied world.
    expect(s.events.count()).toBe(0);
    s.close();
  });

  it('starts the chain at the genesis hash and links each event to its predecessor', () => {
    const s = createTestSubstrate();
    const a = msg(s, 'one');
    s.clock.advance(5);
    const b = msg(s, 'two');
    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.prevHash).toBe(a.hash);
    expect(s.events.head()).toEqual({ seq: 2, hash: b.hash });
    s.close();
  });
});

describe('immutability', () => {
  it('rejects UPDATE on events at the database level', () => {
    const s = createTestSubstrate();
    msg(s, 'original');
    expect(() => s.storage.run("UPDATE events SET payload = '{}' WHERE seq = 1")).toThrow(
      /append-only/,
    );
    s.close();
  });

  it('rejects DELETE on events at the database level', () => {
    const s = createTestSubstrate();
    msg(s, 'original');
    expect(() => s.storage.run('DELETE FROM events WHERE seq = 1')).toThrow(/append-only/);
    s.close();
  });
});

describe('verifyChain', () => {
  it('passes on a clean log', () => {
    const s = createTestSubstrate();
    for (let i = 0; i < 50; i++) {
      s.clock.advance(1);
      msg(s, `m${i}`);
    }
    expect(s.events.verifyChain()).toMatchObject({ ok: true, checked: 50, problems: [] });
    s.close();
  });

  it('detects a tampered payload', () => {
    const s = createTestSubstrate();
    for (let i = 0; i < 5; i++) {
      s.clock.advance(1);
      msg(s, `m${i}`);
    }
    // Bypass the trigger the way a determined attacker with disk access would.
    const raw = (s.storage as unknown as { raw(): { exec(sql: string): void } }).raw();
    raw.exec('DROP TRIGGER events_no_update');
    raw.exec(`UPDATE events SET payload = '{"attachments":[],"text":"forged"}' WHERE seq = 3`);

    const result = s.events.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.seq === 3 && /hash mismatch/.test(p.problem))).toBe(true);
    s.close();
  });

  it('detects a forged hash, because the next event no longer links to it', () => {
    const s = createTestSubstrate();
    for (let i = 0; i < 5; i++) {
      s.clock.advance(1);
      msg(s, `m${i}`);
    }
    const raw = (s.storage as unknown as { raw(): { exec(sql: string): void } }).raw();
    raw.exec('DROP TRIGGER events_no_update');
    raw.exec(`UPDATE events SET hash = '${'f'.repeat(64)}' WHERE seq = 2`);

    const result = s.events.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.seq === 2 && /hash mismatch/.test(p.problem))).toBe(true);
    expect(result.problems.some((p) => p.seq === 3 && /broken link/.test(p.problem))).toBe(true);
    s.close();
  });

  it('detects a deleted row', () => {
    const s = createTestSubstrate();
    for (let i = 0; i < 5; i++) {
      s.clock.advance(1);
      msg(s, `m${i}`);
    }
    const raw = (s.storage as unknown as { raw(): { exec(sql: string): void } }).raw();
    raw.exec('DROP TRIGGER events_no_delete');
    raw.exec('DELETE FROM events WHERE seq = 3');

    const result = s.events.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => /sequence gap/.test(p.problem))).toBe(true);
    expect(result.problems.some((p) => /broken link/.test(p.problem))).toBe(true);
    s.close();
  });

  it('pages through a long log without changing its verdict', () => {
    const s = createTestSubstrate();
    for (let i = 0; i < 300; i++) {
      s.clock.advance(1);
      msg(s, `m${i}`);
    }
    expect(s.events.verifyChain(7).ok).toBe(true);
    expect(s.events.verifyChain(7).checked).toBe(300);
    s.close();
  });
});

describe('reads', () => {
  it('filters by seq range, session, run, type, correlation and trust', () => {
    const s = createTestSubstrate();
    const first = msg(s, 'a', 'sess-1');
    s.clock.advance(1);
    msg(s, 'b', 'sess-2');
    s.clock.advance(1);
    s.events.append({
      type: 'tool.succeeded',
      payload: { tool: 'read_file', durationMs: 12, resultTrust: 'TOOL', artifacts: [] },
      principal: 'tool:read_file',
      trust: 'TOOL',
      sessionId: 'sess-1',
      runId: 'run-1',
      correlationId: first.correlationId,
    });

    expect(s.events.read({ sessionId: 'sess-1' })).toHaveLength(2);
    expect(s.events.read({ runId: 'run-1' })).toHaveLength(1);
    expect(s.events.read({ types: ['message.user'] })).toHaveLength(2);
    expect(s.events.read({ correlationId: first.correlationId })).toHaveLength(2);
    expect(s.events.read({ fromSeq: 2, toSeq: 2 })).toHaveLength(1);
    // minTrust USER excludes the TOOL event.
    expect(s.events.read({ minTrust: 'USER' })).toHaveLength(2);
    expect(s.events.read({ minTrust: 'FOREIGN' })).toHaveLength(3);
    expect(s.events.read({ reverse: true, limit: 1 })[0]?.seq).toBe(3);
    s.close();
  });

  it('walks a causal chain and takes the minimum trust along it', () => {
    const s = createTestSubstrate();
    const user = msg(s, 'summarise this page');
    const fetched = s.events.append({
      type: 'tool.succeeded',
      payload: { tool: 'http', durationMs: 5, resultTrust: 'FOREIGN', artifacts: [] },
      principal: 'tool:http',
      trust: 'FOREIGN',
      sessionId: 'sess-1',
      causationId: user.id,
      correlationId: user.correlationId,
    });
    const derived = s.events.append({
      type: 'memory.observed',
      payload: { candidates: 2, episodeId: 'ep-1' },
      principal: 'system',
      trust: 'DERIVED',
      sessionId: 'sess-1',
      causationId: fetched.id,
      correlationId: user.correlationId,
    });

    const chain = s.events.causalClosure(derived.id);
    expect(chain.map((e) => e.type)).toEqual(['memory.observed', 'tool.succeeded', 'message.user']);
    // The derived event *claims* DERIVED, but its ancestry includes FOREIGN.
    const effective = chain.map((e) => e.trust);
    expect(effective).toContain('FOREIGN');
    s.close();
  });
});
