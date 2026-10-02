import { useState } from 'react';
import type { Message } from '../types';
import { agent } from '../lib/agent';
import { useStore } from '../lib/context';

/**
 * The agent asking permission.
 *
 * Deliberately not a chat bubble. A bubble is something you read; this is
 * something you answer, and the difference has to be visible at a glance or
 * consent degrades into clicking past a thing that looks like conversation.
 *
 * The preview text comes from the runtime (§19: the request names the tool
 * and shows what it would actually do), and the scope choice is the user's —
 * "just this once" is the default because it is the only answer that cannot
 * be regretted later.
 */
export function ApprovalCard({ msg }: { msg: Message }) {
  const { dispatch } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [always, setAlways] = useState(false);
  const approval = msg.approval;
  if (approval === undefined) return null;

  const decided = approval.outcome !== undefined;

  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(true);
    setError(null);
    try {
      await agent.decide(approval.id, decision, always && decision === 'approve' ? 'shape' : 'once');
      dispatch({
        type: 'approval-outcome',
        approvalId: approval.id,
        outcome: decision === 'approve' ? 'granted' : 'denied',
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not record that decision');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`approval ${decided ? 'decided' : ''}`} role="group" aria-label="Permission request">
      <div className="approval-head">
        <span className="approval-risk" data-risk={approval.risk}>
          {approval.risk}
        </span>
        <b>{approval.tool}</b>
        <span className="approval-why">needs your permission</span>
      </div>

      <pre className="approval-preview">{approval.preview}</pre>

      {decided ? (
        <div className="approval-outcome" data-outcome={approval.outcome}>
          {approval.outcome === 'granted'
            ? 'Allowed'
            : approval.outcome === 'denied'
              ? 'Denied'
              : 'Expired — the agent stopped waiting'}
        </div>
      ) : (
        <>
          <label className="approval-scope">
            <input
              type="checkbox"
              checked={always}
              onChange={(e) => setAlways(e.target.checked)}
              disabled={busy}
            />
            Allow calls that look exactly like this one without asking again
          </label>
          <div className="approval-actions">
            <button className="btn-deny" onClick={() => void decide('deny')} disabled={busy}>
              Don’t allow
            </button>
            <button className="btn-allow" onClick={() => void decide('approve')} disabled={busy}>
              Allow
            </button>
          </div>
        </>
      )}

      {error !== null && <div className="approval-error">{error}</div>}
    </div>
  );
}

export default ApprovalCard;
