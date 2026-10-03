import { useCallback, useEffect, useState } from 'react';
import { agent, type NotificationView } from '../lib/agent';

/**
 * The bell — fired reminders the person has not looked at.
 *
 * S3 built reminders that fired correctly into a session nobody had
 * open. Every mechanism worked and the feature did not: a reminder
 * that does not reach anyone is a row in a table. This is the part
 * that reaches them.
 *
 * Three decisions:
 *
 * - **Only reminders.** Not "everything the agent said while you were
 *   away". A reminder is something the person explicitly asked to be
 *   told, at a moment they chose, and that request is what earns an
 *   interruption. The first time a badge shows something nobody asked
 *   for is the day people stop looking at badges.
 * - **Absent, not broken, when the agent is down.** No badge, no error
 *   in the corner of the chrome. The sidebar belongs to the messaging
 *   app, which works perfectly well with no agent running.
 * - **Dismissing is a fact, not a UI state.** "Got it" appends
 *   `reminder.seen` to the agent's log, so it survives a reload and
 *   the history can answer "was I ever actually told?".
 *
 * Polled every 30 seconds rather than streamed: this happens a few
 * times a day, and holding a socket open to hear about it would cost
 * more than it saves.
 */

const POLL_MS = 30_000;

const firedLabel = (at: number, now: number): string => {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(
    new Date(at),
  );
};

export default function NotificationBell({ onOpenSession }: { onOpenSession?: (id: string) => void }) {
  const [items, setItems] = useState<NotificationView[]>([]);
  const [open, setOpen] = useState(false);
  /**
   * Captured when the data arrives, not read during render: reading
   * the clock in a render body is impure (oxlint `react(purity)`) and
   * it is also wrong — "4m ago" should be relative to the data's own
   * age, not to an unrelated re-render.
   */
  const [now, setNow] = useState(() => Date.now());
  /**
   * The load / apply / fail split the other panels use. State is set
   * from the promise callback rather than synchronously inside the
   * effect — oxlint's `react(set-state-in-effect)` is right that the
   * latter starts a second render for no reason.
   */
  const load = useCallback(async () => agent.notifications(), []);

  const apply = useCallback((result: { notifications: NotificationView[] }) => {
    setItems(result.notifications);
    setNow(Date.now());
  }, []);

  const fail = useCallback(() => {
    // The agent not running is not an error worth showing in the
    // window chrome. The badge simply is not there.
    setItems([]);
  }, []);

  const refresh = useCallback(async () => load().then(apply, fail), [load, apply, fail]);

  useEffect(() => {
    let live = true;
    const tick = () => {
      load().then(
        (result) => {
          if (live) apply(result);
        },
        () => {
          if (live) fail();
        },
      );
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [load, apply, fail]);

  // Nothing outstanding: no bell at all. An always-present bell with a
  // zero on it is a thing to check and be disappointed by.
  if (items.length === 0) return null;

  const dismiss = async (notification: NotificationView) => {
    await agent.markNotificationSeen(notification.id).catch(() => undefined);
    await refresh();
  };

  return (
    <div className="ntf-wrap">
      <button
        className="icon-btn ntf-bell"
        onClick={() => setOpen((value) => !value)}
        title={`${items.length} reminder${items.length === 1 ? '' : 's'} you have not seen`}
        aria-label={`Notifications: ${items.length} unseen`}
        aria-expanded={open}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M8 1.6a3.6 3.6 0 0 0-3.6 3.6v2.1L3.2 9.6c-.3.4 0 1 .5 1h8.6c.5 0 .8-.6.5-1l-1.2-2.3V5.2A3.6 3.6 0 0 0 8 1.6Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <path d="M6.6 12.2a1.5 1.5 0 0 0 2.8 0" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
        <span className="ntf-badge">{items.length > 9 ? '9+' : items.length}</span>
      </button>

      {!open ? null : (
        <div className="ntf-pop" role="dialog" aria-label="Unseen reminders">
          <div className="ntf-head">Reminders</div>
          {items.map((notification) => (
            <div key={notification.id} className="ntf-item">
              <div className="ntf-main">
                <div className="ntf-text">{notification.text}</div>
                <div className="ntf-when">{firedLabel(notification.firedAt, now)}</div>
              </div>
              {onOpenSession === undefined ? null : (
                <button
                  className="ntf-btn"
                  onClick={() => {
                    onOpenSession(notification.sessionId);
                    setOpen(false);
                  }}
                >
                  Open
                </button>
              )}
              <button className="ntf-btn is-primary" onClick={() => void dismiss(notification)}>
                Got it
              </button>
            </div>
          ))}
          <div className="ntf-foot">
            These are reminders you asked for. Dismissing one is recorded in the agent&rsquo;s log.
          </div>
        </div>
      )}
    </div>
  );
}
