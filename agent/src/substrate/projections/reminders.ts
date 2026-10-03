/**
 * The reminder projection (S3, extended in S4).
 *
 * Four events, one table. Nothing here generates an id, reads a clock
 * or decides anything: the row is a flattening of what the log already
 * says, which is the rule that lets `rebuild()` be trusted.
 *
 * Note what this projector does *not* do: it does not create the
 * schedule. The schedule is its own aggregate with its own events, and
 * a projector that reached across and wrote one would make a replay
 * produce side effects.
 */
import type { Projector } from '../events/log.js';
import type { PayloadOf } from '../events/types.js';

export const remindersProjector: Projector = {
  name: 'reminders',
  // Version 2: `reminder.seen` (S4).
  version: 2,
  handles: ['reminder.set', 'reminder.cancelled', 'reminder.fired', 'reminder.seen'],

  reset(storage) {
    storage.exec('DELETE FROM reminders');
  },

  apply(e, storage) {
    switch (e.type) {
      case 'reminder.set': {
        const p = e.payload as PayloadOf<'reminder.set'>;
        storage.run(
          `INSERT INTO reminders (
             id, principal, owner_kind, owner_id, schedule_id, remind_at, text,
             created_at, cancelled_at, fired_at, seq
           ) VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?)
           ON CONFLICT(id) DO NOTHING`,
          [
            p.reminderId,
            e.principal,
            p.ownerKind,
            p.ownerId,
            p.scheduleId,
            p.remindAt,
            p.text,
            e.ts,
            e.seq,
          ],
        );
        return;
      }
      case 'reminder.cancelled': {
        const p = e.payload as PayloadOf<'reminder.cancelled'>;
        storage.run('UPDATE reminders SET cancelled_at = ? WHERE id = ? AND cancelled_at IS NULL', [
          e.ts,
          p.reminderId,
        ]);
        return;
      }
      case 'reminder.fired': {
        const p = e.payload as PayloadOf<'reminder.fired'>;
        // A cancelled reminder that somehow fires is recorded as fired
        // anyway — the log says what happened, not what should have.
        storage.run('UPDATE reminders SET fired_at = ? WHERE id = ? AND fired_at IS NULL', [
          e.ts,
          p.reminderId,
        ]);
        return;
      }
      case 'reminder.seen': {
        const p = e.payload as PayloadOf<'reminder.seen'>;
        storage.run('UPDATE reminders SET seen_at = ? WHERE id = ? AND seen_at IS NULL', [
          e.ts,
          p.reminderId,
        ]);
        return;
      }
      default:
        return;
    }
  },
};
