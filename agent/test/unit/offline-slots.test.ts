/**
 * The offline provider's slot filling (S3, part 1).
 *
 * Before S3 the provider skipped any tool with a required argument, so
 * on the default configuration — no API key, which is how the app boots
 * out of the box — only the four zero-argument tools were reachable and
 * nineteen others were dead code with a passing unit test each.
 *
 * These tests pin the two things that make the fix safe rather than
 * merely clever: it is driven by the JSON schema alone (so a tool added
 * tomorrow is callable with no change here, invariant 9), and it never
 * guesses its way into a write.
 */
import { describe, expect, it } from 'vitest';
import { OfflineProvider } from '../../src/providers/offline.js';
import type { ModelChunk, ModelToolSpec } from '../../src/substrate/model/types.js';
import { ToolRegistry } from '../../src/capability/registry.js';
import { registerBuiltins } from '../../src/tools/index.js';

async function collect(stream: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const out: ModelChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

/** The first tool call the provider makes, if it makes one. */
async function callFor(
  asked: string,
  tools: ModelToolSpec[],
): Promise<{ name: string; input: Record<string, unknown> } | undefined> {
  const chunks = await collect(
    new OfflineProvider().generate(
      { model: 'offline', messages: [{ role: 'user', content: asked }], tools },
      new AbortController().signal,
    ) as AsyncIterable<ModelChunk>,
  );
  const call = chunks.find((chunk) => chunk.type === 'tool-call');
  return call === undefined
    ? undefined
    : (call as unknown as { name: string; input: Record<string, unknown> });
}

const safe = { risk: 'safe', effect: 'pure' } as const;

describe('the offline provider fills arguments from the schema', () => {
  it('fills a string slot with the question, which is what a search wants', async () => {
    const call = await callFor('search my messages about the mortgage paperwork', [
      {
        name: 'conversation.search',
        description: 'Search the messages in past conversations for a phrase.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        ...safe,
      },
    ]);
    expect(call?.name).toBe('conversation.search');
    expect(String(call?.input.query)).toContain('mortgage');
  });

  it('prefers a quoted span, because quoting is the user being explicit', async () => {
    const call = await callFor('search my messages for "the blue folder" please', [
      {
        name: 'conversation.search',
        description: 'Search the messages in past conversations for a phrase.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        ...safe,
      },
    ]);
    expect(call?.input.query).toBe('the blue folder');
  });

  it('fills a number slot from the first number in the question', async () => {
    const call = await callFor('convert 42 kilometres into miles', [
      {
        name: 'unit.convert',
        description: 'Convert a quantity between units of length, mass or temperature.',
        parameters: {
          type: 'object',
          properties: {
            value: { type: 'number' },
            from: { type: 'string', enum: ['kilometres', 'miles'] },
            to: { type: 'string', enum: ['kilometres', 'miles'] },
          },
          required: ['value', 'from', 'to'],
        },
        ...safe,
      },
    ]);
    expect(call?.input.value).toBe(42);
  });

  it('fills an enum slot only with a member the question actually names', async () => {
    const call = await callFor('convert 42 kilometres into miles', [
      {
        name: 'unit.convert',
        description: 'Convert a quantity between units of length, mass or temperature.',
        parameters: {
          type: 'object',
          properties: {
            value: { type: 'number' },
            from: { type: 'string', enum: ['kilometres', 'miles'] },
          },
          required: ['value', 'from'],
        },
        ...safe,
      },
    ]);
    expect(call?.input.from).toBe('kilometres');
  });

  it('abandons the whole call when one slot cannot be filled', async () => {
    // Half a call is worse than none: zod rejects it and the person
    // reads the tool error as the agent crashing.
    const call = await callFor('convert something into furlongs', [
      {
        name: 'unit.convert',
        description: 'Convert a quantity between units of length, mass or temperature.',
        parameters: {
          type: 'object',
          properties: {
            value: { type: 'number' },
            from: { type: 'string' },
          },
          required: ['value', 'from'],
        },
        ...safe,
      },
    ]);
    expect(call).toBeUndefined();
  });

  it('gives up on a boolean rather than guessing which way the user meant it', async () => {
    const call = await callFor('expand the history of this conversation in detail', [
      {
        name: 'history.expand',
        description: 'Expand the history of a conversation in detail.',
        parameters: {
          type: 'object',
          properties: { verbose: { type: 'boolean' } },
          required: ['verbose'],
        },
        ...safe,
      },
    ]);
    expect(call).toBeUndefined();
  });

  it('still calls a zero-argument tool, which is all it could do before', async () => {
    const call = await callFor('what time is it?', [
      {
        name: 'clock.now',
        description: 'The time and date right now, as the user would read it.',
        parameters: { type: 'object', properties: {} },
        ...safe,
      },
    ]);
    expect(call).toMatchObject({ name: 'clock.now', input: {} });
  });
});

describe('the offline provider stays name-blind', () => {
  it('contains no literal tool name anywhere in its source', async () => {
    // Invariant 9: the registry is the only place tool names live. This
    // provider sits below L5 and must not recognise one. Slot filling
    // is exactly the kind of feature that tempts a lookup table.
    //
    // Checked against the live roster rather than a copied list, so
    // tool #24 is covered the day it is registered.
    const { readFile } = await import('node:fs/promises');
    const source: string = await readFile(new URL('../../src/providers/offline.ts', import.meta.url), 'utf8');
    const code = source
      // Comments explain the history, and the history names the tools
      // that went wrong. Only executable lines are under the rule.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    // `registerBuiltins` with no deps registers only the tools that
    // need no live store; the rest are registered by the composition
    // root. So the roster is topped up by scanning the tool sources
    // for declared names, which covers all of them either way.
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    const roster = new Set(registry.list().map((tool) => tool.name));
    const toolsDir = new URL('../../src/tools/', import.meta.url);
    const { readdir } = await import('node:fs/promises');
    for (const file of await readdir(toolsDir)) {
      if (!file.endsWith('.ts')) continue;
      const text = await readFile(new URL(file, toolsDir), 'utf8');
      for (const match of text.matchAll(/name:\s*'([a-z]+\.[a-z]+)'/g)) roster.add(match[1]!);
    }

    expect(roster.size).toBeGreaterThan(20);
    for (const name of roster) expect(code).not.toContain(name);
  });

  it('calls a tool invented in this test, with no provider change', async () => {
    // The plugin contract, at the provider: a tool nobody has ever seen
    // is reachable purely from its description and schema.
    const call = await callFor('what is the rainfall in Shillong', [
      {
        name: 'weather.rainfall',
        description: 'Rainfall for a named place.',
        parameters: {
          type: 'object',
          properties: { place: { type: 'string' } },
          required: ['place'],
        },
        ...safe,
      },
    ]);
    expect(call?.name).toBe('weather.rainfall');
    expect(String(call?.input.place)).toContain('shillong');
  });
});

describe('the offline provider will not guess its way into a write', () => {
  const cancel: ModelToolSpec = {
    name: 'calendar.cancel',
    // The real description. "there" in it is what used to match the
    // greeting below.
    description: 'Cancel an event by id. Confirm first — this removes something they put there.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    risk: 'dangerous',
    effect: 'local',
  };

  it('does not answer a greeting by cancelling something', async () => {
    // This is not hypothetical: the first draft of the slot filler did
    // exactly this, turning "hello there" into a dangerous approval
    // against an event id of "hello there".
    expect(await callFor('hello there', [cancel])).toBeUndefined();
  });

  it('refuses a dangerous tool even when the question matches it well', async () => {
    expect(await callFor('cancel the event and remove it from my calendar', [cancel])).toBeUndefined();
  });

  it('refuses a caution-risk writing tool too', async () => {
    const call = await callFor('write a note about the kitchen renovation', [
      {
        name: 'notes.write',
        description: 'Write a note into the notebook under a name.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' }, text: { type: 'string' } },
          required: ['name', 'text'],
        },
        risk: 'caution',
        effect: 'local',
      },
    ]);
    expect(call).toBeUndefined();
  });

  it('refuses a tool that leaves the machine, however safe it calls itself', async () => {
    const call = await callFor('fetch the page about rainfall', [
      {
        name: 'net.fetch',
        description: 'Fetch a page from the network.',
        parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        risk: 'safe',
        effect: 'external',
      },
    ]);
    expect(call).toBeUndefined();
  });

  it('treats a spec with no risk stated as dangerous', async () => {
    // Absent is not "safe". A tool spec built by some future caller
    // that forgets the field should fall out of reach, not into it.
    const call = await callFor('what time is it?', [
      {
        name: 'clock.now',
        description: 'The time and date right now.',
        parameters: { type: 'object', properties: {} },
      },
    ]);
    expect(call).toBeUndefined();
  });
});

describe('the offline provider picks between tools sensibly', () => {
  const clock: ModelToolSpec = {
    name: 'clock.now',
    description: 'The time and date right now.',
    parameters: { type: 'object', properties: {} },
    ...safe,
  };
  // A deliberately wordy description, which under the old raw-overlap
  // score beat every other tool on almost every question.
  const wordy: ModelToolSpec = {
    name: 'memory.recall',
    description:
      'Recall stored facts about the person, their preferences, their family, their work, ' +
      'their health, their time, their dates, their plans, their notes and their messages.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    ...safe,
  };

  it('does not let the wordiest description win the time question', async () => {
    const call = await callFor('what is the time right now?', [wordy, clock]);
    expect(call?.name).toBe('clock.now');
  });

  it('answers a greeting with silence even when the tool is a harmless read', async () => {
    // The risk gate is not the only defence: a greeting must not turn
    // into a search for the word "hello" either.
    const search: ModelToolSpec = {
      name: 'conversation.search',
      description: 'Search past messages. Finds what they said and where they put it there.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      ...safe,
    };
    expect(await callFor('hello there', [search, clock])).toBeUndefined();
    expect(await callFor('good morning!', [search, clock])).toBeUndefined();
  });

  it('calls nothing at all when the question matches nothing', async () => {
    expect(await callFor('what do you think of my plan?', [clock, wordy])).toBeUndefined();
  });
});
