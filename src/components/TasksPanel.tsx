import { useCallback, useEffect, useState } from 'react';
import { agent, AgentUnavailableError, type TaskView } from '../lib/agent';

/**
 * The to-do list — the things with no time attached.
 *
 * Like the calendar, this is the agent's own state, kept in its event
 * log on this machine. No account, no sync, no connector.
 *
 * Three decisions the layout is making:
 *
 * - **A due date is a deadline, not an alarm.** Nothing fires. The
 *   panel says so in as many words, because a date next to a task in
 *   every other app means a notification is coming, and quietly not
 *   sending one is the kind of broken promise that makes people stop
 *   trusting the whole thing.
 * - **Done and dropped are different buttons.** Ticking says you did
 *   it; removing says it stopped being worth doing. They are separate
 *   events in the log, so the list can honestly answer "how much of
 *   what I wrote down actually got done".
 * - **Overdue is stated plainly, not in red everywhere.** One marker on
 *   the row. A list that shouts at you is a list you close.
 */

const dueLabel = (dueAt: number | null, now: number): string => {
  if (dueAt === null) return '';
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = new Date(dueAt);
  // Compare calendar days, not instants. A task due at 23:59 yesterday
  // is less than a day behind "now", so an instant comparison rounds to
  // zero and labels it "Today" while the row is already marked overdue
  // — two parts of the same screen disagreeing. Caught by e2e test 40.
  const dayStart = new Date(dueAt);
  dayStart.setHours(0, 0, 0, 0);
  const days = Math.round((dayStart.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(day);
};

/** A `yyyy-mm-dd` value from a date input, as end of that day locally. */
const endOfDay = (value: string): number => {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year!, month! - 1, day!, 23, 59, 0, 0).getTime();
};

export default function TasksPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [loaded, setLoaded] = useState(false);
  /**
   * The clock at the moment the list was fetched, not at render.
   * Reading `Date.now()` during render is impure — oxlint's
   * `react(purity)` rule catches it — and it is also subtly wrong:
   * "overdue" should be judged against the data's own age, so that a
   * re-render for an unrelated reason cannot silently change what the
   * list says.
   */
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');

  const load = useCallback(async (closed: boolean) => agent.tasks(closed), []);

  const apply = useCallback((result: { tasks: TaskView[] }) => {
    setTasks(result.tasks);
    setNow(Date.now());
    setError(null);
    setLoaded(true);
  }, []);

  const fail = useCallback((cause: unknown) => {
    setError(
      cause instanceof AgentUnavailableError
        ? 'The agent is not running, so its list cannot be read.'
        : (cause as Error).message,
    );
    setLoaded(true);
  }, []);

  const refresh = useCallback(
    async () => load(showDone).then(apply, fail),
    [load, showDone, apply, fail],
  );

  useEffect(() => {
    let live = true;
    load(showDone).then(
      (result) => {
        if (live) apply(result);
      },
      (caught: unknown) => {
        if (live) fail(caught);
      },
    );
    return () => {
      live = false;
    };
  }, [load, showDone, apply, fail]);

  const create = async () => {
    if (title.trim() === '') return;
    try {
      await agent.addTask({
        title: title.trim(),
        dueAt: due === '' ? null : endOfDay(due),
      });
      setTitle('');
      setDue('');
      await refresh();
    } catch (cause) {
      onNotice((cause as Error).message);
    }
  };

  if (error !== null) {
    return (
      <>
        <div className="panel-label" style={{ marginTop: 6 }}>
          To-do
        </div>
        <div className="tsk-empty">{error}</div>
      </>
    );
  }

  const open = tasks.filter((task) => !task.done && task.droppedAt === null);
  // Finished means finished. A dropped task was removed on purpose, and
  // resurrecting it under "Show finished" would make Remove look like it
  // had not worked.
  const closed = tasks.filter((task) => task.done && task.droppedAt === null);
  const shown = showDone ? [...open, ...closed] : open;

  return (
    <>
      <div className="panel-label" style={{ marginTop: 6 }}>
        To-do
      </div>

      <div className="tsk-note">
        Things with no particular time — anything that happens at a time belongs in the calendar.
        A due date here is a deadline for sorting, <strong>not a reminder</strong>: nothing will
        notify you. The agent can add items and tick them off; only you can delete one.
      </div>

      <div className="tsk-add">
        <input
          className="tsk-input"
          placeholder="Add something to do"
          aria-label="Task title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void create();
          }}
        />
        <input
          className="tsk-date"
          type="date"
          aria-label="Due date (optional)"
          value={due}
          onChange={(event) => setDue(event.target.value)}
        />
        <button className="tsk-btn is-primary" onClick={create}>
          Add
        </button>
      </div>

      <div className="tsk-list">
        {!loaded ? (
          <div className="tsk-empty">Checking&hellip;</div>
        ) : shown.length === 0 ? (
          <div className="tsk-empty">Nothing on the list.</div>
        ) : (
          shown.map((task) => (
            <div key={task.id} className={`tsk-row${task.done ? ' is-done' : ''}`}>
              <button
                className="tsk-check"
                aria-label={task.done ? `${task.title} is done` : `Mark ${task.title} done`}
                disabled={task.done}
                onClick={async () => {
                  await agent.completeTask(task.id);
                  await refresh();
                }}
              >
                {task.done ? '✓' : ''}
              </button>
              <div className="tsk-main">
                <div className="tsk-title">{task.title}</div>
                {task.note === null || task.note === '' ? null : (
                  <div className="tsk-sub">{task.note}</div>
                )}
              </div>
              {task.dueAt === null ? null : (
                <div
                  className={`tsk-due${
                    !task.done && task.dueAt < now ? ' is-overdue' : ''
                  }`}
                >
                  {dueLabel(task.dueAt, now)}
                </div>
              )}
              <button
                className="tsk-btn is-danger"
                onClick={async () => {
                  await agent.dropTask(task.id);
                  await refresh();
                  onNotice('Removed from the list.');
                }}
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>

      <button className="tsk-btn" onClick={() => setShowDone(!showDone)}>
        {showDone ? 'Hide finished' : 'Show finished'}
      </button>
    </>
  );
}
