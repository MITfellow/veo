import { useCallback, useEffect, useState } from 'react';
import { agent, AgentUnavailableError, type EventView } from '../lib/agent';

/**
 * §30 — the log, as a person can read it.
 *
 * Every other panel in this product is a projection: memory, the
 * constitution, schedules, metrics, the trace. All of them are derived
 * from this one append-only table, and none of them could be inspected
 * against their source because nothing in the UI called `GET /events`.
 * That is the wrong way round — the derived views were auditable and the
 * thing they are audited against was not.
 *
 * Grouped filters rather than a free-text type box: "show me the model
 * calls" is the question people have, and `model.requested,
 * model.responded, model.failed` is the answer spelled in the log's
 * vocabulary rather than the user's.
 *
 * No live tail. `GET /events` is a tail slice with no cursor, so a poll
 * loop would re-fetch the whole window to discover one new row and would
 * quietly paper over a gap that should stay visible. Refresh is a button
 * until the route can express "since".
 */

const GROUPS: Array<{ id: string; label: string; types: string[] }> = [
  { id: 'all', label: 'Everything', types: [] },
  {
    id: 'conversation',
    label: 'Conversation',
    types: ['message.user', 'message.agent', 'session.created', 'run.started', 'run.finished'],
  },
  { id: 'model', label: 'Model', types: ['model.requested', 'model.responded', 'model.failed'] },
  {
    id: 'tools',
    label: 'Tools',
    types: ['tool.requested', 'tool.started', 'tool.succeeded', 'tool.failed', 'tool.timedout'],
  },
  {
    id: 'memory',
    label: 'Memory',
    types: [
      'memory.written',
      'memory.confirmed',
      'memory.superseded',
      'memory.corrected',
      'memory.forgotten',
      'memory.used',
    ],
  },
  {
    id: 'safety',
    label: 'Safety',
    types: [
      'approval.requested',
      'approval.granted',
      'approval.denied',
      'approval.expired',
      'policy.blocked',
      'run.degraded',
    ],
  },
];

const clock = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

/** One line that says what happened, before anyone opens the payload. */
function summarise(event: EventView): string {
  const payload = event.payload;
  const text = (key: string): string | null => {
    const value = payload[key];
    return typeof value === 'string' ? value : null;
  };
  return (
    text('text') ??
    text('tool') ??
    text('model') ??
    text('reason') ??
    text('name') ??
    text('level') ??
    ''
  );
}

export default function EventLogPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [events, setEvents] = useState<EventView[]>([]);
  const [total, setTotal] = useState(0);
  const [group, setGroup] = useState('all');
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Fetch only — see the same split in every other panel on this screen. */
  const load = useCallback(async (which: string) => {
    const types = GROUPS.find((candidate) => candidate.id === which)?.types ?? [];
    return agent.events({ types, limit: 200 });
  }, []);

  const apply = useCallback((page: { events: EventView[]; total: number }) => {
    // Newest first: the question people bring to a log is "what just
    // happened", and the answer is at the bottom of an append-only table.
    setEvents([...page.events].reverse());
    setTotal(page.total);
    setError(null);
  }, []);

  const fail = useCallback((cause: unknown) => {
    setError(
      cause instanceof AgentUnavailableError
        ? 'The agent is not running, so there is no log to read.'
        : (cause as Error).message,
    );
  }, []);

  const refresh = useCallback(
    async (which: string) => {
      try {
        apply(await load(which));
      } catch (cause) {
        fail(cause);
      }
    },
    [load, apply, fail],
  );

  useEffect(() => {
    let live = true;
    load(group).then(
      (page) => {
        if (live) apply(page);
      },
      (cause: unknown) => {
        if (live) fail(cause);
      },
    );
    return () => {
      live = false;
    };
  }, [load, apply, fail, group]);

  if (error !== null) {
    return (
      <>
        <div className="panel-label" style={{ marginTop: 6 }}>
          The log
        </div>
        <div className="evt-empty">{error}</div>
      </>
    );
  }

  return (
    <>
      <div className="panel-label" style={{ marginTop: 6 }}>
        The log
      </div>
      <div className="evt-note">
        Append-only and hash-chained. Everything else on this screen is computed from these rows —
        if a panel and the log disagree, the log is right.
      </div>

      <div className="evt-filters" role="group" aria-label="Filter the log">
        {GROUPS.map((candidate) => (
          <button
            key={candidate.id}
            className={`evt-chip${group === candidate.id ? ' is-on' : ''}`}
            aria-pressed={group === candidate.id}
            onClick={() => {
              setGroup(candidate.id);
              setOpen(null);
            }}
          >
            {candidate.label}
          </button>
        ))}
        <button
          className="evt-chip"
          onClick={() => {
            void refresh(group);
            onNotice('Reloaded.');
          }}
        >
          Refresh
        </button>
      </div>

      <div className="evt-count">
        {events.length === 0
          ? 'Nothing matches.'
          : `Showing the last ${events.length} of ${total} event${total === 1 ? '' : 's'}.`}
      </div>

      <div className="evt-list">
        {events.map((event) => (
          <div key={event.seq} className="evt-row">
            <button
              className="evt-head"
              aria-expanded={open === event.seq}
              onClick={() => setOpen(open === event.seq ? null : event.seq)}
            >
              <span className="evt-seq">#{event.seq}</span>
              <span className="evt-type">{event.type}</span>
              <span className="evt-trust">{event.trust}</span>
              <span className="evt-time">{clock(event.ts)}</span>
            </button>
            {summarise(event) !== '' && open !== event.seq ? (
              <div className="evt-summary">{summarise(event)}</div>
            ) : null}
            {open === event.seq ? (
              <pre className="evt-payload">{JSON.stringify(event.payload, null, 2)}</pre>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}
