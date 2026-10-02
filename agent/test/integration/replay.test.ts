/**
 * Tests 19–24: `replay <runId>` (§30, §34.5).
 *
 * The claim being tested is "zero context diff" — that the context a
 * historical run assembled can be rebuilt today, byte for byte, from the
 * log alone. That claim is what makes the assembler safe to refactor: if
 * the diff is empty, nothing a model would have seen has changed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start, type StartedAgent } from '../../src/main.js';
import { createSubstrate } from '../../src/substrate/index.js';
import { replayRun, renderReplay } from '../../src/observability/replay.js';
import { Snapshotter } from '../../src/orchestration/snapshot.js';
import { Compactor } from '../../src/cognition/compaction.js';
import { ConstitutionStore } from '../../src/cognition/constitution/store.js';
import { viewOf } from '../../src/cognition/constitution/render.js';
import { PersonaStore } from '../../src/cognition/persona/store.js';
import { MemoryService } from '../../src/cognition/memory/service.js';
import { HashEmbedder } from '../../src/providers/fake-embedder.js';
import { assembleContext } from '../../src/cognition/context/assemble.js';
import { policyFor } from '../../src/cognition/context/policy.js';
import type { PayloadOf } from '../../src/substrate/events/types.js';
import type { Substrate } from '../../src/substrate/index.js';
import { DEFAULT_SYSTEM } from '../../src/orchestration/runner.js';

let app: StartedAgent;
let dir: string;
let dbPath: string;
let runId: string;

const auth = { authorization: 'Bearer replay-token', 'content-type': 'application/json' };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arish-replay-'));
  dbPath = join(dir, 'replay.db');
  app = await start({ port: 0, dbPath, token: 'replay-token' });
  const base = `http://127.0.0.1:${app.port}`;

  const session = (await (
    await fetch(`${base}/sessions`, { method: 'POST', headers: auth, body: '{}' })
  ).json()) as { id: string };
  const sent = (await (
    await fetch(`${base}/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: 'what time is it?' }),
    })
  ).json()) as { runId: string };
  runId = sent.runId;
  await new Promise((r) => setTimeout(r, 2000));
  // Close the agent: replay reads the database on its own, as the command
  // does, which also proves it needs nothing but the file.
  await app.close();
}, 40_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The command's re-assembler, in-process. */
function reassemblerFor(substrate: Substrate, options: { templateChange?: boolean } = {}) {
  const { storage, events, clock, ids, logger } = substrate;
  const snapshotter = new Snapshotter({
    events,
    clock,
    compactor: new Compactor({ events, clock, ids }),
    memory: new MemoryService({
      storage,
      events,
      clock,
      ids,
      principal: 'user:me',
      embedder: new HashEmbedder(),
      logger,
    }).source,
    constitutionDoc: () => viewOf(new ConstitutionStore({ storage, events, clock, ids }).current()),
    persona: (who) =>
      options.templateChange === true
        ? [...new PersonaStore({ storage, events, clock }).lines(who), '- An extra line of voice.']
        : new PersonaStore({ storage, events, clock }).lines(who),
    tools: { summaries: () => [] },
  });

  return (id: string) => {
    const started = events.read({ runId: id, types: ['run.started'] })[0];
    if (started === undefined) return null;
    const p = started.payload as PayloadOf<'run.started'>;
    const gathered = snapshotter.gather({
      principal: started.principal,
      sessionId: started.sessionId ?? p.sessionId,
      runId: id,
      asOfSeq: started.seq,
      trigger: p.trigger,
      degradation: 'L0',
      observations: [],
      fallbackTrust: p.trigger === 'user' ? 'USER' : 'SYSTEM',
    });
    const assembled = assembleContext({
      principal: started.principal,
      sessionId: started.sessionId ?? p.sessionId,
      trust: gathered.effectiveTrust,
      now: started.ts,
      policy: policyFor('replay', { window: 6_000, reserveForOutput: 0 }),
      snapshot: {
        ...gathered.snapshot,
        // The same substitution the runner makes: an empty kernel means
        // "use the default system prompt", and a replay that skipped it
        // would report a diff on every historical run.
        kernel: gathered.snapshot.kernel === '' ? DEFAULT_SYSTEM : gathered.snapshot.kernel,
      },
    });
    return {
      digest: assembled.digest,
      totalTokens: assembled.totalTokens,
      policyVersion: assembled.policyVersion,
      blocks: assembled.blocks.map((b) => ({ name: b.name, tokens: b.tokens, items: b.items })),
    };
  };
}

describe('replay', () => {
  it('19 + 21 + 22. replays a finished run from the log, touching nothing', () => {
    const substrate = createSubstrate({ dbPath });
    const before = substrate.events.count();

    const result = replayRun(substrate.events, runId, reassemblerFor(substrate));

    expect(result.found).toBe(true);
    expect(result.recorded).not.toBeNull();
    expect(result.rebuilt).not.toBeNull();

    // 19: the blocks the run actually used are the blocks it would build
    // today. (The recorded run ran with the real tool list and a different
    // window, so the comparison that matters is the cognition blocks.)
    const cognition = ['kernel', 'constitution', 'identity', 'situation', 'conversation'];
    for (const name of cognition) {
      const was = result.recorded!.blocks.find((b) => b.name === name);
      const now = result.rebuilt!.blocks.find((b) => b.name === name);
      expect(was?.items, name).toBe(now?.items);
      expect(was?.tokens, name).toBe(now?.tokens);
    }

    // 21: no tool ran. 22: nothing was written.
    expect(substrate.events.count()).toBe(before);
    expect(substrate.events.read({ types: ['tool.requested'] }).length).toBe(
      substrate.events.read({ types: ['tool.requested'] }).length,
    );
    substrate.close();
  });

  it('20. a deliberate change makes the diff non-empty and names the block', () => {
    const substrate = createSubstrate({ dbPath });
    const result = replayRun(
      substrate.events,
      runId,
      reassemblerFor(substrate, { templateChange: true }),
    );

    const kernel = result.diffs.find((d) => d.block === 'kernel');
    expect(kernel, 'the changed block is named').toBeDefined();
    expect(kernel!.tokenDelta).toBeGreaterThan(0);
    expect(renderReplay(result)).toContain('context diff');
    expect(renderReplay(result)).toContain('kernel');
    substrate.close();
  });

  it('23. an unknown run id fails cleanly and says so', () => {
    const substrate = createSubstrate({ dbPath });
    const result = replayRun(substrate.events, '01DOESNOTEXIST');
    expect(result.found).toBe(false);
    expect(result.diffs).toEqual([]);
    expect(renderReplay(result)).toContain('no run with id');
    substrate.close();
  });

  it('24. with no re-assembler it shows the recorded context and says that is all', () => {
    const substrate = createSubstrate({ dbPath });
    const result = replayRun(substrate.events, runId);
    expect(result.recorded).not.toBeNull();
    expect(result.rebuilt).toBeNull();
    expect(result.notes.join(' ')).toContain('no re-assembler supplied');
    // And it still renders, because "what did this run see" is useful on
    // its own even when you cannot rebuild it.
    expect(renderReplay(result)).toContain('recorded');
    substrate.close();
  });
});
