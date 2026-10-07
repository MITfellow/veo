import { describe, expect, it } from 'vitest';
import { createTestSubstrate, type TestSubstrate } from '../fakes/substrate.js';
import { WorldGraph, WorldError } from '../../src/capability/world/graph.js';
import type { Basis } from '../../src/capability/world/contracts.js';
import { scopePermits, winner, relationKindOf, relationPredicate, INVERSE, RELATION_KINDS } from '../../src/capability/world/contracts.js';
import { must, one } from '../fakes/must.js';

/**
 * Phase 2 — the Personal World Model.
 *
 * These tests are written as the questions a personal intelligence has to
 * answer, not as unit tests of a graph library. Several are lifted verbatim
 * from the brief's own acceptance scenarios (§140, §141, §159) so that
 * passing them means passing the thing that was asked for.
 */

function world(): { s: TestSubstrate; g: WorldGraph } {
  const s = createTestSubstrate();
  const g = new WorldGraph({
    storage: s.storage, events: s.events,
    now: () => s.clock.now(), nextId: () => s.ids.ulid(),
  });
  return { s, g };
}

describe('the vocabulary (Phase 1)', () => {
  it('round-trips every relation kind through its predicate', () => {
    for (const kind of RELATION_KINDS) {
      expect(relationKindOf(relationPredicate(kind))).toBe(kind);
    }
  });

  it('does not mistake an ordinary fact for a relation', () => {
    expect(relationKindOf('lives_in')).toBeUndefined();
    expect(relationKindOf('rel:NOT_A_REAL_KIND')).toBeUndefined();
  });

  it('keeps every inverse symmetric, so traversal cannot disagree with itself', () => {
    for (const [kind, inverse] of Object.entries(INVERSE)) {
      expect(INVERSE[must(inverse, 'inverse')]).toBe(kind);
    }
  });

  it('does not let an UNKNOWN scope act as a wildcard', () => {
    // The failure this prevents: a personal file reaching a work thread
    // because nobody had classified it yet.
    expect(scopePermits('WORK', 'UNKNOWN')).toBe(false);
    expect(scopePermits('UNKNOWN', 'PERSONAL')).toBe(false);
    expect(scopePermits('UNKNOWN', 'UNKNOWN')).toBe(true);
    expect(scopePermits('WORK', 'PUBLIC')).toBe(true);
    expect(scopePermits('WORK', 'PROJECT')).toBe(true);
    expect(scopePermits('PERSONAL', 'WORK')).toBe(false);
  });

  it('settles a disagreement by basis before recency', () => {
    const remembered: { basis: Basis; validFrom: number } = { basis: 'USER_ASSERTION', validFrom: 2000 };
    const verified: { basis: Basis; validFrom: number } = { basis: 'VERIFIED', validFrom: 1000 };
    // The older verified reading wins over the newer remembered sentence.
    expect(winner(remembered, verified)).toBe(verified);
    const newer: { basis: Basis; validFrom: number } = { basis: 'VERIFIED', validFrom: 3000 };
    expect(winner(verified, newer)).toBe(newer);
  });
});

describe('nodes', () => {
  it('is idempotent on (kind, name), so a mention does not fork the person', () => {
    const { s, g } = world();
    const first = g.node('person', 'Rahul Sharma', 'WORK');
    const second = g.node('person', 'Rahul Sharma', 'WORK');
    expect(second).toBe(first);
    expect(g.count().nodes).toBe(1);
    s.close();
  });

  it('keeps two people of the same name apart from a project of that name', () => {
    const { s, g } = world();
    const person = g.node('person', 'Atlas', 'WORK');
    const project = g.node('project', 'Atlas', 'WORK');
    expect(project).not.toBe(person);
    expect(must(g.get(person), 'person').kind).toBe('person');
    expect(must(g.get(project), 'project').kind).toBe('project');
    s.close();
  });

  it('stores a kind the entity table has never heard of', () => {
    const { s, g } = world();
    // 'commitment' is not one of the registry's five kinds. The world model
    // must not have to lie to the old column to store it.
    const id = g.node('commitment', 'send the report by Friday', 'WORK');
    expect(must(g.get(id), 'node').kind).toBe('commitment');
    s.close();
  });

  it('defaults to UNKNOWN scope rather than guessing one', () => {
    const { s, g } = world();
    const id = g.node('document', 'notes.md');
    expect(must(g.get(id), 'node').scope).toBe('UNKNOWN');
    s.close();
  });

  it('re-scopes as a correction, keeping the old scope in history', () => {
    const { s, g } = world();
    const id = g.node('document', 'q3-plan.md', 'PERSONAL');
    g.rescope(id, 'WORK', 'user said so');
    expect(must(g.get(id), 'node').scope).toBe('WORK');
    expect(g.claimsFor(id, 'world:scope').length).toBeGreaterThan(1);
    s.close();
  });
});

describe('edges', () => {
  it('refuses to relate a node that does not exist', () => {
    const { s, g } = world();
    const real = g.node('person', 'Ara', 'PERSONAL');
    expect(() => g.relate({
      from: real, kind: 'WORKS_ON', to: 'made-up-id',
      basis: 'OBSERVATION', scope: 'WORK', source: 'test', trust: 'USER',
    })).toThrow(WorldError);
    s.close();
  });

  it('is readable from both ends of the edge', () => {
    const { s, g } = world();
    const rahul = g.node('person', 'Rahul', 'WORK');
    const atlas = g.node('project', 'Atlas', 'WORK');
    g.relate({ from: rahul, kind: 'WORKS_ON', to: atlas, basis: 'OBSERVATION', scope: 'WORK', source: 'email', trust: 'TOOL' });

    // "What is Rahul on?" and "who is on Atlas?" are the same edge.
    expect(one(g.neighbours(rahul), (e) => e.kind === 'WORKS_ON', 'outbound').to).toBe(atlas);
    expect(one(g.neighbours(atlas), (e) => e.kind === 'WORKS_ON', 'inbound').from).toBe(rahul);
    s.close();
  });

  it('cannot launder an inference into a user-level relationship', () => {
    const { s, g } = world();
    const a = g.node('person', 'Rahul', 'WORK');
    const b = g.node('project', 'Atlas', 'WORK');
    const id = g.relate({
      from: a, kind: 'WORKS_ON', to: b,
      basis: 'INFERENCE', scope: 'WORK', source: 'guess', trust: 'USER',
    });
    // Asked for USER; an inference may hold DERIVED at most (§20, §68).
    const edge = one(g.neighbours(a), (e) => e.id === id, 'the edge');
    expect(edge.trust).toBe('DERIVED');
    s.close();
  });

  it('keeps an observation of a web page at FOREIGN, whatever it claims', () => {
    const { s, g } = world();
    const a = g.node('person', 'Rahul', 'WORK');
    const b = g.node('document', 'spec.pdf', 'WORK');
    g.relate({ from: a, kind: 'CREATED', to: b, basis: 'OBSERVATION', scope: 'WORK', source: 'web_page', trust: 'FOREIGN' });
    expect(one(g.neighbours(a), (e) => e.kind === 'CREATED', 'edge').trust).toBe('FOREIGN');
    s.close();
  });

  it('filters by the scope of the question', () => {
    const { s, g } = world();
    const me = g.node('user', 'Ara', 'PERSONAL');
    const workProject = g.node('project', 'Atlas', 'WORK');
    const holiday = g.node('project', 'Japan trip', 'PERSONAL');
    g.relate({ from: me, kind: 'WORKS_ON', to: workProject, basis: 'OBSERVATION', scope: 'WORK', source: 'calendar', trust: 'TOOL' });
    g.relate({ from: me, kind: 'WORKS_ON', to: holiday, basis: 'OBSERVATION', scope: 'PERSONAL', source: 'notes', trust: 'TOOL' });

    const atWork = g.neighbours(me, { scope: 'WORK' });
    expect(atWork.map((e) => e.to)).toEqual([workProject]);
    s.close();
  });

  it('stops believing a retracted edge without losing the record', () => {
    const { s, g } = world();
    const a = g.node('person', 'Rahul', 'WORK');
    const b = g.node('project', 'Atlas', 'WORK');
    const id = g.relate({ from: a, kind: 'WORKS_ON', to: b, basis: 'OBSERVATION', scope: 'WORK', source: 'email', trust: 'TOOL' });
    g.unrelate(id, 'he left the project');

    expect(g.neighbours(a)).toHaveLength(0);
    expect(g.count().edges).toBe(0);
    // The event is still there: an audit of what was believed must survive.
    expect(s.events.read().map((e) => e.type)).toContain('fact.retracted');
    s.close();
  });
});

describe('traversal — "the document John sent about the meeting" (§48)', () => {
  it('finds a path through the graph rather than guessing from text', () => {
    const { s, g } = world();
    const john = g.node('person', 'John', 'WORK');
    const message = g.node('message', 'thread #41', 'WORK');
    const doc = g.node('document', 'deployment-plan.md', 'WORK');
    const meeting = g.node('meeting', 'Deployment review', 'WORK');

    g.relate({ from: john, kind: 'SENT', to: message, basis: 'OBSERVATION', scope: 'WORK', source: 'email', trust: 'TOOL' });
    g.relate({ from: doc, kind: 'ATTACHED_TO', to: message, basis: 'OBSERVATION', scope: 'WORK', source: 'email', trust: 'TOOL' });
    g.relate({ from: message, kind: 'DISCUSSED_IN', to: meeting, basis: 'OBSERVATION', scope: 'WORK', source: 'calendar', trust: 'TOOL' });

    const path = must(g.path(john, doc), 'a path from John to the document');
    expect(path.length).toBeLessThanOrEqual(2);
    // Every hop carries its own evidence, so "how did you know" is answerable.
    for (const edge of path) expect(edge.source).not.toBe('');
    s.close();
  });

  it('refuses to connect two unrelated things through a long chain', () => {
    const { s, g } = world();
    const chain = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => g.node('thing', n, 'WORK'));
    for (let i = 0; i < chain.length - 1; i++) {
      g.relate({
        from: must(chain[i], 'from'), kind: 'RELATED_TO', to: must(chain[i + 1], 'to'),
        basis: 'INFERENCE', scope: 'WORK', source: 'guess', trust: 'DERIVED',
      });
    }
    // Six hops apart is a coincidence, not a relationship.
    expect(g.path(must(chain[0], 'first'), must(chain[5], 'last'), 3)).toBeUndefined();
    expect(g.path(must(chain[0], 'first'), must(chain[2], 'third'), 3)).toBeDefined();
    s.close();
  });
});

describe('current world vs memory — the brief\u2019s §140', () => {
  it('prefers the calendar over the remembered sentence', () => {
    const { s, g } = world();
    const meeting = g.node('meeting', 'presentation', 'WORK');

    // Monday: the user says it is on Friday.
    s.clock.set('2026-03-02T09:00:00.000Z');
    writeClaim(g, meeting, 'day', 'Friday', 'USER_ASSERTION', 'user');
    // Wednesday: the calendar is read, and it says Monday.
    s.clock.set('2026-03-04T09:00:00.000Z');
    writeClaim(g, meeting, 'day', 'Monday', 'VERIFIED', 'calendar');

    const now = must(g.current(meeting, 'day'), 'a current answer');
    expect(now.object).toBe('Monday');
    // And it says what it beat, rather than silently picking.
    expect(now.because).toMatch(/verified/);
    expect(now.because).toMatch(/Friday/);
    s.close();
  });

  it('does not let an inference beat an explicit statement (§14)', () => {
    const { s, g } = world();
    const user = g.node('user', 'Ara', 'PERSONAL');
    writeClaim(g, user, 'meeting_preference', 'afternoons', 'INFERENCE', 'behaviour');
    s.clock.advance(60_000);
    writeClaim(g, user, 'meeting_preference', 'mornings', 'USER_ASSERTION', 'user');
    expect(must(g.current(user, 'meeting_preference'), 'answer').object).toBe('mornings');
    s.close();
  });

  it('is honest when it has only an inference', () => {
    const { s, g } = world();
    const user = g.node('user', 'Ara', 'PERSONAL');
    writeClaim(g, user, 'meeting_preference', 'mornings', 'INFERENCE', 'behaviour');
    const claim = must(g.current(user, 'meeting_preference'), 'answer');
    expect(claim.basis).toBe('INFERENCE');
    expect(claim.because).toMatch(/only live claim/);
    s.close();
  });

  it('returns nothing rather than a guess when nothing is known', () => {
    const { s, g } = world();
    const user = g.node('user', 'Ara', 'PERSONAL');
    expect(g.current(user, 'favourite_colour')).toBeUndefined();
    s.close();
  });
});

describe('forgetting — the brief\u2019s §141', () => {
  it('detaches a person so no future retrieval can reach them', () => {
    const { s, g } = world();
    const rahul = g.node('person', 'Rahul', 'WORK');
    const atlas = g.node('project', 'Atlas', 'WORK');
    const message = g.node('message', 'thread #7', 'WORK');
    g.relate({ from: rahul, kind: 'WORKS_ON', to: atlas, basis: 'OBSERVATION', scope: 'WORK', source: 'email', trust: 'TOOL' });
    g.relate({ from: rahul, kind: 'SENT', to: message, basis: 'OBSERVATION', scope: 'WORK', source: 'email', trust: 'TOOL' });

    expect(g.forget(rahul, 'user asked')).toBe(2);
    expect(g.neighbours(rahul)).toHaveLength(0);
    // And he is gone from the other end too, not just from his own query.
    expect(g.neighbours(atlas)).toHaveLength(0);
    expect(g.current(rahul, 'world:scope')).toBeUndefined();
    s.close();
  });

  it('leaves an auditable trace of the forgetting itself', () => {
    const { s, g } = world();
    const rahul = g.node('person', 'Rahul', 'WORK');
    const atlas = g.node('project', 'Atlas', 'WORK');
    g.relate({ from: rahul, kind: 'WORKS_ON', to: atlas, basis: 'OBSERVATION', scope: 'WORK', source: 'email', trust: 'TOOL' });
    g.forget(rahul, 'user asked');

    const retractions = s.events.read().filter((e) => e.type === 'fact.retracted');
    expect(retractions.length).toBeGreaterThan(0);
    expect(JSON.stringify(retractions)).toContain('user asked');
    s.close();
  });
});

describe('the world is derived, not stored', () => {
  it('survives a projection rebuild unchanged', () => {
    const { s, g } = world();
    const me = g.node('user', 'Ara', 'PERSONAL');
    const atlas = g.node('project', 'Atlas', 'WORK');
    const rahul = g.node('person', 'Rahul', 'WORK');
    g.relate({ from: me, kind: 'WORKS_ON', to: atlas, basis: 'USER_ASSERTION', scope: 'WORK', source: 'user', trust: 'USER' });
    g.relate({ from: rahul, kind: 'WORKS_WITH', to: me, basis: 'OBSERVATION', scope: 'WORK', source: 'email', trust: 'TOOL' });

    const before = { count: g.count(), edges: g.neighbours(me) };
    s.events.rebuild();
    expect(g.count()).toEqual(before.count);
    expect(g.neighbours(me)).toEqual(before.edges);
    s.close();
  });
});

/** A claim that is not a relation: an ordinary bitemporal statement with a basis. */
function writeClaim(
  g: WorldGraph, subject: string, predicate: string, object: string,
  basis: 'INFERENCE' | 'OBSERVATION' | 'USER_ASSERTION' | 'VERIFIED', source: string,
): void {
  g.state(subject, predicate, object, { basis, scope: 'UNKNOWN', source, trust: 'USER' });
}
