import { useEffect, useState } from 'react';
import { agent, AgentUnavailableError, type TraceView } from '../lib/agent';

/**
 * §30's question — "why did it say that?" — asked from the bubble that
 * prompted it.
 *
 * The join is the message's own `runId`. A separate traces screen would
 * have made the user match run ids by eye, which is exactly the chore
 * that stops anyone from ever checking.
 *
 * Both renderings of the trace are here because they answer different
 * questions. The structured view answers "what happened, in order, and
 * what did it cost" at a glance. The text view is what you paste into a
 * bug report at 2am. They are built from the same events on the server,
 * so they cannot disagree.
 */

const ms = (value: number | null): string => (value === null ? '—' : `${Math.round(value)}ms`);

export default function TraceSheet({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [trace, setTrace] = useState<TraceView | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([agent.trace(runId), agent.traceText(runId)]).then(
      ([structured, readable]) => {
        if (!live) return;
        setTrace(structured);
        setText(readable);
      },
      (cause: unknown) => {
        if (!live) return;
        setError(
          cause instanceof AgentUnavailableError
            ? 'The agent is not running, so its reasoning cannot be read back.'
            : (cause as Error).message,
        );
      },
    );
    return () => {
      live = false;
    };
  }, [runId]);

  return (
    <div className="trc-backdrop" onClick={onClose}>
      <div
        className="trc-sheet"
        role="dialog"
        aria-label="Why it said that"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="trc-head">
          <div className="trc-title">Why it said that</div>
          <button className="trc-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {error !== null ? <div className="trc-empty">{error}</div> : null}
        {error === null && trace === null ? <div className="trc-empty">Reading the log…</div> : null}

        {trace !== null ? (
          <div className="trc-body">
            <div className="trc-row">
              <span>Outcome</span>
              <strong>
                {trace.status}
                {trace.reason === null ? '' : ` · ${trace.reason}`}
              </strong>
            </div>
            <div className="trc-row">
              <span>Started by</span>
              <strong>{trace.trigger ?? 'you'}</strong>
            </div>
            <div className="trc-row">
              <span>Took</span>
              <strong>
                {ms(trace.totals.wallMs)} · {trace.totals.steps} step
                {trace.totals.steps === 1 ? '' : 's'} · {trace.totals.tokens} tokens
              </strong>
            </div>

            {trace.degradation.length > 0 ? (
              <div className="trc-warn">
                Working with less: {trace.degradation.map((d) => `${d.level} (${d.reason})`).join(', ')}
              </div>
            ) : null}

            {trace.context !== null ? (
              <>
                <div className="trc-section">What it was told</div>
                <div className="trc-note">
                  {trace.context.totalTokens} tokens assembled under {trace.context.policyVersion}.
                  Every block the model saw, largest first.
                </div>
                {[...trace.context.blocks]
                  .sort((a, b) => b.tokens - a.tokens)
                  .map((block) => (
                    <div key={block.name} className="trc-block">
                      <span className="trc-block-name">{block.name}</span>
                      <span className="trc-bar" aria-hidden="true">
                        <span
                          className="trc-bar-fill"
                          style={{
                            width: `${Math.max(
                              2,
                              Math.round((block.tokens / Math.max(1, trace.context!.totalTokens)) * 100),
                            )}%`,
                          }}
                        />
                      </span>
                      <span className="trc-block-n">{block.tokens}</span>
                    </div>
                  ))}
                {trace.context.drops.length > 0 ? (
                  <div className="trc-note">
                    Dropped to fit:{' '}
                    {trace.context.drops
                      .map((drop) => `${drop.dropped} from ${drop.block} (${drop.reason})`)
                      .join(', ')}
                  </div>
                ) : null}
              </>
            ) : null}

            {trace.recalls.length > 0 ? (
              <>
                <div className="trc-section">What it remembered</div>
                {trace.recalls.map((recall, index) => (
                  <div key={index} className="trc-line">
                    “{recall.query}” → {recall.selected.length} of {recall.candidates} candidates
                  </div>
                ))}
              </>
            ) : null}

            {trace.modelCalls.length > 0 ? (
              <>
                <div className="trc-section">What it asked the model</div>
                {trace.modelCalls.map((callRecord, index) => (
                  <div key={index} className="trc-line">
                    {callRecord.provider}/{callRecord.model} · {callRecord.inputTokens} in,{' '}
                    {callRecord.outputTokens ?? 0} out · {ms(callRecord.latencyMs)}
                    {callRecord.failed === null ? '' : ` · failed: ${callRecord.failed}`}
                  </div>
                ))}
              </>
            ) : null}

            {trace.toolCalls.length > 0 ? (
              <>
                <div className="trc-section">What it did</div>
                {trace.toolCalls.map((toolCall, index) => (
                  <div key={index} className={`trc-line is-${toolCall.outcome}`}>
                    {toolCall.tool} — {toolCall.outcome} · {ms(toolCall.durationMs)}
                    {toolCall.detail === '' ? '' : ` · ${toolCall.detail}`}
                  </div>
                ))}
              </>
            ) : null}

            {trace.approvals.length > 0 ? (
              <>
                <div className="trc-section">What it asked you</div>
                {trace.approvals.map((approval, index) => (
                  <div key={index} className="trc-line">
                    {approval.tool} ({approval.risk}) — {approval.decision ?? 'still waiting'}
                  </div>
                ))}
              </>
            ) : null}

            {trace.governance.length > 0 ? (
              <>
                <div className="trc-section">What the constitution said</div>
                {trace.governance.map((check, index) => (
                  <div key={index} className="trc-line">
                    {check.articleId}: {check.verdict}
                    {check.detail === '' ? '' : ` — ${check.detail}`}
                  </div>
                ))}
              </>
            ) : null}

            <button className="trc-toggle" onClick={() => setRaw(!raw)}>
              {raw ? 'Hide the full text' : 'Show the full text'}
            </button>
            {raw && text !== null ? <pre className="trc-pre">{text}</pre> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
