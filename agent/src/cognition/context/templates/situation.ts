/**
 * Blocks 5–7: now, what is owed, and what is not known (§21).
 */
import type { Template, RenderedItem } from './index.js';
import { isoDate } from './kernel.js';

const DEGRADATION_NOTE: Record<string, string> = {
  L0: '',
  L1: 'Degraded (L1): the primary model is unavailable and a fallback is in use. Say so if the answer is weaker than usual.',
  L2: 'Degraded (L2): memory retrieval is unavailable. You are working from this conversation alone — do not claim to remember anything.',
  L3: 'Degraded (L3): read-only mode. Nothing you do can change the world or be remembered. Tell the user before they rely on it.',
};

/**
 * Block 5 — situation.
 *
 * Small, cheap, and never evicted in practice because of its floor. It is
 * also where honesty about the context itself lives: truncation notes and
 * degradation notes are appended by the assembler, because they are facts
 * about the assembly rather than about the world (§27: silent degradation
 * is forbidden).
 */
export const SITUATION: Template = {
  name: 'situation',
  version: 'situation-2',
  kind: 'system',
  header: 'Right now:',
  render(snapshot) {
    const s = snapshot.situation;
    const items: RenderedItem[] = [
      { id: 'situation:time', text: `- Time: ${new Date(s.now).toISOString()} (${s.timezone})` },
      { id: 'situation:locale', text: `- Locale: ${s.locale}   Device: ${s.device}` },
      {
        id: 'situation:trigger',
        text:
          s.triggerDetail === undefined || s.triggerDetail === ''
            ? `- This run was triggered by: ${s.trigger}`
            : `- This run was triggered by: ${s.trigger} (${s.triggerDetail}). Nobody is` +
              ` necessarily waiting: say why you are speaking, and be brief.`,
      },
    ];
    if (s.sessionTitle !== undefined && s.sessionTitle !== '') {
      items.push({ id: 'situation:title', text: `- Session: ${s.sessionTitle}` });
    }
    const degraded = DEGRADATION_NOTE[s.degradation] ?? '';
    if (degraded !== '') items.push({ id: 'situation:degradation', text: `- ${degraded}` });
    return items;
  },
};

/**
 * Block 6 — open commitments.
 *
 * Ranked by due date, soonest first, with overdue items marked. This is the
 * block that makes an agent feel like it is actually working for someone
 * rather than answering questions: it is the difference between "how can I
 * help?" and "you said you'd send Priya the draft by Friday."
 */
export const COMMITMENTS: Template = {
  name: 'commitments',
  version: 'commitments-1',
  kind: 'system',
  header: 'You currently owe your principal the following. Do not quietly drop one:',
  elision: (dropped) =>
    `(${dropped} further commitment${dropped === 1 ? '' : 's'} not shown — the list is longer than the budget. Do not treat this list as complete.)`,
  render(snapshot, ctx) {
    const sorted = [...snapshot.commitments].sort((a, b) => {
      // Dated before undated, soonest first, then stable by id. An unordered
      // list here would make the golden files flap on insertion order.
      if (a.dueAt === b.dueAt) return a.id < b.id ? -1 : 1;
      if (a.dueAt === null) return 1;
      if (b.dueAt === null) return -1;
      return a.dueAt - b.dueAt;
    });
    return sorted.map((commitment): RenderedItem => {
      const when =
        commitment.dueAt === null
          ? 'no deadline'
          : commitment.dueAt < ctx.now
            ? `OVERDUE since ${isoDate(commitment.dueAt)}`
            : `due ${isoDate(commitment.dueAt)}`;
      return {
        id: commitment.id,
        text: `- ${commitment.text} (${when}, promised ${isoDate(commitment.madeAt)})`,
      };
    });
  },
};

/**
 * Block 7 — calibration notes: what the agent knows it does not know.
 *
 * §24.4. Carrying open questions in context is what stops the agent
 * inventing an answer to one of them, and it is also how a probe gets asked
 * at a natural moment instead of as an interrogation.
 */
export const CALIBRATION: Template = {
  name: 'calibration',
  version: 'calibration-1',
  kind: 'system',
  header:
    'Open questions about your principal. You do not know these. Do not guess, ' +
    'and do not ask all of them — if one comes up naturally, ask that one:',
  elision: (dropped) => `(${dropped} further open question${dropped === 1 ? '' : 's'} not shown.)`,
  render(snapshot) {
    return snapshot.calibration.map(
      (note): RenderedItem => ({ id: note.id, text: `- ${note.question}` }),
    );
  },
};
