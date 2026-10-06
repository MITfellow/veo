import { describe, expect, it } from 'vitest';
import { createTestSubstrate } from '../fakes/substrate.js';
import { snapshotDigest, diffSnapshots } from '../../src/substrate/projections/index.js';
import { BrowserState, actInSession, startSession, resetSession } from '../../src/interface/browser-api.js';
import { DEMO_PAGES } from '../../src/capability/browser/pages.js';
import { must } from '../fakes/must.js';

/**
 * A hundred browsing sessions, through the real stack, into the real log.
 *
 * The point is not throughput. The point is that the §58 gate — append,
 * drop every projection, replay, get byte-identical bytes — still holds
 * once browsing is the thing producing the events. A projector that minted
 * an id, read a clock, or depended on anything outside the event would
 * pass every unit test in this repository and fail here.
 */

const SESSIONS = 100;

interface Harness {
  substrate: ReturnType<typeof createTestSubstrate>;
  browser: BrowserState;
  close: () => void;
}

function harness(): Harness {
  const substrate = createTestSubstrate();
  const browser = new BrowserState({
    now: () => substrate.clock.now(),
    digest: (input) => substrate.crypto.sha256(input),
    nextId: () => substrate.ids.ulid(),
    append: (event) => {
      substrate.events.append(event);
    },
  });
  return { substrate, browser, close: () => substrate.close() };
}

const originOf = (url: string): string => must(/^(https?:\/\/[^/]+)/.exec(url)?.[1], `origin of ${url}`);

/**
 * One session's worth of work, chosen deterministically from its index.
 *
 * Every session reads a page; a third of them wander off-origin and get
 * refused; a quarter carry private data into a submission and trip the
 * Rule of Two. That mix matters — a scale test where nothing is ever
 * refused only proves the happy path scales.
 */
async function runSession(browser: BrowserState, index: number): Promise<void> {
  const page = must(DEMO_PAGES[index % DEMO_PAGES.length], 'demo page');
  const origin = originOf(page.url);
  const carriesPrivateData = index % 4 === 0;

  startSession(browser, {
    plan: {
      goal: `session ${index}`,
      allowedKinds: ['navigate', 'read', 'click', 'submit'],
      maxSteps: 6,
      allowedOrigins: [origin],
      carriesPrivateData,
    },
    autonomy: 4,
  });

  await actInSession(browser, { action: { kind: 'navigate', url: page.url } });
  await actInSession(browser, { action: { kind: 'read' } });

  if (index % 3 === 0) {
    await actInSession(browser, { action: { kind: 'navigate', url: 'https://evil.example/collect' } });
  }
  if (carriesPrivateData) {
    await actInSession(browser, { action: { kind: 'submit', formIndex: 0 } });
  }
  resetSession(browser);
}

describe(`${SESSIONS} browsing sessions`, () => {
  it('replays to byte-identical projections', async () => {
    const { substrate, browser, close } = harness();

    for (let i = 0; i < SESSIONS; i++) await runSession(browser, i);

    const events = substrate.events.count();
    expect(events).toBeGreaterThan(SESSIONS * 5);

    const before = snapshotDigest(substrate.storage, substrate.crypto);

    // Drop everything a projection owns, then rebuild from the log alone.
    for (const projector of substrate.events.projectors()) projector.reset(substrate.storage);
    const rebuilt = substrate.events.rebuild();
    expect(rebuilt.events).toBe(events);

    const after = snapshotDigest(substrate.storage, substrate.crypto);
    // The per-table diff first, so a failure names the projection that
    // drifted instead of just saying the bytes differ.
    expect(diffSnapshots(before, after)).toEqual([]);
    expect(after.digest).toBe(before.digest);
    expect(after.tables['tool_calls']?.rows).toBeGreaterThan(SESSIONS * 2);
    close();
  });

  it('keeps the hash chain intact across every session', async () => {
    const { substrate, browser, close } = harness();
    for (let i = 0; i < SESSIONS; i++) await runSession(browser, i);
    expect(substrate.events.verifyChain()).toMatchObject({ ok: true });
    close();
  });

  it('every run is opened and closed — no run is left dangling', async () => {
    const { substrate, browser, close } = harness();
    for (let i = 0; i < SESSIONS; i++) await runSession(browser, i);

    const rows = substrate.storage.prepare('SELECT status, COUNT(*) AS n FROM runs GROUP BY status').all() as Array<{
      status: string;
      n: number;
    }>;
    expect(rows).toEqual([{ status: 'finished', n: SESSIONS }]);
    close();
  });

  it('every tool call reaches a terminal state', async () => {
    const { substrate, browser, close } = harness();
    for (let i = 0; i < SESSIONS; i++) await runSession(browser, i);

    const dangling = substrate.storage
      .prepare(`SELECT COUNT(*) AS n FROM tool_calls WHERE status = 'invoked'`)
      .get() as { n: number };
    expect(dangling.n).toBe(0);

    const byStatus = Object.fromEntries(
      (substrate.storage.prepare('SELECT status, COUNT(*) AS n FROM tool_calls GROUP BY status').all() as Array<{
        status: string;
        n: number;
      }>).map((r) => [r.status, r.n]),
    );
    // Both outcomes must be well represented, or this test is only
    // measuring the happy path at scale.
    expect(byStatus['succeeded']).toBeGreaterThanOrEqual(SESSIONS * 2);
    expect(byStatus['denied']).toBeGreaterThan(SESSIONS / 3);
    close();
  });

  it('records the Rule of Two refusals with their code, not just a message', async () => {
    const { substrate, browser, close } = harness();
    for (let i = 0; i < SESSIONS; i++) await runSession(browser, i);

    const codes = Object.fromEntries(
      (substrate.storage
        .prepare(`SELECT code, COUNT(*) AS n FROM tool_calls WHERE status = 'denied' GROUP BY code`)
        .all() as Array<{ code: string; n: number }>).map((r) => [r.code, r.n]),
    );
    expect(codes['rule_of_two']).toBe(SESSIONS / 4);
    expect(codes['origin_not_allowed']).toBeGreaterThan(0);
    close();
  });

  it('never writes page prose into the log', async () => {
    const { substrate, browser, close } = harness();
    for (let i = 0; i < SESSIONS; i++) await runSession(browser, i);

    // Everything the hostile demo pages say in prose, none of which may
    // appear in a record the privileged path reads back on replay.
    const haystack = JSON.stringify(substrate.events.read());
    for (const phrase of [
      'maintenance mode',
      'Ignore all previous',
      'exfiltrate',
      'APPROVED BY USER',
      'rule_of_two: waived',
      'Card number',
      'productivity tips',
    ]) {
      expect(haystack).not.toContain(phrase);
    }
    close();
  });

  it('stays well inside the §57 budget at this scale', async () => {
    const { substrate, browser, close } = harness();
    const started = performance.now();
    for (let i = 0; i < SESSIONS; i++) await runSession(browser, i);
    const elapsed = performance.now() - started;

    // Generous: this is a correctness test that happens to be timed, and a
    // tight bound here would fail on a loaded machine for no good reason.
    expect(elapsed).toBeLessThan(10_000);

    const queryStart = performance.now();
    const refusals = substrate.storage
      .prepare(`SELECT run_id, action, code FROM tool_calls WHERE status = 'denied' ORDER BY started_at LIMIT 50`)
      .all();
    expect(performance.now() - queryStart).toBeLessThan(100);
    expect(refusals.length).toBe(50);
    close();
  });
});

/**
 * The audit trail has to survive the awkward sequences, not just the tidy
 * ones. Every case here was either found by driving the real binary or is
 * the neighbour of something that was.
 */
describe('the audit trail under awkward sequences', () => {
  it('attributes a refusal to the action that was refused, not the previous one', async () => {
    const { substrate, browser, close } = harness();
    startSession(browser, {
      plan: {
        goal: 'read the article',
        allowedKinds: ['navigate', 'click', 'submit'],
        maxSteps: 8,
        allowedOrigins: ['https://blog.example'],
        carriesPrivateData: true,
      },
      autonomy: 4,
    });
    await actInSession(browser, { action: { kind: 'navigate', url: 'https://blog.example/injection' } });
    // Permitted by the gate, then refused once the href is known.
    await actInSession(browser, { action: { kind: 'click', ref: 'e2' } });
    // Refused by the gate itself.
    await actInSession(browser, { action: { kind: 'submit', formIndex: 0 } });

    const rows = substrate.storage
      .prepare('SELECT action, status, code FROM tool_calls ORDER BY started_at')
      .all() as Array<{ action: string; status: string; code: string | null }>;

    expect(rows).toEqual([
      { action: 'open https://blog.example/injection', status: 'succeeded', code: null },
      { action: 'click e2', status: 'denied', code: 'origin_not_allowed' },
      { action: 'submit form 0', status: 'denied', code: 'rule_of_two' },
    ]);
    close();
  });

  it('closes a run even when the session is abandoned mid-plan', async () => {
    const { substrate, browser, close } = harness();
    startSession(browser, {
      plan: { goal: 'a', allowedKinds: ['navigate'], maxSteps: 4, allowedOrigins: ['https://docs.example'], carriesPrivateData: false },
      autonomy: 2,
    });
    await actInSession(browser, { action: { kind: 'navigate', url: 'https://docs.example/guide' } });
    // A second plan replaces the first without anyone ending it.
    startSession(browser, {
      plan: { goal: 'b', allowedKinds: ['navigate'], maxSteps: 4, allowedOrigins: ['https://docs.example'], carriesPrivateData: false },
      autonomy: 2,
    });
    resetSession(browser);

    const runs = substrate.storage.prepare('SELECT status, stop_reason FROM runs ORDER BY started_at').all();
    expect(runs).toEqual([
      { status: 'finished', stop_reason: 'cancelled' },
      { status: 'finished', stop_reason: 'cancelled' },
    ]);
    close();
  });

  it('records the sealed plan before the first page is read', async () => {
    const { substrate, browser, close } = harness();
    startSession(browser, {
      plan: { goal: 'read', allowedKinds: ['navigate'], maxSteps: 4, allowedOrigins: ['https://docs.example'], carriesPrivateData: false },
      autonomy: 2,
    });
    await actInSession(browser, { action: { kind: 'navigate', url: 'https://docs.example/guide' } });

    const types = substrate.events.read().map((e) => e.type);
    expect(types.indexOf('run.planned')).toBeLessThan(types.indexOf('tool.invoked'));
    const planned = substrate.events.read().find((e) => e.type === 'run.planned');
    expect(planned?.payload['seal']).toMatch(/^[0-9a-f]{64}$/);
    close();
  });
});
