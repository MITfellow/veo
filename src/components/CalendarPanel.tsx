import { useCallback, useEffect, useState } from 'react';
import { agent, AgentUnavailableError, type CalendarEventView } from '../lib/agent';

/**
 * The calendar — the agent's own, with nothing plugged in.
 *
 * Worth being precise about what this is, because the word "calendar"
 * usually means a connector. This one is not: there is no account to
 * link, no sync, no token and no network call. Events live in the same
 * event log as everything else the agent knows, which is why they
 * survive a rebuild, appear in an export, and can be read by the model
 * through `calendar.list` without anything leaving the machine.
 *
 * Three commitments the layout is built around:
 *
 * - **Agenda, not a grid.** A month grid is a good way to see shape and
 *   a bad way to see a day. The question people actually ask is "what is
 *   next", so the default view is the next fortnight in order, grouped
 *   by day, with today first.
 * - **Overlaps are shown, never prevented.** Double-booking is sometimes
 *   deliberate. The panel marks a clash and leaves the decision alone.
 * - **Cancelling is the user's, and it is visible.** The agent can add
 *   (`calendar.add` is reachable at DERIVED trust); it cannot cancel.
 *   Anything the agent put there is still removable from right here.
 */

/** Two weeks is the horizon most people can actually act on. */
const HORIZON_DAYS = 14;

const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

const startOfToday = (): number => {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
};

const dayKey = (at: number): string =>
  new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(at),
  );

function dayLabel(at: number): string {
  const today = dayKey(Date.now());
  const tomorrow = dayKey(Date.now() + 86_400_000);
  const key = dayKey(at);
  const formatted = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(at));
  if (key === today) return `Today · ${formatted}`;
  if (key === tomorrow) return `Tomorrow · ${formatted}`;
  return formatted;
}

const timeLabel = (event: CalendarEventView): string =>
  event.allDay
    ? 'All day'
    : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
        new Date(event.startsAt),
      );

/** `2026-07-01T14:30` from a datetime-local input, as an instant. */
const fromLocalInput = (value: string): number => new Date(value).getTime();

export default function CalendarPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [events, setEvents] = useState<CalendarEventView[]>([]);
  /**
   * Explicit, because a panel must not render a state it has not yet
   * confirmed: without this the calendar claims "Nothing coming up"
   * during its very first fetch, which is a lie told confidently.
   */
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState('');
  const [where, setWhere] = useState('');

  const load = useCallback(
    async (search: string) =>
      search.trim() === ''
        ? agent.calendar({
            from: startOfToday(),
            to: startOfToday() + HORIZON_DAYS * 86_400_000,
          })
        : agent.calendar({ q: search.trim() }),
    [],
  );

  const apply = useCallback((result: { events: CalendarEventView[] }) => {
    setEvents(result.events);
    setError(null);
    setLoaded(true);
  }, []);

  const fail = useCallback((cause: unknown) => {
    setError(
      cause instanceof AgentUnavailableError
        ? 'The agent is not running, so its calendar cannot be read.'
        : (cause as Error).message,
    );
    setLoaded(true);
  }, []);

  const refresh = useCallback(async () => load(query).then(apply, fail), [load, query, apply, fail]);

  useEffect(() => {
    let live = true;
    load(query).then(
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
  }, [load, query, apply, fail]);

  const create = async () => {
    if (title.trim() === '' || when === '') return;
    try {
      const created = await agent.addCalendarEvent({
        title: title.trim(),
        startsAt: fromLocalInput(when),
        timezone: localZone(),
        location: where.trim() === '' ? null : where.trim(),
      });
      setTitle('');
      setWhen('');
      setWhere('');
      setAdding(false);
      await refresh();
      onNotice(
        created.conflicts.length === 0
          ? 'Added to your calendar.'
          : `Added — it overlaps ${created.conflicts.map((c) => c.title).join(', ')}.`,
      );
    } catch (cause) {
      onNotice((cause as Error).message);
    }
  };

  /** Events that overlap another in the same list, so the row can say so. */
  const clashing = new Set<string>();
  for (const a of events) {
    for (const b of events) {
      if (a.id !== b.id && a.startsAt < b.endsAt && b.startsAt < a.endsAt) clashing.add(a.id);
    }
  }

  const days: Array<{ key: string; at: number; items: CalendarEventView[] }> = [];
  for (const event of events) {
    const key = dayKey(event.startsAt);
    const last = days[days.length - 1];
    if (last !== undefined && last.key === key) last.items.push(event);
    else days.push({ key, at: event.startsAt, items: [event] });
  }

  if (error !== null) {
    return (
      <>
        <div className="panel-label" style={{ marginTop: 6 }}>
          Calendar
        </div>
        <div className="cal-empty">{error}</div>
      </>
    );
  }

  return (
    <>
      <div className="panel-label" style={{ marginTop: 6 }}>
        Calendar
      </div>

      <div className="cal-note">
        The agent&rsquo;s own calendar, kept on this machine. Nothing is linked to an outside
        account and nothing syncs — the agent can read it and add to it, and only you can cancel.
      </div>

      <input
        className="cal-search"
        type="search"
        placeholder="Search your calendar"
        aria-label="Search your calendar"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      <div className="cal-list">
        {!loaded ? (
          <div className="cal-empty">Checking&hellip;</div>
        ) : days.length === 0 ? (
          <div className="cal-empty">
            {query.trim() === ''
              ? `Nothing in the next ${HORIZON_DAYS} days.`
              : `Nothing matches “${query.trim()}”.`}
          </div>
        ) : (
          days.map((day) => (
            <div key={day.key} className="cal-day">
              <div className="cal-daylabel">{dayLabel(day.at)}</div>
              {day.items.map((event) => (
                <div key={event.id} className="cal-row">
                  <div className="cal-time">{timeLabel(event)}</div>
                  <div className="cal-main">
                    <div className="cal-title">{event.title}</div>
                    {event.location === null || event.location === '' ? null : (
                      <div className="cal-where">{event.location}</div>
                    )}
                    {clashing.has(event.id) ? (
                      <div className="cal-clash">Overlaps something else</div>
                    ) : null}
                  </div>
                  <button
                    className="cal-btn is-danger"
                    onClick={async () => {
                      await agent.cancelCalendarEvent(event.id);
                      await refresh();
                      onNotice('Cancelled.');
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {adding ? (
        <div className="cal-add">
          <input
            className="cal-input"
            placeholder="What is it?"
            aria-label="Event title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <input
            className="cal-input"
            type="datetime-local"
            aria-label="When"
            value={when}
            onChange={(event) => setWhen(event.target.value)}
          />
          <input
            className="cal-input"
            placeholder="Where (optional)"
            aria-label="Where"
            value={where}
            onChange={(event) => setWhere(event.target.value)}
          />
          <div className="cal-addrow">
            <span className="cal-zone">Times are {localZone()}</span>
            <button className="cal-btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="cal-btn is-primary" onClick={create}>
              Add
            </button>
          </div>
        </div>
      ) : (
        <button className="cal-btn" onClick={() => setAdding(true)}>
          Add an event
        </button>
      )}
    </>
  );
}
