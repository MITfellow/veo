import { useCallback, useEffect, useState } from 'react';
import {
  agent,
  AgentUnavailableError,
  type CatchUp,
  type DegradationView,
  type JobView,
  type ScheduleView,
} from '../lib/agent';

/**
 * Standing instructions: the things the agent does without being asked.
 *
 * ARISH §28 gives the agent a scheduler and a durable queue. That is a real
 * transfer of authority — something that will speak to you at 9am on a
 * Tuesday while you are not looking — so the screen is built around three
 * commitments rather than around the cron syntax.
 *
 * - **Everything is in wall-clock time, and the timezone is written down.**
 *   "Every weekday at 9am" means 9am where you are, including the mornings
 *   either side of a daylight-saving change and including after you move.
 *   The panel always shows the next fire as a local date and time, never as
 *   "in 14 hours", because an offset is the thing people get wrong.
 * - **Misses are shown, not hidden.** If the laptop was shut for three days
 *   the agent does not pretend otherwise: the count of skipped mornings is
 *   on the row, and the catch-up policy that decided what to do about them
 *   is a visible control, not a default buried in a config file.
 * - **Failures surface.** A background job that has exhausted its retries
 *   goes to the dead-letter list and stays there until a person looks. A
 *   queue that quietly drops work is worse than no queue.
 */

const CATCH_UP_LABEL: Record<CatchUp, string> = {
  'fire-once': 'Run once on return',
  'fire-all': 'Run every missed one',
  skip: 'Skip what was missed',
};

/** Weekday-friendly presets. Cron is available, but nobody should need it. */
const PRESETS: Array<{ id: string; label: string; spec: string }> = [
  { id: 'weekday-9', label: 'Weekdays at 9am', spec: '0 9 * * 1-5' },
  { id: 'daily-8', label: 'Every day at 8am', spec: '0 8 * * *' },
  { id: 'daily-6pm', label: 'Every day at 6pm', spec: '0 18 * * *' },
  { id: 'monday-9', label: 'Mondays at 9am', spec: '0 9 * * 1' },
  { id: 'hourly', label: 'Every hour', spec: '0 * * * *' },
];

function whenLocal(at: number | null, timezone: string): string {
  if (at === null) return '—';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  }).format(new Date(at));
}

export default function SchedulePanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [ladder, setLadder] = useState<DegradationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [spec, setSpec] = useState(PRESETS[0]!.spec);

  /** Fetch only. Keeping the awaits and the setState calls apart is what
   * lets the effect below stay a plain promise handler. */
  const load = useCallback(
    async () =>
      Promise.all([agent.schedules(), agent.jobs(), agent.degradation()]).then(
        ([list, queue, degradation]) => ({ list, queue, degradation }),
      ),
    [],
  );

  const apply = useCallback((result: Awaited<ReturnType<typeof load>>) => {
    setSchedules(result.list.schedules);
    setJobs(result.queue.jobs.filter((job) => job.status === 'dead' || job.status === 'failed'));
    setCounts(result.queue.counts);
    setLadder(result.degradation);
    setError(null);
  }, []);

  const fail = useCallback((cause: unknown) => {
    setError(
      cause instanceof AgentUnavailableError
        ? 'The agent is not running, so nothing is scheduled to happen.'
        : (cause as Error).message,
    );
  }, []);

  const refresh = useCallback(
    async () => load().then(apply, fail),
    [load, apply, fail],
  );

  useEffect(() => {
    // Guarded rather than fire-and-forget: the Settings sheet can close
    // mid-fetch, and a setState on an unmounted panel is a warning the
    // next person would have to re-diagnose.
    let live = true;
    load().then(
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
  }, [load, apply, fail]);

  const create = async () => {
    if (name.trim() === '' || prompt.trim() === '') return;
    try {
      await agent.createSchedule({
        name: name.trim(),
        spec,
        prompt: prompt.trim(),
        // The browser's zone, so "9am" means 9am here. The server stores
        // the name, not the offset — that is what survives a DST change.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setName('');
      setPrompt('');
      setAdding(false);
      await refresh();
      onNotice('Scheduled. The agent will start it on its own.');
    } catch (cause) {
      onNotice((cause as Error).message);
    }
  };

  if (error !== null) {
    return (
      <>
        <div className="panel-label" style={{ marginTop: 6 }}>
          Standing instructions
        </div>
        <div className="sch-empty">{error}</div>
      </>
    );
  }

  const dead = jobs.filter((job) => job.status === 'dead');

  return (
    <>
      <div className="panel-label" style={{ marginTop: 6 }}>
        Standing instructions
      </div>

      <div className="sch-note">
        Things the agent does without being asked. Times are wall-clock in{' '}
        {Intl.DateTimeFormat().resolvedOptions().timeZone} — 9am stays 9am across a clock change or a
        move.
      </div>

      {ladder !== null && ladder.level !== 'L0' ? (
        <div className="sch-degraded" role="status">
          <strong>{ladder.level}</strong> · {ladder.meaning}
          {ladder.signals.map((signal) => (
            <div key={signal.signal} className="sch-signal">
              {signal.detail}
            </div>
          ))}
        </div>
      ) : null}

      <div className="sch-list">
        {schedules.length === 0 ? (
          <div className="sch-empty">
            Nothing is scheduled. The agent only acts when you write to it.
          </div>
        ) : (
          schedules.map((schedule) => (
            <div key={schedule.id} className={`sch-row${schedule.enabled ? '' : ' is-off'}`}>
              <div className="sch-main">
                <div className="sch-name">{schedule.name}</div>
                <div className="sch-prompt">&ldquo;{schedule.prompt}&rdquo;</div>
                <div className="sch-when">
                  {schedule.enabled ? 'Next' : 'Paused — next would be'}{' '}
                  {whenLocal(schedule.nextFireAt, schedule.timezone)} · {schedule.timezone}
                </div>
                <div className="sch-stats">
                  Run {schedule.fireCount}×
                  {schedule.missedCount > 0 ? (
                    <span className="sch-missed"> · {schedule.missedCount} missed</span>
                  ) : null}
                  {' · '}
                  <select
                    className="sch-select"
                    aria-label={`Catch-up policy for ${schedule.name}`}
                    value={schedule.catchUp}
                    onChange={async (event) => {
                      await agent.updateSchedule(schedule.id, {
                        catchUp: event.target.value as CatchUp,
                      });
                      await refresh();
                    }}
                  >
                    {(Object.keys(CATCH_UP_LABEL) as CatchUp[]).map((policy) => (
                      <option key={policy} value={policy}>
                        {CATCH_UP_LABEL[policy]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="sch-actions">
                <button
                  className="sch-btn"
                  onClick={async () => {
                    await agent.updateSchedule(schedule.id, { enabled: !schedule.enabled });
                    await refresh();
                  }}
                >
                  {schedule.enabled ? 'Pause' : 'Resume'}
                </button>
                <button
                  className="sch-btn is-danger"
                  onClick={async () => {
                    await agent.deleteSchedule(schedule.id);
                    await refresh();
                    onNotice('Deleted.');
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {adding ? (
        <div className="sch-add">
          <input
            className="sch-input"
            placeholder="Name it — Morning briefing"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <input
            className="sch-input"
            placeholder="What should it do? — What is on today?"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <select
            className="sch-select"
            aria-label="When"
            value={spec}
            onChange={(event) => setSpec(event.target.value)}
          >
            {PRESETS.map((preset) => (
              <option key={preset.id} value={preset.spec}>
                {preset.label}
              </option>
            ))}
          </select>
          <div className="sch-actions">
            <button className="sch-btn is-primary" onClick={() => void create()}>
              Schedule it
            </button>
            <button className="sch-btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="sch-btn" onClick={() => setAdding(true)}>
          Add a standing instruction
        </button>
      )}

      {dead.length > 0 ? (
        <>
          <div className="sch-section">Gave up on</div>
          <div className="sch-note">
            These ran out of retries. They are kept rather than dropped — the agent failing silently
            is the one outcome worth preventing.
          </div>
          {dead.map((job) => (
            <div key={job.id} className="sch-row is-dead">
              <div className="sch-main">
                <div className="sch-name">{job.kind}</div>
                <div className="sch-prompt">{job.lastError ?? 'no reason recorded'}</div>
                <div className="sch-when">
                  {job.attempts} of {job.maxAttempts} attempts used
                </div>
              </div>
            </div>
          ))}
        </>
      ) : null}

      {(counts.pending ?? 0) + (counts.leased ?? 0) > 0 ? (
        <div className="sch-note">
          {(counts.pending ?? 0) + (counts.leased ?? 0)} job
          {(counts.pending ?? 0) + (counts.leased ?? 0) === 1 ? '' : 's'} waiting to run. Background
          work always yields to you.
        </div>
      ) : null}
    </>
  );
}
