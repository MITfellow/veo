import { useMemo, useState } from 'react';
import { useStore } from '../lib/context';
import { isAgentChat } from '../lib/agent-chat';
import type { Message } from '../types';
import { ChatAvatar } from './Avatar';
import { IconSearch } from './Icons';
import { describeType } from '../lib/files';

/**
 * Pass a message on to another conversation.
 *
 * Forwarding re-sends rather than moves: the original stays where it is, and
 * the copy goes through the normal `send` path so it gets its own id, its own
 * delivery lifecycle and the recipient's auto-reply — a forwarded message that
 * skipped all that would sit in the thread as a permanent "Sending…".
 */
export function ForwardModal({ msg, onClose }: { msg: Message; onClose: () => void }) {
  const { state, dispatch, send, chatTitle, chatContacts, messagesFor } = useStore();
  const [q, setQ] = useState('');

  const targets = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return state.chats
      .filter((c) => c.id !== msg.chatId)
      // Not the agent: forwarding into it would hand the runtime a message
      // nobody asked it to act on, which is exactly the shape of a prompt
      // injection. Say things to the agent on purpose.
      .filter((c) => !isAgentChat(c, state.contacts))
      .filter((c) => !needle || chatTitle(c).toLowerCase().includes(needle))
      // most recently active first, the order the sidebar uses
      .sort((a, b) => {
        const at = (id: string) => messagesFor(id).at(-1)?.at ?? 0;
        return at(b.id) - at(a.id);
      });
  }, [state.chats, state.contacts, msg.chatId, q, chatTitle, messagesFor]);

  const forward = (chatId: string) => {
    send(chatId, { text: msg.text, attachments: msg.attachments, forwarded: true });
    // land the user where it went, so "did that work?" never comes up
    dispatch({ type: 'select', chatId });
    onClose();
  };

  const preview =
    msg.text.trim() ||
    msg.attachments.map((a) => describeType(a.type ?? '', a.name ?? '')).join(', ') ||
    'Attachment';

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Forward message">
        <header>Forward To…</header>
        <div className="body">
          <div className="fwd-preview">
            <span className="fwd-quote">{preview}</span>
          </div>

          {targets.length > 1 && (
            <div className="search">
              <IconSearch />
              <input
                autoFocus
                value={q}
                placeholder="Search conversations"
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          )}

          {targets.map((c) => {
            const people = chatContacts(c);
            return (
              <button key={c.id} className="contact-pick" onClick={() => forward(c.id)}>
                <ChatAvatar contacts={people} size={34} />
                <div style={{ flex: 1 }}>
                  <div className="nm">{chatTitle(c)}</div>
                  <div className="hd">
                    {people.length > 1 ? `${people.length} people` : (people[0]?.handle ?? '')}
                  </div>
                </div>
              </button>
            );
          })}

          {targets.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', padding: '8px 4px' }}>
              {q.trim()
                ? `No conversation matches “${q.trim()}”.`
                : 'There is nowhere else to send this yet — start another conversation first.'}
            </div>
          )}
        </div>
        <footer>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}

export default ForwardModal;
