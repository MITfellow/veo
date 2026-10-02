/**
 * The persona (§29's `GET/PUT /persona`, decision 036).
 *
 * Three things in this system describe a person, and keeping them apart is
 * the whole design:
 *
 *   - the **constitution** is what the agent may and may not do;
 *   - the **identity card** is who the *user* is;
 *   - the **persona**, here, is how the agent sounds.
 *
 * It is small on purpose. Voice is a handful of decisions — what to call
 * the agent, how to address the person, how formal, how long, emoji or
 * not, which language — and everything beyond that belongs in the
 * constitution where it can be enforced rather than merely said.
 *
 * It is also **user-editable only**. There is no tool and no capability
 * that lets the agent rewrite its own voice; the reasoning is decision
 * 035's, one step further: an agent that can restyle itself in response to
 * content it has read is an agent whose tone is an injection surface.
 */
import { z } from 'zod';
import type { Clock, Storage } from '../../substrate/ports.js';
import type { EventLog } from '../../substrate/events/log.js';

/**
 * Voice is spent on every turn forever, so it is bounded — and bounded by
 * the *field lengths* rather than by truncating at render time, which is
 * the version a user can predict: the editor refuses the 41st character of
 * a name instead of the agent quietly dropping a sentence later. This
 * number is what the longest persona the schema permits actually costs,
 * asserted by a test so it cannot drift upward unnoticed.
 */
export const PERSONA_MAX_TOKENS = 200;

export const PersonaSchema = z.object({
  /** What the agent answers to. Empty means it does not introduce itself. */
  agentName: z.string().max(40),
  /** What it calls the user. Empty means it uses no name at all. */
  addressUser: z.string().max(40),
  formality: z.enum(['plain', 'warm', 'formal']),
  length: z.enum(['brief', 'normal', 'thorough']),
  emoji: z.boolean(),
  /** A BCP-47 tag, or 'match' to mirror whatever the user writes in. */
  language: z.string().max(32),
  /** One or two sentences of anything else. Voice, not rules. */
  notes: z.string().max(400),
});

export type Persona = z.infer<typeof PersonaSchema>;

export interface PersonaRecord extends Persona {
  version: number;
  updatedAt: number | null;
}

/**
 * The default is the plainest one. A new install should sound like a
 * careful colleague, not like a brand — and a default that is warm by
 * default is a default that flatters by default (§24).
 */
export const DEFAULT_PERSONA: Persona = {
  agentName: '',
  addressUser: '',
  formality: 'plain',
  length: 'normal',
  emoji: false,
  language: 'match',
  notes: '',
};

interface PersonaRow {
  principal: string;
  agent_name: string;
  address_user: string;
  formality: Persona['formality'];
  length: Persona['length'];
  emoji: number;
  language: string;
  notes: string;
  version: number;
  updated_at: number;
}

export interface PersonaDeps {
  storage: Storage;
  events: EventLog;
  clock: Clock;
}

export class PersonaStore {
  constructor(private readonly deps: PersonaDeps) {}

  /** Never null: an install with no persona has the default one. */
  get(principal: string): PersonaRecord {
    const row = this.deps.storage.get<PersonaRow>('SELECT * FROM personas WHERE principal = ?', [
      principal,
    ]);
    if (row === undefined) return { ...DEFAULT_PERSONA, version: 0, updatedAt: null };
    return {
      agentName: row.agent_name,
      addressUser: row.address_user,
      formality: row.formality,
      length: row.length,
      emoji: row.emoji === 1,
      language: row.language,
      notes: row.notes,
      version: row.version,
      updatedAt: row.updated_at,
    };
  }

  /**
   * A whole-document PUT, not a patch: the persona is six fields, and a
   * partial update of six fields is a merge nobody can reason about when
   * they later read the event back.
   */
  put(principal: string, next: Persona): PersonaRecord {
    const parsed = PersonaSchema.parse(next);
    const current = this.get(principal);
    const changed = (Object.keys(parsed) as Array<keyof Persona>).filter(
      (key) => parsed[key] !== current[key],
    );
    if (changed.length === 0) return current;

    this.deps.events.append({
      type: 'persona.updated',
      principal,
      // USER, always. The agent has no path to this event; see the header.
      trust: 'USER',
      payload: { persona: parsed, version: current.version + 1, changed },
    });
    return this.get(principal);
  }

  /** For the context: the persona as the model will see it. */
  lines(principal: string): string[] {
    return personaLines(this.get(principal));
  }
}

/**
 * Rendered as sentences, not as a JSON blob.
 *
 * A model reading `{"formality":"warm"}` has to infer what that means; a
 * model reading "Be warm, but never flattering" has been told. The second
 * also survives being read by the person whose agent it is, which is the
 * test that matters for anything in the context window.
 */
export function personaLines(persona: Persona): string[] {
  const lines: string[] = [];

  if (persona.agentName.trim() !== '') {
    lines.push(`- You are called ${persona.agentName.trim()}.`);
  }
  if (persona.addressUser.trim() !== '') {
    lines.push(`- Address the person as ${persona.addressUser.trim()}.`);
  }

  lines.push(
    {
      plain: '- Be plain and direct. No preamble, no sign-off, no enthusiasm you do not have.',
      warm: '- Be warm and conversational, but never flattering: warmth is in the phrasing, not in the verdict.',
      formal: '- Be formal and precise. Complete sentences, no contractions, no slang.',
    }[persona.formality],
  );

  lines.push(
    {
      brief: '- Answer in as few words as the question allows. One paragraph is usually too many.',
      normal: '- Match the length of the answer to the complexity of the question.',
      thorough:
        '- Be thorough: give the reasoning and the caveats, not only the conclusion.',
    }[persona.length],
  );

  if (!persona.emoji) lines.push('- Do not use emoji.');

  if (persona.language.trim() !== '' && persona.language !== 'match') {
    lines.push(`- Reply in ${persona.language}, whatever language the question is in.`);
  } else {
    lines.push('- Reply in whatever language the person writes in.');
  }

  if (persona.notes.trim() !== '') {
    // The user's own words, fenced by position rather than by markup: they
    // are the *last* line of the voice section, below the kernel's rules
    // and above nothing. They cannot reach the constitution from here —
    // the constitution block renders after this one and outranks it.
    lines.push(`- ${persona.notes.trim()}`);
  }

  return lines;
}

/** The projector-facing row shape, so `main.ts` does not build SQL. */
export function personaRowFrom(
  principal: string,
  persona: Persona,
  version: number,
  updatedAt: number,
  seq: number,
): Array<string | number> {
  return [
    principal,
    persona.agentName,
    persona.addressUser,
    persona.formality,
    persona.length,
    persona.emoji ? 1 : 0,
    persona.language,
    persona.notes,
    version,
    updatedAt,
    seq,
  ];
}
