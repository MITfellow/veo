/**
 * `persona.name` — the agent can be told what it is called (decision 043).
 *
 * This narrows decision 036, which said the persona is user-editable only
 * and gave the agent no tool at all. That was right about *voice* and wrong
 * about *names*, and the difference showed up the first time a real person
 * typed "your name is Jacky" and got told, flatly, that the agent had no
 * way to do that. It did have a way — a field in Settings, eight panels
 * down — so the refusal was both unhelpful and not quite true.
 *
 * Two fields only: what the agent is called, and what it calls the person.
 * Tone, length, emoji, language and notes stay in the UI, because those are
 * a voice being designed rather than a fact being stated, and a model that
 * can restyle itself in response to something it has read is an injection
 * surface (036's actual argument, which still holds for those fields).
 *
 * Safety here is a mechanism, not a promise. `persona:write` is granted to
 * USER and SYSTEM only, and effective trust is the minimum over a run — so
 * a turn that has read a web page, a file or a tool result is already below
 * USER and cannot reach this tool. The user saying a name in their own
 * message is the only path in.
 *
 * It is also `caution` rather than `safe`: visible and reversible, so by
 * the house rule the agent may do it, but it changes how the agent presents
 * itself and that is worth surfacing on the trust rail.
 */
import { z } from 'zod';
import type { Tool } from '../capability/tool.js';
import type { PersonaStore } from '../cognition/persona/store.js';

/**
 * 40 characters, matching `PersonaSchema` — the limit lives there and is
 * repeated here so the tool fails at its own boundary with a sentence a
 * model can act on, rather than throwing out of the store.
 */
const NAME = z.string().max(40);

const Input = z
  .object({
    /** What to call the agent. Empty string clears it. */
    agentName: NAME.optional(),
    /** What the agent should call the person. Empty string clears it. */
    addressUser: NAME.optional(),
  })
  .refine(
    (value) => value.agentName !== undefined || value.addressUser !== undefined,
    'give at least one of agentName or addressUser',
  );

const Output = z.object({
  agentName: z.string(),
  addressUser: z.string(),
  changed: z.array(z.string()),
});

export interface PersonaToolDeps {
  persona: PersonaStore;
}

export function personaName(
  deps: PersonaToolDeps,
): Tool<z.infer<typeof Input>, z.infer<typeof Output>> {
  return {
    name: 'persona.name',
    version: '1',
    description:
      'Sets what you are called and what you call the person you are talking to. ' +
      'Use this when they tell you your name ("your name is Jacky", "I will call you ' +
      'Ada") or how to address them ("call me Sam"). Pass an empty string to clear ' +
      'either one. It changes nothing else about how you speak; tone and length are ' +
      'the person\'s to set in Settings.',
    input: Input,
    output: Output,
    capabilities: ['persona:write'],
    // USER, not DERIVED. This is the whole guard: see the header.
    minTrust: 'USER',
    risk: 'caution',
    effect: 'local',
    // Setting the same name twice is the same world.
    idempotent: true,
    timeoutMs: 5000,

    execute(input, ctx) {
      const current = deps.persona.get(ctx.principal);
      const next = {
        agentName: input.agentName ?? current.agentName,
        addressUser: input.addressUser ?? current.addressUser,
        formality: current.formality,
        length: current.length,
        emoji: current.emoji,
        language: current.language,
        notes: current.notes,
      };

      const changed: string[] = [];
      if (next.agentName !== current.agentName) changed.push('agentName');
      if (next.addressUser !== current.addressUser) changed.push('addressUser');

      const saved = deps.persona.put(ctx.principal, next);
      return Promise.resolve({
        ok: true as const,
        value: {
          agentName: saved.agentName,
          addressUser: saved.addressUser,
          changed,
        },
        // The persona is a user statement about the user's own agent, so
        // what comes back out is USER, not DERIVED.
        trust: 'USER' as const,
      });
    },

    renderForModel(result) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      const { agentName, addressUser, changed } = result.value;
      if (changed.length === 0) {
        return { text: 'That was already set; nothing changed.', truncated: false };
      }
      // Phrased as what is now true, not as "ok". The model's next sentence
      // is going to be about the change, and it should not have to guess
      // whether the empty case means cleared or failed.
      const parts: string[] = [];
      if (changed.includes('agentName')) {
        parts.push(agentName === '' ? 'you no longer have a name' : `you are now called ${agentName}`);
      }
      if (changed.includes('addressUser')) {
        parts.push(
          addressUser === ''
            ? 'you no longer address them by name'
            : `you now address them as ${addressUser}`,
        );
      }
      return { text: `Saved: ${parts.join(', ')}.`, truncated: false };
    },
  };
}
