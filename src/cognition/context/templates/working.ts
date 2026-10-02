/**
 * Blocks 10–12: the working set, the conversation, and what the conversation
 * used to be (§21, §23).
 */
import type { Template, RenderedItem } from './index.js';
import { isoDate } from './kernel.js';
import { fenceTurn } from './foreign.js';

/**
 * Block 10 — working set: artifacts and entities in play right now.
 *
 * Summaries only. A 3MB file does not go in the context; its id, kind and
 * one-line summary do, and the model asks for the rest if it needs it
 * (§18's artifact rule, same reasoning).
 */
export const WORKING: Template = {
  name: 'working',
  version: 'working-1',
  kind: 'system',
  header: 'In play right now. Refer to these by id if you need their contents:',
  elision: (dropped) => `(${dropped} further item${dropped === 1 ? '' : 's'} in play, not shown.)`,
  render(snapshot) {
    return snapshot.working.map(
      (item): RenderedItem => ({
        id: item.id,
        text: `- ${item.kind} ${item.id} — ${item.label}: ${item.summary}`,
      }),
    );
  },
};

/**
 * Block 11 — the conversation, verbatim.
 *
 * The only `turns` block: these become real user/assistant messages rather
 * than lines inside a system message, because every provider treats the
 * conversation array as special and flattening it into prose loses the
 * structure the model is actually trained on.
 *
 * Eviction is **oldest first** and always contiguous. Keeping an old turn
 * after dropping a newer one would reorder the conversation, which reads as
 * the user contradicting themselves.
 */
export const CONVERSATION: Template = {
  name: 'conversation',
  version: 'conversation-2',
  kind: 'turns',
  elision: (dropped) =>
    `${dropped} earlier turn${dropped === 1 ? '' : 's'} in this conversation ` +
    `${dropped === 1 ? 'was' : 'were'} dropped to fit the context budget. If the user ` +
    `refers to something you cannot see, say so and ask — do not reconstruct it.`,
  render(snapshot, ctx) {
    return snapshot.conversation.map(
      (turn): RenderedItem => ({
        id: turn.id,
        role: turn.role,
        trust: turn.trust,
        // A FOREIGN *turn* is fenced exactly like foreign data: trust travels
        // with content, not with the slot it arrived in.
        text: fenceTurn(turn, ctx.policy.fence),
      }),
    );
  },
};

/**
 * Block 12 — compacted history (§23).
 *
 * Structured summaries, not prose soup, each carrying the event-id span it
 * covers so `history.expand` can get the detail back. Compaction is a view;
 * the originals are still in the log and the pointers are how you reach
 * them.
 */
export const COMPACTED: Template = {
  name: 'compacted',
  version: 'compacted-1',
  kind: 'system',
  header:
    'Earlier in this conversation, summarized. Call history.expand with a span ' +
    'below to read the original turns verbatim:',
  elision: (dropped) =>
    `(${dropped} earlier summar${dropped === 1 ? 'y' : 'ies'} not shown. The conversation ` +
    `began before what you can see here.)`,
  render(snapshot) {
    return snapshot.compacted.map((chunk): RenderedItem => {
      const s = chunk.summary;
      const lines = [
        `- [${s.span.fromEventId}..${s.span.toEventId}] ${s.span.turnCount} turns, ` +
          `${isoDate(s.span.fromTime)} to ${isoDate(s.span.toTime)}`,
      ];
      const section = (label: string, values: readonly string[]): void => {
        if (values.length > 0) lines.push(`    ${label}: ${values.join('; ')}`);
      };
      section('decided', s.decisions);
      section('still open', s.openThreads);
      section('about', s.entities);
      section('unanswered', s.unresolvedQuestions);
      return { id: chunk.id, text: lines.join('\n') };
    });
  },
};
