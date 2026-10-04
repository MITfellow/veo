import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, isEventType } from '../../src/substrate/events/types.js';
import { payloadSchema, registeredTypes } from '../../src/substrate/events/registry.js';

describe('event schemas (§15)', () => {
  it('the type union is closed and has no duplicates', () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
    expect(isEventType('session.started')).toBe(true);
    expect(isEventType('session.exploded')).toBe(false);
  });

  it('every registered schema belongs to the closed union', () => {
    // Guards the inverse mistake: a schema for a type nothing can ever emit.
    for (const type of registeredTypes()) expect(isEventType(type)).toBe(true);
  });

  it('accepts a valid payload', () => {
    const schema = payloadSchema('session.started');
    expect(schema?.safeParse({ channel: 'veo' }).success).toBe(true);
  });

  it('rejects an invalid payload', () => {
    const schema = payloadSchema('fact.asserted');
    const result = schema?.safeParse({ factId: 'f1', confidence: 5 });
    expect(result?.success).toBe(false);
  });

  it('rejects extra fields, because a projector would later depend on them', () => {
    const schema = payloadSchema('session.started');
    expect(schema?.safeParse({ channel: 'veo', sneaky: true }).success).toBe(false);
  });

  it('has no schema for a type whose milestone has not arrived', () => {
    // Decision 003: the type is nameable, the payload is not yet appendable.
    expect(payloadSchema('vault.unlocked')).toBeUndefined();
  });
});
