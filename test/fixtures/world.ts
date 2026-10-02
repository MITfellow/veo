import type { Substrate } from '../../src/substrate/index.js';
import type { FakeClock } from '../../src/substrate/clock.js';

/**
 * A deterministic synthetic history.
 *
 * Shaped like a real one rather than ten thousand copies of the same event:
 * sessions with runs inside them, tool calls, facts that later get superseded,
 * entities, failures. The rebuild test is only meaningful if the log exercises
 * every projector and every branch of the fact store.
 *
 * Fully seeded — no `Math.random`, no wall clock — so a failure is reproducible.
 */
export function seedWorld(
  s: Substrate & { clock: FakeClock },
  targetEvents: number,
): { sessions: string[]; facts: string[] } {
  let rng = 20260101;
  const next = (n: number): number => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    return rng % n;
  };

  const sessions: string[] = [];
  const facts: string[] = [];
  const people = ['Maya', 'Dev', 'Arjun', 'Priya', 'Sam'];
  const predicates = ['works_at', 'lives_in', 'prefers', 'is_allergic_to', 'reports_to'];
  const places = ['Acme', 'Globex', 'Initech', 'Bengaluru', 'Berlin'];

  let appended = 0;
  const budget = (): boolean => appended < targetEvents;
  const tick = (ms = 1000): void => void s.clock.advance(ms);

  let sessionIndex = 0;
  while (budget()) {
    const sessionId = `sess-${String(sessionIndex++).padStart(5, '0')}`;
    sessions.push(sessionId);

    s.events.append({
      type: 'session.created',
      payload: { title: null, source: 'cli' },
      principal: 'user:ara',
      trust: 'USER',
      sessionId,
    });
    appended++;
    tick();
    if (!budget()) break;

    const turns = 1 + next(4);
    for (let t = 0; t < turns && budget(); t++) {
      const user = s.events.append({
        type: 'message.user',
        payload: { text: `question ${t} in ${sessionId}`, attachments: [] },
        principal: 'user:ara',
        trust: 'USER',
        sessionId,
      });
      appended++;
      tick();
      if (!budget()) break;

      const runId = `run-${sessionId}-${t}`;
      s.events.append({
        type: 'run.started',
        payload: { trigger: 'user', sessionId },
        principal: 'system',
        trust: 'SYSTEM',
        sessionId,
        runId,
        causationId: user.id,
        correlationId: user.correlationId,
      });
      appended++;
      tick(50);
      if (!budget()) break;

      const steps = 1 + next(3);
      for (let i = 0; i < steps && budget(); i++) {
        const stepId = `${runId}-s${i}`;
        s.events.append({
          type: 'step.started',
          payload: { index: i, effectiveTrust: 'USER' },
          principal: 'system',
          trust: 'SYSTEM',
          sessionId,
          runId,
          stepId,
          correlationId: user.correlationId,
        });
        appended++;
        tick(10);
        if (!budget()) break;

        if (next(3) === 0) {
          s.events.append({
            type: 'tool.succeeded',
            payload: {
              tool: 'read_file',
              durationMs: 5 + next(90),
              resultTrust: 'TOOL',
              artifacts: [],
            },
            principal: 'tool:read_file',
            trust: 'TOOL',
            sessionId,
            runId,
            stepId,
            correlationId: user.correlationId,
          });
          appended++;
          tick(5);
          if (!budget()) break;
        }

        s.events.append({
          type: 'step.finished',
          payload: { index: i, outcome: i === steps - 1 ? 'finish' : 'tools', durationMs: 20 + next(80) },
          principal: 'system',
          trust: 'SYSTEM',
          sessionId,
          runId,
          stepId,
          correlationId: user.correlationId,
        });
        appended++;
        tick(10);
      }
      if (!budget()) break;

      s.events.append({
        type: 'model.responded',
        payload: {
          provider: 'fake',
          model: 'fake-1',
          outputTokens: 40 + next(400),
          finishReason: 'stop',
          latencyMs: 100 + next(900),
          costCents: 0.1,
        },
        principal: 'system',
        trust: 'SYSTEM',
        sessionId,
        runId,
        correlationId: user.correlationId,
      });
      appended++;
      tick();
      if (!budget()) break;

      s.events.append({
        type: 'message.agent',
        payload: { text: `answer ${t}`, finishReason: 'stop' },
        principal: 'system',
        trust: 'SYSTEM',
        sessionId,
        runId,
        correlationId: user.correlationId,
      });
      appended++;
      tick();
      if (!budget()) break;

      // Every eighth run fails instead of finishing: failure is data (§35.11).
      if (next(8) === 0) {
        s.events.append({
          type: 'run.failed',
          payload: { kind: 'tool_error', message: 'simulated failure', stepId: null },
          principal: 'system',
          trust: 'SYSTEM',
          sessionId,
          runId,
          correlationId: user.correlationId,
        });
      } else {
        s.events.append({
          type: 'run.finished',
          payload: { steps, tokens: 500, costCents: 0.2 },
          principal: 'system',
          trust: 'SYSTEM',
          sessionId,
          runId,
          correlationId: user.correlationId,
        });
      }
      appended++;
      tick();
      if (!budget()) break;

      // Memory: a new fact, sometimes superseding an older one.
      if (next(2) === 0) {
        const person = people[next(people.length)]!;
        const predicate = predicates[next(predicates.length)]!;
        const factId = `fact-${person}-${predicate}`;
        const isNew = !facts.includes(factId);
        if (isNew) facts.push(factId);

        if (!isNew) {
          s.events.append({
            type: 'memory.superseded',
            payload: {
              factId,
              supersededBy: `${factId}-v${appended}`,
              validTo: s.clock.now(),
            },
            principal: 'system',
            trust: 'DERIVED',
            sessionId,
            runId,
            correlationId: user.correlationId,
          });
          appended++;
          tick();
          if (!budget()) break;
        }

        s.events.append({
          type: 'memory.written',
          payload: {
            factId,
            subject: person,
            predicate,
            object: places[next(places.length)]!,
            basis: next(3) === 0 ? 'asserted_by_user' : 'observed',
            confidence: 0.5 + next(50) / 100,
            sources: [{ eventId: user.id, quote: `question ${t}` }],
            validFrom: s.clock.now(),
            validTo: null,
            stability: 'slow',
            sensitivity: 'normal',
            status: 'active',
          },
          principal: 'system',
          trust: 'DERIVED',
          sessionId,
          runId,
          correlationId: user.correlationId,
        });
        appended++;
        tick();
        if (!budget()) break;

        s.events.append({
          type: 'entity.upserted',
          payload: { entityId: `person-${person}`, kind: 'person', name: person, aliases: [] },
          principal: 'system',
          trust: 'DERIVED',
          sessionId,
          runId,
          correlationId: user.correlationId,
        });
        appended++;
        tick();
        if (!budget()) break;
      }

      if (next(10) === 0) {
        s.events.append({
          type: 'artifact.created',
          payload: {
            artifactId: `art-${appended}`,
            kind: 'text',
            bytes: 100 + next(9000),
            summary: 'generated during a run',
          },
          principal: 'system',
          trust: 'DERIVED',
          sessionId,
          runId,
          correlationId: user.correlationId,
        });
        appended++;
        tick();
      }
    }

    if (budget() && next(5) === 0) {
      s.events.append({
        type: 'session.archived',
        payload: { reason: 'inactive' },
        principal: 'user:ara',
        trust: 'USER',
        sessionId,
      });
      appended++;
      tick(3_600_000);
    }
  }

  return { sessions, facts };
}
