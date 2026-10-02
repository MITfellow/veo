/**
 * The persona projection (decision 036).
 *
 * One row per principal, last write wins — the history lives in the log,
 * as always, so "what did my agent sound like in March" is answerable by
 * reading `persona.updated` events rather than by versioning the table.
 */
import type { Projector } from '../events/log.js';
import type { PayloadOf } from '../events/types.js';
import { personaRowFrom } from '../../cognition/persona/store.js';

export const personaProjector: Projector = {
  name: 'persona',
  version: 1,
  handles: ['persona.updated'],

  reset(storage) {
    storage.exec('DELETE FROM personas');
  },

  apply(e, storage) {
    const p = e.payload as PayloadOf<'persona.updated'>;
    storage.run(
      `INSERT INTO personas (
         principal, agent_name, address_user, formality, length, emoji,
         language, notes, version, updated_at, seq
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(principal) DO UPDATE SET
         agent_name = excluded.agent_name,
         address_user = excluded.address_user,
         formality = excluded.formality,
         length = excluded.length,
         emoji = excluded.emoji,
         language = excluded.language,
         notes = excluded.notes,
         version = excluded.version,
         updated_at = excluded.updated_at,
         seq = excluded.seq`,
      personaRowFrom(e.principal, p.persona, p.version, e.ts, e.seq),
    );
  },
};
