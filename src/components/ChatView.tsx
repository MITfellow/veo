import { useState } from 'react';
import type { Message } from '../types';
import { useStore } from '../lib/context';
import { ChatAvatar } from './Avatar';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { IconBack, IconChevron } from './Icons';
import { Wordmark } from './Logo';

export function ChatView({ onBack, onToggleDetails }: { onBack: () => void; onToggleDetails: () => void }) {
  const { activeChat, chatContacts, chatTitle } = useStore();
  const [replyTo, setReplyTo] = useState<Message | null>(null);

  // switching conversation clears the reply target (adjusted during render,
  // which is cheaper than a second render pass from an effect)
  const [shownChatId, setShownChatId] = useState(activeChat?.id);
  if (shownChatId !== activeChat?.id) {
    setShownChatId(activeChat?.id);
    setReplyTo(null);
  }

  if (!activeChat) {
    return (
      <section className="chat" id="main" aria-label="Conversation">
        <div className="no-chat">
          <Wordmark size={40} />
          <div>
            <div style={{ fontSize: 15, color: 'var(--text-2)' }}>Nothing open</div>
            <div style={{ fontSize: 12.5, marginTop: 4 }}>
              Open <strong>Agent</strong> on the left to talk to it, or press ⌘N to start a conversation.
            </div>
          </div>
        </div>
      </section>
    );
  }

  const people = chatContacts(activeChat);
  const sub = activeChat.typing ? 'typing…' : people.length > 1 ? `${people.length} people` : null;
  // just the first name for one-to-one threads, the full name for groups
  const title = chatTitle(activeChat);
  const pillName =
    people.length > 1 || /[\d@]/.test(title) ? title : title.split(' ')[0];

  return (
    <section className="chat" id="main" aria-label="Conversation">
      <div className="chat-header">
        <button className="who" onClick={onToggleDetails} title="Conversation details (⌘I)">
          <ChatAvatar chat={activeChat} contacts={people} size={44} />
          <span className="who-pill">
            {pillName}
            {sub && <span className="who-sub">· {sub}</span>}
            <IconChevron size={10} className="chev" />
          </span>
        </button>
      </div>

      <button className="icon-btn back-btn" onClick={onBack} title="Back">
        <IconBack />
      </button>
      <MessageList chat={activeChat} onReply={setReplyTo} />
      <Composer chat={activeChat} replyTo={replyTo} clearReply={() => setReplyTo(null)} />
    </section>
  );
}
