/**
 * The calendar projection (S1).
 *
 * Two events and one table. `calendar.cancelled` stamps `cancelled_at`
 * instead of deleting the row, for the same reason `memory.superseded`
 * closes valid time rather than removing a fact: the question "what was
 * on my calendar before I cancelled it" is a question about the past,
 * and a `DELETE` is the one operation that cannot answer it.
 *
 * Nothing here generates an id or reads a clock — a projector that does
 * either produces a different database on every rebuild, which is how
 * invariant 1 gets broken quietly.
 */
import type { Projector } from '../events/log.js';
import type { PayloadOf } from '../events/types.js';

export const calendarProjector: Projector = {
  name: 'calendar',
  version: 1,
  handles: ['calendar.added', 'calendar.cancelled'],

  reset(storage) {
    storage.exec('DELETE FROM calendar_events');
  },

  apply(e, storage) {
    switch (e.type) {
      case 'calendar.added': {
        const p = e.payload as PayloadOf<'calendar.added'>;
        storage.run(
          `INSERT INTO calendar_events (
             id, principal, title, starts_at, ends_at, all_day, timezone,
             location, notes, created_at, cancelled_at, seq
           ) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?)
           ON CONFLICT(id) DO NOTHING`,
          [
            p.eventId,
            e.principal,
            p.title,
            p.startsAt,
            p.endsAt,
            p.allDay ? 1 : 0,
            p.timezone,
            p.location,
            p.notes,
            e.ts,
            e.seq,
          ],
        );
        return;
      }
      case 'calendar.cancelled': {
        const p = e.payload as PayloadOf<'calendar.cancelled'>;
        storage.run('UPDATE calendar_events SET cancelled_at = ? WHERE id = ?', [
          e.ts,
          p.eventId,
        ]);
        return;
      }
      default:
        return;
    }
  },
};
