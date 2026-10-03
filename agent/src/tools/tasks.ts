/**
 * `tasks.*` — the list of things with no time attached (S2).
 *
 * The trust split is the same one the calendar settled and this is the
 * third time it has applied, so it is now the house rule rather than a
 * judgement call:
 *
 *   adding and marking done are DERIVED — visible, reversible
 *   deleting is USER — neither of those things
 *
 * `tasks.complete` says "this happened". `tasks.drop` says "forget I
 * asked". A model may do the first on your behalf and report it; the
 * second removes something you wrote down, and the only person who
 * gets to decide that is you.
 */
import { z } from 'zod';
import type { Tool } from '../capability/tool.js';
import type { Task, TaskStore } from '../cognition/tasks/store.js';
import { zonedToUtc } from '../cognition/calendar/store.js';

export interface TaskToolDeps {
  store: TaskStore;
}

const TaskShape = z.object({
  id: z.string(),
  title: z.string(),
  note: z.string().nullable(),
  dueAt: z.number().int().nullable(),
  done: z.boolean(),
});

const view = (task: Task) => ({
  id: task.id,
  title: task.title,
  note: task.note,
  dueAt: task.dueAt,
  done: task.completedAt !== null,
});

const describe = (task: Task, now: number): string => {
  if (task.dueAt === null) return task.title;
  const day = new Date(task.dueAt).toLocaleString('sv-SE', { timeZone: 'UTC' }).slice(0, 10);
  return task.dueAt < now ? `${task.title} (overdue, was due ${day})` : `${task.title} (due ${day})`;
};

/** A bare date or a date and time, read in the given zone. */
function parseDue(due: string, timezone: string): number {
  const text = due.trim().replace('T', ' ');
  const full = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text} 23:59:00`
    : text.length === 16
      ? `${text}:00`
      : text;
  return zonedToUtc(full, timezone);
}

/* ─────────────────────────────── tasks.add ──────────────────────────── */

const AddInput = z.object({
  title: z.string().min(1).max(200),
  /** Optional. A bare date means end of that day. */
  due: z.string().max(40).optional(),
  note: z.string().max(2000).optional(),
  timezone: z.string().min(1).max(64).default('UTC'),
});

const AddOutput = TaskShape;

export function makeTasksAdd(
  deps: TaskToolDeps,
): Tool<z.infer<typeof AddInput>, z.infer<typeof AddOutput>> {
  return {
    name: 'tasks.add',
    version: '1',
    description:
      "Adds something to the user's to-do list. Use this for things with no particular time " +
      '— "buy a router", "reply to Rui". If it happens at a time, it belongs in the calendar ' +
      'instead. A due date is optional and is a deadline, not a reminder: nothing will fire.',
    input: AddInput,
    output: AddOutput,
    capabilities: ['tasks:write'],
    minTrust: 'DERIVED',
    risk: 'caution',
    effect: 'local',
    idempotent: false,
    timeoutMs: 5000,

    async execute(input, ctx) {
      let dueAt: number | null = null;
      if (input.due !== undefined && input.due.trim() !== '') {
        try {
          dueAt = parseDue(input.due, input.timezone);
        } catch {
          return {
            ok: false,
            error: {
              kind: 'invalid_input',
              message: `'${input.due}' is not a date I can read`,
              retryable: false,
              hint: 'Write it as 2026-04-01 or 2026-04-01 17:00.',
            },
          };
        }
      }

      try {
        const task = deps.store.add(ctx.principal, {
          title: input.title,
          dueAt,
          note: input.note ?? null,
        });
        return { ok: true, value: view(task), trust: 'USER' };
      } catch (error) {
        return {
          ok: false,
          error: {
            kind: 'invalid_input',
            message: error instanceof Error ? error.message : 'the task could not be added',
            retryable: false,
          },
        };
      }
    },

    renderForModel(result) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      return { text: `Added to the list: ${result.value.title}`, truncated: false };
    },
  };
}

/* ─────────────────────────────── tasks.list ─────────────────────────── */

const ListInput = z.object({
  includeDone: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(50),
});
const ListOutput = z.object({ tasks: z.array(TaskShape), open: z.number().int() });

export function makeTasksList(
  deps: TaskToolDeps,
): Tool<z.infer<typeof ListInput>, z.infer<typeof ListOutput>> {
  return {
    name: 'tasks.list',
    version: '1',
    description:
      "What is on the user's to-do list, soonest deadline first. Use this before claiming " +
      'you know what they have to do, and before adding something that might be there already.',
    input: ListInput,
    output: ListOutput,
    capabilities: ['tasks:read'],
    minTrust: 'DERIVED',
    risk: 'safe',
    effect: 'pure',
    idempotent: true,
    timeoutMs: 5000,

    async execute(input, ctx) {
      const tasks = deps.store.list(ctx.principal, {
        includeClosed: input.includeDone,
        limit: input.limit,
      });
      const open = tasks.filter((task) => task.completedAt === null && task.droppedAt === null);
      return {
        ok: true,
        value: { tasks: tasks.map(view), open: open.length },
        trust: 'USER',
      };
    },

    renderForModel(result, budget) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      if (result.value.tasks.length === 0) {
        return { text: 'The to-do list is empty.', truncated: false };
      }
      const now = Date.now();
      const lines = result.value.tasks.map(
        (task) =>
          `${task.done ? '[x]' : '[ ]'} ${describe(
            {
              ...task,
              createdAt: 0,
              completedAt: task.done ? 1 : null,
              droppedAt: null,
            } as Task,
            now,
          )}`,
      );
      const limit = budget * 4;
      const text = lines.join('\n');
      if (text.length <= limit) return { text, truncated: false };
      // Soonest-due first is already the order, so the tail is the
      // least urgent and the right thing to cut.
      const kept: string[] = [];
      let used = 0;
      for (const line of lines) {
        if (used + line.length > limit) break;
        kept.push(line);
        used += line.length + 1;
      }
      return { text: `${kept.join('\n')}\n…and ${lines.length - kept.length} more`, truncated: true };
    },
  };
}

/* ───────────────────────────── tasks.complete ───────────────────────── */

const IdInput = z.object({ id: z.string().min(1).max(64) });
const CompleteOutput = z.object({ id: z.string(), done: z.boolean() });

export function makeTasksComplete(
  deps: TaskToolDeps,
): Tool<z.infer<typeof IdInput>, z.infer<typeof CompleteOutput>> {
  return {
    name: 'tasks.complete',
    version: '1',
    description:
      'Marks a task done, by the id from tasks.list. Use this when the user says they have ' +
      'done something. It is reversible and it is recorded, so it is safe to be wrong about.',
    input: IdInput,
    output: CompleteOutput,
    capabilities: ['tasks:write'],
    // Reversible and visible, so the agent may do it and say so.
    minTrust: 'DERIVED',
    risk: 'caution',
    effect: 'local',
    idempotent: true,
    timeoutMs: 5000,

    async execute(input, ctx) {
      const done = deps.store.complete(ctx.principal, input.id);
      if (!done) {
        return {
          ok: false,
          error: {
            kind: 'not_found',
            message: `There is no task with id '${input.id}'.`,
            retryable: false,
            hint: 'Call tasks.list to get the id first.',
          },
        };
      }
      return { ok: true, value: { id: input.id, done: true }, trust: 'USER' };
    },

    renderForModel(result) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      return { text: 'Marked done.', truncated: false };
    },
  };
}

/* ───────────────────────────── tasks.reopen ────────────────────────── */

const ReopenOutput = z.object({ id: z.string(), done: z.boolean() });

export function makeTasksReopen(
  deps: TaskToolDeps,
): Tool<z.infer<typeof IdInput>, z.infer<typeof ReopenOutput>> {
  return {
    name: 'tasks.reopen',
    version: '1',
    description:
      'Puts a finished task back on the list, by the id from tasks.list. Use this when ' +
      'something was ticked off too early, or turned out not to be finished after all.',
    input: IdInput,
    output: ReopenOutput,
    capabilities: ['tasks:write'],
    // The exact counterpart of tasks.complete, and reversible by it,
    // so it sits at the same trust floor. It also *restores* rather
    // than removes, which is the side of decision 035's line the agent
    // is allowed on.
    minTrust: 'DERIVED',
    risk: 'caution',
    effect: 'local',
    idempotent: true,
    timeoutMs: 5000,

    async execute(input, ctx) {
      const reopened = deps.store.reopen(ctx.principal, input.id);
      if (!reopened) {
        const task = deps.store.get(ctx.principal, input.id);
        const message =
          task === undefined
            ? `There is no task with id '${input.id}'.`
            : task.droppedAt !== null
              ? `'${task.title}' was dropped from the list, not completed, so there is ` +
                'nothing to reopen. Add it again if it needs doing.'
              : `'${task.title}' is already on the list.`;
        return {
          ok: false,
          error: {
            kind: task === undefined ? 'not_found' : 'conflict',
            message,
            retryable: false,
            hint: 'Call tasks.list with closed items included to see what is finished.',
          },
        };
      }
      return { ok: true, value: { id: input.id, done: false }, trust: 'USER' };
    },

    renderForModel(result) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      return { text: 'Back on the list.', truncated: false };
    },
  };
}

/* ─────────────────────────────── tasks.drop ─────────────────────────── */

const DropOutput = z.object({ id: z.string(), dropped: z.boolean() });

export function makeTasksDrop(
  deps: TaskToolDeps,
): Tool<z.infer<typeof IdInput>, z.infer<typeof DropOutput>> {
  return {
    name: 'tasks.drop',
    version: '1',
    description:
      'Removes a task from the list without claiming it was done. Confirm with the user ' +
      'first — this deletes something they wrote down. If they did it, use tasks.complete.',
    input: IdInput,
    output: DropOutput,
    capabilities: ['tasks:write'],
    // Not the agent's call. The same reasoning as decision 035 and
    // `calendar.cancel`: removing what a person wrote down is theirs.
    minTrust: 'USER',
    risk: 'dangerous',
    effect: 'local',
    idempotent: true,
    timeoutMs: 5000,

    async dryRun(input, ctx) {
      const task = deps.store.get(ctx.principal, input.id);
      if (task === undefined) return `There is no task with id '${input.id}'.`;
      return `Remove from the list, without marking it done: ${task.title}`;
    },

    async execute(input, ctx) {
      const dropped = deps.store.drop(ctx.principal, input.id);
      if (!dropped) {
        return {
          ok: false,
          error: {
            kind: 'not_found',
            message: `There is no task with id '${input.id}'.`,
            retryable: false,
          },
        };
      }
      return { ok: true, value: { id: input.id, dropped: true }, trust: 'USER' };
    },

    renderForModel(result) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      return { text: 'Removed from the list.', truncated: false };
    },
  };
}

export function taskTools(deps: TaskToolDeps) {
  return [
    makeTasksAdd(deps),
    makeTasksList(deps),
    makeTasksComplete(deps),
    makeTasksReopen(deps),
    makeTasksDrop(deps),
  ];
}
