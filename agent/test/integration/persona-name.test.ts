/**
 * S6 tests 67–78: the agent can be told its own name (decision 043).
 *
 * The bug these come from is in a real transcript: the user typed "your
 * name is Jacky" twice and was told twice that the agent had no way to do
 * that — while a Settings field for exactly that sat eight panels down.
 *
 * So the tests are split along the three claims decision 043 makes:
 *   - the tool works and is narrow (67–71),
 *   - it is reachable from a user's own sentence and from nowhere else
 *     (72–75) — this is the load-bearing group, because it is the whole
 *     reason it is safe to let the agent write here at all,
 *   - the name actually reaches the model afterwards (76–78), since a
 *     setting the agent never sees is the same as no setting.
 */
import { describe, expect, it } from 'vitest';
import { createTestSubstrate } from '../../src/substrate/index.js';
import { PersonaStore, personaLines } from '../../src/cognition/persona/store.js';
import { personaName } from '../../src/tools/persona-name.js';
import { ToolRegistry } from '../../src/capability/registry.js';
import { registerBuiltins } from '../../src/tools/index.js';
import { capabilitiesFor } from '../../src/security/trust.js';
import type { ToolContext } from '../../src/capability/tool.js';
import type { TrustLevel } from '../../src/substrate/events/types.js';

const USER = 'user:sameer';
const NOW = Date.UTC(2026, 9, 3);

function fixture() {
  const substrate = createTestSubstrate();
  const persona = new PersonaStore({
    storage: substrate.storage,
    events: substrate.events,
    clock: substrate.clock,
  });
  return { ...substrate, persona, tool: personaName({ persona }) };
}

const ctx = (trust: TrustLevel = 'USER'): ToolContext =>
  ({ principal: USER, now: () => NOW, effectiveTrust: trust }) as unknown as ToolContext;

describe('67–71: the tool sets a name, and only a name', () => {
  it('67. "your name is Jacky" ends with the agent called Jacky', async () => {
    const f = fixture();
    const result = await f.tool.execute({ agentName: 'Jacky' }, ctx());

    expect(result.ok).toBe(true);
    expect(f.persona.get(USER).agentName).toBe('Jacky');
  });

  it('68. it writes an event, so the change is in the log like everything else', async () => {
    const f = fixture();
    const before = f.events.count();
    await f.tool.execute({ agentName: 'Jacky' }, ctx());

    expect(f.events.count()).toBe(before + 1);
    const [event] = f.events.read({ types: ['persona.updated'], limit: 5 });
    const payload = event?.payload as { changed: string[]; persona: { agentName: string } };
    expect(payload.changed).toEqual(['agentName']);
    expect(payload.persona.agentName).toBe('Jacky');
  });

  it('69. setting one field leaves the other five alone', async () => {
    const f = fixture();
    f.persona.put(USER, {
      agentName: '',
      addressUser: '',
      formality: 'formal',
      length: 'thorough',
      emoji: true,
      language: 'en-GB',
      notes: 'Mentions cricket too often.',
    });

    await f.tool.execute({ agentName: 'Jacky' }, ctx());

    const after = f.persona.get(USER);
    // The tool takes a patch, but the store takes a whole document. If the
    // patch were applied to the *default* persona rather than the current
    // one, naming the agent would silently reset its voice.
    expect(after).toMatchObject({
      agentName: 'Jacky',
      formality: 'formal',
      length: 'thorough',
      emoji: true,
      language: 'en-GB',
      notes: 'Mentions cricket too often.',
    });
  });

  it('70. "call me Sam" and "your name is Jacky" are different fields', async () => {
    const f = fixture();
    await f.tool.execute({ addressUser: 'Sam' }, ctx());
    await f.tool.execute({ agentName: 'Jacky' }, ctx());

    const after = f.persona.get(USER);
    expect(after.addressUser).toBe('Sam');
    expect(after.agentName).toBe('Jacky');
  });

  it('71. an empty patch is refused, and an empty string clears', async () => {
    const f = fixture();
    expect(f.tool.input.safeParse({}).success).toBe(false);

    await f.tool.execute({ agentName: 'Jacky' }, ctx());
    const cleared = await f.tool.execute({ agentName: '' }, ctx());
    expect(cleared.ok).toBe(true);
    expect(f.persona.get(USER).agentName).toBe('');
    if (cleared.ok) {
      // Cleared and failed must not read the same to the model.
      expect(f.tool.renderForModel(cleared, 100).text).toContain('no longer have a name');
    }
  });
});

describe('72–75: reachable from the user, and from nowhere else', () => {
  it('72. the tool requires USER trust', () => {
    const f = fixture();
    expect(f.tool.minTrust).toBe('USER');
  });

  it('73. DERIVED cannot hold persona:write — decision 043 rests on this', () => {
    // If this ever goes green for DERIVED, decision 036's injection
    // argument comes back in full and the tool must be withdrawn.
    expect(capabilitiesFor('DERIVED').has('persona:write')).toBe(false);
    expect(capabilitiesFor('TOOL').has('persona:write')).toBe(false);
    expect(capabilitiesFor('FOREIGN').has('persona:write')).toBe(false);
    expect(capabilitiesFor('USER').has('persona:write')).toBe(true);
    expect(capabilitiesFor('SYSTEM').has('persona:write')).toBe(true);
  });

  it('74. the capability ceiling still nests, so a drop in trust grants nothing', () => {
    const order: TrustLevel[] = ['SYSTEM', 'USER', 'DERIVED', 'TOOL', 'FOREIGN'];
    for (let i = 1; i < order.length; i++) {
      const weaker = capabilitiesFor(order[i]!);
      const stronger = capabilitiesFor(order[i - 1]!);
      for (const capability of weaker) {
        expect(stronger.has(capability)).toBe(true);
      }
    }
  });

  it('75. it is not a FOREIGN-reachable tool, and it declares an effect the gate can see', () => {
    const f = fixture();
    expect(f.tool.risk).toBe('caution');
    expect(f.tool.effect).toBe('local');
    // `caution` keeps it off the offline provider's arg-filling path, so a
    // greeting can never be parsed into a rename.
    expect(f.tool.risk).not.toBe('safe');
  });
});

describe('76–78: the name reaches the model', () => {
  it('76. a named agent is told its name in the persona lines', async () => {
    const f = fixture();
    await f.tool.execute({ agentName: 'Jacky', addressUser: 'Sameer' }, ctx());

    const lines = f.persona.lines(USER).join('\n');
    expect(lines).toContain('You are called Jacky.');
    expect(lines).toContain('Address the person as Sameer.');
  });

  it('77. an unnamed agent is told nothing, rather than told it is called ""', () => {
    const lines = personaLines({
      agentName: '',
      addressUser: '',
      formality: 'plain',
      length: 'normal',
      emoji: false,
      language: 'match',
      notes: '',
    }).join('\n');
    expect(lines).not.toContain('You are called');
    expect(lines).not.toContain('Address the person as');
  });

  it('78. the tool is registered only when the composition root supplies a store', () => {
    const bare = new ToolRegistry();
    registerBuiltins(bare);
    expect(bare.list().map((t) => t.name)).not.toContain('persona.name');

    const f = fixture();
    const wired = new ToolRegistry();
    registerBuiltins(wired, { persona: { persona: f.persona } });
    expect(wired.list().map((t) => t.name)).toContain('persona.name');
  });
});
