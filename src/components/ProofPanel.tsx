import { useCallback, useEffect, useState } from 'react';
import {
  agent,
  AgentUnavailableError,
  type BackupReport,
  type MetricsView,
  type PersonaView,
} from '../lib/agent';

/**
 * Voice, proof and portability — the three things M9 puts in front of a
 * person.
 *
 * **Voice.** Six fields that decide how the agent sounds. Separate from
 * the constitution on purpose: the constitution is what it may do, this
 * is how it sounds doing it, and conflating them produces a settings
 * screen where "be brief" and "never contact my ex" look like the same
 * kind of promise.
 *
 * **Proof.** The numbers come from the event log rather than from
 * counters, so they survive a restart and cannot disagree with a trace.
 * Each latency carries the budget it is being held to — a dashboard that
 * shows 180ms without saying the target was 100ms is a dashboard nobody
 * acts on.
 *
 * **Portability.** "An untested backup is a rumor" (§13.5), so the test
 * is a button: it copies the database, verifies the hash chain, rebuilds
 * every projection from the events alone and compares. Export hands the
 * whole agent back as one file — with the vault still sealed, because a
 * portability feature is not an exception to a secrecy guarantee.
 */

const FORMALITY: Array<[PersonaView['formality'], string]> = [
  ['plain', 'Plain'],
  ['warm', 'Warm'],
  ['formal', 'Formal'],
];

const LENGTH: Array<[PersonaView['length'], string]> = [
  ['brief', 'Brief'],
  ['normal', 'Normal'],
  ['thorough', 'Thorough'],
];

const pct = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`);
const ms = (value: number | null) => (value === null ? '—' : `${Math.round(value)}ms`);

export default function ProofPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [persona, setPersona] = useState<PersonaView | null>(null);
  const [rendered, setRendered] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<MetricsView | null>(null);
  const [backup, setBackup] = useState<BackupReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async () =>
      Promise.all([agent.persona(), agent.metrics(30)]).then(([voice, numbers]) => ({
        voice,
        numbers,
      })),
    [],
  );

  const apply = useCallback((result: Awaited<ReturnType<typeof load>>) => {
    setPersona(result.voice.persona);
    setRendered(result.voice.rendered);
    setMetrics(result.numbers);
    setError(null);
  }, []);

  const fail = useCallback((cause: unknown) => {
    setError(
      cause instanceof AgentUnavailableError
        ? 'The agent is not running, so there is nothing to measure.'
        : (cause as Error).message,
    );
  }, []);

  useEffect(() => {
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

  const save = async (patch: Partial<PersonaView>) => {
    if (persona === null) return;
    const next = { ...persona, ...patch };
    setPersona(next);
    try {
      const saved = await agent.savePersona(next);
      setRendered(saved.rendered);
    } catch (cause) {
      onNotice((cause as Error).message);
    }
  };

  if (error !== null) {
    return (
      <>
        <div className="panel-label" style={{ marginTop: 6 }}>
          How it sounds, and how it is doing
        </div>
        <div className="prf-empty">{error}</div>
      </>
    );
  }

  return (
    <>
      <div className="panel-label" style={{ marginTop: 6 }}>
        How it sounds
      </div>
      <div className="prf-note">
        Voice only. What the agent may and may not do lives in the constitution above — this
        decides how it sounds doing it.
      </div>

      <div className="prf-form">
        <label className="prf-field">
          <span>It is called</span>
          <input
            className="prf-input"
            value={persona?.agentName ?? ''}
            maxLength={40}
            placeholder="unnamed"
            onChange={(event) => void save({ agentName: event.target.value })}
          />
        </label>
        <label className="prf-field">
          <span>It calls you</span>
          <input
            className="prf-input"
            value={persona?.addressUser ?? ''}
            maxLength={40}
            placeholder="nothing in particular"
            onChange={(event) => void save({ addressUser: event.target.value })}
          />
        </label>
        <label className="prf-field">
          <span>Tone</span>
          <select
            className="prf-select"
            value={persona?.formality ?? 'plain'}
            onChange={(event) =>
              void save({ formality: event.target.value as PersonaView['formality'] })
            }
          >
            {FORMALITY.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="prf-field">
          <span>Length</span>
          <select
            className="prf-select"
            value={persona?.length ?? 'normal'}
            onChange={(event) => void save({ length: event.target.value as PersonaView['length'] })}
          >
            {LENGTH.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="prf-field">
          <span>Anything else</span>
          <input
            className="prf-input"
            value={persona?.notes ?? ''}
            maxLength={400}
            placeholder="Use metric units and a 24-hour clock."
            onChange={(event) => void save({ notes: event.target.value })}
          />
        </label>
      </div>

      {rendered.length > 0 ? (
        <details className="prf-details">
          <summary>What the model is actually told</summary>
          <pre className="prf-pre">{rendered.join('\n')}</pre>
        </details>
      ) : null}

      <div className="panel-label" style={{ marginTop: 10 }}>
        How it is doing
      </div>
      <div className="prf-note">
        Measured from the event log, not from counters — so these numbers survive a restart and
        can never disagree with what the trace of a single answer says.
      </div>

      {metrics !== null ? (
        <div className="prf-grid">
          <div className="prf-stat">
            <div className="prf-value">{metrics.runs.total}</div>
            <div className="prf-key">answers in 30 days</div>
          </div>
          <div className="prf-stat">
            <div className="prf-value">{metrics.tokens.perRun ?? '—'}</div>
            <div className="prf-key">tokens per answer</div>
          </div>
          <div className="prf-stat">
            <div className="prf-value">{metrics.cost.cents.toFixed(2)}¢</div>
            <div className="prf-key">spent in 30 days</div>
          </div>
          <div className="prf-stat">
            <div className="prf-value">{pct(metrics.tools.successRate)}</div>
            <div className="prf-key">
              tool success · {metrics.tools.denied} refused on purpose
            </div>
          </div>
          <div className="prf-stat">
            <div className="prf-value">{metrics.memory.facts}</div>
            <div className="prf-key">things it believes · {metrics.memory.pinned} pinned</div>
          </div>
          <div className="prf-stat">
            <div className="prf-value">{pct(metrics.context.utilization)}</div>
            <div className="prf-key">of the context window used</div>
          </div>
          <div
            className={`prf-stat${metrics.latency.contextAssemblyMs.met === false ? ' is-over' : ''}`}
          >
            <div className="prf-value">{ms(metrics.latency.contextAssemblyMs.p95)}</div>
            <div className="prf-key">
              context assembly p95 · budget {metrics.latency.contextAssemblyMs.budgetMs}ms
            </div>
          </div>
          <div className="prf-stat">
            <div className="prf-value">{ms(metrics.latency.modelMs.p50)}</div>
            <div className="prf-key">median model latency</div>
          </div>
          <div className="prf-stat">
            <div className="prf-value">
              {metrics.honesty.calibrationError === null
                ? '—'
                : metrics.honesty.calibrationError.toFixed(2)}
            </div>
            <div className="prf-key">Brier score · lower is better</div>
          </div>
        </div>
      ) : null}

      <div className="panel-label" style={{ marginTop: 10 }}>
        Backup and portability
      </div>
      <div className="prf-note">
        An untested backup is a rumour. Checking copies the database, verifies the hash chain end
        to end, and rebuilds every projection from the events alone to see whether it comes back
        the same.
      </div>

      <div className="prf-actions">
        <button
          className="prf-btn"
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            try {
              setBackup(await agent.verifyBackup());
            } catch (cause) {
              onNotice((cause as Error).message);
            } finally {
              setChecking(false);
            }
          }}
        >
          {checking ? 'Checking…' : 'Verify a backup now'}
        </button>
        <button
          className="prf-btn"
          onClick={async () => {
            try {
              const document = await agent.exportAll();
              const blob = new Blob([JSON.stringify(document)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const anchor = Object.assign(window.document.createElement('a'), {
                href: url,
                download: `agent-export-${new Date().toISOString().slice(0, 10)}.json`,
              });
              anchor.click();
              URL.revokeObjectURL(url);
              onNotice('Exported. Secrets are included, still encrypted.');
            } catch (cause) {
              onNotice((cause as Error).message);
            }
          }}
        >
          Export everything
        </button>
      </div>

      {backup !== null ? (
        <div className={`prf-report${backup.ok ? '' : ' is-bad'}`}>
          <strong>{backup.ok ? 'This backup is good.' : 'This backup should not be relied on.'}</strong>
          <ul className="prf-list">
            {backup.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <div className="prf-key">checked in {backup.elapsedMs}ms</div>
        </div>
      ) : null}
    </>
  );
}
