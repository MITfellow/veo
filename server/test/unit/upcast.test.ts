import { afterEach, describe, expect, it } from 'vitest';
import { registerUpcaster, resetUpcasters, upcast } from '../../src/substrate/events/migrations/index.js';
import { EventError } from '../../src/substrate/events/types.js';

afterEach(() => resetUpcasters());

describe('event upcasters (§15)', () => {
  it('reads a v1 payload fixture correctly after the shape moves on', () => {
    // The actual guarantee: a log written a year ago still reads today.
    registerUpcaster('message.sent', 1, (p) => ({ ...p, role: p['role'] ?? 'agent' }));
    const v1Fixture = { messageId: 'm1', content: 'hello' };
    expect(upcast('message.sent', 1, v1Fixture)).toEqual({ messageId: 'm1', content: 'hello', role: 'agent' });
  });

  it('chains one version at a time', () => {
    registerUpcaster('message.sent', 1, (p) => ({ ...p, a: 1 }));
    registerUpcaster('message.sent', 2, (p) => ({ ...p, b: 2 }));
    expect(upcast('message.sent', 1, {})).toEqual({ a: 1, b: 2 });
    expect(upcast('message.sent', 2, {})).toEqual({ b: 2 });
  });

  it('leaves a current-version payload untouched', () => {
    expect(upcast('session.started', 1, { channel: 'veo' })).toEqual({ channel: 'veo' });
  });

  it('refuses a payload from a NEWER build rather than guessing', () => {
    // A downgrade is a real situation. Guessing the shape is how silent
    // corruption starts.
    let caught: EventError | undefined;
    try {
      upcast('session.started', 7, {});
    } catch (error) {
      caught = error as EventError;
    }
    expect(caught?.kind).toBe('unknown_schema_version');
    expect(caught?.message).toMatch(/newer than the code/);
  });

  it('refuses when a step in the chain is missing', () => {
    registerUpcaster('message.sent', 2, (p) => p);
    expect(() => upcast('message.sent', 1, {})).toThrow(/No upcaster registered/);
  });
});
