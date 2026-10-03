import React, { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/context';
import { isAgentChat } from '../lib/agent-chat';
import type { Chat, Contact, Message } from '../types';
import { TAPBACKS } from '../types';
import { listStamp } from '../lib/time';
import { ChatAvatar } from './Avatar';
import { Floating } from './Floating';
import { IconFilter, IconGear, IconMuted, IconPin, IconSearch, IconX } from './Icons';
import NotificationBell from './NotificationBell';

/** wraps every occurrence of the needle in <mark> */
function highlight(text: string, needle: string) {
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return text;
  const start = Math.max(0, i - 24);
  const head = (start > 0 ? '…' : '') + text.slice(start, i);
  return (
    <>
      {head}
      <mark>{text.slice(i, i + needle.length)}</mark>
      {text.slice(i + needle.length)}
    </>
  );
}

/** macOS shows tapbacks in the list as: Name reacted ❤️ to “…” */
function previewOf(m: Message | undefined, authorName: string, youPrefix: boolean): string {
  if (!m) return 'No messages yet';
  if (m.unsent) return 'Message unsent';

  const att = m.attachments[0];
  let body = m.text;
  if (!body && att) {
    body =
      att.kind === 'image'
        ? '📷 Photo'
        : att.kind === 'audio'
          ? '🎙 Audio Message'
          : att.kind === 'file'
            ? `📄 ${att.name ?? 'Attachment'}`
            : att.kind === 'link'
              ? `🔗 ${att.title ?? 'Link'}`
              : 'Attachment';
  }
  if (m.bubbleEffect === 'invisible' && !m.revealed) body = 'sent with Invisible Ink';
  return youPrefix ? `You: ${body}` : authorName ? body : body;
}

/**
 * One conversation row. Memoised on already-computed primitives: selecting a
 * thread used to re-render all 40 rows (and their avatars) because the row was
 * an inline function React could not skip.
 */
const ConvRow = React.memo(function ConvRow({
  chat,
  contacts,
  title,
  stamp,
  preview,
  selected,
  onSelect,
  onContext,
}: {
  chat: Chat;
  contacts: Record<string, Contact>;
  title: string;
  stamp: string;
  preview: string;
  selected: boolean;
  onSelect: (chatId: string) => void;
  onContext: (chat: Chat, x: number, y: number) => void;
}) {
  const people = useMemo(
    () => chat.participantIds.map((id) => contacts[id]).filter(Boolean),
    [chat.participantIds, contacts],
  );

  return (
    <div
      // `conv-agent` marks the one conversation that is the product rather
      // than a contact. It exists because the agent's *name* is now
      // user-settable (decision 043), so anything that found this row by
      // the word "Agent" started failing the moment someone renamed it —
      // which is exactly what the feature is for.
      className={`conv-row ${isAgentChat(chat, contacts) ? 'conv-agent' : ''} ${
        selected ? 'selected' : ''
      } ${chat.unread ? 'unread' : ''}`}
      role="option"
      tabIndex={0}
      aria-selected={selected}
      aria-label={`${title}${chat.unread ? `, ${chat.unread} unread` : ''}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(chat.id);
        }
      }}
      onClick={() => onSelect(chat.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(chat, e.clientX, e.clientY);
      }}
    >
      {chat.unread > 0 && !selected && <span className="unread-dot" />}
      <ChatAvatar chat={chat} contacts={people} />
      <div className="conv-main">
        <div className="conv-line1">
          <span className="conv-name">{title}</span>
          {chat.muted && (
            <span className="conv-muted-icon">
              <IconMuted />
            </span>
          )}
          <span className="conv-time">
            {stamp}
            <svg
              className="chev"
              width="9"
              height="9"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m9 5 7 7-7 7" />
            </svg>
          </span>
        </div>
        <div className="conv-preview">{chat.typing ? <em>typing…</em> : preview}</div>
      </div>
    </div>
  );
});

export function Sidebar({
  onCompose,
  onSettings,
  onOpen,
}: {
  onCompose: () => void;
  onSettings: () => void;
  onOpen?: () => void;
}) {
  const { state, dispatch, messagesFor, chatTitle, chatContacts } = useStore();
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; chat: Chat } | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // typing stays responsive while the cross-thread scan catches up
  const deferredQuery = useDeferredValue(query);

  const rows = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return state.chats
      .map((chat) => {
        const msgs = messagesFor(chat.id);
        const last = msgs[msgs.length - 1];
        let hit: Message | undefined;
        if (q) hit = [...msgs].reverse().find((m) => m.text.toLowerCase().includes(q));
        return { chat, last, hit, at: last?.at ?? 0 };
      })
      .filter(({ chat, hit }) => {
        if (unreadOnly && !chat.unread) return false;
        if (!q) return true;
        return chatTitle(chat).toLowerCase().includes(q) || !!hit;
      })
      .sort((a, b) => {
        if (a.chat.pinned && b.chat.pinned) {
          return state.chats.indexOf(a.chat) - state.chats.indexOf(b.chat);
        }
        return b.at - a.at;
      });
  }, [state.chats, deferredQuery, unreadOnly, messagesFor, chatTitle]);

  /** every matching message across every thread, newest first (Apple's
      "Messages" section under the conversation hits) */
  const messageHits = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: { chat: Chat; msg: Message }[] = [];
    for (const chat of state.chats) {
      for (const msg of messagesFor(chat.id)) {
        if (msg.unsent || msg.system || !msg.text) continue;
        if (msg.text.toLowerCase().includes(q)) out.push({ chat, msg });
      }
    }
    return out.sort((a, b) => b.msg.at - a.msg.at).slice(0, 40);
  }, [deferredQuery, state.chats, messagesFor]);

  const pinned = rows.filter((r) => r.chat.pinned);
  const normal = rows.filter((r) => !r.chat.pinned);

  /** the newest tapback in a thread wins the preview line, like macOS */
  const reactionLine = (chat: Chat): string | null => {
    const msgs = messagesFor(chat.id);
    let best: { at: number; text: string } | null = null;
    for (const m of msgs.slice(-12)) {
      for (const r of m.reactions) {
        if (r.by === 'me') continue;
        const who = state.contacts[r.by]?.name.split(' ')[0] ?? 'Someone';
        const glyph = TAPBACKS.find((t) => t.id === r.type)?.glyph ?? '❤️';
        const target = m.text || (m.attachments.length ? 'an attachment' : '');
        const line = `${who} reacted ${glyph} to “${target}”`;
        if (!best || r.at > best.at) best = { at: r.at, text: line };
      }
    }
    const last = msgs[msgs.length - 1];
    if (best && last && best.at > last.at) return best.text;
    return null;
  };

  const selectChat = useCallback(
    (chatId: string) => {
      dispatch({ type: 'select', chatId });
      onOpen?.();
    },
    [dispatch, onOpen],
  );

  const openMenu = useCallback((chat: Chat, x: number, y: number) => setMenu({ x, y, chat }), []);

  const renderRow = ({ chat, last, hit }: (typeof rows)[number]) => {
    const msg = hit ?? last;
    return (
      <ConvRow
        key={chat.id}
        chat={chat}
        contacts={state.contacts}
        title={chatTitle(chat)}
        stamp={msg ? listStamp(msg.at) : ''}
        preview={reactionLine(chat) ?? previewOf(msg, '', !!msg && msg.authorId === 'me')}
        selected={state.activeChatId === chat.id}
        onSelect={selectChat}
        onContext={openMenu}
      />
    );
  };

  return (
    <aside className="sidebar" aria-label="Conversations">
      <div className="sidebar-top">
        <div className="sidebar-titlebar">
          {/* decorative window chrome — not announced, not focusable */}
          <div className="traffic" aria-hidden="true">
            <span className="tl-red" />
            <span className="tl-yellow" />
            <span className="tl-green" />
          </div>
          <div className="title-actions">
            {/* S4: fired reminders nobody has looked at. Renders
                nothing at all when there are none, and when the agent
                is not running. */}
            <NotificationBell />
            <button className="icon-btn" onClick={onSettings} title="Settings" aria-label="Settings">
              <IconGear size={15} />
            </button>
            <button
              className="icon-btn"
              onClick={() => setUnreadOnly((v) => !v)}
              title={unreadOnly ? 'Show all conversations' : 'Show unread only'}
              style={unreadOnly ? { color: 'var(--blue)', background: 'var(--row-hover)' } : undefined}
            >
              <IconFilter />
            </button>
          </div>
        </div>
        <div className="search">
          <IconSearch />
          <input
            ref={searchRef}
            id="sidebar-search"
            value={query}
            placeholder="Search"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          />
          {query ? (
            <button className="icon-btn plain" style={{ width: 18, height: 18 }} onClick={() => setQuery('')}>
              <IconX size={11} />
            </button>
          ) : (
            <kbd>⌘K</kbd>
          )}
        </div>
      </div>

      <div className="conv-scroll">
        {pinned.length > 0 && !query && (
          <div className="pinned-grid" role="group" aria-label="Pinned conversations">
            {pinned.slice(0, 9).map(({ chat, last }) => {
              const people = chatContacts(chat);
              const selected = state.activeChatId === chat.id;
              // Apple floats the newest unread message over the pin, plus a
              // badge for the newest tapback on it.
              const preview =
                last && last.authorId !== 'me' && chat.unread > 0 && !last.unsent
                  ? last.text || (last.attachments.length ? 'Attachment' : '')
                  : '';
              const reaction = last?.reactions?.length
                ? TAPBACKS.find((t) => t.id === last.reactions[last.reactions.length - 1].type)
                : undefined;
              return (
                <button
                  key={chat.id}
                  className={`pinned-item ${selected ? 'selected' : ''}`}
                  aria-label={`${chatTitle(chat)}${chat.unread ? `, ${chat.unread} unread` : ''}`}
                  onClick={() => {
                    dispatch({ type: 'select', chatId: chat.id });
                    onOpen?.();
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, chat });
                  }}
                >
                  <span className="pin-art">
                    <ChatAvatar chat={chat} contacts={people} size={56} />
                    {reaction && !chat.typing && (
                      <span className="pin-tapback" aria-hidden="true">
                        {reaction.glyph}
                      </span>
                    )}
                  </span>
                  {chat.typing ? (
                    <span className="pin-bubble typing">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : (
                    preview && <span className="pin-bubble">{preview}</span>
                  )}
                  <span className="pin-label">
                    {chat.unread > 0 && <span className="pin-dot" />}
                    <span className="pin-name">
                      {chat.name ?? (people.length === 1 ? people[0].name.split(' ')[0] : chatTitle(chat).split(',')[0])}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {query && rows.length === 0 && messageHits.length === 0 && (
          <div className="empty-list">No results for “{query}”</div>
        )}
        {unreadOnly && rows.length === 0 && <div className="empty-list">No unread messages</div>}
        <div role="listbox" aria-label="Conversations">{(query ? rows : normal).map(renderRow)}</div>

        {!query && !unreadOnly && state.chats.every((c) => isAgentChat(c, state.contacts)) && (
          /* Below the list, not above it: the agent's own row is a real
             conversation and the empty state is about the ones you have not
             started yet. */
          <div className="empty-first-run">
            <div className="efr-glyph" aria-hidden="true">
              <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
                <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 9 9 0 0 1-3.6-.74L3 21l1.9-5.1A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
              </svg>
            </div>
            <div className="efr-title">No Conversations</div>
            <div className="efr-sub">Start one and it will show up here.</div>
            <button className="btn primary efr-cta" onClick={onCompose}>
              New Message
            </button>
          </div>
        )}

        {query.trim().length >= 2 && messageHits.length > 0 && (
          <>
            <div className="search-section" id="search-messages-label">
              Messages
            </div>
            <div role="group" aria-labelledby="search-messages-label">
            {messageHits.map(({ chat, msg }) => (
              <button
                key={msg.id}
                className="hit-row"
                onClick={() => {
                  dispatch({ type: 'select', chatId: chat.id });
                  onOpen?.();
                  setTimeout(
                    () => window.dispatchEvent(new CustomEvent('jump-to-message', { detail: msg.id })),
                    90,
                  );
                }}
              >
                <ChatAvatar chat={chat} contacts={chatContacts(chat)} size={30} />
                <span className="hit-main">
                  <span className="hit-line1">
                    <span className="hit-name">{chatTitle(chat)}</span>
                    <span className="hit-time">{listStamp(msg.at)}</span>
                  </span>
                  <span className="hit-text">{highlight(msg.text, query.trim())}</span>
                </span>
              </button>
            ))}
            </div>
          </>
        )}
      </div>

      {menu && (
        <Floating x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <div className="menu">
            <button
              className="menu-item"
              onClick={() => {
                dispatch({ type: 'chat-flag', chatId: menu.chat.id, patch: { pinned: !menu.chat.pinned } });
                setMenu(null);
              }}
            >
              <IconPin /> {menu.chat.pinned ? 'Unpin' : 'Pin'}
            </button>
            <button
              className="menu-item"
              onClick={() => {
                dispatch({ type: 'chat-flag', chatId: menu.chat.id, patch: { muted: !menu.chat.muted } });
                setMenu(null);
              }}
            >
              <IconMuted /> {menu.chat.muted ? 'Show Alerts' : 'Hide Alerts'}
            </button>
            <button
              className="menu-item"
              onClick={() => {
                dispatch({
                  type: 'chat-flag',
                  chatId: menu.chat.id,
                  patch: { unread: menu.chat.unread ? 0 : 1 },
                });
                setMenu(null);
              }}
            >
              <span style={{ width: 14, textAlign: 'center' }}>●</span>
              {menu.chat.unread ? 'Mark as Read' : 'Mark as Unread'}
            </button>
            <div className="menu-sep" />
            <button
              className="menu-item danger"
              onClick={() => {
                dispatch({ type: 'delete-chat', chatId: menu.chat.id });
                setMenu(null);
              }}
            >
              <IconX /> Delete Conversation
            </button>
          </div>
        </Floating>
      )}
      <button className="glass-btn compose-btn" onClick={onCompose} title="New Message (⌘N)" aria-label="New message">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.5 7.5 16.5 3.5 5.6 14.4a2 2 0 0 0-.5.9l-1 3.6 3.6-1a2 2 0 0 0 .9-.5L20.5 7.5Z" />
          <path d="m14.8 5.2 4 4" />
        </svg>
      </button>
    </aside>
  );
}
